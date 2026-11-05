// Contract tests (docs/contract.md, contract/contract.json): black box, against whatever
// OVERHAUL_BIN names (the release executable, the Go port), else node bin/overhaul.mjs.
// Only the command line, files on disk, HTTP and the SQLite file: no imports from src/.
//   OVERHAUL_BIN=dist/overhaul-linux-x64 node --test test/contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT = JSON.parse(fs.readFileSync(path.join(root, "contract/contract.json"), "utf8"));
export const BIN = process.env.OVERHAUL_BIN ? [path.resolve(process.env.OVERHAUL_BIN)] : [process.execPath, path.join(root, "bin/overhaul.mjs")];
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const AGENT_TOKEN = "an-agent-token-of-24-chars-or-more";
const PASSWORD = "a-long-ui-password";

// A clean environment: a temporary HOME, nothing of this machine's Overhaul.
export function cleanEnv(home, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TMUX_PANE: "", XDG_CONFIG_HOME: path.join(home, ".config") };
  return { ...env, ...extra };
}

export function overhaul(args, { env, input, timeout = 20_000 } = {}) {
  return spawnSync(BIN[0], [...BIN.slice(1), ...args], { env, input, encoding: "utf8", timeout });
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// `overhaul serve` on a temporary home; resolves once it answers HTTP.
export async function serve(env) {
  const child = spawn(BIN[0], [...BIN.slice(1), "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 15_000;
  while (!/on http:\/\//.test(out)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      throw new Error(`overhaul serve did not start:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { log: () => out, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.on("exit", r); child.kill(); }) };
}

// A home with config.yaml and env (no password prompt), written where the contract says.
export function hubHome(port, extraConfig = "") {
  const home = tmp("overhaul-contract-");
  const oh = path.join(home, ".overhaul");
  fs.mkdirSync(oh, { mode: 0o700 });
  fs.writeFileSync(path.join(oh, "config.yaml"), `version: 2\nport: ${port}\nbind: [127.0.0.1]\nprojects:\n  alpha: {}\n${extraConfig}`);
  fs.writeFileSync(path.join(oh, "env"), `HUB_TOKEN=${PASSWORD}\nHUB_AGENT_TOKEN=${AGENT_TOKEN}\n`, { mode: 0o600 });
  return { home, oh };
}

test("contract: version and help; unknown commands exit 2", () => {
  const home = tmp("overhaul-contract-");
  const v = overhaul(["version"], { env: cleanEnv(home) });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), PKG_VERSION);
  assert.equal(overhaul(["--version"], { env: cleanEnv(home) }).stdout.trim(), PKG_VERSION);
  const help = overhaul(["help"], { env: cleanEnv(home) });
  assert.equal(help.status, 0);
  for (const group of Object.values(CONTRACT.command.subcommands)) {
    for (const sub of group) assert.ok(help.stdout.includes(sub.split(" ")[0]), `help names ${sub}`);
  }
  const bad = overhaul(["no-such-command"], { env: cleanEnv(home) });
  assert.equal(bad.status, CONTRACT.command.exit.usage);
  assert.equal(overhaul(["ask"], { env: cleanEnv(home) }).status, CONTRACT.command.exit.usage); // no ticket, no token
});

test("contract: the hub's HTTP API, auth on every route, and the SQLite schema", async () => {
  const port = await freePort();
  const { home, oh } = hubHome(port);
  const hub = await serve(cleanEnv(home));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const p of CONTRACT.http.public) assert.equal((await fetch(base + p)).status, 200, p);
    // Without a session the page is the login page.
    assert.match(await (await fetch(`${base}/`)).text(), /<form|password/i);
    const fill = (p) => p.replace("{project}", "alpha").replace("{key}", "ABC-1").replace("{uuid}", "00000000-0000-4000-8000-000000000000");
    for (const r of CONTRACT.http.routes) {
      const res = await fetch(base + fill(r.path), { method: r.method, headers: { "content-type": "application/json", "x-hub": "1" }, body: r.method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 401, `${r.method} ${r.path} without credentials`);
    }
    // Agent side, with the token: ask, then the inbox (empty).
    const agent = { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" };
    const ask = await fetch(`${base}/agent/alpha/ABC-1/ask`, { method: "POST", headers: agent, body: JSON.stringify({ text: "¿UTC?", blocks: "", from: "be", host: "h", tmuxPane: "" }) });
    assert.equal(ask.status, 200);
    assert.ok((await ask.json()).id);
    const inbox = await fetch(`${base}/agent/alpha/ABC-1/inbox?wait=0`, { headers: agent }).then((r) => r.json());
    assert.deepEqual(inbox.messages, []);
    // The page, with a session: the question is there.
    const login = await fetch(`${base}/login`, { method: "POST", body: `token=${PASSWORD}`, headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const state = await fetch(`${base}/api/state`, { headers: { cookie } }).then((r) => r.json());
    const t = state.projects.find((p) => p.id === "alpha").tickets.find((x) => x.key === "ABC-1");
    assert.equal(t.questions[0].text, "¿UTC?");
    assert.equal((await fetch(`${base}/api/state`, { method: "GET", headers: { cookie: "s=forged" } })).status, 401);
  } finally {
    await hub.stop();
  }
  // SQLite: <home>/overhaul.db, private, exactly the contract's tables and columns.
  const dbFile = path.join(oh, CONTRACT.layout.files.db);
  assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE ? ORDER BY type, name").all("sqlite_%");
    const tables = Object.fromEntries(rows.filter((r) => r.type === "table").map((r) => [r.name, db.prepare(`PRAGMA table_info(${r.name})`).all().map((c) => c.name)]));
    assert.deepEqual(tables, CONTRACT.sqlite.tables);
    assert.deepEqual(rows.filter((r) => r.type === "index").map((r) => r.name), CONTRACT.sqlite.indexes);
    assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, CONTRACT.sqlite.schema_version);
  } finally {
    db.close();
  }
});

test("contract: `overhaul hook <Event>` posts the event to the hub and always exits 0", async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { home } = hubHome(1);
    const env = cleanEnv(home, { HUB_URL: `http://127.0.0.1:${server.address().port}`, HUB_HOST: "host-a", HUB_WINDOW: "personal:k-1" });
    const run = (args, input) => new Promise((resolve) => {
      const child = spawn(BIN[0], [...BIN.slice(1), ...args], { env, stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(input);
      child.on("exit", resolve);
    });
    // The event comes from the command line when stdin does not name it.
    assert.equal(await run(["hook", "UserPromptSubmit"], JSON.stringify({ prompt: "hola", session_id: "s", cwd: "/w" })), 0);
    assert.equal(got.length, 1);
    assert.equal(got[0].url, CONTRACT.hook.post);
    assert.equal(got[0].auth, `Bearer ${AGENT_TOKEN}`);
    assert.deepEqual(Object.keys(got[0].body).sort(), [...CONTRACT.hook.payload].sort());
    assert.deepEqual({ ...got[0].body }, { host: "host-a", session: "personal", window: "k-1", event: "UserPromptSubmit", text: "hola", cwd: "/w" });
    // Garbage in, nothing out, still 0.
    assert.equal(await run(["hook", "Stop"], "not json"), 0);
    assert.equal(got.length, 1);
  } finally {
    server.close();
  }
});
