import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserProcess, collectToken, configDir, detectAgents, installSkills, main, npmProcess, prepareComments, preparePublish, prepareShare, presentError } from "../src/cli.js";
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
  assert.match(await readFile(new URL("SKILL.md", skill), "utf8"), /\[\/Users\/me\/My Notes\/café\.html\]\(file:\/\/\/Users\/me\/My%20Notes\/caf%C3%A9\.html\)/);
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
    access: "default",
    body: { title: "My Page", html: "<!doctype html><p>kept</p>" },
  });
  assert.deepEqual(await preparePublish(page, ["--doc-id", "9f2k4mvq7t0xbz3n", "--title", "Notes"]), {
    docId: "9f2k4mvq7t0xbz3n",
    access: "default",
    body: { title: "Notes", html: "<!doctype html><p>kept</p>" },
  });
  // An update without --title omits the field so the server keeps the current title.
  assert.deepEqual(await preparePublish(page, ["--doc-id", "9f2k4mvq7t0xbz3n"]), {
    docId: "9f2k4mvq7t0xbz3n",
    access: "default",
    body: { html: "<!doctype html><p>kept</p>" },
  });
  // --private and --public select a route; neither rides in the body.
  assert.deepEqual(await preparePublish(page, ["--private"]), {
    docId: undefined,
    access: "private",
    body: { title: "My Page", html: "<!doctype html><p>kept</p>" },
  });
  assert.deepEqual(await preparePublish(page, ["--public", "--title", "Open"]), {
    docId: undefined,
    access: "public",
    body: { title: "Open", html: "<!doctype html><p>kept</p>" },
  });
  await assert.rejects(preparePublish(page, ["--public", "--private"]), /--public and --private cannot be used together/);
  await assert.rejects(preparePublish(page, ["--public", "--doc-id", "9f2k4mvq7t0xbz3n"]), /share <docId> --link anyone/);
  await assert.rejects(preparePublish(page, ["--public", "--public"]), /Usage: openartifacts/);
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
  const control = { staleUpdates: false, missingDeletes: false, privateDocs: true, privatePlan: true, privateLimit: undefined, comments: true, unlinked: false, openUrl: undefined };
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
      const docId = "9f2k4mvq7t0xbz3n";
      const url = `http://${request.headers.host}/d/${docId}`;
      if (request.url.includes("/access")) {
        response.end(JSON.stringify({
          docId, url, linkAccess: "invited", email: true,
          people: [{ email: "alice@acme.com", role: "comment", addedAt: 1 }],
          requests: [{ email: "bob@other.com", requestedAt: 2 }],
        }));
        return;
      }
      // A license key with no linked account cannot name anyone.
      if (control.unlinked && request.method === "PUT" && request.url === "/api/v1/account") {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: { code: "not_found", message: "This credential has no account to name. Sign in to link one." } }));
        return;
      }
      // A Worker that predates comments has none of these routes.
      if (!control.comments && /\/(threads|comments|settings)|^\/api\/v1\/account$/.test(request.url.split("?")[0]) && request.method !== "GET") {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: { code: "not_found", message: "No API route." } }));
        return;
      }
      if (!control.comments && request.url.includes("/threads")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: { code: "not_found", message: "No API route." } }));
        return;
      }
      // A Worker that predates private sharing has no such route.
      if (request.url === "/api/v1/private-docs" && !control.privateDocs) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: { code: "not_found", message: "No API route for /api/v1/private-docs" } }));
        return;
      }
      // A plan without private sharing is refused before anything is created.
      if (request.url === "/api/v1/private-docs" && (!control.privatePlan || control.privateLimit)) {
        response.statusCode = 402;
        response.end(JSON.stringify({ error: { code: "limit_reached", message: "Private sharing needs a paid plan.", plan: "free", limit: control.privateLimit ?? "privateSharing" } }));
        return;
      }
      if (request.url.endsWith("/open")) {
        if (control.openUrl === null) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: { code: "not_found", message: "Document not found." } }));
        } else {
          response.end(JSON.stringify({ url: control.openUrl ?? "http://127.0.0.1:1/d/9f2k4mvq7t0xbz3n?grant=secret-grant", expiresAt: Date.now() + 60000 }));
        }
        return;
      }
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
      const mode = request.url === "/api/v1/private-docs" ? { linkAccess: "invited" } : request.url === "/api/v1/docs" ? { linkAccess: "anyone" } : {};
      response.end(JSON.stringify({ docId, url, version: requests.length, ...mode }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, requests, control, host: `http://127.0.0.1:${address.port}` };
}

test("publish --public creates, --doc-id updates, and unshare withdraws using the environment token", async () => {
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
      await main(["publish", page, "--title", "Notes", "--public"]);
      await main(["publish", page, "--doc-id", "9f2k4mvq7t0xbz3n"]);
      await main(["unshare", "9f2k4mvq7t0xbz3n"]);
      assert.deepEqual(lines, [
        JSON.stringify({ docId: "9f2k4mvq7t0xbz3n", url: `${remote.host}/d/9f2k4mvq7t0xbz3n`, version: 1, linkAccess: "anyone" }),
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

test("share changes one thing per flag, then prints the access list, requests and the share page", async () => {
  const remote = await publishingServer();
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "openartifacts-share-")),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async (lines) => {
      await main(["share", "9f2k4mvq7t0xbz3n", "--link", "invited", "--add", "alice@acme.com", "--remove", "bob@acme.com", "--decline", "bob@other.com"]);
      await main(["share", "9f2k4mvq7t0xbz3n"]);
      assert.equal(lines.length, 2);
      // The share page is on the API host the CLI talks to, and the output stays one JSON document.
      const printed = JSON.parse(lines[1]);
      assert.deepEqual(printed.people, [{ email: "alice@acme.com", role: "comment", addedAt: 1 }]);
      assert.deepEqual(printed.requests, [{ email: "bob@other.com", requestedAt: 2 }]);
      assert.equal(printed.manageUrl, `${remote.host}/share/9f2k4mvq7t0xbz3n`);
      assert.equal(JSON.parse(lines[0]).manageUrl, printed.manageUrl);
      // Options are read before any request, and there is no flag that sends a whole list.
      await assert.rejects(main(["share", "9f2k4mvq7t0xbz3n", "--add"]), /Usage: openartifacts/);
      await assert.rejects(main(["share", "9f2k4mvq7t0xbz3n", "--people", "a@b.c"]), /Usage: openartifacts/);
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(remote.requests.map(({ method, path, body }) => [method, path, body]), [
    ["PUT", "/api/v1/docs/9f2k4mvq7t0xbz3n/access", { linkAccess: "invited" }],
    ["PUT", "/api/v1/docs/9f2k4mvq7t0xbz3n/access/people/alice%40acme.com", undefined],
    ["DELETE", "/api/v1/docs/9f2k4mvq7t0xbz3n/access/people/bob%40acme.com", undefined],
    ["DELETE", "/api/v1/docs/9f2k4mvq7t0xbz3n/access/requests/bob%40other.com", undefined],
    ["GET", "/api/v1/docs/9f2k4mvq7t0xbz3n/access", undefined],
  ]);
});

test("publish --private creates through /private-docs and reports the share page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-private-"));
  const page = join(directory, "notes.html");
  await writeFile(page, "<p>Private</p>");
  const remote = await publishingServer();
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: join(directory, "config"),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async (lines) => {
      await main(["publish", page, "--private"]);
      assert.deepEqual(remote.requests.map(({ method, path }) => [method, path]), [["POST", "/api/v1/private-docs"]]);
      // The mode is the route; the body is the same as a public create.
      assert.deepEqual(remote.requests[0].body, { title: "notes", html: "<p>Private</p>" });
      assert.deepEqual(JSON.parse(lines[0]), {
        docId: "9f2k4mvq7t0xbz3n",
        url: `${remote.host}/d/9f2k4mvq7t0xbz3n`,
        version: 1,
        linkAccess: "invited",
        manageUrl: `${remote.host}/share/9f2k4mvq7t0xbz3n`,
      });

      // Access to an existing page changes through share, never through publish.
      await assert.rejects(main(["publish", page, "--private", "--doc-id", "9f2k4mvq7t0xbz3n"]), /share <docId> --link invited/);
      assert.equal(remote.requests.length, 1);
    });
  } finally {
    remote.server.close();
  }
});

const PRIVATE_UNSUPPORTED = "This server does not support private documents. Nothing was published. " +
  "To publish a new page for anyone with the link instead, add --public.";

test("publish --private against a server without private documents creates nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-private-old-"));
  const page = join(directory, "notes.html");
  await writeFile(page, "<p>Private</p>");
  const remote = await publishingServer();
  remote.control.privateDocs = false;
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: join(directory, "config"),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async (lines) => {
      await assert.rejects(main(["publish", page, "--private"]), (error) =>
        error.message === PRIVATE_UNSUPPORTED);
      assert.deepEqual(lines, []);
    });
    // The process exit code is the failure the agent sees.
    const result = await cliProcess(["publish", page, "--private"], {
      OPENARTIFACTS_CONFIG_DIR: join(directory, "config"),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /This server does not support private documents\. Nothing was published\. To publish a new page for anyone with the link instead, add --public\./);
    assert.equal(result.stdout, "");
  } finally {
    remote.server.close();
  }
  // One attempt per run and nothing else: no public create, no delete.
  assert.deepEqual(remote.requests.map(({ method, path }) => [method, path]), [
    ["POST", "/api/v1/private-docs"],
    ["POST", "/api/v1/private-docs"],
  ]);
});

const publishEnvironment = (directory, remote) => ({
  OPENARTIFACTS_CONFIG_DIR: join(directory, "config"),
  OPENARTIFACTS_API_HOST: remote.host,
  OPENARTIFACTS_TOKEN: "opaque-test-token",
});

async function publishFixture(name) {
  const directory = await mkdtemp(join(tmpdir(), `openartifacts-${name}-`));
  const page = join(directory, "notes.html");
  await writeFile(page, "<p>Page</p>");
  return { directory, page };
}

const routes = (remote) => remote.requests.map(({ method, path }) => [method, path]);

test("a new page starts private when no flag is given, and its receipt says so", async () => {
  const { directory, page } = await publishFixture("default-private");
  const remote = await publishingServer();
  try {
    await withEnvironment(publishEnvironment(directory, remote), async (lines) => {
      await main(["publish", page]);
      assert.deepEqual(routes(remote), [["POST", "/api/v1/private-docs"]]);
      assert.deepEqual(JSON.parse(lines[0]), {
        docId: "9f2k4mvq7t0xbz3n",
        url: `${remote.host}/d/9f2k4mvq7t0xbz3n`,
        version: 1,
        linkAccess: "invited",
        manageUrl: `${remote.host}/share/9f2k4mvq7t0xbz3n`,
      });
    });
  } finally {
    remote.server.close();
  }
});

test("with no flag, a plan without private sharing publishes publicly instead", async () => {
  const { directory, page } = await publishFixture("default-402");
  const remote = await publishingServer();
  remote.control.privatePlan = false;
  try {
    await withEnvironment(publishEnvironment(directory, remote), async (lines) => {
      await main(["publish", page]);
      // The refused private create made nothing, so the public one is the only page.
      assert.deepEqual(routes(remote), [["POST", "/api/v1/private-docs"], ["POST", "/api/v1/docs"]]);
      assert.deepEqual(remote.requests[1].body, remote.requests[0].body);
      assert.deepEqual(JSON.parse(lines[0]), {
        docId: "9f2k4mvq7t0xbz3n", url: `${remote.host}/d/9f2k4mvq7t0xbz3n`, version: 2, linkAccess: "anyone",
      });
    });
  } finally {
    remote.server.close();
  }
});

test("with no flag, a server without private documents publishes nothing", async () => {
  const { directory, page } = await publishFixture("default-404");
  const remote = await publishingServer();
  remote.control.privateDocs = false;
  try {
    await withEnvironment(publishEnvironment(directory, remote), async (lines) => {
      await assert.rejects(main(["publish", page]), (error) => error.message === PRIVATE_UNSUPPORTED);
      assert.deepEqual(lines, []);
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(routes(remote), [["POST", "/api/v1/private-docs"]]);
});

test("with no flag, a failure that is not about private support is not retried publicly", async () => {
  const { directory, page } = await publishFixture("default-other");
  const remote = await publishingServer();
  remote.control.privateLimit = "documents";
  try {
    await withEnvironment(publishEnvironment(directory, remote), async () => {
      await assert.rejects(main(["publish", page]), (error) => error instanceof APIError && error.detail.limit === "documents");
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(routes(remote), [["POST", "/api/v1/private-docs"]]);
});

test("publish --private on a plan without private sharing fails with no fallback and a hint", async () => {
  const { directory, page } = await publishFixture("private-402");
  const remote = await publishingServer();
  remote.control.privatePlan = false;
  try {
    await withEnvironment(publishEnvironment(directory, remote), async (lines) => {
      await assert.rejects(main(["publish", page, "--private"]), (error) =>
        error instanceof APIError && error.status === 402 && error.detail.limit === "privateSharing");
      assert.deepEqual(lines, []);
    });
    const result = await cliProcess(["publish", page, "--private"], publishEnvironment(directory, remote));
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Limit: privateSharing/);
    assert.match(result.stderr, /Private sharing needs a paid plan\. Nothing was published\. To publish a new page for anyone with the link instead, add --public\./);
  } finally {
    remote.server.close();
  }
  assert.deepEqual(routes(remote), [["POST", "/api/v1/private-docs"], ["POST", "/api/v1/private-docs"]]);
});

test("publish --public creates through /docs and never tries the private route", async () => {
  const { directory, page } = await publishFixture("public");
  const remote = await publishingServer();
  try {
    await withEnvironment(publishEnvironment(directory, remote), async (lines) => {
      await main(["publish", page, "--public"]);
      assert.deepEqual(routes(remote), [["POST", "/api/v1/docs"]]);
      assert.deepEqual(remote.requests[0].body, { title: "notes", html: "<p>Page</p>" });
      assert.equal(JSON.parse(lines[0]).linkAccess, "anyone");
      assert.equal(JSON.parse(lines[0]).manageUrl, undefined);
    });
  } finally {
    remote.server.close();
  }
});

/** A directory whose `open` and `xdg-open` record the url they were given, so a test sees what the browser would. */
async function fakeBrowser(exitCode = 0, lingerSeconds = 0) {
  const directory = await mkdtemp(join(tmpdir(), "openartifacts-browser-"));
  const record = join(directory, "opened.txt");
  for (const name of ["open", "xdg-open"]) {
    await writeFile(join(directory, name), `#!/bin/sh\nprintf '%s' "$1" > "${record}"\n${lingerSeconds ? `/bin/sleep ${lingerSeconds}\n` : ""}exit ${exitCode}\n`);
    await chmod(join(directory, name), 0o755);
  }
  return { directory, async opened() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { return await readFile(record, "utf8"); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    return undefined;
  } };
}

test("open sends the owner's own grant to the browser and never prints it", { skip: process.platform === "win32" }, async () => {
  const { directory } = await publishFixture("open");
  const remote = await publishingServer();
  const browser = await fakeBrowser();
  try {
    const result = await cliProcess(["open", "9f2k4mvq7t0xbz3n"], { ...publishEnvironment(directory, remote), PATH: browser.directory });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { opened: true, docId: "9f2k4mvq7t0xbz3n" });
    assert.equal(await browser.opened(), "http://127.0.0.1:1/d/9f2k4mvq7t0xbz3n?grant=secret-grant");
    assert(!`${result.stdout}${result.stderr}`.includes("grant"));
  } finally {
    remote.server.close();
  }
  assert.deepEqual(routes(remote), [["POST", "/api/v1/docs/9f2k4mvq7t0xbz3n/open"]]);
  assert.equal(remote.requests[0].authorization, "Bearer opaque-test-token");
});

test("open reports a missing page and a browser that will not start, and prints no url", async () => {
  const { directory } = await publishFixture("open-errors");
  const remote = await publishingServer();
  try {
    remote.control.openUrl = null;
    const missing = await cliProcess(["open", "9f2k4mvq7t0xbz3n"], publishEnvironment(directory, remote));
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /No document 9f2k4mvq7t0xbz3n is in this account/);
    assert.equal(missing.stdout, "");

    remote.control.openUrl = undefined;
    const noBrowser = await cliProcess(["open", "9f2k4mvq7t0xbz3n"], publishEnvironment(directory, remote));
    assert.notEqual(noBrowser.code, 0);
    assert.match(noBrowser.stderr, /Could not start a browser/);
    assert(!`${noBrowser.stdout}${noBrowser.stderr}`.includes("grant"));

    // An opener that stays up until the browser closes, as `xdg-open` can: the
    // CLI stops waiting and reports the page opened.
    if (process.platform !== "win32") {
      const lingering = await fakeBrowser(0, 30);
      const started = Date.now();
      const opened = await cliProcess(["open", "9f2k4mvq7t0xbz3n"], { ...publishEnvironment(directory, remote), PATH: lingering.directory });
      assert.equal(opened.code, 0, opened.stderr);
      assert.deepEqual(JSON.parse(opened.stdout), { opened: true, docId: "9f2k4mvq7t0xbz3n" });
      assert(Date.now() - started < 15_000);
    }

    // An opener that starts and then fails, as `xdg-open` does on a headless host.
    if (process.platform !== "win32") {
      const failing = await fakeBrowser(1);
      const failed = await cliProcess(["open", "9f2k4mvq7t0xbz3n"], { ...publishEnvironment(directory, remote), PATH: failing.directory });
      assert.notEqual(failed.code, 0);
      assert.match(failed.stderr, /Could not start a browser/);
      assert.equal(failed.stdout, "");
      assert(!failed.stderr.includes("grant"));
    }

    remote.control.openUrl = "javascript:alert(1)";
    const unsafe = await cliProcess(["open", "9f2k4mvq7t0xbz3n"], publishEnvironment(directory, remote));
    assert.notEqual(unsafe.code, 0);
    assert.match(unsafe.stderr, /invalid page link/);
    assert(!unsafe.stderr.includes("alert"));
    await assert.rejects(main(["open"]), /Usage: openartifacts/);
  } finally {
    remote.server.close();
  }
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
    presentError(new APIError(402, { error: { code: "limit_reached", message: "Private sharing needs a paid plan.", limit: "privateSharing" } }));
  } finally {
    console.error = previous;
  }
  assert(lines.includes("Limit: privateSharing"));
  assert(!lines.some((line) => line.includes("--public")));
  assert(lines.some((line) => line.includes("quota window")));
  assert(lines.includes("Limit: 10 documents"));
  assert(lines.some((line) => line.includes("https://example.test/upgrade")));
  assert(!lines.some((line) => line.includes("openartifacts account --open")));
});

async function accountServer() {
  const requests = [];
  const control = { status: 200, unsafeUrl: false, storage: false, privateSharing: undefined };
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      response.setHeader("content-type", "application/json");
      response.statusCode = control.status;
      if (control.status !== 200) {
        response.end(JSON.stringify({ error: { code: "unauthorized", message: "Sign in again." } }));
      } else if (request.url === "/api/v1/account") {
        response.end(JSON.stringify({ accountId: "oa_account", plan: "free", limits: { documents: 1, pushesPerDay: 6, htmlBytes: 1048576, ...(control.storage ? { storageBytes: 5368709120 } : {}), ...(control.privateSharing === undefined ? {} : { privateSharing: control.privateSharing }) }, usage: { documents: 0, pushesToday: 0, ...(control.storage ? { storedBytes: 1234 } : {}) }, externalLinked: false, refresh: { status: "refreshed", checkedAt: 123, expiresAt: null }, access_token: "never-print-response-extra" }));
      } else if (request.url === "/api/v1/account/handoffs") {
        response.end(JSON.stringify({ url: control.unsafeUrl ? "javascript:alert(1)" : `https://actions.example.test/continue?code=${"a".repeat(64)}`, expiresAt: Date.now() + 600000, token: "never-print-response-extra" }));
      } else {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { message: "Unexpected login or request." } }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, requests, control, host: `http://127.0.0.1:${server.address().port}` };
}

async function cliProcess(args, values) {
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, ...values, PATH: values.PATH ?? "" }; // Browser launch fails harmlessly; never open a real browser in tests.
  if (!values.OPENARTIFACTS_TOKEN) delete env.OPENARTIFACTS_TOKEN;
  const child = spawn(process.execPath, [new URL("../bin/openartifacts.js", import.meta.url).pathname, ...args], { env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("account commands use host-scoped stored OAuth tokens and print only safe JSON fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oa-01a08465-cli-account-"));
  const remote = await accountServer();
  await writeFile(join(directory, "credentials.json"), JSON.stringify({ hosts: {
    [remote.host]: { token: "oat_stored-secret" }, "https://other.test": { token: "oat_other-secret" },
  } }));
  const env = { OPENARTIFACTS_CONFIG_DIR: directory, OPENARTIFACTS_API_HOST: remote.host };
  try {
    const account = await cliProcess(["account"], env);
    assert.equal(account.code, 0, account.stderr);
    assert.deepEqual(JSON.parse(account.stdout), { accountId: "oa_account", plan: "free", limits: { documents: 1, pushesPerDay: 6, htmlBytes: 1048576, privateSharing: false }, usage: { documents: 0, pushesToday: 0 }, externalLinked: false, refresh: { status: "refreshed", checkedAt: 123, expiresAt: null } });
    for (const args of [["account", "--open"]]) {
      const result = await cliProcess(args, env);
      assert.equal(result.code, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(parsed).sort(), ["expiresAt", "url"]);
      assert.equal(new URL(parsed.url).searchParams.get("code"), "a".repeat(64));
      assert(!`${result.stdout}${result.stderr}`.includes("secret"));
      assert(!result.stdout.includes("never-print-response-extra"));
    }
    assert.deepEqual(remote.requests.map(({ method, path, body }) => [method, path, body]), [
      ["GET", "/api/v1/account", undefined],
      ["POST", "/api/v1/account/handoffs", undefined],
    ]);
    assert(remote.requests.every((r) => r.authorization === "Bearer oat_stored-secret"));
  } finally { remote.server.close(); }
});

test("get on an unknown id prints the not-found sentence once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oa-get-404-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/api/v1/docs?")) {
      response.end(JSON.stringify({ docs: [] }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const host = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(directory, "credentials.json"), JSON.stringify({ hosts: { [host]: { token: "oat_stored-secret" } } }));
  try {
    const result = await cliProcess(["get", "abc"], { OPENARTIFACTS_CONFIG_DIR: directory, OPENARTIFACTS_API_HOST: host });
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr.match(/No document/g)?.length, 1, result.stderr);
    assert.match(result.stderr, /No document abc is in this account\./);
    assert(!/HTTP 404/.test(result.stderr), result.stderr);
  } finally { server.close(); }
});

test("account actions honor environment credentials, refuse license arguments, and never silently re-login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oa-01a08465-cli-credentials-"));
  const remote = await accountServer();
  const env = { OPENARTIFACTS_CONFIG_DIR: directory, OPENARTIFACTS_API_HOST: remote.host, OPENARTIFACTS_TOKEN: "oat_environment-secret" };
  await writeFile(join(directory, "credentials.json"), JSON.stringify({ hosts: { [remote.host]: { token: "oat_stored-secret" } } }));
  try {
    assert.equal((await cliProcess(["account"], env)).code, 0);
    assert.equal(remote.requests[0].authorization, "Bearer oat_environment-secret");
    for (const command of ["account", "upgrade", "billing", "link-copilot"]) {
      const result = await cliProcess([command, "license-secret-must-not-leak"], env);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Usage: openartifacts/);
      assert(!result.stderr.includes("license-secret-must-not-leak"));
    }
    const license = await cliProcess(["account", "--open"], { ...env, OPENARTIFACTS_TOKEN: "license-secret" });
    assert.equal(license.code, 1);
    assert.match(license.stderr, /unset OPENARTIFACTS_TOKEN/);
    assert.equal(remote.requests.length, 1);
    remote.control.status = 401;
    const rejected = await cliProcess(["account"], env);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /openartifacts login/);
    assert.equal(rejected.stdout, "");
    assert(!rejected.stderr.includes("environment-secret"));
    assert.deepEqual(remote.requests.map((r) => r.path), ["/api/v1/account", "/api/v1/account"]);
    assert.equal(JSON.parse(await readFile(join(directory, "credentials.json"), "utf8")).hosts[remote.host].token, "oat_stored-secret");
  } finally { remote.server.close(); }
});

test("account actions reject unsafe browser URLs without printing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oa-01a08465-cli-url-"));
  const remote = await accountServer();
  remote.control.unsafeUrl = true;
  try {
    const result = await cliProcess(["account", "--open"], { OPENARTIFACTS_CONFIG_DIR: directory, OPENARTIFACTS_API_HOST: remote.host, OPENARTIFACTS_TOKEN: "oat_test-secret" });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid account action link/);
    assert(!result.stderr.includes("javascript:"));
  } finally { remote.server.close(); }
});

test("Windows browser launch passes the complete URL as data rather than command text", () => {
  const url = 'https://actions.example.test/?source=cli&code=abc&x=";Write-Output injected"';
  const windows = browserProcess(url, "win32");
  assert.equal(windows.command, "powershell.exe");
  assert.deepEqual(windows.args, ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:OPENARTIFACTS_BROWSER_URL"]);
  assert.equal(windows.env.OPENARTIFACTS_BROWSER_URL, url);
  assert(!windows.args.some((arg) => arg.includes(url)));
  assert.deepEqual(browserProcess(url, "darwin").args, [url]);
  assert.deepEqual(browserProcess(url, "linux").args, [url]);
});


test("account output always carries a boolean privateSharing, for the skill to read", async () => {
  const remote = await accountServer();
  try {
    const env = { OPENARTIFACTS_API_HOST: remote.host, OPENARTIFACTS_TOKEN: "oat_private-test" };
    assert.equal(JSON.parse((await cliProcess(["account"], env)).stdout).limits.privateSharing, false);
    remote.control.privateSharing = true;
    assert.equal(JSON.parse((await cliProcess(["account"], env)).stdout).limits.privateSharing, true);
    remote.control.privateSharing = false;
    assert.equal(JSON.parse((await cliProcess(["account"], env)).stdout).limits.privateSharing, false);
  } finally { remote.server.close(); }
});

test("account output includes additive storage figures without exposing unrelated response fields", async () => {
  const remote = await accountServer();
  remote.control.storage = true;
  try {
    const result = await cliProcess(["account"], { OPENARTIFACTS_API_HOST: remote.host, OPENARTIFACTS_TOKEN: "oat_storage-test" });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.limits.storageBytes, 5368709120);
    assert.equal(parsed.usage.storedBytes, 1234);
    assert(!result.stdout.includes("never-print-response-extra"));
  } finally { remote.server.close(); }
});

const DOC = "9f2k4mvq7t0xbz3n";
const THREAD = "th_ABCDEFGHJKMNPQRS";
const COMMENT = "cm_ABCDEFGHJKMNPQRS";

test("comments subcommands send one request each, with the exact method, path and body", async () => {
  const remote = await publishingServer();
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "openartifacts-comments-")),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async (lines) => {
      await main(["comments", "list", DOC]);
      await main(["comments", "list", DOC, "--all", "--since", "2026-10-14T09:00:00Z"]);
      await main(["comments", "list", DOC, "--resolved"]);
      // A quote or a body may start with dashes; only flag positions are flags.
      await main(["comments", "add", DOC, "--quote", "--two of three", "--body", "Soften this.", "--prefix", "says ", "--suffix", " renewed", "--section", "summary", "--version", "3"]);
      await main(["comments", "add", DOC, "--body", "-- agreed?", "--quote", "Q3 revenue"]);
      await main(["comments", "reply", DOC, THREAD, "--body", "Softened in v4."]);
      await main(["comments", "resolve", DOC, THREAD, "--version", "4"]);
      await main(["comments", "resolve", DOC, THREAD]);
      await main(["comments", "reopen", DOC, THREAD]);
      await main(["comments", "delete", DOC, COMMENT]);
      await main(["comments", "on", DOC]);
      await main(["comments", "off", DOC]);
      await main(["comments", "name", "Logan Yang"]);
      assert.equal(lines.length, 13);
      // Output is the server's JSON, pretty-printed like list and share; delete prints a sentence.
      assert.equal(JSON.parse(lines[0]).docId, DOC);
      assert.equal(lines[9], `Deleted ${COMMENT}.`);
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(remote.requests.map(({ method, path, body }) => [method, path, body]), [
    ["GET", `/api/v1/docs/${DOC}/threads?state=open`, undefined],
    ["GET", `/api/v1/docs/${DOC}/threads?state=all&since=2026-10-14T09%3A00%3A00Z`, undefined],
    ["GET", `/api/v1/docs/${DOC}/threads?state=resolved`, undefined],
    ["POST", `/api/v1/docs/${DOC}/threads`, { anchor: { exact: "--two of three", prefix: "says ", suffix: " renewed", section: "summary" }, body: "Soften this.", version: 3 }],
    ["POST", `/api/v1/docs/${DOC}/threads`, { anchor: { exact: "Q3 revenue" }, body: "-- agreed?" }],
    ["POST", `/api/v1/docs/${DOC}/threads/${THREAD}/comments`, { body: "Softened in v4." }],
    ["POST", `/api/v1/docs/${DOC}/threads/${THREAD}/resolve`, { version: 4 }],
    ["POST", `/api/v1/docs/${DOC}/threads/${THREAD}/resolve`, {}],
    ["POST", `/api/v1/docs/${DOC}/threads/${THREAD}/reopen`, undefined],
    ["DELETE", `/api/v1/docs/${DOC}/comments/${COMMENT}`, undefined],
    ["PUT", `/api/v1/docs/${DOC}/settings`, { comments: true }],
    ["PUT", `/api/v1/docs/${DOC}/settings`, { comments: false }],
    ["PUT", "/api/v1/account", { displayName: "Logan Yang" }],
  ]);
  assert(remote.requests.every((request) => request.authorization === "Bearer opaque-test-token"));
});

test("comments reject malformed arguments before any credential is read or request is made", async () => {
  const remote = await publishingServer();
  try {
    // No token and a fresh config directory: reaching authentication would start a device login.
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "openartifacts-comments-bad-")),
      OPENARTIFACTS_API_HOST: remote.host,
    }, async () => {
      const usage = /Usage: openartifacts/;
      await assert.rejects(main(["comments"]), usage);
      await assert.rejects(main(["comments", "frobnicate", DOC]), usage);
      await assert.rejects(main(["comments", "list"]), usage);
      await assert.rejects(main(["comments", "list", DOC, "--open", "--all"]), usage);
      await assert.rejects(main(["comments", "list", DOC, "--since"]), usage);
      await assert.rejects(main(["comments", "list", DOC, "--since", "yesterday"]), /--since must be a date/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x"]), /--body is required/);
      await assert.rejects(main(["comments", "add", DOC, "--body", "x"]), /--quote is required/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x", "--body", "  "]), /--body cannot be empty/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x".repeat(1001), "--body", "b"]), /limit is 1000/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x", "--body", "b".repeat(4001)]), /limit is 4000/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x", "--body", "b", "--prefix", "p".repeat(33)]), /limit is 32/);
      // Measured as the server measures: UTF-16 units, so 2,500 emoji are 5,000 and refused before any credential is read.
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x", "--body", "\u{1F600}".repeat(2500)]), /5000 characters; the limit is 4000/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "\u{1F600}".repeat(501), "--body", "b"]), /1002 characters; the limit is 1000/);
      // The body is counted after trimming, and a quote is not trimmed; an NFD letter counts once it is NFC.
      assert.equal(prepareComments("add", [DOC, "--quote", "x", "--body", ` ${"b".repeat(4000)} `]).body.body.length, 4002);
      assert.equal(prepareComments("add", [DOC, "--quote", "e\u0301".repeat(1000), "--body", "b"]).body.anchor.exact.length, 2000);
      await assert.rejects(main(["comments", "add", DOC, "--quote", `x${" ".repeat(1000)}`, "--body", "b"]), /1001 characters; the limit is 1000/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x", "--body", "b", "--version", "0"]), /--version must be/);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x", "--body", "b", "--quote", "y"]), usage);
      await assert.rejects(main(["comments", "add", DOC, "--quote", "x", "--body", "b", "--owner", "me"]), usage);
      await assert.rejects(main(["comments", "reply", DOC, "not-a-thread", "--body", "b"]), usage);
      await assert.rejects(main(["comments", "reply", DOC, THREAD]), /--body is required/);
      await assert.rejects(main(["comments", "resolve", DOC]), usage);
      await assert.rejects(main(["comments", "reopen", DOC, THREAD, "extra"]), usage);
      await assert.rejects(main(["comments", "delete", DOC, THREAD]), usage);
      await assert.rejects(main(["comments", "on"]), usage);
      await assert.rejects(main(["comments", "off", DOC, "extra"]), usage);
      await assert.rejects(main(["comments", "name"]), usage);
      await assert.rejects(main(["comments", "name", "   "]), /cannot be empty/);
      await assert.rejects(main(["comments", "name", "n".repeat(65)]), /limit is 64/);
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(remote.requests, []);
});

test("prepareComments returns the request it will send", () => {
  assert.deepEqual(prepareComments("list", [DOC]), { action: "list", docId: DOC, state: "open" });
  assert.deepEqual(prepareComments("name", ["  Logan Yang "]), { action: "name", name: "Logan Yang" });
  assert.deepEqual(prepareComments("add", [DOC, "--quote", "Q3", "--body", "hi"]), {
    action: "add", docId: DOC, body: { anchor: { exact: "Q3" }, body: "hi" },
  });
});

test("comments name a missing resource the same way whatever the reason", async () => {
  const remote = await publishingServer();
  remote.control.comments = false;
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "openartifacts-comments-404-")),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async () => {
      await assert.rejects(main(["comments", "list", DOC]), /Not found, or this server does not support comments\./);
      await assert.rejects(main(["comments", "on", DOC]), /Not found, or this server does not support comments\./);
    });
  } finally {
    remote.server.close();
  }
});

test("comments name keeps the server's answer for a key with no linked account", async () => {
  const remote = await publishingServer();
  remote.control.unlinked = true;
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "openartifacts-comments-name-")),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async () => {
      await assert.rejects(main(["comments", "name", "Alice"]), /Sign in to link one/);
    });
  } finally {
    remote.server.close();
  }
  assert.throws(() => prepareComments("list", [DOC, "--since", "October 14, 2026"]), /--since must be a date/);
});

test("share --role sets the role of the people added in the same call", async () => {
  assert.deepEqual(prepareShare(["--add", "a@b.co", "--role", "view"]), [["add", "a@b.co", "view"]]);
  assert.deepEqual(prepareShare(["--role", "comment", "--add", "a@b.co", "--add", "c@d.co"]), [["add", "a@b.co", "comment"], ["add", "c@d.co", "comment"]]);
  assert.deepEqual(prepareShare(["--add", "a@b.co"]), [["add", "a@b.co"]]);
  assert.throws(() => prepareShare(["--role", "view"]), /--role applies to a person added/);
  assert.throws(() => prepareShare(["--link", "invited", "--role", "view"]), /--role applies to a person added/);
  assert.throws(() => prepareShare(["--add", "a@b.co", "--role", "owner"]), /Usage: openartifacts/);
  assert.throws(() => prepareShare(["--add", "a@b.co", "--role", "view", "--role", "comment"]), /Usage: openartifacts/);

  const remote = await publishingServer();
  try {
    await withEnvironment({
      OPENARTIFACTS_CONFIG_DIR: await mkdtemp(join(tmpdir(), "openartifacts-role-")),
      OPENARTIFACTS_API_HOST: remote.host,
      OPENARTIFACTS_TOKEN: "opaque-test-token",
    }, async () => {
      await main(["share", DOC, "--add", "bob@acme.com", "--role", "view"]);
      await main(["share", DOC, "--add", "bob@acme.com"]);
      await assert.rejects(main(["share", DOC, "--role", "view"]), /--role applies/);
    });
  } finally {
    remote.server.close();
  }
  assert.deepEqual(remote.requests.map(({ method, path, body }) => [method, path, body]), [
    ["PUT", `/api/v1/docs/${DOC}/access/people/bob%40acme.com`, { role: "view" }],
    ["PUT", `/api/v1/docs/${DOC}/access/people/bob%40acme.com`, undefined],
  ]);
});

test("presentError explains the comment error codes", () => {
  const lines = [];
  const previous = console.error;
  console.error = (...parts) => lines.push(parts.join(" "));
  try {
    presentError(new APIError(400, { error: { code: "anchor_not_found", message: "Quote not found." } }));
    presentError(new APIError(409, { error: { code: "comments_off", message: "Comments are off." } }));
    presentError(new APIError(409, { error: { code: "name_required", message: "Name needed." } }));
    presentError(new APIError(402, { error: { code: "limit_reached", message: "Comments need a plan.", limit: "comments" } }));
  } finally {
    console.error = previous;
  }
  assert(lines.some((line) => line.includes("openartifacts get <docId>")));
  assert(lines.some((line) => line.includes("openartifacts comments on <docId>")));
  assert(lines.some((line) => line.includes('openartifacts comments name "<name>"')));
  assert(lines.includes("Limit: comments"));
  assert(lines.some((line) => line.includes("paid plan")));
});
