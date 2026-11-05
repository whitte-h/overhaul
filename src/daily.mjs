// Daily summary drafts: a private markdown note per project and day that you review
// and copy into the client's daily yourself. It is never posted anywhere.
import { PENDING_STATUSES } from "./store.mjs";
import fs from "node:fs";
import { localHost } from "./env.mjs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

export class Daily {
  constructor(cfg, store, ticketsFor) {
    this.cfg = cfg;
    this.store = store;
    this.ticketsFor = ticketsFor; // async (project, refresh) -> tracker tickets
    this.dir = path.join(cfg.dataDir, "daily");
  }

  start() {
    const tick = () => this.tick().catch((err) => console.error("daily:", err.message));
    setInterval(tick, 60_000);
    tick();
  }

  async tick() {
    const { date, time } = localNow(this.cfg.timezone);
    for (const p of this.cfg.projects) {
      if (p.daily.enabled && time >= p.daily.at && !fs.existsSync(this.file(p.id, date))) await this.generate(p);
    }
  }

  file(projectId, date) {
    return path.join(this.dir, projectId, `${date}.md`);
  }

  latest(projectId) {
    const dir = path.join(this.dir, projectId);
    if (!fs.existsSync(dir)) return null;
    const last = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().pop();
    return last ? { date: last.slice(0, 10), markdown: fs.readFileSync(path.join(dir, last), "utf8") } : null;
  }

  async generate(p) {
    const { date } = localNow(this.cfg.timezone);
    const since = Date.now() - DAY_MS;
    const tickets = await this.ticketsFor(p, true);
    const changes = this.statusChanges(p, tickets);
    const stored = this.store.listStored().filter((t) => t.project === p.id);
    const title = (key) => tickets.find((t) => t.key === key)?.title ?? "";
    const inc = new Set(p.daily.include);
    const out = [`# Daily ${p.name} · ${date}`, ""];

    if (inc.has("status_changes")) {
      section(out, "Movimientos en el tracker", changes.map((c) => `${c.key} ${c.title}: ${c.from ?? "nuevo"} → ${c.to}`));
    }
    if (inc.has("decisions")) {
      const decided = stored.flatMap((t) =>
        t.questions.filter((q) => q.status === "answered" && Date.parse(q.answeredAt) > since).map((q) => `${t.key}: ${q.text} → ${q.answer}`),
      );
      section(out, "Decisiones de ayer", decided);
    }
    if (inc.has("commits")) section(out, "Commits (últimas 24 h)", await this.commits(p));
    if (inc.has("today")) {
      const active = tickets.filter((t) => p.autoWork.statuses.includes(String(t.status).toLowerCase()));
      section(out, "Hoy", active.map((t) => `${t.key} ${t.title}`));
    }
    if (inc.has("blockers")) {
      const blockers = stored.flatMap((t) =>
        t.questions
          .filter((q) => PENDING_STATUSES.includes(q.status))
          .map((q) => `${t.key}${title(t.key) ? ` ${title(t.key)}` : ""}: ${q.text}${q.status === "client" ? " (pendiente del cliente)" : ""}`),
      );
      section(out, "Bloqueos", blockers);
    }

    const file = this.file(p.id, date);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, out.join("\n"), { mode: 0o600 });
    return { date, markdown: out.join("\n") };
  }

  // Compares today's tracker statuses with the last snapshot, then stores the new one.
  statusChanges(p, tickets) {
    const snapFile = path.join(this.dir, p.id, "statuses.json");
    const prev = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, "utf8")) : null;
    const now = Object.fromEntries(tickets.map((t) => [t.key, t.status]));
    fs.mkdirSync(path.dirname(snapFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(snapFile, JSON.stringify(now), { mode: 0o600 });
    if (!prev) return [];
    const changes = tickets.filter((t) => prev[t.key] !== t.status).map((t) => ({ key: t.key, title: t.title, from: prev[t.key], to: t.status }));
    for (const key of Object.keys(prev)) if (!(key in now)) changes.push({ key, title: "", from: prev[key], to: "cerrado o reasignado" });
    return changes;
  }

  // Only repos on this machine; other hosts are not reachable from here.
  async commits(p) {
    if (p.host !== localHost()) return [];
    const lines = [];
    for (const repo of p.repos) {
      try {
        const { stdout } = await run("git", ["-C", repo, "log", "--all", "--since=24.hours", "--no-merges", "--format=%h %s"]);
        for (const l of stdout.trim().split("\n").filter(Boolean)) lines.push(`${path.basename(repo)} ${l}`);
      } catch {}
    }
    return lines;
  }
}

function section(out, heading, items) {
  out.push(`## ${heading}`, ...(items.length ? items.map((i) => `- ${i}`) : ["- Nada"]), "");
}

export function localNow(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
