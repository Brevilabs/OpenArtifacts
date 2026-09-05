import { access, chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { APIError, createClient } from "./client.js";

const DEFAULT_HOST = "https://api.openartifacts.ai";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_SOURCE = join(PACKAGE_ROOT, "skill", "openartifacts", "SKILL.md");
/** @typedef {{name: string, detected: boolean, target: string}} DetectedAgent */
/** @typedef {{files: Record<string, {docId: string, url: string}>}} PublishState */
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
      target: join(agent.root, "skills", "openartifacts", "SKILL.md"),
    });
  }
  return found;
}

/** Copy the package's one shared skill into every detected agent.
 * @param {DetectedAgent[]} agents @param {string} [source]
 */
export async function installSkills(agents, source = SKILL_SOURCE) {
  for (const agent of agents) {
    if (!agent.detected) continue;
    await mkdir(dirname(agent.target), { recursive: true });
    await copyFile(source, agent.target);
  }
}

/** @param {string} file */
export async function renderFile(file) {
  const extension = extname(file).toLowerCase();
  if (![".md", ".markdown", ".html", ".htm"].includes(extension)) {
    throw new Error("Publish a Markdown (.md, .markdown) or HTML (.html, .htm) file.");
  }
  const source = await readFile(file, "utf8");
  if ([".html", ".htm"].includes(extension)) return source;
  const title = basename(file, extname(file));
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title><style>body{max-width:48rem;margin:3rem auto;padding:0 1rem;font:18px/1.6 system-ui;color:#222}img{max-width:100%}pre{overflow:auto;padding:1rem;background:#f5f5f5}code{font-family:ui-monospace,monospace}</style></head><body>${marked.parse(source)}</body></html>`;
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

/** @param {string} url */
function openBrowser(url) {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
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
  await installSkills(agents, join(installedRoot, "skill", "openartifacts", "SKILL.md"));
  for (const agent of agents) {
    console.log(`${agent.name}: ${agent.detected ? `installed ${agent.target}` : "not detected"}`);
  }
}

const HELP = `Usage: openartifacts <command> [argument]

Commands:
  install            Install or upgrade the CLI and detected agent skills
  login              Approve this machine and store its token
  preview <file>     Print rendered HTML locally without publishing or signing in
  publish <file>     Publish Markdown or HTML; repeat to update the same document
  list               List published documents
  get <docId>        Print a document's current HTML
  unshare <docId>    Withdraw a public document
  tokens             List this account's machine tokens
  revoke <tokenId>   Revoke a machine token`;

/** CLI entry point. */
/** @param {string[]} args */
export async function main(args) {
  const [command, argument, ...extra] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (!["install", "login", "preview", "publish", "list", "get", "unshare", "tokens", "revoke"].includes(command)) {
    throw new Error(HELP);
  }
  const needsArgument = ["preview", "publish", "get", "unshare", "revoke"].includes(command);
  if (extra.length || (needsArgument && !argument) || (!needsArgument && argument)) {
    throw new Error(HELP);
  }
  const value = argument ?? "";
  if (command === "install") return install();
  if (command === "preview") {
    process.stdout.write(await renderFile(await realpath(resolve(value))));
    return;
  }

  const host = (process.env.OPENARTIFACTS_API_HOST ?? DEFAULT_HOST).replace(/\/$/, "");
  const directory = configDir();
  if (command === "login") {
    await login(host, directory);
    return;
  }

  /** @type {{file: string, body: {title: string, html: string}} | undefined} */
  let preparedPublish;
  if (command === "publish") {
    const file = await realpath(resolve(value));
    preparedPublish = {
      file,
      body: { title: basename(file, extname(file)), html: await renderFile(file) },
    };
  }

  const token = await credential(host, directory);
  const client = createClient({ host, token });

  if (command === "publish") {
    if (!preparedPublish) throw new Error("Publish input was not prepared.");
    const { file, body } = preparedPublish;
    const fileKey = `${host}\n${file}`;
    const statePath = join(directory, "state.json");
    const state = await readJson(statePath, /** @type {PublishState} */ ({ files: {} }));
    const previous = state.files[fileKey];
    let published;
    try {
      published = previous ? await client.updateDoc(previous.docId, body) : await client.createDoc(body);
    } catch (error) {
      if (previous && error instanceof APIError && error.status === 404) {
        error.message += ` To intentionally replace it, run \`openartifacts unshare ${previous.docId}\`, then publish again.`;
      }
      throw error;
    }
    state.files[fileKey] = { docId: published.docId, url: published.url };
    await writePrivateJson(statePath, state);
    console.log(published.url);
  } else if (command === "list") {
    console.log(JSON.stringify(await client.listDocs(), null, 2));
  } else if (command === "get") {
    const doc = (await client.listDocs()).find((item) => item.docId === value);
    if (!doc) throw new Error(`No document with id ${value} is in this account.`);
    process.stdout.write(await client.readDocument(doc.url));
  } else if (command === "unshare") {
    await client.unshare(value);
    const statePath = join(directory, "state.json");
    const state = await readJson(statePath, /** @type {PublishState} */ ({ files: {} }));
    for (const [fileKey, entry] of Object.entries(state.files)) {
      if (fileKey.startsWith(`${host}\n`) && entry.docId === value) delete state.files[fileKey];
    }
    await writePrivateJson(statePath, state);
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
      if (error.detail.upgrade_url) console.error(`Upgrade: ${error.detail.upgrade_url}`);
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
}
