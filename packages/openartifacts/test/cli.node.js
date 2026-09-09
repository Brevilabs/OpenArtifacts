import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectToken, configDir, detectAgents, installSkills, main, npmProcess, preparePublish, presentError } from "../src/cli.js";
import { APIError } from "../src/client.js";

/** Point the CLI at a scratch config directory and host for one test. */
async function withEnvironment(values, run) {
  const names = ["OPENARTIFACTS_CONFIG_DIR", "OPENARTIFACTS_API_HOST", "OPENARTIFACTS_TOKEN"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  for (const name of names) {
    values[name] === undefined ? delete process.env[name] : process.env[name] = values[name];
  }
  try {
    await run(lines);
  } finally {
    console.log = log;
    for (const [name, value] of Object.entries(previous)) {
      value === undefined ? delete process.env[name] : process.env[name] = value;
    }
  }
}

async function writeSkillSource(directory, marker) {
  const source = join(directory, "skill");
  await mkdir(join(source, "themes"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), `${marker} skill\n`);
  await writeFile(join(source, "themes", "research-memo.md"), `${marker} theme\n`);
  return source;
}

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

test("rejects unknown commands and malformed arguments before authentication", async () => {
  await assert.rejects(main(["unknown"]), /Usage: openartifacts/);
  await assert.rejects(main(["list", "extra"]), /Usage: openartifacts/);
  await assert.rejects(main(["unshare"]), /Usage: openartifacts/);
  await assert.rejects(main(["publish"]), /Usage: openartifacts/);
  await assert.rejects(main(["preview", "page.html"]), /Usage: openartifacts/);
});

test("detects configured agents and installs the skill directory into each", async () => {
  const home = await mkdtemp(join(tmpdir(), "openartifacts-agents-"));
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".codex"));
  const source = await writeSkillSource(home, "shared");
  const agents = await detectAgents(home, { PATH: "" });
  assert.deepEqual(agents.filter((agent) => agent.detected).map((agent) => agent.name), ["Claude Code", "Codex"]);
  await installSkills(agents, source);
  for (const agent of agents.filter((item) => item.detected)) {
    assert.equal(await readFile(join(agent.target, "SKILL.md"), "utf8"), "shared skill\n");
    assert.equal(await readFile(join(agent.target, "themes", "research-memo.md"), "utf8"), "shared theme\n");
  }
  await writeFile(join(source, "SKILL.md"), "upgraded skill\n");
  await installSkills(agents, source);
  for (const agent of agents.filter((item) => item.detected)) {
    assert.equal(await readFile(join(agent.target, "SKILL.md"), "utf8"), "upgraded skill\n");
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
  assert.equal(targets["Claude Code"], join(home, "claude-home", "skills", "openartifacts"));
  assert.equal(targets.Codex, join(home, "codex-home", "skills", "openartifacts"));
  assert.equal(targets.OpenCode, join(home, "xdg", "opencode", "skills", "openartifacts"));
  assert.equal(targets.pi, join(home, "pi-home", "skills", "openartifacts"));
});

test("installer fetches latest and copies its newly installed skill and themes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-install-"));
  const bin = join(directory, "bin");
  const globalRoot = join(directory, "global", "node_modules");
  const installedRoot = join(globalRoot, "openartifacts");
  const calls = join(directory, "npm-calls.jsonl");
  await mkdir(bin, { recursive: true });
  await mkdir(join(installedRoot, "skill", "openartifacts", "themes"), { recursive: true });
  await writeFile(join(installedRoot, "package.json"), JSON.stringify({ name: "openartifacts", version: "0.2.2" }));
  await writeFile(join(installedRoot, "skill", "openartifacts", "SKILL.md"), "latest skill\n");
  await writeFile(join(installedRoot, "skill", "openartifacts", "themes", "research-memo.md"), "latest theme\n");
  const fakeNpm = join(bin, "npm");
  await writeFile(fakeNpm, `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");\nif (args[0] === "root") console.log(${JSON.stringify(globalRoot)});\n`);
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
    ["install", "--global", "openartifacts@latest"],
    ["root", "--global"],
  ]);
  for (const root of ["claude", "codex", "pi"]) {
    assert.equal(await readFile(join(directory, root, "skills", "openartifacts", "SKILL.md"), "utf8"), "latest skill\n");
    assert.equal(await readFile(join(directory, root, "skills", "openartifacts", "themes", "research-memo.md"), "utf8"), "latest theme\n");
  }
});

test("the shipped skill directory carries the skill and the research-memo theme", async () => {
  const skill = new URL("../skill/openartifacts/", import.meta.url);
  assert.match(await readFile(new URL("SKILL.md", skill), "utf8"), /end your turn/i);
  assert.deepEqual(await readdir(new URL("themes/", skill)), ["research-memo.md"]);
});

test("publish reads only HTML files and parses its options before authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-prepare-"));
  const page = join(directory, "My Page.html");
  const markdown = join(directory, "notes.md");
  await writeFile(page, "<!doctype html><p>kept</p>");
  await writeFile(markdown, "# Not rendered here");
  assert.deepEqual(await preparePublish(page, []), {
    docId: undefined,
    body: { title: "My Page", html: "<!doctype html><p>kept</p>" },
  });
  assert.deepEqual(await preparePublish(page, ["--doc-id", "9f2k4mvq7t0xbz3n", "--title", "Notes"]), {
    docId: "9f2k4mvq7t0xbz3n",
    body: { title: "Notes", html: "<!doctype html><p>kept</p>" },
  });
  // An update without --title omits the field so the server keeps the current title.
  assert.deepEqual(await preparePublish(page, ["--doc-id", "9f2k4mvq7t0xbz3n"]), {
    docId: "9f2k4mvq7t0xbz3n",
    body: { html: "<!doctype html><p>kept</p>" },
  });
  await assert.rejects(preparePublish(markdown, []), /HTML file.*Render other formats/);
  await assert.rejects(preparePublish(page, ["--title"]), /Usage: openartifacts/);
  await assert.rejects(preparePublish(page, ["--title", "--doc-id"]), /Usage: openartifacts/);
  await assert.rejects(preparePublish(page, ["--title", "a", "--title", "b"]), /Usage: openartifacts/);
  await assert.rejects(preparePublish(page, ["--unknown", "x"]), /Usage: openartifacts/);
  // A blank id must not silently turn an update into a create.
  await assert.rejects(preparePublish(page, ["--doc-id", ""]), /Usage: openartifacts/);
  await assert.rejects(preparePublish(page, ["--title", ""]), /Usage: openartifacts/);
  await assert.rejects(preparePublish(join(directory, "missing.html"), []), { code: "ENOENT" });

  await withEnvironment({
    OPENARTIFACTS_CONFIG_DIR: join(directory, "config"),
    OPENARTIFACTS_API_HOST: "http://127.0.0.1:1",
  }, async () => {
    await assert.rejects(main(["publish", markdown]), /HTML file/);
    await assert.rejects(readdir(join(directory, "config")), { code: "ENOENT" });
  });
});

async function publishingServer() {
  const requests = [];
  const control = { staleUpdates: false, missingDeletes: false };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      });
      response.setHeader("content-type", "application/json");
      if ((request.method === "PUT" && control.staleUpdates) || (request.method === "DELETE" && control.missingDeletes)) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: { code: "not_found", message: "Document not found." } }));
        return;
      }
      if (request.method === "DELETE") {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = request.method === "POST" ? 201 : 200;
      response.end(JSON.stringify({
        docId: "9f2k4mvq7t0xbz3n",
        url: `http://${request.headers.host}/d/9f2k4mvq7t0xbz3n`,
        version: requests.length,
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, requests, control, host: `http://127.0.0.1:${address.port}` };
}

test("publish creates, --doc-id updates, and unshare withdraws using the environment token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-publish-"));
  const page = join(directory, "notes.html");
  const html = '<!doctype html><style>p::before{content:"\\00b7"}</style><p>Kept</p>';
  await writeFile(page, html);
  const remote = await publishingServer();
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: join(directory, "config"),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async (lines) => {
      await main(["publish", page, "--title", "Notes"]);
      await main(["publish", page, "--doc-id", "9f2k4mvq7t0xbz3n"]);
      await main(["unshare", "9f2k4mvq7t0xbz3n"]);
      assert.deepEqual(lines, [
        JSON.stringify({ docId: "9f2k4mvq7t0xbz3n", url: `${remote.host}/d/9f2k4mvq7t0xbz3n`, version: 1 }),
        JSON.stringify({ docId: "9f2k4mvq7t0xbz3n", url: `${remote.host}/d/9f2k4mvq7t0xbz3n`, version: 2 }),
        "Unshared 9f2k4mvq7t0xbz3n.",
      ]);
      // The CLI keeps no publish state; only a credential file could ever exist here.
      await assert.rejects(readdir(join(directory, "config")), { code: "ENOENT" });
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(remote.requests.map(({ method, path }) => [method, path]), [
    ["POST", "/api/v1/docs"],
    ["PUT", "/api/v1/docs/9f2k4mvq7t0xbz3n"],
    ["DELETE", "/api/v1/docs/9f2k4mvq7t0xbz3n"],
  ]);
  assert(remote.requests.every((request) => request.authorization === "Bearer opaque-test-token"));
  assert.deepEqual(remote.requests[0].body, { title: "Notes", html });
  assert.deepEqual(remote.requests[1].body, { html });
});

test("a stale --doc-id is reported, never silently replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-stale-"));
  const page = join(directory, "notes.html");
  await writeFile(page, "<p>One</p>");
  const remote = await publishingServer();
  remote.control.staleUpdates = true;
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: join(directory, "config"),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async () => {
      await assert.rejects(
        main(["publish", page, "--doc-id", "9f2k4mvq7t0xbz3n"]),
        (error) => error instanceof APIError && error.status === 404 && /without --doc-id to create a new document/.test(error.message),
      );
      remote.control.missingDeletes = true;
      await main(["unshare", "9f2k4mvq7t0xbz3n"]);
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(remote.requests.map((request) => request.method), ["PUT", "DELETE"]);
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
