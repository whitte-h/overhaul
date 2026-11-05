// Starts an agent for tickets that enter an "in progress" status: one git worktree and
// one tmux window per ticket on this machine. With plan_first the agent must get your OK
// through the hub before it changes code. Never relaunches by itself after an exit.
import fs from "node:fs";
import { localHost, tool } from "./env.mjs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_ENV } from "./restart.mjs";

const run = promisify(execFile);
const TMUX = tool("tmux", process.env.TMUX_BIN);
const KEY_RE = /^[A-Za-z0-9._-]{1,80}$/;

export class AutoWork {
  constructor(cfg, store, ticketsFor) {
    this.cfg = cfg;
    this.store = store;
    this.ticketsFor = ticketsFor;
    this.running = false;
  }

  start() {
    const tick = () => this.tick().catch((err) => console.error("auto_work:", err.message));
    setInterval(tick, 120_000);
    setTimeout(tick, 5_000);
  }

  // Why a project cannot auto-work here, or null when it can.
  blocker(p) {
    if (!p.autoWork.enabled) return "desactivado";
    if (p.host !== localHost()) return `los agentes corren en ${p.host}; auto_work solo lanza en ${localHost()}`;
    return null;
  }

  // With repos_by_group, a ticket only runs in its group's repo; no silent fallback.
  repoFor(p, t) {
    const aw = p.autoWork;
    if (!Object.keys(aw.repoByGroup).length) return aw.repo;
    return aw.repoByGroup[String(t.group ?? "").toLowerCase()] ?? null;
  }

  ticketBlocker(p, t) {
    return this.blocker(p) ?? (this.repoFor(p, t) ? null : `sin repo para ${t.group || "este ticket"} en repos_by_group`);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const p of this.cfg.projects) {
        if (this.blocker(p)) continue;
        const tickets = await this.ticketsFor(p, false);
        let active = 0;
        for (const t of this.store.listStored().filter((s) => s.project === p.id && s.auto?.status === "running")) {
          if (await paneAlive(t.auto.pane)) active++;
          else this.setAuto(p.id, t.key, { ...t.auto, status: "exited", exitedAt: new Date().toISOString() });
        }
        for (const t of tickets) {
          if (active >= p.autoWork.maxParallel) break;
          if (!p.autoWork.statuses.includes(String(t.status).toLowerCase())) continue;
          if (this.store.get(p.id, t.key).auto || this.ticketBlocker(p, t)) continue;
          await this.launch(p, t);
          active++;
        }
      }
    } finally {
      this.running = false;
    }
  }

  async launch(p, t) {
    if (!KEY_RE.test(t.key)) throw new Error(`Bad ticket key ${t.key}`);
    const aw = p.autoWork;
    const repo = this.repoFor(p, t);
    const branch = t.key.toLowerCase();
    const worktree = path.join(aw.worktreeRoot ?? path.join(path.dirname(repo), ".worktrees"), t.key);
    try {
      if (!fs.existsSync(worktree)) await addWorktree(repo, worktree, branch, aw.baseRef);
      const promptFile = path.join(this.cfg.dataDir, "prompts", p.id, `${t.key}.md`);
      fs.mkdirSync(path.dirname(promptFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(promptFile, prompt(p, t, branch, this.cfg.messageTag), { mode: 0o600 });

      await run(TMUX, ["has-session", "-t", `=${aw.tmuxSession}`]).catch(() =>
        run(TMUX, ["new-session", "-d", "-s", aw.tmuxSession, "-c", repo]),
      );
      // Interactive login zsh so per-folder wrappers (e.g. the claude() account switch) apply.
      const cmd = `zsh -lic '${aw.agentCommand} "$(cat ${promptFile})"'`;
      const { stdout } = await run(TMUX, [
        "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${aw.tmuxSession}:`, "-n", t.key, "-c", worktree,
        "-e", `HUB_PROJECT=${p.id}`, "-e", `HUB_TICKET=${t.key}`, "-e", `HUB_AGENT_NAME=auto`,
        ...Object.entries(AGENT_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]), cmd,
      ]);
      const pane = stdout.trim();
      this.setAuto(p.id, t.key, { status: "running", pane, repo, worktree, branch, launchedAt: new Date().toISOString() });
      this.store.seenAgent(p.id, t.key, { from: "auto", host: localHost(), tmuxPane: pane });
      console.log(`auto_work: ${p.id}/${t.key} in ${worktree} (${pane})`);
    } catch (err) {
      this.setAuto(p.id, t.key, { status: "failed", error: String(err.stderr || err.message).slice(0, 500), at: new Date().toISOString() });
    }
  }

  setAuto(project, key, auto) {
    const t = this.store.get(project, key);
    t.auto = auto;
    this.store.save(t);
  }

  // Clears the record so the next tick may launch again (the "Relanzar" button).
  reset(project, key) {
    const t = this.store.get(project, key);
    delete t.auto;
    this.store.save(t);
  }
}

async function addWorktree(repo, dir, branch, baseRef) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const exists = await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  const args = exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, baseRef];
  await run("git", ["-C", repo, ...args]);
}

export async function paneAlive(pane) {
  if (!pane || !/^%\d+$/.test(pane)) return false;
  return run(TMUX, ["display-message", "-p", "-t", pane, "#{pane_id}"]).then(() => true, () => false);
}

export async function capturePane(pane, lines = 60) {
  if (!(await paneAlive(pane))) return null;
  const { stdout } = await run(TMUX, ["capture-pane", "-p", "-J", "-t", pane, "-S", `-${lines}`]);
  return stdout.replace(/\s+$/, "");
}

function prompt(p, t, branch, tag = "overhaul") {
  const steps = [
    `Trabaja el ticket ${t.key}: ${t.title}`,
    t.url ? `Tracker: ${t.url}` : null,
    `Estás en un worktree en la rama ${branch}. HUB_PROJECT y HUB_TICKET ya están definidos.`,
    "",
    "Reglas:",
    "- Lee el ticket completo con las herramientas del tracker que tengas. Si no puedes, pide los detalles con hub ask.",
    p.autoWork.planFirst && p.autoWork.initialQuestions
      ? '- Primero, sin cambiar código, propón las preguntas que necesitas resolver para completar el ticket: `overhaul propose "<pregunta 1>" "<pregunta 2>" …` y detente. El usuario las refina y responde en el hub; te llega un mensaje "Preguntas iniciales revisadas" en esta ventana. Si no necesitas ninguna, sáltate este paso.'
      : null,
    p.autoWork.planFirst
      ? '- Antes de cambiar código, corre `hub ask "Plan: <tu plan en pocas líneas>" --blocks "inicio"` y detente: la respuesta llega como mensaje en esta ventana. Solo empieza si lo aprueba.'
      : null,
    '- Si te falta una decisión o un dato, corre `hub ask "<pregunta>" --blocks "<qué frena>"` y sigue con otra parte: la respuesta llega después como mensaje en esta ventana.',
    "- Las instrucciones y respuestas del usuario llegan como mensajes \"[" + tag + "] …\" en esta ventana.",
    "- Nunca copies preguntas ni respuestas del hub al repo, a commits ni al tracker.",
    "- No hagas push, no abras PR y no cambies el estado del ticket sin que te lo pida.",
  ];
  return steps.filter((s) => s !== null).join("\n") + "\n";
}
