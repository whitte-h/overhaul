// The hub itself on a temporary HOME: it imports the JSON tickets on first start, and the
// agent CLI (`hub ask`, `hub propose`) works against it. Never touches this machine's hub.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function fakeHome(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-hub-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  w(".config/overhaul/config.yaml", `version: 2\nport: ${port}\nbind: [127.0.0.1]\nprojects:\n  alpha: {}\n`);
  w(".local/share/overhaul/tickets/alpha/ABC-1.json", JSON.stringify({
    project: "alpha", key: "ABC-1", notes: "mías",
    questions: [{ id: "q1", text: "¿UTC?", from: "be", blocks: "", status: "open", createdAt: "2026-01-01T00:00:00.000Z" }],
    inbox: [], agent: { from: "be", host: "host-a", tmuxPane: "%1", lastSeen: "2026-01-01T00:00:00.000Z" },
  }));
  return home;
}

const env = (home, port) => ({
  ...process.env, HOME: home, HUB_CONFIG_DIR: "", OVERHAUL_CONFIG_DIR: "", HUB_URL: `http://127.0.0.1:${port}`,
  HUB_TOKEN: "a-long-ui-password", HUB_AGENT_TOKEN: "an-agent-token-of-24-chars-or-more", HUB_HOST: "host-a",
  HUB_PROJECT: "alpha", HUB_TICKET: "ABC-1", HUB_AGENT_NAME: "be", TMUX_PANE: "",
});

async function startHub(home, port) {
  const child = spawn(process.execPath, [path.join(root, "src/server.mjs")], { env: env(home, port), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 10_000;
  while (!/on http:\/\//.test(out)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`hub did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, log: () => out, stop: () => new Promise((r) => { child.on("exit", r); child.kill(); }) };
}

const cli = (home, port, ...args) => spawnSync(process.execPath, [path.join(root, "bin/hub.mjs"), ...args], { env: env(home, port), encoding: "utf8", timeout: 20_000 });

test("hub imports JSON tickets on its first start, keeps the JSON, then serves ask and propose", async () => {
  const port = await freePort();
  const home = fakeHome(port);
  const data = path.join(home, ".local/share/overhaul");
  const json = fs.readFileSync(path.join(data, "tickets/alpha/ABC-1.json"), "utf8");

  let hub = await startHub(home, port);
  try {
    assert.match(hub.log(), /tickets JSON importados a SQLite: 1 tickets, 1 preguntas, 0 mensajes/);
    const ask = cli(home, port, "ask", "¿Rama base?", "--blocks", "inicio");
    assert.equal(ask.status, 0, ask.stderr);
    // `overhaul` is the same script under another name (install.sh links both).
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(root, "bin/hub.mjs"), path.join(bin, "overhaul"));
    const prop = spawnSync(process.execPath, [path.join(bin, "overhaul"), "propose", "¿Qué endpoint?", "¿Hay diseño?"], { env: env(home, port), encoding: "utf8", timeout: 20_000 });
    assert.match(spawnSync(process.execPath, [path.join(bin, "overhaul"), "propose"], { env: env(home, port), encoding: "utf8" }).stderr, /^Usage: overhaul propose/);
    assert.equal(prop.status, 0, prop.stderr);
    assert.match(prop.stdout, /2 pregunta\(s\) propuesta\(s\)/);

    // The page: refine one proposed question, answer the other on release, read the history.
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/login`, { method: "POST", body: "token=a-long-ui-password", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const ui = async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { cookie, "x-hub": "1", "content-type": "application/json" }, body: body && JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const state = async () => (await ui("GET", "/api/state")).body.projects[0].tickets.find((t) => t.key === "ABC-1");
    const [endpoint, design] = (await state()).questions.filter((q) => q.status === "proposed");
    const refined = await ui("POST", "/api/t/alpha/ABC-1/refine", { questionId: design.id, text: "¿Hay diseño en Figma?" });
    assert.equal(refined.status, 200);
    assert.equal(refined.body.refines, design.id);
    assert.equal((await ui("POST", "/api/t/alpha/ABC-1/status", { questionId: design.id, status: "open" })).status, 409);
    const rel = await ui("POST", "/api/t/alpha/ABC-1/initial/release", { answers: { [endpoint.id]: "/v2/users" } });
    assert.equal(rel.status, 200);
    assert.deepEqual(rel.body.questions.map((q) => q.status), ["answered", "open"]);
    assert.equal((await ui("POST", "/api/t/alpha/ABC-1/initial/release", {})).status, 409);
    const hist = await ui("GET", `/api/t/alpha/ABC-1/history?questionId=${refined.body.id}`);
    assert.deepEqual(hist.body.events.map((e) => e.type), ["created", "refined", "created", "released"]);
    const inbox = await fetch(`${base}/agent/alpha/ABC-1/inbox?wait=0`, { headers: { authorization: "Bearer an-agent-token-of-24-chars-or-more" } }).then((r) => r.json());
    assert.match(inbox.messages.at(-1).text, /^Preguntas iniciales revisadas:/);
  } finally {
    await hub.stop();
  }
  assert.equal(fs.readFileSync(path.join(data, "tickets/alpha/ABC-1.json"), "utf8"), json);
  assert.ok(fs.readdirSync(path.join(data, "backups")).some((f) => f.startsWith("tickets-json-")));

  // A second start finds the import done and changes nothing.
  hub = await startHub(home, port);
  try {
    assert.doesNotMatch(hub.log(), /importados/);
  } finally {
    await hub.stop();
  }
  const t = new Store(data).get("alpha", "ABC-1");
  assert.equal(t.notes, "mías");
  assert.deepEqual(t.questions.map((q) => [q.text, q.status, q.kind ?? null, q.blocks]), [
    ["¿UTC?", "open", null, ""],
    ["¿Rama base?", "open", null, "inicio"],
    ["¿Qué endpoint?", "answered", "initial", ""],
    ["¿Hay diseño?", "refined", "initial", ""],
    ["¿Hay diseño en Figma?", "open", "initial", ""],
  ]);
});
