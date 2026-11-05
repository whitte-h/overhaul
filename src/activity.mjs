// Conversation log per agent window (host + "session:window"), fed by the Claude Code hook:
// what the agent was asked, its final replies, and permission requests.
import fs from "node:fs";
import path from "node:path";

const KEEP = 300;

export class Activity {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "activity");
    this.cache = new Map();
  }

  file(host, win) {
    return path.join(this.dir, encodeURIComponent(host), `${encodeURIComponent(win)}.json`);
  }

  list(host, win) {
    const f = this.file(host, win);
    if (!this.cache.has(f)) this.cache.set(f, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []);
    return this.cache.get(f);
  }

  add(host, win, entry) {
    const list = this.list(host, win);
    list.push({ at: new Date().toISOString(), ...entry });
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    const f = this.file(host, win);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify(list), { mode: 0o600 });
  }

  recent(host, win, n) {
    return this.list(host, win).slice(-n);
  }

  // Messages the bridge relays to an orchestrator start with "[overhaul] Ticket KEY …" (or the
  // install's message_tag, "[work-hub]" before the rename).
  // That prompt and the replies after it, until the next prompt, also go to the ticket's
  // own log ("ticket:KEY") so the ticket tab shows them.
  record(host, win, entry) {
    // Claude's idle notice says nothing new; the window state already shows "en espera".
    if (entry.event === "Notification" && /waiting for your input/i.test(entry.text)) return;
    const key = `${host}|${win}`;
    if (entry.event === "UserPromptSubmit") this.relaying.set(key, relayedTicket(entry.text));
    const ticket = this.relaying.get(key) ?? null;
    this.add(host, win, ticket ? { ...entry, ticket } : entry);
    if (ticket) this.add(host, `ticket:${ticket}`, { ...entry, via: win });
  }

  get relaying() {
    return (this._relaying ??= new Map());
  }
}

export function relayedTicket(text) {
  return String(text ?? "").match(/^\[[\w.-]+\] Ticket ([A-Z][A-Z0-9]+-\d+)\b/)?.[1] ?? null;
}

// Numbered choices of a Claude Code prompt ("❯ 1. Yes", "2. Yes, and don't ask again…").
export function promptOptions(tail) {
  const lines = String(tail ?? "").split("\n").slice(-20);
  const options = [];
  let question = "";
  for (const l of lines) {
    const q = l.match(/(Do you want to .*|Would you like to .*)$/) ?? l.match(/^\s*([^❯│].*\?)\s*$/);
    if (q) question = q[1].trim();
    const m = l.match(/^\s*(?:[❯>]\s*)?([1-9])\.\s+(.+?)\s*$/);
    if (m) options.push({ key: m[1], label: m[2] });
  }
  return { question, options };
}
