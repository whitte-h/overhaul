// Restarting an agent window (Claude or pi) without losing its conversation. `claude --continue` only finds
// sessions of the folder it runs in, and agents often cd into a worktree before restarting,
// so the hook remembers each window's session id and launch folder and a restart resumes that.
// Dependency-free: copied to agent hosts with the CLI.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG_DIR, tool } from "./env.mjs";

const run = promisify(execFile);
const TMUX = tool("tmux", process.env.TMUX_BIN);
// Next to the env file: on some hosts ~/.cache and ~/.local are root-owned.
const DIR = path.join(CONFIG_DIR, "panes");
const fileFor = (win) => path.join(DIR, `${encodeURIComponent(win)}.json`);
const ENV_KEYS = ["HUB_PROJECT", "HUB_TICKET", "HUB_AGENT_NAME"];
// Classic renderer: the conversation stays in tmux history, so the hub's terminal can scroll it.
export const AGENT_ENV = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" };

// Called by the hook. The first event of a session runs before the agent can cd anywhere,
// so its cwd is the launch folder; later events of the same session keep that folder.
export function rememberSession(win, sessionId, cwd) {
  if (!win || !sessionId || !cwd) return;
  const f = fileFor(win);
  try {
    if (JSON.parse(fs.readFileSync(f, "utf8")).sessionId === sessionId) return;
  } catch {}
  const env = Object.fromEntries(ENV_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ sessionId, cwd, env, at: new Date().toISOString() }), { mode: 0o600 });
}

// A window seen through the hub's grouped views (hub-* sessions, helper/attach.mjs) belongs to
// several sessions, and tmux names it after whichever one is attached. The hub knows it by its
// own session, so that is the name used here; a hub-* one only if there is no other.
async function paneNames(pane) {
  const { stdout } = await run(TMUX, ["list-panes", "-a", "-F", "#{pane_id}|||#{session_name}|||#{window_name}"]);
  return stdout.trim().split("\n").map((l) => l.split("|||")).filter(([id]) => id === pane).map(([, s, w]) => `${s}:${w}`);
}

export async function paneWindow(pane) {
  const names = await paneNames(pane);
  const name = names.find((n) => !n.startsWith("hub-")) ?? names[0];
  if (!name) throw new Error(`No encuentro el pane ${pane} en tmux`);
  return name;
}

// The session the hook remembered for this window, under any of its names: files written
// before paneWindow carry the name of a hub-* view. The newest wins.
async function savedSession(win) {
  const files = [fileFor(win)];
  try {
    const { stdout } = await run(TMUX, ["display-message", "-p", "-t", `=${win}`, "#{pane_id}"]);
    for (const n of await paneNames(stdout.trim())) if (n !== win) files.push(fileFor(n));
  } catch {}
  const saved = files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
  return saved.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
}

// pi has no hook to report its session, so the window carries it as tmux options, set when the
// bridge (or the orchestrator) starts it with `pi --session-id <uuid>`.
export const isPi = (command) => /^pi(\s|$)/.test(String(command ?? "").trim());
const PI_ENV = { HUB_PROJECT: "@hub_project", HUB_TICKET: "@hub_ticket", HUB_AGENT_NAME: "@hub_agent_name" };

export async function markPiWindow(target, sessionId, vars = {}, runTmux = (args) => run(TMUX, args)) {
  const opts = { "@hub_agent": "pi", "@hub_session": sessionId };
  for (const [k, opt] of Object.entries(PI_ENV)) if (vars[k]) opts[opt] = vars[k];
  for (const [k, v] of Object.entries(opts)) await runTmux(["set-option", "-w", "-t", target, k, v]);
}

async function piWindow(win) {
  const { stdout } = await run(TMUX, ["show-options", "-w", "-t", `=${win}`]);
  const opts = Object.fromEntries(stdout.split("\n").map((l) => l.match(/^(@hub_\w+) "?(.*?)"?$/)?.slice(1)).filter(Boolean));
  return opts["@hub_agent"] === "pi" ? opts : null;
}

// Replaces the window's process with its agent resuming the same session: pi by the id its
// window carries, Claude by the one the hook remembered.
export async function restartWindow(win) {
  const pi = await piWindow(win).catch(() => null);
  if (pi) {
    if (!/^[0-9a-f-]{36}$/.test(pi["@hub_session"] ?? "")) throw new Error(`Sesión de pi inválida para ${win}`);
    const { stdout: cwd } = await run(TMUX, ["display-message", "-p", "-t", `=${win}`, "#{pane_start_path}"]);
    const vars = Object.fromEntries(Object.entries(PI_ENV).filter(([, o]) => pi[o]).map(([k, o]) => [k, pi[o]]));
    const env = Object.entries({ ...vars, ...AGENT_ENV }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    await run(TMUX, ["respawn-pane", "-k", "-t", `=${win}`, "-c", cwd.trim(), ...env, `zsh -ic 'pi --session-id ${pi["@hub_session"]}; exec zsh'`]);
    return { sessionId: pi["@hub_session"], cwd: cwd.trim(), env: vars };
  }
  const saved = await savedSession(win);
  if (!saved) throw new Error(`No sé qué sesión corre en ${win} (todavía no ha recibido ningún mensaje)`);
  if (!/^[0-9a-f-]{36}$/.test(saved.sessionId)) throw new Error(`Sesión inválida para ${win}`);
  const env = Object.entries({ ...saved.env, ...AGENT_ENV }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await run(TMUX, ["respawn-pane", "-k", "-t", `=${win}`, "-c", saved.cwd, ...env, `zsh -ic 'claude --resume ${saved.sessionId}; exec zsh'`]);
  return saved;
}
