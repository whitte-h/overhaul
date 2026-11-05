// SQLite store: schema, persistence, question lifecycle and the JSON import.
// Every test uses its own temporary data dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, Store } from "../src/store.mjs";
import { canonical, importJsonTickets, verifyJsonImport } from "../src/jsonimport.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-db-"));
const reopen = (s) => new Store(s.dataDir);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("database lives in data_dir/overhaul.db, private, at the latest schema", () => {
  const s = new Store(tmpDir());
  assert.equal(s.file, path.join(s.dataDir, "overhaul.db"));
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  const versions = s.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  assert.deepEqual(versions, MIGRATIONS.map((_, i) => i + 1));
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ["projects", "tasks", "agents", "questions", "question_events", "notes", "messages", "meta"]) assert.ok(tables.includes(t), t);
  // Reopening applies nothing twice.
  assert.equal(reopen(s).db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, MIGRATIONS.length);
});

test("a database from newer code is refused", () => {
  const s = new Store(tmpDir());
  s.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(MIGRATIONS.length + 1, "x");
  assert.throws(() => reopen(s), /newer than this code/);
});

test("node id is stable and every row has a uuid and timestamps", () => {
  const s = new Store(tmpDir());
  const node = s.nodeId();
  assert.match(node, UUID);
  assert.equal(reopen(s).nodeId(), node);
  const q = s.ask("alpha", "ABC-1", { text: "¿UTC?", from: "be" });
  s.setNotes("alpha", "ABC-1", "mías");
  s.seenAgent("alpha", "ABC-1", { from: "be", host: "h", tmuxPane: "%1" });
  s.answer("alpha", "ABC-1", q.id, "sí");
  for (const t of ["projects", "tasks", "agents", "questions", "question_events", "notes", "messages"]) {
    const rows = s.db.prepare(`SELECT * FROM ${t}`).all();
    assert.ok(rows.length, t);
    for (const r of rows) {
      assert.match(r.id, UUID, t);
      assert.ok(r.created_at && r.updated_at, t);
    }
  }
});

test("everything a ticket holds survives a restart, unchanged", async () => {
  const s = new Store(tmpDir());
  const q = s.ask("alpha", "ABC-1", { text: "¿UTC?", from: "be", blocks: "fechas" });
  s.message("alpha", "ABC-1", "hola", [{ id: "a", name: "x.png", size: 3 }]);
  s.setNotes("alpha", "ABC-1", "nota");
  s.seenAgent("alpha", "ABC-1", { from: "be", host: "h", tmuxPane: "%1" });
  const t = s.get("alpha", "ABC-1");
  t.auto = { status: "running", pane: "%1" };
  s.save(t);
  await s.waitFor("alpha", "ABC-1", { questionId: null, timeoutMs: 10 });
  s.answer("alpha", "ABC-1", q.id, "sí");
  const before = JSON.parse(JSON.stringify(s.get("alpha", "ABC-1")));
  const after = reopen(s).get("alpha", "ABC-1");
  assert.deepEqual(JSON.parse(JSON.stringify(after)), before);
  delete t.auto;
  s.save(t);
  assert.equal(reopen(s).get("alpha", "ABC-1").auto, undefined);
});

test("save writes only rows that changed", () => {
  const s = new Store(tmpDir());
  s.ask("alpha", "ABC-1", { text: "a" });
  const q2 = s.ask("alpha", "ABC-1", { text: "b" });
  const stamp = (id) => s.db.prepare("SELECT updated_at FROM questions WHERE id = ?").get(id).updated_at;
  const first = s.get("alpha", "ABC-1").questions[0];
  const was = stamp(first.id);
  const until = Date.now() + 5;
  while (Date.now() < until);
  s.setStatus("alpha", "ABC-1", q2.id, "client");
  assert.equal(stamp(first.id), was);
  assert.notEqual(stamp(q2.id), was);
});

test("listStored and pending read from the database", () => {
  const s = new Store(tmpDir());
  s.message("beta", "K-2", "x");
  s.setNotes("alpha", "K-1", "n");
  const r = reopen(s);
  assert.deepEqual(r.listStored().map((t) => `${t.project}/${t.key}`), ["alpha/K-1", "beta/K-2"]);
  assert.deepEqual(r.pending("beta").map((t) => t.key), ["K-2"]);
  assert.deepEqual(r.pending("alpha"), []);
  // A ticket only read stays out of the database.
  r.get("gamma", "K-3");
  assert.equal(reopen(s).listStored().length, 2);
});

test("lifecycle: refine keeps the chain, history lists every step", () => {
  const s = new Store(tmpDir());
  const q = s.ask("alpha", "ABC-1", { text: "¿Zona?", from: "be", blocks: "fechas" });
  const child = s.refine("alpha", "ABC-1", q.id, { text: "¿Zona horaria del usuario o UTC?" });
  assert.equal(child.refines, q.id);
  assert.equal(child.status, "open");
  assert.equal(child.from, "be");
  assert.equal(child.blocks, "fechas");
  assert.equal(s.get("alpha", "ABC-1").questions[0].status, "refined");
  assert.throws(() => s.answer("alpha", "ABC-1", q.id, "x"), /refined/);
  assert.throws(() => s.setStatus("alpha", "ABC-1", q.id, "open"), /Cannot go/);
  s.setStatus("alpha", "ABC-1", child.id, "client");
  s.answer("alpha", "ABC-1", child.id, "UTC");
  const h = reopen(s).history("alpha", "ABC-1", child.id);
  assert.deepEqual(h.map((e) => [e.type, e.from ?? null, e.to]), [
    ["created", null, "open"],
    ["refined", "open", "refined"],
    ["created", null, "open"],
    ["status", "open", "client"],
    ["answered", "client", "answered"],
  ]);
  assert.equal(h[1].data.by, child.id);
  assert.equal(h[1].actor, "tú");
});

test("lifecycle: bad statuses and transitions are refused", () => {
  const s = new Store(tmpDir());
  const q = s.ask("alpha", "ABC-1", { text: "x" });
  assert.throws(() => s.setStatus("alpha", "ABC-1", q.id, "nope"), /Bad status/);
  assert.throws(() => s.setStatus("alpha", "ABC-1", q.id, "answered"), /Bad status/);
  s.setStatus("alpha", "ABC-1", q.id, "dismissed");
  s.setStatus("alpha", "ABC-1", q.id, "open"); // reopened
  assert.throws(() => s.refine("alpha", "ABC-1", "missing", { text: "y" }), /not found/);
});

test("initial round: proposed questions, refined and answered in the hub, released in one message", async () => {
  const s = new Store(tmpDir());
  const [a, b, c] = s.propose("alpha", "ABC-1", { from: "auto", questions: [{ text: "¿Qué endpoint?" }, { text: "¿Hay diseño?" }, { text: "¿Tests e2e?" }, { text: "  " }] });
  assert.deepEqual([a, b, c].map((q) => [q.status, q.kind]), [["proposed", "initial"], ["proposed", "initial"], ["proposed", "initial"]]);
  const b2 = s.refine("alpha", "ABC-1", b.id, { text: "¿Hay diseño en Figma?" });
  assert.equal(b2.status, "proposed");
  s.setStatus("alpha", "ABC-1", c.id, "dismissed");
  const mine = s.ask("alpha", "ABC-1", { text: "¿Rama base?", status: "proposed", kind: "initial" });
  assert.deepEqual(s.pending("alpha"), []); // nothing goes to the agent while you review
  const waiting = s.waitFor("alpha", "ABC-1", { questionId: null, timeoutMs: 1000 });
  const out = s.releaseInitial("alpha", "ABC-1", { [a.id]: "/v2/users", [mine.id]: "main" });
  assert.deepEqual(out.questions.map((q) => q.status), ["answered", "open", "answered"]);
  const [msg] = await waiting;
  assert.equal(msg.kind, "message");
  assert.match(msg.text, /^Preguntas iniciales revisadas:/);
  assert.match(msg.text, /¿Qué endpoint\?\n {3}Respuesta: \/v2\/users/);
  assert.match(msg.text, /¿Hay diseño en Figma\?\n {3}Sin respuesta todavía/);
  assert.doesNotMatch(msg.text, /¿Hay diseño\?\n/);
  assert.match(msg.text, /1 descartada/);
  assert.throws(() => s.releaseInitial("alpha", "ABC-1"), /No proposed/);
  assert.deepEqual(s.history("alpha", "ABC-1", b2.id).map((e) => e.type), ["created", "refined", "created", "released"]);
});

test("ask still works as before: open, from defaults to tú, answer goes to the inbox", () => {
  const s = new Store(tmpDir());
  const q = s.ask("alpha", "ABC-1", { text: "x" });
  assert.deepEqual([q.status, q.from, q.blocks], ["open", "tú", ""]);
  assert.equal("kind" in q || "refines" in q, false);
  s.answer("alpha", "ABC-1", q.id, "y");
  assert.equal(s.get("alpha", "ABC-1").inbox[0].kind, "answer");
});

test("a failed transaction leaves the database and later reads consistent", () => {
  const s = new Store(tmpDir());
  s.ask("alpha", "ABC-1", { text: "x" });
  assert.throws(() => s.tx(() => { s.message("alpha", "ABC-1", "y"); throw new Error("boom"); }), /boom/);
  assert.equal(s.get("alpha", "ABC-1").inbox.length, 0);
  assert.equal(reopen(s).get("alpha", "ABC-1").inbox.length, 0);
});

// --- JSON import ----------------------------------------------------------------------

const LEGACY = {
  project: "alpha",
  key: "ABC-1",
  notes: "nota con ñ",
  questions: [
    { id: "q1", text: "¿UTC?", from: "be", blocks: "", status: "answered", createdAt: "2026-01-01T00:00:00.000Z", answer: "sí", answeredAt: "2026-01-01T01:00:00.000Z" },
    { id: "q2", text: "¿Diseño?", from: "tú", blocks: "ui", status: "client", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "q3", text: "vieja", from: "be", blocks: "", status: "dismissed", createdAt: "2026-01-03T00:00:00.000Z", custom: { a: 1 } },
  ],
  inbox: [
    { id: "m1", createdAt: "2026-01-01T01:00:00.000Z", kind: "answer", questionId: "q1", question: "¿UTC?", text: "sí", attachments: [], consumedAt: "2026-01-01T01:00:01.000Z", via: "alpha:abc-1" },
    { id: "m2", createdAt: "2026-01-04T00:00:00.000Z", kind: "message", text: "pendiente" },
  ],
  agent: { from: "be", host: "host-a", tmuxPane: "%3", lastSeen: "2026-01-04T00:00:00.000Z" },
};

function legacyDir() {
  const dir = tmpDir();
  const w = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  };
  w("tickets/alpha/ABC-1.json", LEGACY);
  w("tickets/alpha/ABC-2.json", { notes: "solo notas" }); // older files carry no project/key
  w("tickets/beta/K-9.json", { project: "beta", key: "K-9", notes: "", questions: [], inbox: [], agent: null, auto: { status: "exited", pane: "%9" } });
  w("tickets/beta/K-9.json.123.tmp", "{ half");
  return dir;
}

const snapshot = (dir) => Object.fromEntries(fs.readdirSync(path.join(dir, "tickets"), { recursive: true }).sort().map((f) => {
  const p = path.join(dir, "tickets", f);
  return [f, fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : null];
}));

test("JSON import: same questions, inbox, notes and agents; JSON left as they were, plus a backup", () => {
  const dir = legacyDir();
  const files = snapshot(dir);
  const s = new Store(dir);
  const res = importJsonTickets(s, { stamp: "T" });
  assert.equal(res.status, "imported");
  assert.deepEqual([res.tickets, res.questions, res.messages], [3, 3, 2]);
  assert.deepEqual(snapshot(dir), files);
  assert.equal(fs.readFileSync(path.join(dir, "backups/tickets-json-T/alpha/ABC-1.json"), "utf8"), files["alpha/ABC-1.json"]);

  const r = reopen(s);
  assert.deepEqual(canonical(JSON.parse(JSON.stringify(r.get("alpha", "ABC-1")))), canonical(LEGACY));
  assert.equal(r.get("alpha", "ABC-2").notes, "solo notas");
  assert.deepEqual(r.get("beta", "K-9").auto, { status: "exited", pane: "%9" });
  assert.deepEqual(verifyJsonImport(r), []);
  assert.deepEqual(r.history("alpha", "ABC-1", "q2").map((e) => [e.type, e.to]), [["imported", "client"]]);
  assert.deepEqual(r.pending("alpha").map((t) => t.key), ["ABC-1"]); // m2 still undelivered
});

test("JSON import is idempotent and never merges into a database in use", () => {
  const dir = legacyDir();
  const s = new Store(dir);
  importJsonTickets(s, { stamp: "T" });
  const again = importJsonTickets(reopen(s), { stamp: "T2" });
  assert.equal(again.status, "done");
  assert.equal(fs.existsSync(path.join(dir, "backups/tickets-json-T2")), false);
  assert.equal(reopen(s).listStored().length, 3);

  const used = tmpDir();
  fs.cpSync(path.join(dir, "tickets"), path.join(used, "tickets"), { recursive: true });
  const u = new Store(used);
  u.setNotes("alpha", "NEW-1", "ya en uso");
  assert.equal(importJsonTickets(u).status, "skipped");
  assert.equal(u.listStored().length, 1);

  assert.equal(importJsonTickets(new Store(tmpDir())).status, "none");
});

test("JSON import: an unreadable file stops it and leaves the database empty", () => {
  const dir = legacyDir();
  fs.writeFileSync(path.join(dir, "tickets/alpha/ABC-3.json"), "{ broken");
  const s = new Store(dir);
  assert.throws(() => importJsonTickets(s, { stamp: "T" }), /ABC-3\.json/);
  assert.equal(s.listStored().length, 0);
  assert.equal(s.meta("json_import"), null);
});

test("JSON import: a mismatch on read-back rolls everything back", () => {
  const dir = legacyDir();
  const s = new Store(dir);
  const load = s.load.bind(s);
  s.load = (p, k) => { const t = load(p, k); if (t?.key === "ABC-2") t.notes = "otra"; return t; };
  assert.throws(() => importJsonTickets(s, { stamp: "T" }), /ABC-2: notes distinto/);
  s.load = load;
  assert.equal(s.listStored().length, 0);
  assert.equal(s.meta("json_import"), null);
  assert.equal(new DatabaseSync(s.file).prepare("SELECT COUNT(*) AS n FROM questions").get().n, 0);
});
