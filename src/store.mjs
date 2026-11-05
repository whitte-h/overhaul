// Private per-ticket state in SQLite (dataDir/overhaul.db, node:sqlite: no native deps).
// Questions come from agents (or from you); answers and messages go out through an inbox
// that the host bridge pastes into the ticket's window (or an agent drains with `hub inbox`).
//
// The API is the one the JSON store had: get() hands out one mutable object per ticket
// ({ project, key, notes, questions, inbox, agent, auto? }) and save(t) writes it back. Here
// save() writes only the rows that changed since they were last read or written.
//
// Every row has a uuid and created_at/updated_at so a node can later sync with a master
// (no sync yet). Question changes are kept in question_events.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const KEY_RE = /^[A-Za-z0-9._-]{1,80}$/;
export const DB_FILE = "overhaul.db";

// Question lifecycle. "client" is an open question that waits on someone else (shown,
// not blocking the agent). "refined" was replaced by a new question whose `refines` is it.
export const QUESTION_STATUSES = ["proposed", "open", "client", "refined", "answered", "dismissed"];
export const PENDING_STATUSES = ["proposed", "open", "client"];
const NEXT = {
  proposed: ["open", "client", "answered", "dismissed", "refined"],
  open: ["client", "answered", "dismissed", "refined"],
  client: ["open", "answered", "dismissed", "refined"],
  dismissed: ["open"],
  answered: [],
  refined: [],
};

// Versioned schema: each entry runs once, in order, inside a transaction.
export const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE projects (
     id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL,
     auto TEXT, extra TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     UNIQUE (project_id, key));
   CREATE TABLE notes (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), body TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE agents (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
     task_id TEXT UNIQUE REFERENCES tasks(id),
     name TEXT, role TEXT, runtime TEXT, host TEXT, tmux_pane TEXT, last_seen TEXT, extra TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE questions (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
     text TEXT NOT NULL, asked_by TEXT, blocks TEXT, status TEXT NOT NULL,
     answer TEXT, answered_at TEXT, refines_id TEXT REFERENCES questions(id), kind TEXT, extra TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX questions_task ON questions (task_id);
   CREATE INDEX questions_status ON questions (status);
   CREATE TABLE question_events (
     id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id),
     type TEXT NOT NULL, from_status TEXT, to_status TEXT, actor TEXT, data TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX question_events_question ON question_events (question_id, created_at);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
     kind TEXT, question_id TEXT, question_text TEXT, text TEXT, attachments TEXT,
     consumed_at TEXT, via TEXT, extra TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX messages_task ON messages (task_id);
   CREATE INDEX messages_pending ON messages (task_id) WHERE consumed_at IS NULL;`,
];

// Fields with their own column; anything else an object carries is kept in `extra`.
const TICKET_KEYS = ["project", "key", "notes", "questions", "inbox", "agent", "auto"];
const QUESTION_KEYS = ["id", "text", "from", "blocks", "status", "answer", "answeredAt", "refines", "kind", "createdAt"];
const MESSAGE_KEYS = ["id", "kind", "questionId", "question", "text", "attachments", "consumedAt", "via", "createdAt"];
const AGENT_KEYS = ["from", "role", "runtime", "host", "tmuxPane", "lastSeen"];

export class Store {
  constructor(dataDir, { file } = {}) {
    this.dataDir = dataDir;
    this.file = file ?? path.join(dataDir, DB_FILE);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    fs.chmodSync(this.file, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrate(this.db);
    this.cache = new Map(); // "project/key" -> ticket object
    this.written = new Map(); // "table:id" -> last row written or read, to skip unchanged rows
    this.projectIds = new Map(); // project key -> projects.id
    this.waiters = new Map(); // "project/key" -> Set of { resolve, questionId }
    this.sql = new Map();
    this.depth = 0;
  }

  close() {
    this.db.close();
  }

  stmt(sql) {
    let s = this.sql.get(sql);
    if (!s) this.sql.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  // Runs fn in one transaction; nested calls join the outer one.
  tx(fn) {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const out = fn();
      this.depth = 0;
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.depth = 0;
      this.db.exec("ROLLBACK");
      // Rows written in the failed transaction are gone: forget what we thought was stored.
      this.cache.clear();
      this.written.clear();
      this.projectIds.clear();
      throw err;
    }
  }

  meta(key) {
    return this.stmt("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  // This installation's id, made once: a master will tell nodes apart by it.
  nodeId() {
    let id = this.meta("node_id");
    if (!id) this.setMeta("node_id", (id = randomUUID()));
    return id;
  }

  checkKeys(project, key) {
    if (!KEY_RE.test(project) || !KEY_RE.test(key)) throw httpError(400, "Bad project or ticket key");
  }

  get(project, key) {
    const id = `${project}/${key}`;
    if (this.cache.has(id)) return this.cache.get(id);
    this.checkKeys(project, key);
    const t = this.load(project, key) ?? hidden({ project, key, notes: "", questions: [], inbox: [], agent: null }, { _id: randomUUID() });
    this.cache.set(id, t);
    return t;
  }

  // A ticket as stored right now, bypassing the cache; null when it has no row.
  load(project, key) {
    const row = this.stmt("SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.key = ? AND t.key = ?").get(project, key);
    if (!row) return null;
    const t = hidden({ ...parse(row.extra), project, key, notes: "", questions: [], inbox: [], agent: null }, { _id: row.id });
    if (row.auto != null) t.auto = JSON.parse(row.auto);
    const note = this.stmt("SELECT body FROM notes WHERE task_id = ?").get(row.id);
    if (note) t.notes = note.body;
    const agent = this.stmt("SELECT * FROM agents WHERE task_id = ?").get(row.id);
    if (agent) t.agent = compact({ ...parse(agent.extra), from: agent.name, role: agent.role, runtime: agent.runtime, host: agent.host, tmuxPane: agent.tmux_pane, lastSeen: agent.last_seen });
    t.questions = this.stmt("SELECT * FROM questions WHERE task_id = ? ORDER BY rowid").all(row.id).map((q) =>
      compact({ ...parse(q.extra), id: q.id, text: q.text, from: q.asked_by, blocks: q.blocks, status: q.status, createdAt: q.created_at, answer: q.answer, answeredAt: q.answered_at, refines: q.refines_id, kind: q.kind }),
    );
    t.inbox = this.stmt("SELECT * FROM messages WHERE task_id = ? ORDER BY rowid").all(row.id).map((m) =>
      compact({ ...parse(m.extra), id: m.id, createdAt: m.created_at, kind: m.kind, questionId: m.question_id, question: m.question_text, text: m.text, attachments: m.attachments == null ? null : JSON.parse(m.attachments), consumedAt: m.consumed_at, via: m.via }),
    );
    for (const r of this.rows(t)) this.written.set(r.id, r.sig);
    return t;
  }

  save(t) {
    this.checkKeys(t.project, t.key);
    if (!t._id) hidden(t, { _id: randomUUID() });
    this.tx(() => {
      const at = now();
      for (const r of this.rows(t)) {
        if (this.written.get(r.id) === r.sig) continue;
        r.write(at);
        this.written.set(r.id, r.sig);
      }
    });
  }

  projectId(key) {
    let id = this.projectIds.get(key) ?? this.stmt("SELECT id FROM projects WHERE key = ?").get(key)?.id;
    if (!id) {
      id = randomUUID();
      const at = now();
      this.stmt("INSERT INTO projects (id, key, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, key, at, at);
    }
    this.projectIds.set(key, id);
    return id;
  }

  // The rows one ticket maps to, each with a signature of its content and a writer.
  // Task first: the other rows reference it.
  rows(t) {
    const tid = t._id;
    const out = [];
    const row = (id, values, write) => out.push({ id, sig: JSON.stringify(values), write: (at) => write(values, at) });
    const extra = json(pickExtra(t, TICKET_KEYS));
    row(`tasks:${tid}`, [t.project, t.key, t.auto == null ? null : JSON.stringify(t.auto), extra], ([project, key, auto, ex], at) =>
      this.stmt(`INSERT INTO tasks (id, project_id, key, auto, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET auto = excluded.auto, extra = excluded.extra, updated_at = excluded.updated_at`)
        .run(tid, this.projectId(project), key, auto, ex, firstSeen(t) ?? at, at),
    );
    if (t.notes || this.written.has(`notes:${tid}`)) {
      row(`notes:${tid}`, [String(t.notes ?? "")], ([body], at) =>
        this.stmt(`INSERT INTO notes (id, task_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (task_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`).run(randomUUID(), tid, body, at, at),
      );
    }
    if (t.agent) {
      const a = t.agent;
      row(`agents:${tid}`, [a.from, a.role, a.runtime, a.host, a.tmuxPane, a.lastSeen, json(pickExtra(a, AGENT_KEYS))].map(nul), (v, at) =>
        this.stmt(`INSERT INTO agents (id, project_id, task_id, name, role, runtime, host, tmux_pane, last_seen, extra, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (task_id) DO UPDATE SET name = excluded.name, role = excluded.role, runtime = excluded.runtime, host = excluded.host,
            tmux_pane = excluded.tmux_pane, last_seen = excluded.last_seen, extra = excluded.extra, updated_at = excluded.updated_at`)
          .run(randomUUID(), this.projectId(t.project), tid, ...v, at, at),
      );
    }
    for (const q of t.questions) {
      const v = [q.text, q.from, q.blocks, q.status, q.answer, q.answeredAt, q.refines, q.kind, json(pickExtra(q, QUESTION_KEYS))].map(nul);
      row(`questions:${q.id}`, v, (vals, at) =>
        this.stmt(`INSERT INTO questions (id, task_id, text, asked_by, blocks, status, answer, answered_at, refines_id, kind, extra, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET text = excluded.text, asked_by = excluded.asked_by, blocks = excluded.blocks, status = excluded.status,
            answer = excluded.answer, answered_at = excluded.answered_at, refines_id = excluded.refines_id, kind = excluded.kind,
            extra = excluded.extra, updated_at = excluded.updated_at`)
          .run(q.id, tid, ...vals, q.createdAt ?? at, at),
      );
    }
    for (const m of t.inbox) {
      const v = [m.kind, m.questionId, m.question, m.text, m.attachments == null ? null : JSON.stringify(m.attachments), m.consumedAt, m.via, json(pickExtra(m, MESSAGE_KEYS))].map(nul);
      row(`messages:${m.id}`, v, (vals, at) =>
        this.stmt(`INSERT INTO messages (id, task_id, kind, question_id, question_text, text, attachments, consumed_at, via, extra, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET consumed_at = excluded.consumed_at, via = excluded.via, text = excluded.text,
            attachments = excluded.attachments, extra = excluded.extra, updated_at = excluded.updated_at`)
          .run(m.id, tid, ...vals, m.createdAt ?? at, at),
      );
    }
    return out;
  }

  // Every ticket that has stored state, so hub-only tickets still show up.
  listStored() {
    return this.stmt("SELECT p.key AS project, t.key AS key FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY p.key, t.key")
      .all()
      .map((r) => this.get(r.project, r.key));
  }

  // Questions asked by agents (`hub ask`) or by you. `status`/`kind` let the initial round
  // add proposed questions; `refines` links a reworded question to the one it replaces.
  ask(project, key, { text, from, blocks, status = "open", kind = null, refines = null }, actor) {
    if (!QUESTION_STATUSES.includes(status)) throw httpError(400, "Bad status");
    const t = this.get(project, key);
    const q = compact({ id: randomUUID(), text, from: from || "tú", blocks: blocks || "", status, createdAt: now(), kind, refines });
    return this.tx(() => {
      t.questions.push(q);
      this.save(t);
      this.event(q, "created", null, status, actor ?? q.from, refines ? { refines } : null);
      return q;
    });
  }

  // The questions an agent needs before it starts; you refine them in the hub, then release.
  propose(project, key, { questions, from }) {
    const list = (questions ?? []).filter((q) => String(q?.text ?? "").trim());
    if (!list.length) throw httpError(400, "No questions");
    return this.tx(() => list.map((q) => this.ask(project, key, { text: String(q.text).trim(), blocks: q.blocks, from, status: "proposed", kind: "initial" })));
  }

  question(t, questionId) {
    const q = t.questions.find((x) => x.id === questionId);
    if (!q) throw httpError(404, "Question not found");
    return q;
  }

  answer(project, key, questionId, answer, attachments = [], actor = "tú") {
    const t = this.get(project, key);
    const q = this.question(t, questionId);
    if (q.status === "refined") throw httpError(409, "Question was refined; answer the new one");
    return this.tx(() => {
      const from = q.status;
      Object.assign(q, { status: "answered", answer, answeredAt: now() });
      this.save(t);
      this.event(q, "answered", from, "answered", actor);
      this.enqueue(t, { kind: "answer", questionId, question: q.text, text: answer, attachments });
      return q;
    });
  }

  // Questions the client must answer stay visible but stop blocking the agent.
  setStatus(project, key, questionId, status, actor = "tú") {
    const t = this.get(project, key);
    const q = this.question(t, questionId);
    if (q.status === status) return q;
    if (!QUESTION_STATUSES.includes(status) || status === "refined" || status === "answered") throw httpError(400, "Bad status");
    if (!(NEXT[q.status] ?? QUESTION_STATUSES).includes(status)) throw httpError(409, `Cannot go from ${q.status} to ${status}`);
    return this.tx(() => {
      const from = q.status;
      q.status = status;
      this.save(t);
      this.event(q, "status", from, status, actor);
      return q;
    });
  }

  // Rewords a pending question: the old one becomes "refined", the new one takes its place.
  refine(project, key, questionId, { text, blocks }, actor = "tú") {
    const t = this.get(project, key);
    const q = this.question(t, questionId);
    if (!PENDING_STATUSES.includes(q.status)) throw httpError(409, `Cannot refine a ${q.status} question`);
    return this.tx(() => {
      const from = q.status;
      const child = this.ask(project, key, { text, from: q.from, blocks: blocks ?? q.blocks, status: from, kind: q.kind ?? null, refines: q.id }, actor);
      q.status = "refined";
      this.save(t);
      this.event(q, "refined", from, "refined", actor, { by: child.id });
      return child;
    });
  }

  // Closes the initial round: proposed questions with an answer here are answered, the rest
  // open. The agent gets one message with the whole list.
  releaseInitial(project, key, answers = {}, actor = "tú") {
    const t = this.get(project, key);
    const proposed = t.questions.filter((q) => q.status === "proposed");
    if (!proposed.length) throw httpError(409, "No proposed questions");
    return this.tx(() => {
      const at = now();
      for (const q of proposed) {
        const a = String(answers[q.id] ?? "").trim();
        if (a) Object.assign(q, { status: "answered", answer: a.slice(0, 8000), answeredAt: at });
        else q.status = "open";
      }
      this.save(t);
      for (const q of proposed) this.event(q, "released", "proposed", q.status, actor);
      const msg = this.enqueue(t, { kind: "message", text: initialSummary(t, proposed), attachments: [] });
      return { questions: proposed, message: msg };
    });
  }

  event(q, type, from, to, actor, data = null) {
    const at = now();
    this.stmt(`INSERT INTO question_events (id, question_id, type, from_status, to_status, actor, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), q.id, type, from, to, actor ?? null, data ? JSON.stringify(data) : null, at, at);
  }

  // A question's history, oldest first, following the chain of questions it refines.
  history(project, key, questionId) {
    const t = this.get(project, key);
    const chain = [];
    for (let q = this.question(t, questionId); q; q = q.refines ? t.questions.find((x) => x.id === q.refines) : null) chain.unshift(q);
    return chain.flatMap((q) =>
      this.stmt("SELECT * FROM question_events WHERE question_id = ? ORDER BY created_at, rowid").all(q.id).map((e) =>
        compact({ id: e.id, questionId: q.id, text: q.text, type: e.type, from: e.from_status, to: e.to_status, actor: e.actor, data: parse(e.data, null), at: e.created_at }),
      ),
    );
  }

  message(project, key, text, attachments = []) {
    return this.enqueue(this.get(project, key), { kind: "message", text, attachments });
  }

  enqueue(t, msg) {
    const m = { id: randomUUID(), createdAt: now(), ...msg };
    t.inbox.push(m);
    this.save(t);
    this.wake(t);
    return m;
  }

  setNotes(project, key, notes) {
    const t = this.get(project, key);
    t.notes = notes;
    this.save(t);
  }

  seenAgent(project, key, agent) {
    const t = this.get(project, key);
    t.agent = { ...t.agent, ...agent, lastSeen: now() };
    this.save(t);
  }

  // Pending messages; a waiter for one question only takes that answer.
  take(t, questionId) {
    const pending = t.inbox.filter((m) => !m.consumedAt && (!questionId || m.questionId === questionId));
    if (!pending.length) return [];
    for (const m of pending) m.consumedAt = now();
    this.save(t);
    return pending;
  }

  // Pending messages for the host bridge, which pastes them into tmux and then acks.
  pending(project) {
    const keys = this.stmt(`SELECT DISTINCT t.key FROM messages m JOIN tasks t ON t.id = m.task_id JOIN projects p ON p.id = t.project_id
      WHERE p.key = ? AND m.consumed_at IS NULL ORDER BY t.key`).all(project).map((r) => r.key);
    return keys
      .filter((key) => !this.listening(project, key))
      .map((key) => ({ key, messages: this.get(project, key).inbox.filter((m) => !m.consumedAt) }))
      .filter((t) => t.messages.length);
  }

  ack(project, key, ids, via) {
    const t = this.get(project, key);
    for (const m of t.inbox) if (ids.includes(m.id) && !m.consumedAt) Object.assign(m, { consumedAt: now(), via });
    this.save(t);
  }

  waitFor(project, key, { questionId, timeoutMs }) {
    const t = this.get(project, key);
    const ready = this.take(t, questionId);
    if (ready.length) return Promise.resolve(ready);
    const id = `${project}/${key}`;
    return new Promise((resolve) => {
      const w = { questionId, resolve: (msgs) => { clearTimeout(timer); set.delete(w); resolve(msgs); } };
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      set.add(w);
      const timer = setTimeout(() => w.resolve([]), timeoutMs);
    });
  }

  // An agent is listening only while a `hub inbox` waits (no questionId): it takes every message.
  // A `hub ask` waits for its own answer only, so other messages still go out by tmux.
  listening(project, key) {
    return [...(this.waiters.get(`${project}/${key}`) ?? [])].some((w) => !w.questionId);
  }

  wake(t) {
    // `hub ask` waiters go first so a parallel `hub inbox` does not steal their answer.
    const waiters = [...(this.waiters.get(`${t.project}/${t.key}`) ?? [])].sort((a, b) => !!b.questionId - !!a.questionId);
    for (const w of waiters) {
      const msgs = this.take(t, w.questionId);
      if (msgs.length) w.resolve(msgs);
    }
  }
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v ?? 0;
  if (done > MIGRATIONS.length) throw new Error(`overhaul.db is at schema ${done}, newer than this code (${MIGRATIONS.length})`);
  for (let v = done + 1; v <= MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v - 1]);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v, now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

// What the agent reads when you close the initial round.
function initialSummary(t, released) {
  const final = (q) => q.text;
  const lines = released.map((q, i) =>
    q.status === "answered" ? `${i + 1}. ${final(q)}\n   Respuesta: ${q.answer}` : `${i + 1}. ${final(q)}\n   Sin respuesta todavía: llegará como "Respuesta a …"; sigue con lo que no dependa de ella.`,
  );
  const dropped = t.questions.filter((q) => q.kind === "initial" && q.status === "dismissed").length;
  return [
    "Preguntas iniciales revisadas:",
    ...lines,
    dropped ? `(${dropped} descartada${dropped === 1 ? "" : "s"}: no hacen falta.)` : null,
    "Ya puedes seguir.",
  ].filter(Boolean).join("\n");
}

// Ticket objects carry their row id without it showing up in JSON.
function hidden(obj, props) {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(obj, k, { value: v, enumerable: false, writable: true, configurable: true });
  return obj;
}

function firstSeen(t) {
  const times = [...t.questions, ...t.inbox].map((x) => x.createdAt).filter(Boolean).sort();
  return times[0] ?? null;
}

function pickExtra(obj, known) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!known.includes(k) && v !== undefined) out[k] = v;
  return out;
}

const json = (obj) => (Object.keys(obj).length ? JSON.stringify(obj) : null);
const nul = (v) => (v === undefined ? null : v);
const parse = (s, fallback = {}) => (s == null ? fallback : JSON.parse(s));

// Optional fields: a NULL column means the field was never set.
function compact(obj) {
  for (const k of Object.keys(obj)) if (obj[k] == null) delete obj[k];
  return obj;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const now = () => new Date().toISOString();
