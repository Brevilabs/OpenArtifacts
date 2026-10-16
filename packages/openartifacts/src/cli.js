import { access, chmod, cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APIError, createClient } from "./client.js";

const DEFAULT_HOST = "https://api.openartifacts.ai";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_SOURCE = join(PACKAGE_ROOT, "skill", "openartifacts");
/** @typedef {{name: string, detected: boolean, target: string}} DetectedAgent */
/** @typedef {{hosts: Record<string, {token: string, tokenId?: string}>}} Credentials */

/** @param {NodeJS.Platform} os @param {string} home @param {NodeJS.ProcessEnv} env */
export function configDir(os = platform(), home = homedir(), env = process.env) {
  if (env.OPENARTIFACTS_CONFIG_DIR) return resolve(env.OPENARTIFACTS_CONFIG_DIR);
  if (os === "darwin") return join(home, "Library", "Application Support", "openartifacts");
  if (os === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "openartifacts");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "openartifacts");
}

/** @param {string} command @param {NodeJS.ProcessEnv} env */
async function hasCommand(command, env) {
  const suffixes = platform() === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(platform() === "win32" ? ";" : ":")) {
    for (const suffix of suffixes) {
      try {
        await access(join(dir, `${command}${suffix.toLowerCase()}`), constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

/** Detect supported agents by their executable or existing user config root.
 * @returns {Promise<DetectedAgent[]>}
 */
export async function detectAgents(home = homedir(), env = process.env) {
  const agents = [
    { name: "Claude Code", command: "claude", root: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), hinted: !!env.CLAUDE_CONFIG_DIR },
    { name: "Codex", command: "codex", root: env.CODEX_HOME ?? join(home, ".codex"), hinted: !!env.CODEX_HOME },
    { name: "OpenCode", command: "opencode", root: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode"), hinted: false },
    { name: "pi", command: "pi", root: env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), hinted: !!env.PI_CODING_AGENT_DIR },
  ];
  /** @type {DetectedAgent[]} */
  const found = [];
  for (const agent of agents) {
    let configured = false;
    try {
      configured = (await stat(agent.root)).isDirectory();
    } catch {}
    found.push({
      name: agent.name,
      detected: agent.hinted || configured || (await hasCommand(agent.command, env)),
      target: join(agent.root, "skills", "openartifacts"),
    });
  }
  return found;
}

/** Copy the skill directory (SKILL.md and its themes) into every detected agent.
 * @param {DetectedAgent[]} agents @param {string} [source]
 */
export async function installSkills(agents, source = SKILL_SOURCE) {
  for (const agent of agents) {
    if (!agent.detected) continue;
    await mkdir(dirname(agent.target), { recursive: true });
    await cp(source, agent.target, { recursive: true });
  }
}

/** @template T @param {string} path @param {T} fallback @returns {Promise<T>} */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

/** @param {string} path @param {unknown} value */
async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/** Keep browser URLs as data, including Windows shell metacharacters.
 * @param {string} url @param {NodeJS.Platform} [os]
 */
export function browserProcess(url, os = platform()) {
  return os === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:OPENARTIFACTS_BROWSER_URL"],
      env: { ...process.env, OPENARTIFACTS_BROWSER_URL: url } }
    : { command: os === "darwin" ? "open" : "xdg-open", args: [url], env: process.env };
}

/**
 * Hand a url to the system browser. Resolves true once the opener exits
 * successfully and false when it could not start or exited with an error (an
 * `xdg-open` on a headless host starts and then fails), and never rejects:
 * callers that only offer a url ignore the answer.
 * @param {string} url @returns {Promise<boolean>}
 */
function openBrowser(url) {
  return new Promise((resolvePromise) => {
    const opener = browserProcess(url);
    try {
      const child = spawn(opener.command, opener.args, { env: opener.env, shell: false, detached: true, stdio: "ignore" });
      child.on("error", () => resolvePromise(false));
      // Not unref'd: the exit status is the answer, so the CLI waits for it.
      child.on("exit", (code) => resolvePromise(code === 0));
    } catch {
      resolvePromise(false);
    }
  });
}

/** @param {number} milliseconds */
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

/**
 * Poll a device code until it yields a token or expires.
 * @param {ReturnType<typeof createClient>} client
 * @param {{device_code: string, interval: number, expires_in: number}} minted
 * @param {{wait?: (milliseconds: number) => Promise<unknown>, now?: () => number}} [options]
 */
export async function collectToken(client, minted, { wait = sleep, now = Date.now } = {}) {
  let delay = minted.interval * 1000;
  const expiresAt = now() + minted.expires_in * 1000;
  while (now() < expiresAt) {
    try {
      return await client.deviceToken(minted.device_code);
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      if (error.code === "authorization_pending") await wait(delay);
      else if (error.code === "slow_down") {
        delay += 5000;
        await wait(delay);
      } else throw error;
    }
  }
  throw new Error("The approval code expired. Run the command again to start a new sign-in.");
}

/** Sign in, store the credential owner-only, and return it without printing it. */
/** @param {string} host @param {string} directory @returns {Promise<string>} */
async function login(host, directory) {
  const anonymous = createClient({ host });
  const minted = await anonymous.deviceCode(`OpenArtifacts CLI on ${hostname()}`);
  console.error(`Approve OpenArtifacts: ${minted.verification_uri_complete}`);
  console.error(`Or open ${minted.verification_uri} and enter ${minted.user_code}.`);
  openBrowser(minted.verification_uri_complete);

  const issued = await collectToken(anonymous, minted);
  const credentialsPath = join(directory, "credentials.json");
  const credentials = await readJson(
    credentialsPath,
    /** @type {Credentials} */ ({ hosts: {} }),
  );
  credentials.hosts ??= {};
  credentials.hosts[host] = { token: issued.access_token, tokenId: issued.token_id };
  await writePrivateJson(credentialsPath, credentials);
  console.error(`Signed in (${issued.token_id}).`);
  return issued.access_token;
}

/** @param {string} host @param {string} directory */
async function credential(host, directory) {
  if (process.env.OPENARTIFACTS_TOKEN) return process.env.OPENARTIFACTS_TOKEN;
  const stored = await readJson(
    join(directory, "credentials.json"),
    /** @type {Credentials} */ ({ hosts: {} }),
  );
  return stored.hosts?.[host]?.token ?? login(host, directory);
}

/** @param {NodeJS.Platform} os */
export function npmProcess(os = platform()) {
  return os === "win32"
    ? { command: "npm.cmd", shell: true }
    : { command: "npm", shell: false };
}

/** @param {{command: string, shell: boolean}} npm */
async function npmGlobalRoot(npm) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const child = spawn(npm.command, ["root", "--global"], {
      shell: npm.shell,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise(output.trim())
      : reject(new Error(`Could not locate the global npm package directory (npm exit ${code}).`)));
  });
}

async function install() {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const npm = npmProcess();
  await new Promise((resolvePromise, reject) => {
    const child = spawn(npm.command, ["install", "--global", `${manifest.name}@latest`], {
      shell: npm.shell,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise(undefined)
      : reject(new Error(`Global CLI install failed (npm exit ${code}). Fix the npm error above; for EACCES, use a Node version manager or a user-writable npm prefix, then rerun.`)));
  });
  const installedRoot = join(await npmGlobalRoot(npm), ...manifest.name.split("/"));
  const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  console.log(`CLI: installed ${installedManifest.name}@${installedManifest.version}`);
  const agents = await detectAgents();
  await installSkills(agents, join(installedRoot, "skill", "openartifacts"));
  for (const agent of agents) {
    console.log(`${agent.name}: ${agent.detected ? `installed ${agent.target}` : "not detected"}`);
  }
}

const HELP = `Usage: openartifacts <command> [argument] [options]

Commands:
  install            Install or upgrade the CLI and detected agent skills
  login              Approve this machine and store its token
  account [--open]   Refresh plan, limits, and usage; open account management with --open
  publish <file.html> [--title <title>] [--doc-id <docId>] [--public | --private]
                     Publish an HTML file. A new page is private (invited people only)
                     when the plan allows it and public otherwise; --public makes it
                     public, and --private requires private (it fails rather than
                     publishing publicly). Pass --doc-id to update an existing document;
                     an update never changes who can open it
  open <docId>       Open your own page in the browser, signed in as you
  share <docId> [--add <email> [--role view|comment]] [--remove <email>] [--decline <email>]
        [--link anyone|invited]
                     Show who can open a document, pending requests and its share page,
                     or change it; --add also approves a request, and --role sets whether
                     the added person can comment (the default) or only view
  comments list <docId> [--open|--resolved|--all] [--since <iso>]
                     Print a document's comment threads as JSON (open ones by default)
  comments add <docId> --quote <text> --body <text> [--prefix <text>] [--suffix <text>]
        [--section <id>] [--version <n>]
                     Start a thread on text quoted from the page
  comments reply <docId> <threadId> --body <text>
  comments resolve <docId> <threadId> [--version <n>]
  comments reopen <docId> <threadId>
  comments delete <docId> <commentId>
                     Delete your own comment; deleting a thread's first comment deletes the thread
  comments on <docId>, comments off <docId>
                     Turn comments on or off for a document you own
  comments name <name>
                     Set the display name your comments carry
  list               List published documents and their link access
  get <docId>        Print a document's current HTML
  unshare <docId>    Withdraw a document
  tokens             List this account's machine tokens
  revoke <tokenId>   Revoke a machine token`;

/**
 * Read the HTML file and the publish options before any authentication. A create
 * defaults the title to the file name; an update omits it so the server keeps the
 * current title unless --title was given.
 * @param {string} file @param {string[]} options
 * @returns {Promise<{docId?: string, access: "private" | "public" | "default", body: {title?: string, html: string}}>}
 */
export async function preparePublish(file, options) {
  if (![".html", ".htm"].includes(extname(file).toLowerCase())) {
    throw new Error("Publish an HTML file (.html, .htm). Render other formats to HTML first.");
  }
  /** @type {{title?: string, docId?: string, private?: boolean, public?: boolean}} */
  const flags = {};
  for (let index = 0; index < options.length; index += 1) {
    const flag = options[index];
    if (flag === "--private" && !flags.private) {
      flags.private = true;
      continue;
    }
    if (flag === "--public" && !flags.public) {
      flags.public = true;
      continue;
    }
    const value = options[++index];
    if (!value || value.startsWith("--")) throw new Error(HELP);
    if (flag === "--title" && flags.title === undefined) flags.title = value;
    else if (flag === "--doc-id" && flags.docId === undefined) flags.docId = value;
    else throw new Error(HELP);
  }
  if (flags.private && flags.public) {
    throw new Error("--public and --private cannot be used together.");
  }
  if (flags.private && flags.docId) {
    throw new Error("--private applies to a new document. Change an existing one with `openartifacts share <docId> --link invited`.");
  }
  if (flags.public && flags.docId) {
    throw new Error("--public applies to a new document. Change an existing one with `openartifacts share <docId> --link anyone`.");
  }
  const path = resolve(file);
  const html = await readFile(path, "utf8");
  const title = flags.title ?? (flags.docId ? undefined : basename(path, extname(path)));
  return {
    docId: flags.docId,
    access: flags.private ? "private" : flags.public ? "public" : "default",
    body: { ...(title === undefined ? {} : { title }), html },
  };
}

/**
 * The share page of a document, on the API host the CLI is talking to. It is
 * not derived from the document's url, which is on the serving domain.
 * @param {string} host @param {string} docId
 */
function manageUrl(host, docId) {
  return `${host}/share/${encodeURIComponent(docId)}`;
}

/**
 * The access changes `share` was asked for, in order, read before any
 * authentication. Each flag changes one thing: one address added (which also
 * approves its request), one removed, one request declined, or the link
 * setting. There is no way to send a whole list, so a retry or a mistake cannot
 * remove everyone. `--role` is not a change of its own: it sets the role of the
 * address each `--add` in the same call adds, and means nothing without one.
 * @param {string[]} options
 * @returns {Array<["link" | "add" | "remove" | "decline", string, ("view" | "comment")?]>}
 */
export function prepareShare(options) {
  /** @type {Array<["link" | "add" | "remove" | "decline", string, ("view" | "comment")?]>} */
  const changes = [];
  /** @type {"view" | "comment" | undefined} */
  let role;
  for (let index = 0; index < options.length; index += 2) {
    const [flag, value] = [options[index], options[index + 1]];
    if (!value || value.startsWith("--")) throw new Error(HELP);
    if (flag === "--add") changes.push(["add", value]);
    else if (flag === "--remove") changes.push(["remove", value]);
    else if (flag === "--decline") changes.push(["decline", value]);
    else if (flag === "--link" && (value === "anyone" || value === "invited")) changes.push(["link", value]);
    else if (flag === "--role" && role === undefined && (value === "view" || value === "comment")) role = value;
    else throw new Error(HELP);
  }
  if (role !== undefined) {
    const adds = changes.filter(([change]) => change === "add");
    if (!adds.length) throw new Error("--role applies to a person added in the same call. Use `openartifacts share <docId> --add <email> --role view|comment`.");
    for (const change of adds) change[2] = role;
  }
  return changes;
}

const THREAD_ID = /^th_[A-Za-z0-9_-]{1,64}$/;
const COMMENT_ID = /^cm_[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
/**
 * The text limits the server enforces, checked here so a mistake costs no credential or request.
 * Measured the way the server measures: UTF-16 length (`.length`, so an emoji is 2) after the
 * same normalising, in `text()` below.
 */
const COMMENT_LIMITS = { body: 4000, quote: 1000, context: 32, section: 128, name: 64 };

/** @typedef {{action: "list", docId: string, state: "open" | "resolved" | "all", since?: string}
 *   | {action: "add", docId: string, body: {anchor: {exact: string, prefix?: string, suffix?: string, section?: string}, body: string, version?: number}}
 *   | {action: "reply", docId: string, threadId: string, body: string}
 *   | {action: "resolve", docId: string, threadId: string, version?: number}
 *   | {action: "reopen", docId: string, threadId: string}
 *   | {action: "delete", docId: string, commentId: string}
 *   | {action: "on" | "off", docId: string}
 *   | {action: "name", name: string}} CommentsRequest */

/**
 * Read a `comments` subcommand's arguments before any authentication, so a
 * malformed one fails without a credential being read or a login started. Text
 * values may begin with `--` (a quote or a comment can), so a value is whatever
 * follows its flag; only the flag positions are matched against the known flags.
 * Ids are never guessed here, only checked for shape.
 * @param {string | undefined} action the subcommand @param {string[]} extra the rest
 * @returns {CommentsRequest}
 */
export function prepareComments(action, extra) {
  /** Parse `--flag value` pairs (and the listed bare flags) after `skip` positionals.
   * @param {number} skip @param {string[]} valued @param {string[]} [bare]
   * @returns {{positional: string[], flags: Map<string, string>}} */
  const parse = (skip, valued, bare = []) => {
    const positional = extra.slice(0, skip);
    if (positional.length < skip || positional.some((item) => !item || item.startsWith("--"))) throw new Error(HELP);
    /** @type {Map<string, string>} */
    const flags = new Map();
    for (let index = skip; index < extra.length; index += 1) {
      const flag = extra[index] ?? "";
      if (flags.has(flag)) throw new Error(HELP);
      if (bare.includes(flag)) {
        flags.set(flag, "");
      } else if (valued.includes(flag) && index + 1 < extra.length) {
        flags.set(flag, extra[++index] ?? "");
      } else {
        throw new Error(HELP);
      }
    }
    return { positional, flags };
  };
  /** @param {string} label @param {string | undefined} value @param {number} max @param {boolean} required
   * @param {(value: string) => string} measured the text as the server reads it before counting */
  const text = (label, value, max, required, measured) => {
    if (value === undefined) {
      if (required) throw new Error(`${label} is required.`);
      return undefined;
    }
    const length = measured(value).length;
    if (required && !value.trim()) throw new Error(`${label} cannot be empty.`);
    if (length > max) throw new Error(`${label} is ${length} characters; the limit is ${max}.`);
    return value;
  };
  /** A comment body: trimmed. */
  const trimmed = (/** @type {string} */ value) => value.trim();
  /** A quote, its context and a section: NFC. */
  const normalised = (/** @type {string} */ value) => value.normalize("NFC");
  /** A display name: NFC, then trimmed. */
  const named = (/** @type {string} */ value) => value.normalize("NFC").trim();
  /** @param {string | undefined} value */
  const version = (value) => {
    if (value === undefined) return undefined;
    if (!VERSION.test(value)) throw new Error("--version must be a version number such as 3.");
    return Number(value);
  };
  /** @param {string} value @param {RegExp} shape */
  const identifier = (value, shape) => {
    if (!shape.test(value)) throw new Error(HELP);
    return value;
  };

  if (action === "list") {
    const { positional: [docId = ""], flags } = parse(1, ["--since"], ["--open", "--resolved", "--all"]);
    const states = ["--open", "--resolved", "--all"].filter((flag) => flags.has(flag));
    if (states.length > 1) throw new Error(HELP);
    const since = flags.get("--since");
    if (since !== undefined && (!/^\d{4}-\d{2}-\d{2}/.test(since) || Number.isNaN(Date.parse(since)))) {
      throw new Error("--since must be a date such as 2026-10-14T09:00:00Z.");
    }
    // The CLI names the state it wants rather than leaning on the server's default.
    const state = states[0] === "--resolved" ? "resolved" : states[0] === "--all" ? "all" : "open";
    return { action, docId, state, ...(since === undefined ? {} : { since }) };
  }
  if (action === "add") {
    const { positional: [docId = ""], flags } = parse(1, ["--quote", "--body", "--prefix", "--suffix", "--section", "--version"]);
    const exact = text("--quote", flags.get("--quote"), COMMENT_LIMITS.quote, true, normalised) ?? "";
    const body = text("--body", flags.get("--body"), COMMENT_LIMITS.body, true, trimmed) ?? "";
    const prefix = text("--prefix", flags.get("--prefix"), COMMENT_LIMITS.context, false, normalised);
    const suffix = text("--suffix", flags.get("--suffix"), COMMENT_LIMITS.context, false, normalised);
    const section = text("--section", flags.get("--section"), COMMENT_LIMITS.section, false, normalised);
    const atVersion = version(flags.get("--version"));
    return {
      action, docId,
      body: {
        anchor: { exact, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}), ...(section ? { section } : {}) },
        body,
        ...(atVersion === undefined ? {} : { version: atVersion }),
      },
    };
  }
  if (action === "reply") {
    const { positional: [docId = "", threadId = ""], flags } = parse(2, ["--body"]);
    return { action, docId, threadId: identifier(threadId, THREAD_ID), body: text("--body", flags.get("--body"), COMMENT_LIMITS.body, true, trimmed) ?? "" };
  }
  if (action === "resolve") {
    const { positional: [docId = "", threadId = ""], flags } = parse(2, ["--version"]);
    const atVersion = version(flags.get("--version"));
    return { action, docId, threadId: identifier(threadId, THREAD_ID), ...(atVersion === undefined ? {} : { version: atVersion }) };
  }
  if (action === "reopen") {
    const { positional: [docId = "", threadId = ""] } = parse(2, []);
    return { action, docId, threadId: identifier(threadId, THREAD_ID) };
  }
  if (action === "delete") {
    const { positional: [docId = "", commentId = ""] } = parse(2, []);
    return { action, docId, commentId: identifier(commentId, COMMENT_ID) };
  }
  if (action === "on" || action === "off") {
    const { positional: [docId = ""] } = parse(1, []);
    return { action, docId };
  }
  if (action === "name") {
    // The name is a positional that may contain spaces and any characters, so it
    // is read whole rather than by the flag parser.
    if (extra.length !== 1) throw new Error(HELP);
    const name = (extra[0] ?? "").trim();
    return { action, name: text("The display name", name, COMMENT_LIMITS.name, true, named) ?? "" };
  }
  throw new Error(HELP);
}

/** CLI entry point. */
/** @param {string[]} args */
export async function main(args) {
  const [command, argument, ...extra] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (!["install", "login", "account", "publish", "open", "share", "comments", "list", "get", "unshare", "tokens", "revoke"].includes(command)) {
    throw new Error(HELP);
  }
  const needsArgument = ["publish", "open", "share", "comments", "get", "unshare", "revoke"].includes(command);
  if ((extra.length && command !== "publish" && command !== "share" && command !== "comments") || (needsArgument && !argument) || (!needsArgument && argument && !(command === "account" && argument === "--open"))) {
    throw new Error(HELP);
  }
  const value = argument ?? "";
  if (command === "install") return install();
  const prepared = command === "publish" ? await preparePublish(value, extra) : undefined;
  const changes = command === "share" ? prepareShare(extra) : [];
  const comments = command === "comments" ? prepareComments(argument, extra) : undefined;

  const host = (process.env.OPENARTIFACTS_API_HOST ?? DEFAULT_HOST).replace(/\/$/, "");
  const directory = configDir();
  if (command === "login") {
    await login(host, directory);
    return;
  }

  const token = await credential(host, directory);
  const client = createClient({ host, token });
  if (command === "account" && !token.startsWith("oat_")) {
    throw new Error("This command needs an OpenArtifacts account token. Run `openartifacts login`; unset OPENARTIFACTS_TOKEN if it contains a license key.");
  }
  if (command === "account" && !argument) {
    const result = await client.account();
    console.log(JSON.stringify({ accountId: result.accountId, plan: result.plan,
      limits: { documents: result.limits.documents, pushesPerDay: result.limits.pushesPerDay, htmlBytes: result.limits.htmlBytes,
        ...(Number.isSafeInteger(result.limits.storageBytes) ? { storageBytes: result.limits.storageBytes } : {}),
        // The skill reads this to know whether to offer a private page.
        // The server leaves it out for a plan without private sharing; always print a boolean so a
        // missing key means a CLI older than the skill, not a free plan.
        privateSharing: result.limits.privateSharing === true },
      usage: { documents: result.usage.documents, pushesToday: result.usage.pushesToday,
        ...(Number.isSafeInteger(result.usage.storedBytes) ? { storedBytes: result.usage.storedBytes } : {}) }, externalLinked: result.externalLinked,
      refresh: { status: result.refresh.status, checkedAt: result.refresh.checkedAt, expiresAt: result.refresh.expiresAt } }));
    return;
  }
  if (command === "account") {
    const result = await client.createHandoff();
    const url = new URL(result.url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || url.href.includes(token) ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      !/^[0-9a-f]{64}$/.test(url.searchParams.get("code") ?? "") ||
      !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) {
      throw new Error("The server returned an invalid account action link.");
    }
    console.log(JSON.stringify({ url: url.toString(), expiresAt: result.expiresAt }));
    openBrowser(url.toString());
    return;
  }

  if (command === "open") {
    await openOwnPage(client, value);
  } else if (prepared) {
    try {
      const { published, viaPrivateRoute } = prepared.docId
        ? { published: await client.updateDoc(prepared.docId, prepared.body), viaPrivateRoute: false }
        : await createPage(client, prepared.access, prepared.body);
      // A 201 from the private route proves the server has the share page, and the
      // skill ends its report with this url even when the user named nobody.
      console.log(JSON.stringify(viaPrivateRoute
        ? { ...published, manageUrl: manageUrl(host, published.docId) }
        : published));
    } catch (error) {
      if (prepared.docId && error instanceof APIError && error.status === 404) {
        error.message += ` No document ${prepared.docId} is in this account. Publish without --doc-id to create a new document.`;
      }
      // A Worker that predates private sharing, and one without reader sign-in,
      // both answer 404 and create nothing. There is no fallback to a public page.
      if (prepared.access === "private" && error instanceof APIError && error.status === 404) {
        throw new Error("This server does not support private documents. Nothing was published.");
      }
      if (prepared.access === "private" && error instanceof APIError && error.status === 402 && error.detail.limit === "privateSharing") {
        error.message += " Nothing was published. To publish a new page for anyone with the link instead, add --public.";
      }
      throw error;
    }
  } else if (command === "share") {
    try {
      let access;
      for (const [change, target, role] of changes) {
        access = change === "link"
          ? await client.setLinkAccess(value, /** @type {"anyone" | "invited"} */ (target))
          : change === "add" ? await client.addPerson(value, target, role)
            : change === "remove" ? await client.removePerson(value, target)
              : await client.declineRequest(value, target);
      }
      access ??= await client.getAccess(value);
      console.log(JSON.stringify({ ...access, manageUrl: manageUrl(host, value) }, null, 2));
    } catch (error) {
      // Not yours, deleted, an older Worker and a server without reader sign-in all
      // answer 404, and the CLI cannot tell them apart.
      if (error instanceof APIError && error.status === 404) {
        error.message = "Not found, or this server does not support private documents.";
      }
      throw error;
    }
  } else if (comments) {
    try {
      await runComments(client, comments);
    } catch (error) {
      // Not yours to read, deleted, comments off for a non-owner, and a server that
      // predates comments all answer 404, and the CLI cannot tell them apart.
      if (error instanceof APIError && error.status === 404) {
        // `name` has no document: its 404 is either a missing route (a server without comments) or the
        // server's own "no account to name, sign in to link one", which the user must be told.
        if (comments.action !== "name") error.message = "Not found, or this server does not support comments.";
        else if (!/Sign in to link/.test(error.message)) error.message = "This server does not support comments.";
      }
      throw error;
    }
  } else if (command === "list") {
    console.log(JSON.stringify(await client.listDocs(), null, 2));
  } else if (command === "get") {
    try {
      process.stdout.write(await client.getHtml(value));
    } catch (error) {
      if (error instanceof APIError && error.status === 404) {
        error.message = `No document ${value} is in this account.`;
      }
      throw error;
    }
  } else if (command === "unshare") {
    await client.unshare(value);
    console.log(`Unshared ${value}.`);
  } else if (command === "tokens") {
    console.log(JSON.stringify((await client.listTokens()).tokens, null, 2));
  } else if (command === "revoke") {
    const result = await client.revoke(value);
    const credentialsPath = join(directory, "credentials.json");
    const credentials = await readJson(
      credentialsPath,
      /** @type {Credentials} */ ({ hosts: {} }),
    );
    if (credentials.hosts?.[host]?.tokenId === value) {
      delete credentials.hosts[host];
      await writePrivateJson(credentialsPath, credentials);
    }
    console.log(result ? JSON.stringify(result) : `Token ${value} is already absent.`);
  } else {
    throw new Error(HELP);
  }
}

/**
 * Create a new page. `--public` and `--private` name their route and never fall
 * back. With no flag the page starts private, because a page that was ever
 * public may already have been copied by whoever saw it and a later switch
 * cannot recall those copies; it starts public only where private is not on
 * offer: a plan without private sharing (`402 limit_reached`, `limit:
 * "privateSharing"`) or a server with no private documents (`404` from the
 * private route, after which nothing exists). Any other failure stays a failure.
 * @param {ReturnType<typeof createClient>} client @param {"private" | "public" | "default"} access
 * @param {{title?: string, html: string}} body
 */
async function createPage(client, access, body) {
  if (access === "public") return { published: await client.createDoc(body), viaPrivateRoute: false };
  try {
    return { published: await client.createPrivateDoc(body), viaPrivateRoute: true };
  } catch (error) {
    const unavailable = error instanceof APIError &&
      (error.status === 404 || (error.status === 402 && error.code === "limit_reached" && error.detail.limit === "privateSharing"));
    if (access === "private" || !unavailable) throw error;
    return { published: await client.createDoc(body), viaPrivateRoute: false };
  }
}

/**
 * Open the owner's own page in the browser. The url the server returns is a
 * 60-second grant that signs the owner in, so it goes to the browser and is
 * never printed: agent wrappers print command output into transcripts.
 * @param {ReturnType<typeof createClient>} client @param {string} docId
 */
async function openOwnPage(client, docId) {
  let opened;
  try {
    opened = await client.openDoc(docId);
  } catch (error) {
    if (error instanceof APIError && error.status === 404) {
      error.message = `No document ${docId} is in this account, or this server cannot open it.`;
    }
    throw error;
  }
  /** @type {URL | undefined} */
  let url;
  try {
    url = new URL(opened.url);
  } catch {}
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url?.hostname ?? "");
  if (!url || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("The server returned an invalid page link.");
  }
  if (!(await openBrowser(url.toString()))) {
    throw new Error(`Could not start a browser to open ${docId}. Open the page from its share page instead.`);
  }
  console.log(JSON.stringify({ opened: true, docId }));
}

/**
 * Run one prepared `comments` request and print its result: the server's JSON
 * for everything that returns a body, a sentence for the delete that returns none.
 * @param {ReturnType<typeof createClient>} client @param {CommentsRequest} request
 */
async function runComments(client, request) {
  const print = (/** @type {unknown} */ result) => console.log(JSON.stringify(result, null, 2));
  if (request.action === "list") {
    print(await client.listThreads(request.docId, { state: request.state, since: request.since }));
  } else if (request.action === "add") {
    print(await client.addThread(request.docId, request.body));
  } else if (request.action === "reply") {
    print(await client.replyToThread(request.docId, request.threadId, request.body));
  } else if (request.action === "resolve") {
    print(await client.resolveThread(request.docId, request.threadId, request.version));
  } else if (request.action === "reopen") {
    print(await client.reopenThread(request.docId, request.threadId));
  } else if (request.action === "delete") {
    await client.deleteComment(request.docId, request.commentId);
    console.log(`Deleted ${request.commentId}.`);
  } else if (request.action === "name") {
    print(await client.setDisplayName(request.name));
  } else {
    print(await client.setComments(request.docId, request.action === "on"));
  }
}

/** Print API errors without ever exposing a credential. */
/** @param {unknown} error */
export function presentError(error) {
  if (error instanceof APIError) {
    console.error(error.message);
    if (error.status === 401) console.error("Run `openartifacts login` to sign in again.");
    if (error.code === "quota_exceeded") {
      console.error("Wait for the current quota window to reset before retrying.");
    }
    if (error.code === "limit_reached") {
      if (error.detail.limit) console.error(`Limit: ${error.detail.limit}`);
      if (error.detail.limit === "comments") {
        console.error("Comments need a paid plan on the document owner's account, or the document has reached its thread or comment cap.");
      }
      if (error.detail.upgrade_url) console.error(`Upgrade: ${error.detail.upgrade_url}`);
    }
    if (error.code === "anchor_not_found") {
      console.error("The quote is not in that version of the page. Copy it exactly from `openartifacts get <docId>`, as visible text without tags, and add --prefix or --suffix if it is ambiguous.");
    }
    if (error.code === "comments_off") {
      console.error("Comments are off for this document. Turn them on with `openartifacts comments on <docId>`.");
    }
    if (error.code === "name_required") {
      console.error("Set a display name first with `openartifacts comments name \"<name>\"`.");
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
