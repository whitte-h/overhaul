// Orca on the desktop machine shows the hub's agents: one Orca project per hub project, a browser tab with
// the hub locked to it (/p/<project>), and one terminal per agent tmux window (helper/attach.mjs).
// Shared by the helper (buttons in the hub) and orca-restore.mjs (rebuilds it all).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca";
const ATTACH = path.join(HERE, "attach.mjs");

const expandHome = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
// The layout lives outside the repo, on this machine: OVERHAUL_LAYOUT, else
// ~/.overhaul/orca-layout.json (OVERHAUL_HOME), else v0.1's ~/.config/overhaul/orca-layout.json
// (generate it on the hub host with `overhaul orca-layout`). helper/orca-layout.json, from before
// it moved out, is still read when it is the only one.
export function layoutFile(env = process.env, home = os.homedir()) {
  if (env.OVERHAUL_LAYOUT) return env.OVERHAUL_LAYOUT;
  const ohHome = env.OVERHAUL_HOME || path.join(home, ".overhaul");
  const files = [path.join(ohHome, "orca-layout.json"), path.join(home, ".config/overhaul/orca-layout.json"), path.join(HERE, "orca-layout.json")];
  const found = files.find((f) => fs.existsSync(f));
  if (!found) throw new Error(`Sin layout de Orca: crea ${files[0]} con \`overhaul orca-layout\` en el host del hub`);
  return found;
}
export const layout = () => {
  const l = JSON.parse(fs.readFileSync(layoutFile(), "utf8"));
  return { ...l, origins: l.origins ?? [l.hub], agentsDir: expandHome(l.agentsDir) };
};
export const worktreeOf = (project) => {
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error("bad project");
  return `path:${path.join(layout().agentsDir, project)}`;
};

export async function orca(...args) {
  const { stdout } = await run(ORCA, [...args, "--json"], { timeout: 30_000 });
  const out = JSON.parse(stdout);
  if (!out.ok) throw new Error(out.error?.message ?? "orca failed");
  return out.result;
}

export const attachCommand = (host, win) => `${JSON.stringify(process.execPath)} ${JSON.stringify(ATTACH)} ${host} ${win}`;

// Whether this Mac has an attach.mjs running for that agent window.
async function attached(host, win) {
  return run("pgrep", ["-f", `attach\\.mjs ${host} ${win}$`]).then(() => true, () => false);
}

// The project's tab with this title: brought forward, or created running `command`.
// With focus off (restoring), an existing tab is left alone and a new one opens in background.
// `agent` ({ host, win }) marks an agent terminal: if its tab is there but attach.mjs is not
// running (it ended or crashed), the command is typed again into that same tab.
export async function orcaTerminal(project, title, command, { focus = true, agent = null } = {}) {
  const worktree = worktreeOf(project);
  const { terminals } = await orca("terminal", "list", "--worktree", worktree);
  const open = terminals.find((t) => t.title === title);
  if (open) {
    let state = "existing";
    if (agent && !(await attached(agent.host, agent.win))) {
      await orca("terminal", "send", "--terminal", open.handle, "--text", "\x15"); // clear the shell's line
      await orca("terminal", "send", "--terminal", open.handle, "--text", command, "--enter");
      state = "revived";
    }
    if (focus) await orca("terminal", "switch", "--terminal", open.handle);
    return state;
  }
  await orca("terminal", "create", "--worktree", worktree, "--title", title, "--command", command, ...(focus ? ["--focus"] : []));
  return "created";
}

// An empty git folder registered as an Orca project (Orca only takes git repos).
export async function ensureProject(project) {
  const dir = worktreeOf(project).slice("path:".length);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await run("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  }
  const { repos } = await orca("repo", "list");
  if (repos.some((r) => r.path === dir)) return "existing";
  await orca("repo", "add", "--path", dir);
  return "created";
}

// Browser tab URLs Orca has saved for a project, including tabs asleep in a split group that
// `orca tab list` leaves out. Read-only from its state database (no write, no lock taken).
async function savedTabUrls(project) {
  const dataDir = process.env.ORCA_USER_DATA_PATH ?? path.join(os.homedir(), "Library/Application Support/orca");
  try {
    const { activeProfileId } = JSON.parse(fs.readFileSync(path.join(dataDir, "orca-profile-index.json"), "utf8"));
    const db = path.join(dataDir, "profiles", activeProfileId, "profile-state.db");
    const { stdout } = await run("sqlite3", [`file:${db}?mode=ro`, "select payload from profile_state_documents where domain='workspaceSession'"]);
    const dir = worktreeOf(project).slice("path:".length);
    const tabs = Object.entries(JSON.parse(stdout).browserTabsByWorktree ?? {}).find(([w]) => w.endsWith(`::${dir}`))?.[1] ?? [];
    return tabs.map((t) => t.url ?? "");
  } catch {
    return [];
  }
}

export async function ensureHubTab(project) {
  const url = `${layout().hub}/p/${project}`;
  // Scoped to the project: an unscoped list leaves out projects not on screen.
  const { tabs } = await orca("tab", "list", "--worktree", worktreeOf(project));
  const same = (u) => u.split("#")[0] === url;
  if (tabs.some((t) => same(t.url)) || (await savedTabUrls(project)).some(same)) return "existing";
  await orca("tab", "create", "--url", url, "--worktree", worktreeOf(project));
  return "created";
}

// Agent windows (Claude running) in the project's tmux session on its host.
export async function agentWindows(host, session) {
  const { stdout } = await run("/usr/bin/ssh", ["-o", "BatchMode=yes", host,
    `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; tmux list-windows -t '=${session}' -F '#{window_name} #{pane_current_command}'`], { timeout: 30_000 });
  return stdout.trim().split("\n").filter(Boolean)
    .map((l) => l.split(" "))
    .filter(([, cmd]) => /^\d+\.\d+\.\d+$/.test(cmd) || cmd === "claude")
    .map(([name]) => name);
}

// Rebuilds a project in Orca: folder, hub tab and every agent terminal. Safe to repeat.
export async function restoreProject(p, log = () => {}) {
  log(`${p.id}: proyecto ${await ensureProject(p.id)}`);
  log(`${p.id}: hub ${await ensureHubTab(p.id)}`);
  for (const name of await agentWindows(p.host, p.session)) {
    const win = `${p.session}:${name}`;
    log(`${p.id}: ${name} ${await orcaTerminal(p.id, name, attachCommand(p.host, win), { focus: false, agent: { host: p.host, win } })}`);
  }
}
