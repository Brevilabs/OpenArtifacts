import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectToken, configDir, detectAgents, installSkills, main, npmProcess, presentError, renderFile } from "../src/cli.js";
import { APIError } from "../src/client.js";

test("uses each platform's user config directory", () => {
  assert.equal(configDir("darwin", "/home/me", {}), "/home/me/Library/Application Support/openartifacts");
  assert.equal(configDir("linux", "/home/me", {}), "/home/me/.config/openartifacts");
  assert.equal(configDir("linux", "/home/me", { XDG_CONFIG_HOME: "/xdg" }), "/xdg/openartifacts");
  assert.equal(configDir("win32", "C:\\Users\\me", { APPDATA: "C:\\AppData" }), "C:\\AppData/openartifacts");
});

test("runs npm.cmd through the Windows command processor", () => {
  assert.deepEqual(npmProcess("win32"), { command: "npm.cmd", shell: true });
  assert.deepEqual(npmProcess("linux"), { command: "npm", shell: false });
});

test("rejects an unknown command before authentication", async () => {
  await assert.rejects(main(["unknown"]), /Usage: openartifacts/);
});

test("detects configured agents and installs the same skill into each", async () => {
  const home = await mkdtemp(join(tmpdir(), "openartifacts-agents-"));
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".codex"));
  const source = join(home, "SKILL.md");
  await writeFile(source, "shared skill\n");
  const agents = await detectAgents(home, { PATH: "" });
  assert.deepEqual(agents.filter((agent) => agent.detected).map((agent) => agent.name), ["Claude Code", "Codex"]);
  await installSkills(agents, source);
  for (const agent of agents.filter((item) => item.detected)) {
    assert.equal(await readFile(agent.target, "utf8"), "shared skill\n");
  }
  await writeFile(source, "upgraded skill\n");
  await installSkills(agents, source);
  for (const agent of agents.filter((item) => item.detected)) {
    assert.equal(await readFile(agent.target, "utf8"), "upgraded skill\n");
  }
});

test("honours agent-specific config roots", async () => {
  const home = await mkdtemp(join(tmpdir(), "openartifacts-roots-"));
  const agents = await detectAgents(home, {
    PATH: "",
    CLAUDE_CONFIG_DIR: join(home, "claude-home"),
    CODEX_HOME: join(home, "codex-home"),
    PI_CODING_AGENT_DIR: join(home, "pi-home"),
    XDG_CONFIG_HOME: join(home, "xdg"),
  });
  const targets = Object.fromEntries(agents.map((agent) => [agent.name, agent.target]));
  assert.equal(targets["Claude Code"], join(home, "claude-home", "skills", "openartifacts", "SKILL.md"));
  assert.equal(targets.Codex, join(home, "codex-home", "skills", "openartifacts", "SKILL.md"));
  assert.equal(targets.OpenCode, join(home, "xdg", "opencode", "skills", "openartifacts", "SKILL.md"));
  assert.equal(targets.pi, join(home, "pi-home", "skills", "openartifacts", "SKILL.md"));
});

test("installer fetches latest and copies its newly installed skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-install-"));
  const bin = join(directory, "bin");
  const globalRoot = join(directory, "global", "node_modules");
  const installedRoot = join(globalRoot, "@brevilabs", "openartifacts");
  const calls = join(directory, "npm-calls.jsonl");
  await mkdir(bin, { recursive: true });
  await mkdir(join(installedRoot, "skill", "openartifacts"), { recursive: true });
  await writeFile(join(installedRoot, "package.json"), JSON.stringify({
    name: "@brevilabs/openartifacts",
    version: "0.2.0",
  }));
  await writeFile(join(installedRoot, "skill", "openartifacts", "SKILL.md"), "latest skill\n");
  const fakeNpm = join(bin, "npm");
  await writeFile(fakeNpm, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");\nif (args[0] === "root") console.log(${JSON.stringify(globalRoot)});\n`);
  await chmod(fakeNpm, 0o755);

  const variables = ["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME"];
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  process.env.PATH = bin;
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
  process.env.CODEX_HOME = join(directory, "codex");
  process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
  process.env.XDG_CONFIG_HOME = join(directory, "xdg");
  const originalLog = console.log;
  console.log = () => {};
  try {
    await main(["install"]);
  } finally {
    console.log = originalLog;
    for (const [name, value] of Object.entries(previous)) {
      value === undefined ? delete process.env[name] : process.env[name] = value;
    }
  }

  const npmCalls = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(npmCalls, [
    ["install", "--global", "@brevilabs/openartifacts@latest"],
    ["root", "--global"],
  ]);
  for (const root of ["claude", "codex", "pi"]) {
    assert.equal(await readFile(join(directory, root, "skills", "openartifacts", "SKILL.md"), "utf8"), "latest skill\n");
  }
});

test("keeps HTML verbatim and renders plain Markdown locally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-render-"));
  const html = join(directory, "page.html");
  const markdown = join(directory, "notes.md");
  await writeFile(html, "<!doctype html><p>kept</p>");
  await writeFile(markdown, "# Heading\n\nHello **world**.");
  assert.equal(await renderFile(html), "<!doctype html><p>kept</p>");
  assert.match(await renderFile(markdown), /<h1>Heading<\/h1>[\s\S]*<strong>world<\/strong>/);
  await assert.rejects(renderFile(join(directory, "notes.txt")), /Markdown.*or HTML/);
});

test("validates a publish file before authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-invalid-"));
  const text = join(directory, "notes.txt");
  await writeFile(text, "not publishable");
  const previous = {
    config: process.env.OPENARTIFACTS_CONFIG_DIR,
    host: process.env.OPENARTIFACTS_API_HOST,
    token: process.env.OPENARTIFACTS_TOKEN,
  };
  process.env.OPENARTIFACTS_CONFIG_DIR = join(directory, "config");
  process.env.OPENARTIFACTS_API_HOST = "http://127.0.0.1:1";
  delete process.env.OPENARTIFACTS_TOKEN;
  try {
    await assert.rejects(main(["publish", text]), /Markdown.*or HTML/);
  } finally {
    for (const [name, value] of [
      ["OPENARTIFACTS_CONFIG_DIR", previous.config],
      ["OPENARTIFACTS_API_HOST", previous.host],
      ["OPENARTIFACTS_TOKEN", previous.token],
    ]) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test("device polling handles pending, slow down, denial, and expiry", async () => {
  const minted = { device_code: "device", interval: 1, expires_in: 60 };
  const pendingWaits = [];
  let pendingCalls = 0;
  const pendingResult = await collectToken(
    {
      deviceToken: async () => {
        pendingCalls += 1;
        if (pendingCalls === 1) throw new APIError(400, { error: { code: "authorization_pending" } });
        return { access_token: "opaque", token_id: "token" };
      },
    },
    minted,
    { wait: async (milliseconds) => pendingWaits.push(milliseconds) },
  );
  assert.equal(pendingResult.access_token, "opaque");
  assert.deepEqual(pendingWaits, [1000]);

  const slowWaits = [];
  let slowCalls = 0;
  await collectToken(
    {
      deviceToken: async () => {
        slowCalls += 1;
        if (slowCalls === 1) throw new APIError(400, { error: { code: "slow_down" } });
        return { access_token: "opaque", token_id: "token" };
      },
    },
    minted,
    { wait: async (milliseconds) => slowWaits.push(milliseconds) },
  );
  assert.deepEqual(slowWaits, [6000]);

  await assert.rejects(
    collectToken(
      { deviceToken: async () => { throw new APIError(400, { error: { code: "access_denied" } }); } },
      minted,
    ),
    (error) => error instanceof APIError && error.code === "access_denied",
  );

  const times = [0, 0, 1000];
  await assert.rejects(
    collectToken(
      { deviceToken: async () => { throw new APIError(400, { error: { code: "authorization_pending" } }); } },
      { ...minted, expires_in: 1 },
      { wait: async () => {}, now: () => times.shift() ?? 1000 },
    ),
    /approval code expired/,
  );
});

test("prints guidance for current quota and future plan limits", () => {
  const lines = [];
  const previous = console.error;
  console.error = (...parts) => lines.push(parts.join(" "));
  try {
    presentError(new APIError(429, { error: { code: "quota_exceeded", message: "Quota reached." } }));
    presentError(new APIError(402, {
      error: {
        code: "limit_reached",
        message: "Plan limit reached.",
        limit: "10 documents",
        upgrade_url: "https://example.test/upgrade",
      },
    }));
  } finally {
    console.error = previous;
  }
  assert(lines.some((line) => line.includes("quota window")));
  assert(lines.includes("Limit: 10 documents"));
  assert(lines.includes("Upgrade: https://example.test/upgrade"));
});

async function publishingServer() {
  const methods = [];
  const control = { staleUpdates: false, missingDeletes: false };
  const server = createServer((request, response) => {
    methods.push(request.method);
    response.setHeader("content-type", "application/json");
    if (request.method === "PUT" && control.staleUpdates) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found", message: "Document not found." } }));
      return;
    }
    if (request.method === "DELETE" && control.missingDeletes) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found", message: "Document not found." } }));
      return;
    }
    response.end(JSON.stringify({
      docId: "9f2k4mvq7t0xbz3n",
      url: `http://${request.headers.host}/d/9f2k4mvq7t0xbz3n`,
      version: methods.length,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, methods, control, host: `http://127.0.0.1:${address.port}` };
}

test("repeat publish updates per API host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-state-"));
  const markdown = join(directory, "notes.md");
  await writeFile(markdown, "# One");
  const first = await publishingServer();
  const second = await publishingServer();
  const previous = {
    config: process.env.OPENARTIFACTS_CONFIG_DIR,
    host: process.env.OPENARTIFACTS_API_HOST,
    token: process.env.OPENARTIFACTS_TOKEN,
    log: console.log,
  };
  process.env.OPENARTIFACTS_CONFIG_DIR = join(directory, "config");
  process.env.OPENARTIFACTS_TOKEN = "opaque-test-token";
  console.log = () => {};
  try {
    process.env.OPENARTIFACTS_API_HOST = first.host;
    await main(["publish", markdown]);
    await main(["publish", markdown]);
    process.env.OPENARTIFACTS_API_HOST = second.host;
    await main(["publish", markdown]);
    process.env.OPENARTIFACTS_API_HOST = first.host;
    await main(["unshare", "9f2k4mvq7t0xbz3n"]);
    process.env.OPENARTIFACTS_API_HOST = second.host;
    await main(["publish", markdown]);
  } finally {
    console.log = previous.log;
    for (const [name, value] of [
      ["OPENARTIFACTS_CONFIG_DIR", previous.config],
      ["OPENARTIFACTS_API_HOST", previous.host],
      ["OPENARTIFACTS_TOKEN", previous.token],
    ]) value === undefined ? delete process.env[name] : process.env[name] = value;
    first.server.close();
    second.server.close();
  }
  assert.deepEqual(first.methods, ["POST", "PUT", "DELETE"]);
  assert.deepEqual(second.methods, ["POST", "PUT"]);
});

test("a stale publish mapping requires explicit replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-stale-"));
  const markdown = join(directory, "notes.md");
  await writeFile(markdown, "# One");
  const remote = await publishingServer();
  const previous = {
    config: process.env.OPENARTIFACTS_CONFIG_DIR,
    host: process.env.OPENARTIFACTS_API_HOST,
    token: process.env.OPENARTIFACTS_TOKEN,
    log: console.log,
  };
  process.env.OPENARTIFACTS_CONFIG_DIR = join(directory, "config");
  process.env.OPENARTIFACTS_API_HOST = remote.host;
  process.env.OPENARTIFACTS_TOKEN = "opaque-test-token";
  console.log = () => {};
  try {
    await main(["publish", markdown]);
    remote.control.staleUpdates = true;
    await assert.rejects(
      main(["publish", markdown]),
      /openartifacts unshare 9f2k4mvq7t0xbz3n/,
    );
    remote.control.missingDeletes = true;
    await main(["unshare", "9f2k4mvq7t0xbz3n"]);
    remote.control.staleUpdates = false;
    await main(["publish", markdown]);
  } finally {
    console.log = previous.log;
    for (const [name, value] of [
      ["OPENARTIFACTS_CONFIG_DIR", previous.config],
      ["OPENARTIFACTS_API_HOST", previous.host],
      ["OPENARTIFACTS_TOKEN", previous.token],
    ]) value === undefined ? delete process.env[name] : process.env[name] = value;
    remote.server.close();
  }
  assert.deepEqual(remote.methods, ["POST", "PUT", "DELETE", "POST"]);
});
