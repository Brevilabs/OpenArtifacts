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

/** @param {string} url */
function openBrowser(url) {
  const opener = browserProcess(url);
  try {
    const child = spawn(opener.command, opener.args, { env: opener.env, shell: false, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
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
  publish <file.html> [--title <title>] [--doc-id <docId>]
                     Publish an HTML file; pass --doc-id to update an existing document
  list               List published documents
  get <docId>        Print a document's current HTML
  unshare <docId>    Withdraw a public document
  tokens             List this account's machine tokens
  revoke <tokenId>   Revoke a machine token`;

/**
 * Read the HTML file and the publish options before any authentication. A create
 * defaults the title to the file name; an update omits it so the server keeps the
 * current title unless --title was given.
 * @param {string} file @param {string[]} options
 * @returns {Promise<{docId?: string, body: {title?: string, html: string}}>}
 */
export async function preparePublish(file, options) {
  if (![".html", ".htm"].includes(extname(file).toLowerCase())) {
    throw new Error("Publish an HTML file (.html, .htm). Render other formats to HTML first.");
  }
  /** @type {{title?: string, docId?: string}} */
  const flags = {};
  for (let index = 0; index < options.length; index += 2) {
    const [flag, value] = [options[index], options[index + 1]];
    if (!value || value.startsWith("--")) throw new Error(HELP);
    if (flag === "--title" && flags.title === undefined) flags.title = value;
    else if (flag === "--doc-id" && flags.docId === undefined) flags.docId = value;
    else throw new Error(HELP);
  }
  const path = resolve(file);
  const html = await readFile(path, "utf8");
  const title = flags.title ?? (flags.docId ? undefined : basename(path, extname(path)));
  return { docId: flags.docId, body: title === undefined ? { html } : { title, html } };
}

/** CLI entry point. */
/** @param {string[]} args */
export async function main(args) {
  const [command, argument, ...extra] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (!["install", "login", "account", "publish", "list", "get", "unshare", "tokens", "revoke"].includes(command)) {
    throw new Error(HELP);
  }
  const needsArgument = ["publish", "get", "unshare", "revoke"].includes(command);
  if ((extra.length && command !== "publish") || (needsArgument && !argument) || (!needsArgument && argument && !(command === "account" && argument === "--open"))) {
    throw new Error(HELP);
  }
  const value = argument ?? "";
  if (command === "install") return install();
  const prepared = command === "publish" ? await preparePublish(value, extra) : undefined;

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
      limits: { documents: result.limits.documents, pushesPerDay: result.limits.pushesPerDay, htmlBytes: result.limits.htmlBytes },
      usage: { documents: result.usage.documents, pushesToday: result.usage.pushesToday }, externalLinked: result.externalLinked,
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

  if (prepared) {
    try {
      const published = prepared.docId
        ? await client.updateDoc(prepared.docId, prepared.body)
        : await client.createDoc(prepared.body);
      console.log(JSON.stringify(published));
    } catch (error) {
      if (prepared.docId && error instanceof APIError && error.status === 404) {
        error.message += ` No document ${prepared.docId} is in this account. Publish without --doc-id to create a new document.`;
      }
      throw error;
    }
  } else if (command === "list") {
    console.log(JSON.stringify(await client.listDocs(), null, 2));
  } else if (command === "get") {
    const doc = (await client.listDocs()).find((item) => item.docId === value);
    if (!doc) throw new Error(`No document with id ${value} is in this account.`);
    process.stdout.write(await client.readDocument(doc.url));
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
      console.error("Run `openartifacts account --open` to get a secure account upgrade link.");
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
