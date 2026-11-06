// Orca terminals as the bridge's other backend (projects with `terminals: orca`): one terminal
// per ticket in the project's Orca worktree, titled like the tmux window would be (k-257).
// Talks to the Orca runtime on this host through its CLI. Dependency-free: copied to agent
// hosts with the CLI.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { CONFIG_DIR, tool } from "./env.mjs";
import { AGENT_ENV } from "./restart.mjs";

const run = promisify(execFile);
// The Orca CLI: ORCA_BIN, else `orca` in the PATH, else the one inside Orca.app on macOS.
export const MAC_ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca";
export function orcaBin(env = process.env, exists = fs.existsSync) {
  if (env.ORCA_BIN) return exists(env.ORCA_BIN) ? env.ORCA_BIN : null;
  for (const dir of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, "orca");
    if (exists(f)) return f;
  }
  return exists(MAC_ORCA) ? MAC_ORCA : null;
}
export const ORCA = orcaBin() ?? "orca";
const TMUX = tool("tmux", process.env.TMUX_BIN);

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
// A worktree is a folder (path:) or already a selector, like a group's folder workspace
// ("id:folder:<id>", which has no path of its own).
export const selector = (w) => (/^id:/.test(w) ? w : `path:${w}`);

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
// Every worktree of the project: its repos and, in a group, the folder workspace (orq's).
// Terminals that only attach to a tmux window are left out: the window itself is listed.
export async function listTerminals(projects, { exec, call } = {}) {
  const out = [];
  for (const p of projects) {
    if (!worktreeOf(p)) continue;
    let worktrees;
    try {
      worktrees = await projectWorktrees(p, { call });
    } catch (err) {
      console.error(`bridge: ${p.id}: ${err.message}`);
      worktrees = [worktreeOf(p)];
    }
    for (const wt of worktrees) {
      try {
        const { terminals = [] } = await orca(["terminal", "list", "--worktree", selector(wt)], { exec });
        for (const t of terminals) {
          if (t.orphaned || !t.writable || !t.title || out.some((o) => o.pane === t.handle)) continue;
          const worktree = t.worktreePath || wt;
          if (loadRecord(worktree, t.title)?.attach) continue;
          out.push({
            backend: "orca", session: sessionOf(p), name: t.title, pane: t.handle, command: t.agentIdentity ?? "",
            worktree, paneKey: `${t.tabId}:${t.leafId}`, project: p.id,
          });
        }
      } catch (err) {
        console.error(`bridge: ${err.message}`);
      }
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

// Records of the agents the hub opened for a project, to bring back the ones Orca lost.
export function projectRecords(id) {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {}
  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    } catch {
      return null;
    }
  }).filter((r) => r?.env?.HUB_PROJECT === id && !r.attach);
}

// Claude writes a session only after its first message: an agent opened and never used has none,
// and `claude --resume <id>` would end at "No conversation found". Looked up in every Claude
// config of this user (~/.claude, ~/.claude-<account>, CLAUDE_CONFIG_DIR).
export function claudeSessionExists(id, { env = process.env, home = os.homedir() } = {}) {
  const roots = new Set(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : []);
  for (const d of fs.readdirSync(home).filter((n) => /^\.claude(-[\w.-]+)?$/.test(n))) roots.add(path.join(home, d));
  for (const root of roots) {
    let dirs;
    try {
      dirs = fs.readdirSync(path.join(root, "projects"));
    } catch {
      continue;
    }
    if (dirs.some((d) => fs.existsSync(path.join(root, "projects", d, `${id}.jsonl`)))) return true;
  }
  return false;
}

export async function createTerminal(rec, { resume = false, exec, sessionExists = claudeSessionExists } = {}) {
  // pi takes the id either way; Claude resumes only a session it wrote, else starts it with that id.
  if (resume && rec.sessionId && !/^pi(\s|$)/.test(rec.command.trim()) && !sessionExists(rec.sessionId)) resume = false;
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
  const folder = /^folder:/.test(terminal.worktreeId ?? "") ? `id:${terminal.worktreeId}` : null;
  return { handle, worktree: terminal.worktreePath || folder, title: terminal.title };
}


// --- Orca's runtime RPC ------------------------------------------------------------------------------
// Project groups and folder workspaces have no CLI command; the runtime answers them on its unix
// socket: one JSON line { id, authToken, method, params } in, one line out. Where it listens and
// its token are in orca-runtime.json, in Orca's data folder.
export const orcaDataDir = (env = process.env, home = os.homedir(), platform = process.platform) => env.ORCA_USER_DATA_PATH
  ?? (platform === "darwin" ? path.join(home, "Library/Application Support/orca") : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "orca"));

export function runtimeFile(env = process.env, home = os.homedir(), platform = process.platform) {
  return env.ORCA_RUNTIME_FILE || path.join(orcaDataDir(env, home, platform), "orca-runtime.json");
}

// --- What Orca's window shows ------------------------------------------------------------------------
// Orca has no call for the terminal in focus. Its desktop app keeps it in the profile's state
// (workspaceSession: activeWorktreeId, activeTabId), read here read-only, never written. A server
// (orca serve) has no window: both are null there.
export function profileDb(env = process.env, home = os.homedir(), platform = process.platform) {
  const data = orcaDataDir(env, home, platform);
  let id = "local-default";
  try {
    id = JSON.parse(fs.readFileSync(path.join(data, "orca-profile-index.json"), "utf8")).activeProfileId ?? id;
  } catch {}
  return path.join(data, "profiles", id, "profile-state.db");
}

// A server (orca serve) has no window, so its workspaceSession has no active tab. What it does keep
// is the tab each paired client (the desktop Orca on another computer, a phone) shows in each
// worktree: mobileClientTabSelectionsByDeviceId[device][worktreeId].activeTabId ("tabId::leafId").
// Which worktree that client shows is not stored, so the focus is the selection that changed since
// the previous read; with no change it stays where it was. Returns { focus, seen } for the next call.
export function clientFocus(selections, prev = { seen: null, focus: null }) {
  const seen = {};
  for (const [device, byWorktree] of Object.entries(selections ?? {})) {
    for (const [worktreeId, sel] of Object.entries(byWorktree ?? {})) {
      if (sel?.activeTabId) seen[`${device}\n${worktreeId}`] = sel.activeTabId;
    }
  }
  let focus = prev.focus;
  if (prev.seen) {
    const changed = Object.keys(seen).find((k) => seen[k] !== prev.seen[k]);
    if (changed) focus = { worktreeId: changed.split("\n")[1], tabId: seen[changed].split("::")[0] };
  }
  return { focus, seen };
}

let clientSeen = { seen: null, focus: null };

export async function readFocus({ file = profileDb(), open } = {}) {
  if (!open && !fs.existsSync(file)) return null;
  let db;
  try {
    db = open ? open(file) : new (await import("node:sqlite")).DatabaseSync(file, { readOnly: true });
    const doc = (domain) => {
      const row = db.prepare("select payload from profile_state_documents where domain = ?").get(domain);
      return row ? JSON.parse(row.payload) : null;
    };
    const s = doc("workspaceSession") ?? {};
    if (s.activeTabId) return { worktreeId: s.activeWorktreeId ?? null, tabId: s.activeTabId };
    clientSeen = clientFocus(doc("mobileClientTabSelectionsByDeviceId"), clientSeen);
    return clientSeen.focus;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// The agent terminal in focus, among the projects' terminals: { project, title } or null.
export async function focusedAgent(projects, { focus, exec, call } = {}) {
  const f = focus ?? (await readFocus());
  if (!f?.tabId) return null;
  const wins = await listTerminals(projects, { exec, call });
  const hit = wins.find((w) => w.paneKey.split(":")[0] === f.tabId);
  return hit ? { project: hit.project, title: hit.name } : null;
}

export function readRuntime(file = runtimeFile()) {
  let rt;
  try {
    rt = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Orca no está corriendo en esta máquina (no encuentro ${file})`);
  }
  const endpoint = (rt.transports ?? []).find((t) => t.kind === "unix")?.endpoint;
  if (!endpoint || !rt.authToken) throw new Error(`${file} no trae socket ni token`);
  return { runtimeId: rt.runtimeId ?? null, endpoint, authToken: rt.authToken };
}

export function rpc(method, params = {}, { runtime, connect = net.createConnection, timeoutMs = 30_000 } = {}) {
  const rt = runtime ?? readRuntime();
  return new Promise((resolve, reject) => {
    const sock = connect(rt.endpoint);
    let buf = "";
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`orca ${method}: sin respuesta`)), timeoutMs);
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: randomUUID(), authToken: rt.authToken, method, params })}\n`));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const res = JSON.parse(buf.slice(0, nl));
        if (!res.ok) finish(new Error(`orca ${method}: ${res.error?.message ?? res.error?.code ?? "failed"}`));
        else finish(null, res.result);
      } catch (err) {
        finish(err);
      }
    });
    sock.on("error", (err) => finish(new Error(`orca ${method}: ${err.message}`)));
    sock.on("end", () => finish(new Error(`orca ${method}: el runtime cerró la conexión`)));
  });
}

// --- How a project looks in Orca ---------------------------------------------------------------------
// Several repos: a project group on their common folder, holding the repos and a folder workspace
// where the orchestrator (and tickets without a repo of their own) run, with the hub's tab.
// One repo: that repo, with all of it. config.mjs puts what this needs in `terminals`.
const real = (d) => {
  try {
    return fs.realpathSync(d);
  } catch {
    return path.resolve(d);
  }
};
const samePath = (a, b) => !!a && !!b && real(a) === real(b);
const under = (child, parent) => {
  const rel = path.relative(real(parent), real(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const sessionOf = (p) => p.session ?? p.orchestrator?.split(":")[0] ?? p.id;

export function orcaPlan(p) {
  const t = p.terminals ?? {};
  const repos = (t.repos ?? []).map(expand);
  const orq = t.orchestrator ?? {};
  return {
    id: p.id,
    name: t.name ?? p.name ?? p.id,
    grouped: repos.length > 1,
    repos,
    parent: expand(t.parent ?? t.worktree ?? ""),
    worktree: expand(t.worktree ?? ""),
    session: sessionOf(p),
    orchestrator: { title: orq.title ?? "orq", command: orq.command ?? "claude", dir: expand(orq.dir ?? t.worktree ?? "~") },
  };
}

// Group lookups run on every bridge round: the folder workspace is kept a minute.
const folderCache = new Map(); // parent -> { id, at }
export async function folderWorkspace(plan, { call = rpc } = {}) {
  const hit = folderCache.get(plan.parent);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const { groups = [] } = await call("projectGroup.list");
  const g = groups.find((x) => samePath(x.parentPath, plan.parent));
  if (!g) return null;
  const { folderWorkspaces = [] } = await call("folderWorkspace.list");
  const ws = folderWorkspaces.find((w) => w.projectGroupId === g.id && !w.isArchived && samePath(w.folderPath, plan.parent));
  if (ws) folderCache.set(plan.parent, { id: ws.id, at: Date.now() });
  return ws?.id ?? null;
}

// Worktrees holding the project's terminals: the folder workspace first (orq), then its repos.
export async function projectWorktrees(p, { call } = {}) {
  const plan = orcaPlan(p);
  if (!plan.grouped) return [plan.worktree];
  const ws = await folderWorkspace(plan, { call });
  return [...(ws ? [`id:folder:${ws}`] : []), ...plan.repos];
}

// Where a ticket's agent opens: its repo when the folder it runs in is one, else the folder
// workspace (a group) or the project's worktree.
export function ticketWorktree(plan, dir, orqWorktree) {
  const repo = plan.repos.find((r) => samePath(r, dir));
  if (repo) return repo;
  return plan.grouped ? orqWorktree : plan.worktree;
}

// What restarts a ticket's agent; the same whether the bridge or the hub opens it.
export function ticketRecord(p, key, { worktree, command, dir }) {
  const title = key.toLowerCase();
  return {
    worktree, title, command, dir: expand(dir),
    // HUB_WINDOW: how the hub names this terminal, for the agent's hook (no tmux to ask).
    env: { HUB_PROJECT: p.id, HUB_TICKET: key, HUB_AGENT_NAME: title, HUB_WINDOW: `${sessionOf(p)}:${title}`, ...AGENT_ENV },
  };
}

export function orchestratorRecord(p, plan, worktree) {
  const { title, command, dir } = plan.orchestrator;
  return { worktree, title, command, dir, env: { HUB_PROJECT: p.id, HUB_AGENT_NAME: title, HUB_WINDOW: `${plan.session}:${title}`, ...AGENT_ENV } };
}

// The terminal titled rec.title in its worktree: the open one, the saved agent resumed, or a new
// agent with a fixed session id (kept so `overhaul restart` and the next resume find it).
export async function ensureTerminal(rec, { exec } = {}) {
  const { terminals = [] } = await orca(["terminal", "list", "--worktree", selector(rec.worktree)], { exec });
  const open = terminals.find((t) => t.title === rec.title && !t.orphaned);
  if (open) return { handle: open.handle, state: "existing" };
  const saved = loadRecord(rec.worktree, rec.title);
  if (saved?.sessionId && !saved.attach) return { handle: await createTerminal(saved, { resume: true, exec }), state: "resumed" };
  const fresh = { ...rec, sessionId: randomUUID() };
  saveRecord(fresh);
  return { handle: await createTerminal(fresh, { exec }), state: "created" };
}

// A terminal showing a live tmux window of this machine, through its own grouped view (hub-*,
// gone on detach) so several of them don't fight over the window shown.
export const attachCommand = (session, win) =>
  `tmux new-session -t ${shq(`=${session}`)} -s hub-${randomUUID().slice(0, 8)} \; set-option destroy-unattached on \; select-window -t ${shq(`:${win}`)}`;

async function attachTerminal(worktree, session, win, { exec } = {}) {
  const { terminals = [] } = await orca(["terminal", "list", "--worktree", selector(worktree)], { exec });
  const open = terminals.find((t) => t.title === win && !t.orphaned);
  if (open) return { handle: open.handle, state: "existing" };
  saveRecord({ worktree, title: win, attach: `${session}:${win}` });
  const { terminal } = await orca(["terminal", "create", "--worktree", selector(worktree), "--title", win, "--command", attachCommand(session, win)], { exec });
  return { handle: terminal.handle, state: "attached" };
}

// Agent windows (Claude, pi) in the project's tmux session on this machine; none without tmux.
export async function tmuxAgentWindows(session, { runTmux = (args) => run(TMUX, args) } = {}) {
  try {
    const { stdout } = await runTmux(["list-windows", "-t", `=${session}`, "-F", "#{window_name} #{pane_current_command}"]);
    return stdout.trim().split("\n").filter(Boolean).map((l) => l.split(" "))
      .filter(([, cmd]) => /^\d+\.\d+\.\d+$/.test(cmd) || cmd === "claude" || cmd === "pi")
      .map(([name]) => name);
  } catch {
    return [];
  }
}

// Orca running (the desktop app, or `orca serve` on a server): asks it, and opens it if it is not.
export async function ensureOrcaRunning({ exec = run } = {}) {
  const up = await orca(["status"], { exec }).then((s) => s.runtime?.reachable, () => false);
  if (up) return;
  try {
    await exec(ORCA, ["open"], { timeout: 120_000 });
  } catch (err) {
    throw new Error(`No pude abrir Orca (${ORCA}): ${String(err.stderr || err.message).trim().split("\n").pop()}`);
  }
}

export async function runtimeId({ exec } = {}) {
  return (await orca(["status"], { exec })).runtime?.runtimeId ?? null;
}

async function ensureRepo(dir, { exec, log }) {
  const { repos = [] } = await orca(["repo", "list"], { exec });
  const hit = repos.find((r) => samePath(r.path, dir));
  if (hit) return hit;
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${dir} no es un repo git: Orca solo toma repos`);
  await orca(["repo", "add", "--path", dir], { exec });
  log(`repo ${path.basename(dir)}: agregado`);
  return (await orca(["repo", "list"], { exec })).repos.find((r) => samePath(r.path, dir));
}

// The group for the project's common folder, with exactly its repos added (a repo loose or in
// another group is moved in). Returns the group.
export async function ensureGroup(plan, { exec, call = rpc, log = () => {} } = {}) {
  const outside = plan.repos.filter((r) => !under(r, plan.parent));
  if (outside.length) throw new Error(`${outside.join(", ")} no está dentro de ${plan.parent}: pon repos_root en la carpeta que los contiene`);
  const find = async () => ((await call("projectGroup.list")).groups ?? []).find((g) => samePath(g.parentPath, plan.parent));
  let group = await find();
  if (!group) {
    await call("projectGroup.importNested", { mode: "group", parentPath: real(plan.parent), groupName: plan.name, projectPaths: plan.repos.map(real) });
    group = await find();
    if (!group) throw new Error(`Orca no creó el grupo ${plan.name} en ${plan.parent}`);
    log(`grupo ${plan.name}: creado`);
  }
  for (const dir of plan.repos) {
    const repo = await ensureRepo(dir, { exec, log });
    if (repo.projectGroupId === group.id) continue;
    await call("projectGroup.moveProject", { repo: `id:${repo.id}`, groupId: group.id });
    log(`repo ${path.basename(dir)}: movido al grupo ${plan.name}${repo.projectGroupId ? " (estaba en otro grupo)" : ""}`);
  }
  return group;
}

export async function ensureFolderWorkspace(plan, group, { call = rpc, log = () => {} } = {}) {
  folderCache.delete(plan.parent);
  const id = await folderWorkspace(plan, { call });
  if (id) return id;
  await call("folderWorkspace.create", { projectGroupId: group.id, name: plan.name, folderPath: real(plan.parent) });
  folderCache.delete(plan.parent);
  const created = await folderWorkspace(plan, { call });
  if (!created) throw new Error(`Orca no creó el espacio de carpeta de ${plan.name}`);
  log(`espacio de carpeta ${plan.name}: creado`);
  return created;
}

export async function ensureHubTab(worktree, url, { exec } = {}) {
  const { tabs = [] } = await orca(["tab", "list", "--worktree", selector(worktree)], { exec });
  const same = (u) => String(u ?? "").split("#")[0].replace(/\/$/, "") === url;
  if (tabs.some((t) => same(t.url))) return "existing";
  await orca(["tab", "create", "--url", url, "--worktree", selector(worktree)], { exec });
  return "created";
}

// The project's whole layout in the Orca of this machine, as the desktop helper builds it on the
// Mac (helper/orca.mjs): group or repo, the hub's tab /p/<id>, the orchestrator and every agent
// (the ones the hub opened, resumed; live tmux windows, attached). Safe to repeat.
// Returns { worktree (orq's), orchestrator: handle }.
export async function ensureOrg(p, { hubUrl, exec, call = rpc, runTmux, log = () => {} } = {}) {
  const plan = orcaPlan(p);
  let worktree;
  if (plan.grouped) {
    const group = await ensureGroup(plan, { exec, call, log });
    worktree = `id:folder:${await ensureFolderWorkspace(plan, group, { call, log })}`;
  } else {
    await ensureRepo(plan.worktree, { exec, log });
    worktree = plan.worktree;
  }
  if (hubUrl) log(`pestaña del hub: ${await ensureHubTab(worktree, `${hubUrl.replace(/\/$/, "")}/p/${p.id}`, { exec })}`);
  const windows = await tmuxAgentWindows(plan.session, { runTmux });
  const orqTitle = plan.orchestrator.title;
  // An orchestrator still alive in tmux (the project used tmux) is shown, not started twice.
  const orq = windows.includes(orqTitle)
    ? await attachTerminal(worktree, plan.session, orqTitle, { exec })
    : await ensureTerminal(orchestratorRecord(p, plan, worktree), { exec });
  log(`${orqTitle}: ${orq.state}`);
  for (const rec of projectRecords(p.id).filter((r) => r.env?.HUB_TICKET)) {
    if (windows.includes(rec.title)) continue;
    const { state } = await ensureTerminal(rec, { exec });
    if (state !== "existing") log(`${rec.title}: ${state}`);
  }
  for (const win of windows.filter((w) => w !== orqTitle)) {
    const { state } = await attachTerminal(worktree, plan.session, win, { exec });
    if (state !== "existing") log(`${win}: ${state} (tmux)`);
  }
  return { worktree, orchestrator: orq.handle };
}

// For the hub's "follow in Orca": the handle of the orchestrator's terminal (key null) or the
// ticket's, created when missing (the whole layout first, if the project has none yet).
// spawn: { command, dir } of the ticket's agent (server.mjs pendingWithSpawn).
export async function focusTerminal(p, key, { spawn, hubUrl, exec, call = rpc, runTmux, log } = {}) {
  const plan = orcaPlan(p);
  const title = key ? key.toLowerCase() : plan.orchestrator.title;
  for (const wt of await projectWorktrees(p, { call }).catch(() => [])) {
    const { terminals = [] } = await orca(["terminal", "list", "--worktree", selector(wt)], { exec }).catch(() => ({}));
    const open = terminals.find((t) => t.title === title && !t.orphaned);
    if (open) return { runtimeId: await runtimeId({ exec }), handle: open.handle, state: "existing" };
  }
  const org = await ensureOrg(p, { hubUrl, exec, call, runTmux, log });
  if (!key || !spawn) return { runtimeId: await runtimeId({ exec }), handle: org.orchestrator, state: "orchestrator" };
  const worktree = ticketWorktree(plan, expand(spawn.dir), org.worktree);
  const { handle, state } = await ensureTerminal(ticketRecord(p, key, { worktree, ...spawn }), { exec });
  return { runtimeId: await runtimeId({ exec }), handle, state };
}
