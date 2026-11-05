// Orca terminals as the bridge's other backend (projects with `terminals: orca`): one terminal
// per ticket in the project's Orca worktree, titled like the tmux window would be (k-257).
// Talks to the Orca runtime on this host through its CLI. Dependency-free: copied to agent
// hosts with the CLI.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG_DIR } from "./env.mjs";

const run = promisify(execFile);
export const ORCA = process.env.ORCA_BIN || "orca";

// Every call asks for JSON; a refusal comes back as { ok: false, error } with a non-zero exit.
export async function orca(args, { exec = run } = {}) {
  let stdout;
  try {
    ({ stdout } = await exec(ORCA, [...args, "--json"], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
  } catch (err) {
    stdout = err.stdout;
    if (!stdout) throw new Error(`orca ${args.slice(0, 2).join(" ")}: ${String(err.stderr || err.message).trim().split("\n").pop()}`);
  }
  const res = JSON.parse(stdout);
  if (!res.ok) throw new Error(`orca ${args.slice(0, 2).join(" ")}: ${res.error?.message ?? res.error?.code ?? "failed"}`);
  return res.result;
}

const expand = (p) => String(p).replace(/^~(?=\/|$)/, process.env.HOME);
export const worktreeOf = (p) => expand(p.terminals?.worktree ?? "");
const selector = (dir) => `path:${dir}`;

// POSIX single quotes: the command is typed into the terminal's login shell.
export const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

// What the terminal types to start (or resume) the agent: cd to its folder, the hub's variables,
// and the agent with a fixed session id. pi takes the id to start or resume; Claude starts with
// --session-id and resumes with --resume.
export function agentCommand({ command, sessionId, dir, env, resume = false }) {
  const pi = /^pi(\s|$)/.test(command.trim());
  const id = sessionId ? (pi ? ` --session-id ${sessionId}` : resume ? ` --resume ${sessionId}` : ` --session-id ${sessionId}`) : "";
  const vars = Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(" ");
  return `cd ${shq(dir)} && ${vars ? `${vars} ` : ""}${command.trim()}${id}`;
}

// Terminals of the orca projects as bridge windows. `session` is the project's tmux session name,
// so the hub files them under the project like its tmux windows ("personal:k-257").
export async function listTerminals(projects, { exec } = {}) {
  const out = [];
  for (const p of projects) {
    const dir = worktreeOf(p);
    if (!dir) continue;
    try {
      const { terminals = [] } = await orca(["terminal", "list", "--worktree", selector(dir)], { exec });
      for (const t of terminals) {
        if (t.orphaned || !t.writable || !t.title) continue;
        out.push({
          backend: "orca", session: p.session, name: t.title, pane: t.handle, command: t.agentIdentity ?? "",
          worktree: t.worktreePath ?? dir, paneKey: `${t.tabId}:${t.leafId}`, project: p.id,
        });
      }
    } catch (err) {
      console.error(`bridge: ${err.message}`);
    }
  }
  return out;
}

// What Orca knows about each agent from its status hooks (pi loads orca-agent-status.ts),
// by pane key: { state: "working" | "done" | …, tool, last }.
export async function agentStates({ exec } = {}) {
  const { worktrees = [] } = await orca(["worktree", "ps"], { exec });
  const states = new Map();
  for (const w of worktrees) {
    for (const a of w.agents ?? []) {
      states.set(a.paneKey, { state: a.state, tool: a.toolName ?? null, last: a.lastAssistantMessage ?? null });
    }
  }
  return states;
}

// Orca's agent state, when it has one, decides; the screen fills in the line and any dialog.
// Unknown states (permission prompts and the like) count as waiting on you unless the screen
// shows something else.
export function mergeState(screen, agent) {
  if (!agent?.state) return screen;
  if (agent.state === "working") return screen.state === "working" ? screen : { state: "working", line: agent.tool ? `Working · ${agent.tool}` : "Working" };
  if (agent.state === "done" || agent.state === "idle") return screen.state === "needs_input" ? screen : { state: "idle", line: screen.state === "idle" ? screen.line : "" };
  return screen.state === "needs_input" ? screen : { state: "needs_input", line: "Esperando tu permiso" };
}

export async function readScreen(handle, { exec } = {}) {
  const { terminal } = await orca(["terminal", "read", "--terminal", handle, "--screen"], { exec });
  return (terminal.tail ?? []).join("\n");
}

// With --enter, Orca bracket-pastes a prompt to a running agent and submits it, so multi-line
// messages arrive as one. pi reports no submission (provider "unsupported"), so no --wait-submit.
// Without Enter, text goes to the PTY as typed, or as one bracketed paste with `paste`.
export async function sendText(handle, text, { enter = true, paste = false, exec } = {}) {
  const body = !enter && paste ? `\x1b[200~${text}\x1b[201~` : text;
  await orca(["terminal", "send", "--terminal", handle, "--text", body, ...(enter ? ["--enter"] : [])], { exec });
}

// tmux key names (what the page sends) as the bytes a terminal gets.
const KEYS = {
  Enter: "\r", "S-Enter": "\x1b\r", "M-Enter": "\x1b\r", BSpace: "\x7f", DC: "\x1b[3~", Tab: "\t", BTab: "\x1b[Z",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D", Home: "\x1b[H", End: "\x1b[F",
  PPage: "\x1b[5~", NPage: "\x1b[6~", Escape: "\x1b", Space: " ",
};
export function keyBytes(name) {
  if (KEYS[name]) return KEYS[name];
  const ctrl = /^C-([a-z])$/.exec(name);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  return name; // a literal, like a permission choice "1"
}

export async function sendKey(handle, name, { exec } = {}) {
  await orca(["terminal", "send", "--terminal", handle, "--text", keyBytes(name)], { exec });
}

export async function closeTerminal(handle, { exec } = {}) {
  await orca(["terminal", "close", "--terminal", handle], { exec });
}

// Orca keeps no metadata of ours on a terminal, so what restarts it (agent, session id, folder,
// variables) is kept here, by worktree and title.
const DIR = path.join(CONFIG_DIR, "orca-terminals");
const recordFile = (worktree, title) => path.join(DIR, `${encodeURIComponent(`${worktree}|${title}`)}.json`);

export function saveRecord(rec) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordFile(rec.worktree, rec.title), JSON.stringify({ ...rec, at: new Date().toISOString() }), { mode: 0o600 });
}

export function loadRecord(worktree, title) {
  try {
    return JSON.parse(fs.readFileSync(recordFile(worktree, title), "utf8"));
  } catch {
    return null;
  }
}

export async function createTerminal(rec, { resume = false, exec } = {}) {
  const command = agentCommand({ ...rec, resume });
  const { terminal } = await orca(["terminal", "create", "--worktree", selector(rec.worktree), "--title", rec.title, "--command", command], { exec });
  return terminal.handle;
}

// Replaces the terminal with a new one, same title, resuming the agent's session. Closing first:
// two processes on one session would both write it.
export async function restartTerminal({ handle, worktree, title }, { exec } = {}) {
  const rec = loadRecord(worktree, title);
  if (!rec) throw new Error(`No sé qué agente corre en la terminal ${title} de Orca (no la abrió el hub)`);
  if (!/^[0-9a-f-]{36}$/.test(rec.sessionId ?? "")) throw new Error(`Sesión inválida para ${title}`);
  if (handle) await closeTerminal(handle, { exec }).catch(() => {}); // already gone is fine
  const created = await createTerminal(rec, { resume: true, exec });
  return { ...rec, handle: created };
}

// The terminal this process runs in, from inside an agent (hub restart).
export async function currentTerminal({ exec } = {}) {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) return null;
  const { terminal } = await orca(["terminal", "show", "--terminal", handle], { exec });
  return { handle, worktree: terminal.worktreePath, title: terminal.title };
}
