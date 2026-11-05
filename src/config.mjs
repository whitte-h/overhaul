import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { expandHome, loadEnvFile, localHost, CONFIG_DIR, defaultDataDir } from "./env.mjs";

export { expandHome, loadEnvFile };

export const TRACKERS = ["jira", "kaneo", "kanban-md"];
export const TERMINALS = ["tmux", "orca"];
export const AGENT_LOCATIONS = ["external", "repo"];

// Who may reach the hub when the config does not say (allow_from). A v2 config only answers
// this machine; v1 configs (work-hub) keep the list they were written for: localhost, the VPN mesh
// ranges (100.64.0.0/10, fd7a:115c:a1e0::/48) and one private LAN. The v1 -> v2 migration writes that list out explicitly.
export const LOOPBACK_ALLOW = ["127.0.0.0/8", "::1/128"];
export const V1_ALLOW = ["127.0.0.0/8", "::1/128", "100.64.0.0/10", "fd7a:115c:a1e0::/48", "192.168.1.0/24"];
const V1_HELPER = "http://127.0.0.1:7421";

export function loadConfig() {
  loadEnvFile();
  const yamlFile = path.join(CONFIG_DIR, "config.yaml");
  const jsonFile = path.join(CONFIG_DIR, "config.json");
  if (fs.existsSync(yamlFile)) return normalize(YAML.parse(fs.readFileSync(yamlFile, "utf8")) ?? {});
  if (fs.existsSync(jsonFile)) return normalize(JSON.parse(fs.readFileSync(jsonFile, "utf8")));
  throw new Error(`Missing ${yamlFile}. Copy config.example.yaml there.`);
}

// Accepts config v2 (`version: 2`), the v1 YAML (work-hub) and the older JSON, and returns one
// internal shape. v1 keeps its old defaults so an unmigrated install behaves as before.
const list = (v) => (v == null ? null : (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase()));

export function normalize(raw) {
  const pick = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v !== undefined);
  const version = Number(raw.version ?? 1);
  if (![1, 2].includes(version)) throw new Error(`Unknown config version: ${raw.version}`);
  const v2 = version === 2;
  const defaults = raw.defaults ?? {};
  const port = raw.port ?? 7420;
  const terminal = String(raw.terminal ?? "tmux");
  if (!TERMINALS.includes(terminal)) throw new Error(`terminal must be one of ${TERMINALS.join(", ")}`);
  const publicUrls = [raw.public_url ?? []].flat().map((u) => String(u).replace(/\/$/, ""));
  const cfg = {
    version,
    port,
    bind: raw.bind ?? ["127.0.0.1"],
    allowFrom: pick(raw, "allow_from", "allowFrom") ?? (v2 ? LOOPBACK_ALLOW : V1_ALLOW),
    dataDir: expandHome(pick(raw, "data_dir", "dataDir") ?? defaultDataDir()),
    // Optional desktop helper (Chrome profiles, Orca terminals, port forwards). null/false/""
    // turns it off; v2 has it off unless `helper` says where it is.
    chromeHelper: helperUrl(pick(raw, "helper", "chrome_helper", "chromeHelper"), v2 ? null : V1_HELPER),
    timezone: raw.timezone ?? (v2 ? systemTimezone() : "America/Bogota"), // v1's old default
    // Simple login: one password, read from this variable in the env file.
    auth: { passwordEnv: String(raw.auth?.password_env ?? "HUB_TOKEN") },
    // Opens every message the hub pastes into an agent ("[overhaul] …"). Orchestrators' own
    // instructions quote it, so a migrated install keeps "work-hub" until those are updated.
    messageTag: String(raw.message_tag ?? (v2 ? "overhaul" : "work-hub")),
    terminal,
    // Where people (and Orca) open the hub; the first one is the canonical link.
    publicUrls: publicUrls.length ? publicUrls : [`http://127.0.0.1:${port}`],
    orca: { agentsDir: String(raw.orca?.agents_dir ?? "~/overhaul/orca") },
    projects: [],
  };

  // YAML uses a map keyed by id; the old JSON used a list with `id`.
  const entries = Array.isArray(raw.projects)
    ? raw.projects.map((p) => [p.id, p])
    : Object.entries(raw.projects ?? {});

  for (const [id, p] of entries) {
    if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error(`Bad project id: ${id}`);
    if (cfg.projects.some((x) => x.id === id)) throw new Error(`Duplicate project id: ${id}`);
    const t = p.tracker && p.tracker.type !== "none" ? p.tracker : null;
    if (t && !TRACKERS.includes(t.type)) throw new Error(`${id}: tracker.type must be one of ${TRACKERS.join(", ")} or none`);
    const daily = { ...asObject(defaults.daily_summary), ...asObject(p.daily_summary) };
    const auto = { ...asObject(defaults.auto_work), ...asObject(p.auto_work) };
    const repoList = repoEntries(id, p.repos ?? (p.repo ? [p.repo] : []));
    const firstRepo = p.repo ?? repoList[0]?.path;
    const repo = expandHome(firstRepo ?? null);
    const rt = runtime(id, p, cfg.terminal, firstRepo);

    cfg.projects.push({
      id,
      name: p.name ?? id,
      host: p.host ?? localHost(), // standalone: every project runs here
      chromeProfile: pick(p, "chrome_profile", "chromeProfile") ?? null,
      links: Array.isArray(p.links) ? p.links : Object.entries(p.links ?? {}).map(([label, url]) => ({ label, url })),
      repo,
      repos: repoList.map((r) => expandHome(r.path)),
      // Each repo's role and description (repos: [{ path, role, description }]), for the agents'
      // context: which repo does what. A plain path has neither.
      repoInfo: repoList.map((r) => ({ ...r, path: expandHome(r.path) })),
      github: p.github?.owner ? { owner: String(p.github.owner) } : null, // PRs looked up by the host bridge with its gh
      // tmux target ("session:window") that gets messages for tickets without their own window.
      orchestrator: rt.orchestrator,
      // Whether the project's general agent (the orchestrator) may create tickets in the tracker.
      createTickets: !!(pick(p, "create_tickets", "createTickets") ?? defaults.create_tickets),
      // One agent per ticket: started by the host bridge on the first message to a ticket
      // without its own window. dir is resolved on that host (~ = its home). The project picks
      // the agent: command is `claude` or `pi`; prompt (optional) opens the first message, with
      // {key} replaced by the ticket key (e.g. "/skill:my-orchestrator {key}").
      worker: rt.worker,
      terminals: rt.terminals,
      // Agent profile (F2): which crew the orchestrator uses and where it lives. `external`
      // keeps it in Overhaul's config, `repo` in the repo (AGENTS.md, .claude/agents).
      agents: agents(id, p.agents),
      reposRoot: expandHome(p.repos_root ?? null), // where the hub looks for unmapped repos and clones new ones
      tracker: t && {
        type: t.type,
        baseUrl: pick(t, "base_url", "baseUrl"),
        emailEnv: pick(t, "email_env", "emailEnv"),
        tokenEnv: pick(t, "token_env", "tokenEnv"),
        jql: t.jql,
        workspaceId: pick(t, "workspace_id", "workspaceId"),
        taskUrl: pick(t, "task_url", "taskUrl"),
        dir: t.dir,
        tasksDir: pick(t, "tasks_dir", "tasksDir"),
        prefix: t.prefix,
        statuses: t.statuses,
        // Kaneo: limit a shared workspace to some projects (slug or name), or leave some out.
        projects: list(t.projects),
        excludeProjects: list(pick(t, "exclude_projects", "excludeProjects")),
      },
      daily: {
        enabled: !!daily.enabled,
        at: daily.at ?? "08:30",
        include: daily.include ?? ["status_changes", "decisions", "commits", "today", "blockers"],
      },
      autoWork: {
        enabled: !!auto.enabled,
        statuses: (auto.statuses ?? ["In Progress", "in-progress"]).map((s) => String(s).toLowerCase()),
        maxParallel: auto.max_parallel ?? 1,
        planFirst: auto.plan_first ?? true,
        // With plan_first: before the plan, the agent proposes the questions it needs.
        initialQuestions: auto.initial_questions ?? true,
        agentCommand: auto.agent_command ?? "claude",
        repo: expandHome(auto.repo ?? firstRepo),
        // Tracker group (Kaneo project name) -> repo, for boards that span several repos.
        repoByGroup: Object.fromEntries(Object.entries(auto.repos_by_group ?? {}).map(([g, r]) => [g.toLowerCase(), expandHome(r)])),
        worktreeRoot: expandHome(auto.worktree_root ?? null),
        tmuxSession: auto.tmux_session ?? id,
        baseRef: auto.base_ref ?? "HEAD",
      },
    });
  }
  for (const p of cfg.projects) {
    if (p.daily.enabled && !/^\d{2}:\d{2}$/.test(p.daily.at)) throw new Error(`${p.id}: daily_summary.at must be HH:MM`);
    const aw = p.autoWork;
    if (aw.enabled && !aw.repo && !Object.keys(aw.repoByGroup).length) {
      throw new Error(`${p.id}: auto_work needs repo, repos[0] or repos_by_group`);
    }
  }
  return cfg;
}

// How the project's agents run. v2 says it in one block:
//   runtime:
//     command: claude | pi | <own command>   (default claude)
//     prompt: "/skill:x {key}"               (opens each ticket agent's first message)
//     dir: ~/code/x                          (where ticket agents start; default: repo)
//     terminal: tmux | orca                  (default: the install's `terminal`)
//     orca_worktree: ~/code/x                (Orca worktree that holds them; default: dir)
//     orchestrator: x:orq                    (tmux target for tickets without a window)
//     per_ticket: true                       (false: no agent per ticket, only the orchestrator)
// v1 spread it over worker, terminals, orca and orchestrator; both are read.
function runtime(id, p, defaultTerminal, repo) {
  const r = p.runtime;
  let worker;
  if (r) {
    if (typeof r !== "object") throw new Error(`${id}: runtime must be a map`);
    worker = r.per_ticket === false ? null : {
      dir: String(r.dir ?? repo ?? "~"),
      command: String(r.command ?? "claude"),
      prompt: r.prompt ? String(r.prompt) : null,
    };
  } else {
    worker = p.worker ? { dir: String(p.worker.dir ?? "~"), command: String(p.worker.command ?? "claude"), prompt: p.worker.prompt ? String(p.worker.prompt) : null } : null;
  }
  const type = String(r?.terminal ?? p.terminals ?? defaultTerminal);
  if (!TERMINALS.includes(type)) throw new Error(`${id}: terminal must be tmux or orca`);
  let terminals = { type };
  if (type === "orca") {
    const worktree = r?.orca_worktree ?? p.orca?.worktree ?? worker?.dir ?? r?.dir;
    if (!worktree) throw new Error(`${id}: terminal orca needs runtime.orca_worktree or runtime.dir`);
    terminals = { type, worktree: String(worktree) };
  }
  return { worker, terminals, orchestrator: r?.orchestrator ?? p.orchestrator ?? null };
}

// repos: a list of paths, or of { path, role, description }; both can be mixed.
function repoEntries(id, repos) {
  return (Array.isArray(repos) ? repos : [repos]).map((r) => {
    if (typeof r === "string") return { path: r, role: null, description: null };
    if (!r || typeof r !== "object" || !r.path) throw new Error(`${id}: each repos entry is a path or { path, role, description }`);
    return { path: String(r.path), role: r.role ? String(r.role) : null, description: r.description ? String(r.description) : null };
  });
}

function agents(id, a) {
  const location = String(a?.location ?? "external");
  if (!AGENT_LOCATIONS.includes(location)) throw new Error(`${id}: agents.location must be one of ${AGENT_LOCATIONS.join(", ")}`);
  return { profile: a?.profile ? String(a.profile) : null, location };
}

// The Orca layout the desktop helper restores (helper/orca-restore.mjs): one Orca project per
// hub project, the hub tab and the tmux session its agents live in. Generated from this
// config so the helper's machine carries no hosts or projects of its own.
export function orcaLayout(cfg) {
  return {
    hub: cfg.publicUrls[0],
    origins: cfg.publicUrls,
    agentsDir: cfg.orca.agentsDir,
    projects: cfg.projects.map((p) => ({ id: p.id, host: p.host, session: p.orchestrator?.split(":")[0] ?? p.id })),
  };
}

const helperUrl = (v, fallback) => (v === undefined ? fallback : v ? String(v) : null);
const asObject = (v) => (typeof v === "boolean" ? { enabled: v } : v ?? {});
const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
