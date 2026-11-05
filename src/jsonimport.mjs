// One-time move of the JSON ticket files (dataDir/tickets/<project>/<KEY>.json, the store
// before SQLite) into overhaul.db. The hub runs it at startup: only when the database has no
// tickets and the import never ran. The JSON files stay where they are; a copy goes to
// dataDir/backups/ first. Every ticket is read back and compared before the commit, so a
// mismatch leaves the database as it was.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const KEY_RE = /^[A-Za-z0-9._-]{1,80}$/;
const META = "json_import";

// [{ project, key, file }] for every JSON ticket file, sorted.
export function jsonTicketFiles(dataDir) {
  const dir = path.join(dataDir, "tickets");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const project of fs.readdirSync(dir).sort()) {
    const pdir = path.join(dir, project);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const f of fs.readdirSync(pdir).sort()) {
      if (f.endsWith(".json")) out.push({ project, key: f.slice(0, -5), file: path.join(pdir, f) });
    }
  }
  return out;
}

// A JSON ticket in the shape the store hands out: project and key from its path, missing
// lists filled in, items without an id given one.
export function normalizeTicket(raw, project, key) {
  const t = { ...raw, project, key };
  t.notes = typeof raw.notes === "string" ? raw.notes : "";
  t.questions = (Array.isArray(raw.questions) ? raw.questions : []).map((q) => ({ ...q, id: q.id ?? randomUUID(), text: String(q.text ?? ""), status: q.status ?? "open" }));
  t.inbox = (Array.isArray(raw.inbox) ? raw.inbox : []).map((m) => ({ ...m, id: m.id ?? randomUUID() }));
  t.agent = raw.agent && typeof raw.agent === "object" ? raw.agent : null;
  if (t.auto == null) delete t.auto;
  return t;
}

// Same content, whatever the key order or fields left null.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] != null) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// What differs between the JSON files and the database; [] when everything matches.
export function verifyJsonImport(store, files = jsonTicketFiles(store.dataDir)) {
  const problems = [];
  for (const f of files) {
    if (!KEY_RE.test(f.project) || !KEY_RE.test(f.key)) continue;
    let want;
    try {
      want = normalizeTicket(JSON.parse(fs.readFileSync(f.file, "utf8")), f.project, f.key);
    } catch (err) {
      problems.push(`${f.project}/${f.key}: JSON ilegible (${err.message})`);
      continue;
    }
    const got = store.load(f.project, f.key);
    if (!got) problems.push(`${f.project}/${f.key}: falta en la base`);
    else for (const part of ["notes", "questions", "inbox", "agent", "auto"]) {
      if (!same(want[part], got[part])) problems.push(`${f.project}/${f.key}: ${part} distinto`);
    }
  }
  return problems;
}

// { status: "none" | "done" | "skipped" | "imported", ... }. Throws (database untouched)
// when a file cannot be read or a ticket does not read back the same.
export function importJsonTickets(store, { stamp = new Date().toISOString().replace(/[:.]/g, "-") } = {}) {
  const prior = store.meta(META);
  if (prior) return { status: "done", ...JSON.parse(prior) };
  const files = jsonTicketFiles(store.dataDir);
  if (!files.length) return { status: "none" };
  const tasks = store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  if (tasks) return { status: "skipped", reason: `la base ya tiene ${tasks} tickets` };

  const bad = files.filter((f) => !KEY_RE.test(f.project) || !KEY_RE.test(f.key)).map((f) => path.relative(store.dataDir, f.file));
  const good = files.filter((f) => KEY_RE.test(f.project) && KEY_RE.test(f.key));
  const tickets = good.map((f) => {
    try {
      return normalizeTicket(JSON.parse(fs.readFileSync(f.file, "utf8")), f.project, f.key);
    } catch (err) {
      throw new Error(`${f.file}: ${err.message}`);
    }
  });

  const backup = path.join(store.dataDir, "backups", `tickets-json-${stamp}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  fs.cpSync(path.join(store.dataDir, "tickets"), backup, { recursive: true, errorOnExist: true, force: false });

  const counts = { tickets: 0, questions: 0, messages: 0 };
  store.tx(() => {
    for (const t of tickets) {
      store.save(t);
      for (const q of t.questions) store.event(q, "imported", null, q.status, "json");
      counts.tickets++;
      counts.questions += t.questions.length;
      counts.messages += t.inbox.length;
    }
    // The comparison reads the rows back, not the objects just written.
    store.written.clear();
    const problems = verifyJsonImport(store, good);
    if (problems.length) throw new Error(`la importación no coincide con los JSON: ${problems.join("; ")}`);
    store.setMeta(META, JSON.stringify({ at: new Date().toISOString(), backup, ...counts, ignored: bad }));
  });
  // Saved objects were the normalized JSON; the next get() reads what the database holds.
  store.cache.clear();
  store.written.clear();
  return { status: "imported", backup, ...counts, ignored: bad };
}
