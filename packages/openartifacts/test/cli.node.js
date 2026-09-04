import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configDir, detectAgents, installSkills, main, renderFile } from "../src/cli.js";

test("uses each platform's user config directory", () => {
  assert.equal(configDir("darwin", "/home/me", {}), "/home/me/Library/Application Support/openartifacts");
  assert.equal(configDir("linux", "/home/me", {}), "/home/me/.config/openartifacts");
  assert.equal(configDir("linux", "/home/me", { XDG_CONFIG_HOME: "/xdg" }), "/xdg/openartifacts");
  assert.equal(configDir("win32", "C:\\Users\\me", { APPDATA: "C:\\AppData" }), "C:\\AppData/openartifacts");
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

async function publishingServer() {
  const methods = [];
  const server = createServer((request, response) => {
    methods.push(request.method);
    response.setHeader("content-type", "application/json");
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
  return { server, methods, host: `http://127.0.0.1:${address.port}` };
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
  assert.deepEqual(first.methods, ["POST", "PUT"]);
  assert.deepEqual(second.methods, ["POST"]);
});
