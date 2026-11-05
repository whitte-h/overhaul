import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { LOOPBACK_ALLOW, V1_ALLOW, normalize, orcaLayout } from "../src/config.mjs";
import { migrateConfigText } from "../src/configmigrate.mjs";
import { Daily, localNow } from "../src/daily.mjs";
import { Store } from "../src/store.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const MULTI = `
version: 2
message_tag: work-hub
helper: http://127.0.0.1:7421
public_url: [ "http://hub.example:7420" ]
defaults:
  create_tickets: false
  daily_summary: false
  auto_work: false
projects:
  alpha:
    host: agents-host
    tracker: { type: jira, base_url: https://alpha.atlassian.net }
    links: { App: http://localhost:5173 }
    daily_summary: { enabled: true }
  beta:
    tracker: { type: kaneo, base_url: https://kaneo.example }
    auto_work: { statuses: [ in progress ], repos_by_group: { grp: ~/code/beta/grp } }
  gamma:
    tracker: { type: kanban-md, dir: ~/code/gamma/kanban }
    auto_work: false
    create_tickets: true
`;

test("multi-project v2 config normalizes with defaults and overrides", () => {
  const cfg = normalize(YAML.parse(MULTI));
  const byId = Object.fromEntries(cfg.projects.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId), ["alpha", "beta", "gamma"]);
  assert.equal(byId.alpha.tracker.baseUrl, "https://alpha.atlassian.net");
  assert.deepEqual(byId.alpha.links, [{ label: "App", url: "http://localhost:5173" }]);
  assert.equal(byId.alpha.daily.enabled, true);
  assert.equal(byId.gamma.daily.enabled, false); // from defaults
  assert.equal(byId.gamma.autoWork.enabled, false); // boolean shorthand
  assert.equal(byId.alpha.createTickets, false); // from defaults
  assert.equal(byId.gamma.createTickets, true);
  assert.deepEqual(byId.beta.autoWork.statuses, ["in progress"]);
  assert.deepEqual(byId.beta.autoWork.repoByGroup, { grp: path.join(os.homedir(), "code/beta/grp") });
  assert.equal(cfg.messageTag, "work-hub");
  assert.equal(cfg.chromeHelper, "http://127.0.0.1:7421");
  assert.equal(cfg.publicUrls[0], "http://hub.example:7420");
});

test("generic example (v2): no hosts, loopback only, helper off, every option valid", () => {
  const text = fs.readFileSync(path.join(root, "config.example.yaml"), "utf8");
  assert.doesNotMatch(text, /^\s*host:/m); // no project names a host
  assert.doesNotMatch(text, /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d/); // no VPN mesh (CGNAT) address
  const cfg = normalize(YAML.parse(text));
  assert.equal(cfg.version, 2);
  assert.deepEqual(cfg.allowFrom, LOOPBACK_ALLOW);
  assert.equal(cfg.chromeHelper, null);
  assert.equal(cfg.messageTag, "overhaul");
  assert.equal(cfg.auth.passwordEnv, "HUB_TOKEN");
  const [app, client] = cfg.projects;
  assert.equal(app.repo, path.join(os.homedir(), "code/myapp"));
  assert.deepEqual(app.repos, [app.repo]);
  assert.deepEqual(app.worker, { dir: "~/code/myapp", command: "claude", prompt: null });
  assert.equal(app.orchestrator, "myapp:orq");
  assert.deepEqual(app.agents, { profile: null, location: "external" });
  assert.deepEqual(client.worker, { dir: "~/code/client", command: "claude", prompt: null });
  assert.equal(client.tracker.type, "jira");
});

test("legacy JSON list still loads", () => {
  const cfg = normalize({ projects: [{ id: "x", tracker: { type: "kanban-md", dir: "~/b" }, chromeProfile: "Default" }] });
  assert.equal(cfg.projects[0].chromeProfile, "Default");
  assert.equal(cfg.projects[0].tracker.dir, "~/b");
});

test("rejects bad tracker type and auto_work without repo", () => {
  assert.throws(() => normalize({ projects: { x: { tracker: { type: "trello" } } } }), /tracker.type/);
  assert.throws(() => normalize({ projects: { x: { auto_work: true } } }), /needs repo/);
});

test("localNow formats date and 24h time", () => {
  const { date, time } = localNow("America/Bogota");
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(time, /^\d{2}:\d{2}$/);
});

test("daily diffs statuses and lists decisions and blockers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-daily-"));
  const store = new Store(dir);
  const cfg = normalize({ data_dir: dir, projects: { nx: { name: "NX", host: "elsewhere", daily_summary: true, tracker: { type: "jira" } } } });
  let tickets = [{ key: "NX-1", title: "Filtro", status: "To Do" }];
  const daily = new Daily(cfg, store, async () => tickets);
  await daily.generate(cfg.projects[0]); // first run only stores the snapshot
  tickets = [{ key: "NX-1", title: "Filtro", status: "In Progress" }];
  const q = store.ask("nx", "NX-1", { text: "¿UTC?" });
  store.answer("nx", "NX-1", q.id, "local");
  store.ask("nx", "NX-1", { text: "¿Presets?" });
  const { markdown } = await daily.generate(cfg.projects[0]);
  assert.match(markdown, /NX-1 Filtro: To Do → In Progress/);
  assert.match(markdown, /NX-1: ¿UTC\? → local/);
  assert.match(markdown, /## Hoy\n- NX-1 Filtro/);
  assert.match(markdown, /## Bloqueos\n- NX-1 Filtro: ¿Presets\?/);
});

test("repos_by_group picks the ticket's repo and blocks unmapped groups", async () => {
  const { AutoWork } = await import("../src/autowork.mjs");
  const cfg = normalize({ projects: { s: { host: os.hostname(), auto_work: { enabled: true, repos_by_group: { Xyz: "~/code/xyz" } } } } });
  const aw = new AutoWork(cfg, null, null);
  const p = cfg.projects[0];
  assert.equal(aw.repoFor(p, { group: "xyz" }), path.join(os.homedir(), "code/xyz"));
  assert.equal(aw.ticketBlocker(p, { group: "Xyz" }), null);
  assert.match(aw.ticketBlocker(p, { group: "Widget" }), /sin repo para Widget/);
});

test("attachments: safe names and the paths note for the agent", async () => {
  const { safeName, withFiles } = await import("../src/uploads.mjs");
  assert.doesNotMatch(safeName("../../etc/passwd"), /\/|^\./); // never a path
  assert.doesNotMatch(safeName(".env"), /^\./);
  assert.equal(safeName("spec v2.pdf"), "spec_v2.pdf");
  assert.equal(safeName(""), "archivo");
  assert.equal(withFiles("hola", []), "hola");
  assert.equal(withFiles("hola", ["/u/a.png"]), "hola\nAdjuntos (léelos con Read):\n- /u/a.png");
});

test("a pending hub ask does not count as listening; hub inbox does", () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "hub-listen-")));
  const q = store.ask("nx", "NX-1", { text: "¿UTC?" });
  store.waitFor("nx", "NX-1", { questionId: q.id, timeoutMs: 50 });
  assert.equal(store.listening("nx", "NX-1"), false); // plain messages still go out by tmux
  store.waitFor("nx", "NX-1", { questionId: null, timeoutMs: 50 });
  assert.equal(store.listening("nx", "NX-1"), true);
});

test("v1 keeps its old defaults; v2 changes them", () => {
  const v1 = normalize({});
  assert.deepEqual(v1.allowFrom, V1_ALLOW);
  assert.equal(v1.chromeHelper, "http://127.0.0.1:7421");
  assert.equal(v1.messageTag, "work-hub");
  const v2 = normalize({ version: 2 });
  assert.deepEqual(v2.allowFrom, LOOPBACK_ALLOW);
  assert.equal(v2.chromeHelper, null);
  assert.equal(v2.messageTag, "overhaul");
  assert.equal(normalize({ version: 2, helper: "http://h:1" }).chromeHelper, "http://h:1");
  assert.throws(() => normalize({ version: 3 }), /Unknown config version/);
});

test("v2 runtime: same internal shape as v1 worker/terminals/orca/orchestrator", () => {
  const v1 = normalize({ projects: { r: { worker: { dir: "~/r", command: "pi", prompt: "/x {key}" }, terminals: "orca", orca: { worktree: "~/r" }, orchestrator: "p:orq" } } }).projects[0];
  const v2 = normalize({ version: 2, projects: { r: { runtime: { dir: "~/r", command: "pi", prompt: "/x {key}", terminal: "orca", orchestrator: "p:orq" } } } }).projects[0];
  for (const k of ["worker", "terminals", "orchestrator"]) assert.deepEqual(v2[k], v1[k], k);
  // Only the orchestrator, no agent per ticket.
  const solo = normalize({ version: 2, projects: { s: { runtime: { per_ticket: false, orchestrator: "s:orq" } } } }).projects[0];
  assert.equal(solo.worker, null);
  assert.equal(solo.orchestrator, "s:orq");
  // The install's terminal is the projects' default.
  assert.throws(() => normalize({ version: 2, terminal: "orca", projects: { x: {} } }), /orca needs/);
  assert.equal(normalize({ version: 2, terminal: "orca", projects: { x: { repo: "~/x", runtime: {} } } }).projects[0].terminals.worktree, "~/x");
  assert.throws(() => normalize({ version: 2, terminal: "screen" }), /terminal must be/);
});

test("tracker none and agent profile location", () => {
  const p = normalize({ version: 2, projects: { a: { tracker: { type: "none" }, agents: { profile: "code-agents", location: "repo" } } } }).projects[0];
  assert.equal(p.tracker, null);
  assert.deepEqual(p.agents, { profile: "code-agents", location: "repo" });
  assert.throws(() => normalize({ version: 2, projects: { a: { agents: { location: "cloud" } } } }), /agents.location/);
});

test("orca layout comes from the config: hub URL, origins, hosts and sessions", () => {
  const cfg = normalize({ version: 2, public_url: ["http://srv:7420/", "http://10.0.0.2:7420"], orca: { agents_dir: "~/o" },
    projects: { a: { host: "srv", runtime: { orchestrator: "work:orq" } }, b: { host: "mac" } } });
  assert.deepEqual(orcaLayout(cfg), {
    hub: "http://srv:7420", origins: ["http://srv:7420", "http://10.0.0.2:7420"], agentsDir: "~/o",
    projects: [{ id: "a", host: "srv", session: "work" }, { id: "b", host: "mac", session: "b" }],
  });
  assert.equal(orcaLayout(normalize({ version: 2, port: 9000 })).hub, "http://127.0.0.1:9000");
});

// What config.example.yaml looked like before F0 (v1, work-hub), trimmed to what changes.
const V1_TEXT = `# work-hub: one block per project. Secrets never go here: *_env fields name a
# variable in ~/.config/work-hub/env. Restart after editing:
#   systemctl --user restart work-hub

port: 7420
bind: [127.0.0.1, 100.64.0.10]   # localhost, tailnet
data_dir: ~/.local/share/work-hub
chrome_helper: http://127.0.0.1:7421 # helper

defaults:
  daily_summary: false

projects:
  delta:
    name: Delta
    host: host-b                     # where its agents run
    worker: { dir: ~/code }          # one Claude per ticket
    orchestrator: delta:orq
    tracker: { type: jira, base_url: https://x.atlassian.net }
  epsilon:
    name: Epsilon
    worker: { dir: ~/code/R, command: pi, prompt: "/skill:r {key}" }
    orchestrator: personal:orq
    terminals: orca
    orca: { worktree: ~/code/R }
    tracker: { type: kanban-md, dir: ~/code/R/kanban }
  solo:
    orchestrator: solo:orq
`;

test("config migrate v1 -> v2: same behavior, comments kept, idempotent", () => {
  const res = migrateConfigText(V1_TEXT, { repoHasLane: (d) => d === "~/code/R" });
  assert.equal(res.changed, true);
  const before = normalize(YAML.parse(V1_TEXT));
  const after = normalize(YAML.parse(res.text));
  assert.equal(after.version, 2);
  for (const k of ["port", "bind", "allowFrom", "dataDir", "chromeHelper", "timezone", "messageTag"]) assert.deepEqual(after[k], before[k], k);
  assert.equal(before.timezone, after.timezone);
  before.projects.forEach((p, i) => {
    for (const k of Object.keys(p).filter((k) => k !== "agents")) assert.deepEqual(after.projects[i][k], p[k], `${p.id}.${k}`);
  });
  assert.deepEqual(after.projects.map((p) => p.agents.location), ["external", "repo", "external"]);
  assert.equal(after.projects[2].worker, null); // orchestrator only stays orchestrator only
  assert.match(res.text, /# where its agents run/);
  assert.match(res.text, /helper: http:\/\/127\.0\.0\.1:7421 # helper/);
  assert.match(res.text, /~\/\.config\/overhaul\/env/);
  assert.doesNotMatch(res.text, /\bworker:|terminals:|chrome_helper/);
  assert.deepEqual(migrateConfigText(res.text), { text: res.text, changed: false, notes: ["ya es v2"] });
});

test("config migrate moves data_dir and adds public_url and orca only when asked", () => {
  const plain = normalize(YAML.parse(migrateConfigText(V1_TEXT).text));
  assert.equal(plain.dataDir, path.join(os.homedir(), ".local/share/work-hub"));
  const moved = normalize(YAML.parse(migrateConfigText(V1_TEXT, { moveData: true, publicUrls: ["http://j:7420"], agentsDir: "~/A" }).text));
  assert.equal(moved.dataDir, path.join(os.homedir(), ".local/share/overhaul"));
  assert.deepEqual(moved.publicUrls, ["http://j:7420"]);
  assert.equal(moved.orca.agentsDir, "~/A");
});

test("config migrate writes a backup and leaves v2 files alone", async () => {
  const { migrateConfigFile } = await import("../src/configmigrate.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-mig-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, V1_TEXT);
  assert.equal(migrateConfigFile(file, { dryRun: true }).changed, true);
  assert.equal(fs.readFileSync(file, "utf8"), V1_TEXT); // dry run: untouched
  const res = migrateConfigFile(file);
  assert.equal(fs.readFileSync(res.backup, "utf8"), V1_TEXT);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(migrateConfigFile(file).changed, false);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test("config migrate: explicit version 1 is replaced, unknown versions refused, other orca keys kept", () => {
  const res = migrateConfigText(`version: 1\nprojects:\n  a:\n    worker: { dir: ~/a }\n    orca: { worktree: ~/a, extra: 1 }\n    terminals: orca\n`);
  const raw = YAML.parse(res.text); // throws on duplicate keys
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.projects.a.orca, { extra: 1 });
  assert.equal(raw.projects.a.runtime.orca_worktree, "~/a");
  assert.ok(res.notes.some((n) => /orca conserva extra/.test(n)));
  assert.throws(() => migrateConfigText("version: 3\n"), /versión de config desconocida/);
});

test("auto_work agent defaults to claude whatever the runtime command", () => {
  assert.equal(normalize({ projects: { a: { worker: { command: "pi" }, auto_work: { enabled: true, repo: "~/x" } } } }).projects[0].autoWork.agentCommand, "claude");
  assert.equal(normalize({ version: 2, projects: { a: { repo: "~/x", runtime: { command: "pi" }, auto_work: true } } }).projects[0].autoWork.agentCommand, "claude");
});
