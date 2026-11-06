// overhaul init (src/wizard.mjs): answers through a simulated stdin, Jira and Kaneo as local fake
// servers, a temporary HOME. Nothing reaches a real API, the real ~/.overhaul or real hooks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { normalize } from "../src/config.mjs";
import { findRepos, prompter, proposeRepo, runInit, writeProject, listProjects, removeProject } from "../src/wizard.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const SELF = ["/opt/overhaul/bin/overhaul"];

// A machine: HOME, a bin folder in the PATH for fake tools (plus the system's, for git), OVERHAUL_HOME.
function machine() {
  const home = tmp("overhaul-wiz-");
  const bin = path.join(home, "fakebin");
  fs.mkdirSync(bin);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, OVERHAUL_HOME: path.join(home, ".overhaul") };
  return { home, bin, env, config: path.join(home, ".overhaul/config.yaml"), envFile: path.join(home, ".overhaul/env") };
}
const fakeTool = (m, name, script = "exit 0") => fs.writeFileSync(path.join(m.bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

function gitRepo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  for (const [f, text] of Object.entries(files)) write(path.join(dir, f), text);
  return dir;
}

// Two repos under one folder: an Express API and a React web app.
function twoRepos(home) {
  const parent = path.join(home, "code/acme");
  gitRepo(path.join(parent, "api"), { "package.json": JSON.stringify({ name: "api", description: "API y modelo de datos", dependencies: { express: "4" } }) });
  gitRepo(path.join(parent, "web"), { "package.json": JSON.stringify({ name: "web", dependencies: { react: "18", vite: "5" } }), "README.md": "# Web\n\nLa tienda en línea.\n" });
  fs.mkdirSync(path.join(parent, "notes")); // not a repo
  return parent;
}

// The wizard with these answers, one per line; returns its exit code and what it printed.
async function wizard(m, cwd, answers, extra = {}) {
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d));
  const io = prompter({ input: Readable.from([answers.map((a) => `${a}\n`).join("")]), output });
  const code = await runInit({ cwd, env: m.env, userHome: m.home, io, self: SELF, openUrl: () => {}, ...extra });
  return { code, out };
}

// Jira Cloud: /myself with Basic email:token, /project/search, /search/jql. Logs what it got.
async function fakeJira({ email = "me@example.com", token = "jira-secret-token" } = {}) {
  const seen = [];
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== auth) return json(401, { errorMessages: ["Unauthorized"] });
    if (url.pathname === "/rest/api/3/myself") return json(200, { displayName: "Me Myself", emailAddress: email });
    if (url.pathname === "/rest/api/3/project/search") return json(200, { values: [{ key: "ACME", name: "Acme Shop" }, { key: "OPS", name: "Operations" }], isLast: true });
    if (url.pathname === "/rest/api/3/search/jql") {
      if (/nonsense/.test(url.searchParams.get("jql"))) return json(400, { errorMessages: ["Error in the JQL Query"] });
      return json(200, { issues: [{ key: "ACME-1" }, { key: "ACME-2" }] });
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

async function fakeKaneo({ token = "kaneo-secret" } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
    if (url.pathname === "/api/auth/organization/list") return json(200, [{ id: "ws-1", name: "Main" }]);
    if (url.pathname === "/api/project" && url.searchParams.get("workspaceId") === "ws-1") {
      return json(200, [{ id: "p1", slug: "abc", name: "Alpha" }, { id: "p2", slug: "xyz", name: "Beta" }, { id: "p3", slug: "other", name: "Other team" }]);
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

const project = (m, id) => YAML.parse(fs.readFileSync(m.config, "utf8")).projects[id];
const envVars = (m) => fs.readFileSync(m.envFile, "utf8");

test("detection: one repo, or the git children of a folder; role and description from the stack", () => {
  const m = machine();
  const parent = twoRepos(m.home);
  assert.deepEqual(findRepos(parent), { single: false, repos: [path.join(parent, "api"), path.join(parent, "web")] });
  assert.deepEqual(findRepos(path.join(parent, "api")), { single: true, repos: [path.join(parent, "api")] });
  assert.deepEqual(proposeRepo(path.join(parent, "api")), { role: "backend", description: "API y modelo de datos", stack: "Express, Node.js" });
  assert.deepEqual(proposeRepo(path.join(parent, "web")), { role: "frontend", description: "La tienda en línea.", stack: "React, Node.js" });
  const go = gitRepo(path.join(m.home, "svc"), { "go.mod": "module example.com/svc\n", "main.go": "package main\n" });
  assert.equal(proposeRepo(go).role, "backend");
  assert.equal(proposeRepo(go).stack, "Go");
});

test("init, Jira Cloud with two repos: validates the token, lists projects, builds the JQL, writes config and env", async () => {
  const m = machine();
  const parent = twoRepos(m.home);
  const jira = await fakeJira();
  try {
    const { code, out } = await wizard(m, parent, [
      "1", // tracker: jira
      "Acme", "", // name, id (acme)
      jira.url, "s", // URL; not atlassian.net, but Cloud
      "me@example.com", "jira-secret-token",
      "1", // ACME
      "", // the proposed JQL
      "", // repos: all
      "", "", // api: backend, its package.json description
      "", "Tienda web", // web: frontend, own description
      "", "", "", "", "", // claude, no prompt, tmux, acme:orq, external
      "", // save
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /1\. Tracker/);
    assert.match(out, /Conectado como Me Myself/);
    assert.match(out, /ACME — Acme Shop/);
    assert.match(out, /Ese JQL trae 2 ticket\(s\)/);
    assert.match(out, /Rol y descripción de cada repo/);
    assert.match(out, /Listo: http:\/\/localhost:7420\/p\/acme/);
    assert.match(out, /Servicios no instalados/);
    assert.doesNotMatch(out, /jira-secret-token/, "the token is never printed");

    const p = project(m, "acme");
    assert.equal(p.name, "Acme");
    assert.deepEqual(p.tracker, {
      type: "jira", base_url: jira.url, email_env: "ACME_JIRA_EMAIL", token_env: "ACME_JIRA_TOKEN",
      jql: "project = ACME AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    });
    assert.deepEqual(p.repos, [
      { path: "~/code/acme/api", role: "backend", description: "API y modelo de datos" },
      { path: "~/code/acme/web", role: "frontend", description: "Tienda web" },
    ]);
    assert.equal(p.repos_root, "~/code/acme");
    assert.equal(p.repo, undefined);
    assert.deepEqual(p.runtime, { dir: "~/code/acme", command: "claude", orchestrator: "acme:orq", terminal: "tmux" });
    assert.deepEqual(p.agents, { location: "external", profile: "default" });
    assert.match(envVars(m), /^ACME_JIRA_EMAIL=me@example\.com$/m);
    assert.match(envVars(m), /^ACME_JIRA_TOKEN=jira-secret-token$/m);
    assert.match(envVars(m), /^HUB_AGENT_TOKEN=/m);
    assert.equal(fs.statSync(m.envFile).mode & 0o777, 0o600);
    // setup's comments survive, and the hub loads it.
    assert.match(fs.readFileSync(m.config, "utf8"), /^# Overhaul, config v2/);
    const cfg = normalize(YAML.parse(fs.readFileSync(m.config, "utf8")));
    assert.deepEqual(cfg.projects[0].repoInfo.map((r) => r.role), ["backend", "frontend"]);
    assert.ok(jira.seen.some((s) => s.path === "/rest/api/3/search/jql" && /project = ACME/.test(s.query.jql)));
  } finally { jira.close(); }
});

test("init: a bad token asks again; a rejected JQL is asked again", async () => {
  const m = machine();
  const parent = twoRepos(m.home);
  const jira = await fakeJira();
  try {
    const { code, out } = await wizard(m, parent, [
      "jira", "Acme", "acme",
      jira.url, "s", "me@example.com", "wrong-token",
      "s", // try again
      jira.url, "s", "me@example.com", "jira-secret-token",
      "OPS", "project = OPS AND nonsense", "project = OPS",
      "1", "", "", "", "", "", "", "", "", "",
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /No pude validar: Jira: 401/);
    assert.match(out, /Jira no aceptó el JQL/);
    const p = project(m, "acme");
    assert.equal(p.tracker.jql, "project = OPS");
    assert.deepEqual(p.repos.map((r) => r.path), ["~/code/acme/api"]);
  } finally { jira.close(); }
});

test("init: giving up on credentials changes nothing", async () => {
  const m = machine();
  const parent = twoRepos(m.home);
  const jira = await fakeJira();
  try {
    const { code, out } = await wizard(m, parent, ["jira", "Acme", "acme", jira.url, "s", "me@example.com", "bad", "n"]);
    assert.equal(code, 1);
    assert.match(out, /no cambié nada/);
    assert.equal(YAML.parse(fs.readFileSync(m.config, "utf8")).projects?.acme, undefined);
    assert.doesNotMatch(envVars(m), /ACME_JIRA/);
  } finally { jira.close(); }
});

test("init in the same folder again offers to edit it, never a second project; Enter keeps what is there", async () => {
  const m = machine();
  const parent = twoRepos(m.home);
  const jira = await fakeJira();
  try {
    const answers = ["1", "Acme", "", jira.url, "s", "me@example.com", "jira-secret-token", "1", "", "", "", "", "", "", "", "", "", "", "", ""];
    assert.equal((await wizard(m, parent, answers)).code, 0);
    fs.appendFileSync(m.config, "# my own comment\n");
    const before = fs.readFileSync(m.config, "utf8");

    const no = await wizard(m, parent, ["n"]);
    assert.equal(no.code, 1);
    assert.match(no.out, /Esta carpeta ya es el proyecto «Acme» \(acme\)/);
    assert.equal(fs.readFileSync(m.config, "utf8"), before);

    // Edit: everything by Enter (token kept), except web's role.
    const edit = await wizard(m, parent, ["s", "", "", "", "", "", "", "", "", "", "", "", "ui", "", "", "", "", "", "", ""]);
    assert.equal(edit.code, 0, edit.out);
    assert.match(edit.out, /\[guardado; Enter lo mantiene\]/);
    const text = fs.readFileSync(m.config, "utf8");
    assert.match(text, /# my own comment/);
    assert.equal(Object.keys(YAML.parse(text).projects).length, 1);
    assert.equal(project(m, "acme").repos[1].role, "ui");
    assert.match(envVars(m), /^ACME_JIRA_TOKEN=jira-secret-token$/m);
  } finally { jira.close(); }
});

test("init: an id that exists elsewhere offers to edit that project", async () => {
  const m = machine();
  const parent = twoRepos(m.home);
  const { code } = await wizard(m, path.join(parent, "api"), ["none", "Acme", "acme", "", "", "", "", "", "", "", ""]);
  assert.equal(code, 0);
  const { code: c2, out } = await wizard(m, parent, ["none", "Acme 2", "acme", "s", "", "", "", "", "", "", "", "", "", "", ""]);
  assert.equal(c2, 0, out);
  assert.match(out, /Ya existe el proyecto acme \(en ~\/code\/acme\/api\)/);
  const projects = YAML.parse(fs.readFileSync(m.config, "utf8")).projects;
  assert.deepEqual(Object.keys(projects), ["acme"]);
  assert.equal(projects.acme.name, "Acme 2");
  assert.equal(projects.acme.repos_root, "~/code/acme");
  assert.equal(projects.acme.repo, undefined); // moved from one repo to the parent folder
});

test("init, Kaneo on a shared workspace: lists workspaces and projects, writes the projects filter", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/alpha"), { "go.mod": "module x\n" });
  const kaneo = await fakeKaneo();
  try {
    const { code, out } = await wizard(m, repo, [
      "2", "Alpha", "",
      kaneo.url, "kaneo-secret",
      "", // the only workspace
      "s", "", "1,xyz", // shared; projects; Alpha and Beta
      "", "", // repo role, description
      "", "", "", "", "",
      "",
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /el workspace tiene 3 proyecto\(s\): Alpha \(abc\), Beta \(xyz\), Other team \(other\)/);
    const p = project(m, "alpha");
    assert.deepEqual(p.tracker, { type: "kaneo", base_url: kaneo.url, workspace_id: "ws-1", token_env: "ALPHA_KANEO_TOKEN", projects: ["abc", "xyz"] });
    assert.equal(p.repo, "~/code/alpha");
    assert.equal(p.repos_root, undefined);
    assert.match(envVars(m), /^ALPHA_KANEO_TOKEN=kaneo-secret$/m);
    assert.ok(kaneo.seen.every((s) => s.path !== "/api/project" || s.query.workspaceId === "ws-1"));
  } finally { kaneo.close(); }
});

test("init, kanban-md recommended without a tracker: runs kanban-md init; without kanban-md says how to install it", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/notes-app"), { "README.md": "# Notes\n\nNotas rápidas.\n" });
  fakeTool(m, "kanban-md", `echo "$*" >> "$HOME/kanban.log"; while [ $# -gt 0 ]; do [ "$1" = --dir ] && { mkdir -p "$2/tasks"; echo "name: x" > "$2/config.yml"; }; shift; done`);
  const { code, out } = await wizard(m, repo, ["", "Notes", "", "", "", "", "", "", "", "", "", "", "", ""]);
  assert.equal(code, 0, out);
  assert.match(out, /Te recomiendo kanban-md/);
  assert.match(fs.readFileSync(path.join(m.home, "kanban.log"), "utf8"), new RegExp(`^init --dir ${repo}/kanban --name Notes$`, "m"));
  assert.deepEqual(project(m, "notes").tracker, { type: "kanban-md", dir: "~/code/notes-app/kanban", prefix: "NOTE" });
  assert.equal(project(m, "notes").repos[0].description, "Notas rápidas.");

  const m2 = machine();
  const repo2 = gitRepo(path.join(m2.home, "code/x"));
  const r2 = await wizard(m2, repo2, ["3", "X", "", "", "", "", "", "", "", "", "", "", ""]);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /kanban-md no está instalado\. Instálalo \(https:\/\/github\.com\/antopolskiy\/kanban-md/);
  assert.equal(project(m2, "x").tracker.type, "kanban-md");
});

test("init: a repo with its own lane (ORCA.md, .pi/) keeps it: pi by default, profile in the repo", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/lane"), { "ORCA.md": "# lanes\n", ".pi/settings.json": "{}" });
  const { code, out } = await wizard(m, repo, ["none", "Lane", "", "", "", "", "/skill:lane-orchestrator {key}", "", "", ""]);
  assert.equal(code, 0, out);
  assert.match(out, /tiene lane propio \(ORCA\.md\): lo respeto/);
  const p = project(m, "lane");
  assert.equal(p.runtime.command, "pi");
  assert.equal(p.runtime.prompt, "/skill:lane-orchestrator {key}");
  assert.deepEqual(p.agents, { location: "repo" });
});

test("init: installs Claude's hook and pi's extension when missing, asking first", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/h"));
  fakeTool(m, "claude");
  fakeTool(m, "pi");
  const { code, out } = await wizard(m, repo, ["none", "H", "", "", "", "", "", "", "", "", "", "s", "s"]);
  assert.equal(code, 0, out);
  const settings = JSON.parse(fs.readFileSync(path.join(m.home, ".claude/settings.json"), "utf8"));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /^\/opt\/overhaul\/bin\/overhaul hook Stop$/);
  assert.ok(fs.existsSync(path.join(m.home, ".pi/agent/extensions/overhaul.ts")));
  // Already there: not asked again.
  const again = await wizard(m, repo, ["s", "", "", "", "", "", "", "", "", "", ""]);
  assert.equal(again.code, 0, again.out);
  assert.doesNotMatch(again.out, /¿Instalo el hook/);
});

test("init restarts the services when they are installed", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/s"));
  write(path.join(m.home, ".config/systemd/user/overhaul.service"), "[Service]\n");
  const calls = [];
  const env = { ...m.env, OVERHAUL_PLATFORM: "linux" };
  const { code, out } = await wizard({ ...m, env }, repo, ["none", "S", "", "", "", "", "", "", "", "", ""], {
    runServices: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(code, 0, out);
  assert.match(out, /Reinicié el hub y el puente/);
  assert.ok(calls.some((c) => /^systemctl --user restart overhaul\.service overhaul-bridge\.service$/.test(c)), calls.join("\n"));
});

test("writeProject keeps other keys and comments; turns a flow `projects: {}` into a block", () => {
  const doc = YAML.parseDocument("version: 2\nprojects: {}\n# tail comment\n");
  writeProject(doc, "a", { name: "A", tracker: { type: "none" }, runtime: { command: "claude", prompt: null } });
  assert.match(doc.toString(), /^projects:\n  a:\n    name: A\n/m);
  const doc2 = YAML.parseDocument("projects:\n  a:\n    name: A # mine\n    daily_summary: true\n    runtime:\n      command: pi\n      prompt: x\n");
  writeProject(doc2, "a", { tracker: { type: "none" }, runtime: { command: "claude", prompt: null } });
  const t = doc2.toString();
  assert.match(t, /name: A # mine/);
  assert.match(t, /daily_summary: true/);
  assert.doesNotMatch(t, /prompt:/);
  assert.match(t, /command: claude/);
});

// --- The CLI (black box): --non-interactive, project list/remove, init without a project ---------
const BIN = [process.execPath, path.join(root, "bin/overhaul.mjs")];
// Async: the fake servers live in this process and must keep answering while the CLI runs.
const cli = (args, { env, cwd }) => new Promise((resolve) => {
  const child = spawn(BIN[0], [...BIN.slice(1), ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("cli: init --non-interactive with flags validates against Jira and writes the project; project list and remove", async () => {
  const m = machine();
  const parent = twoRepos(m.home);
  const jira = await fakeJira();
  try {
    const env = { ...m.env, PATH: `${m.bin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(m.home, ".config"), TMUX_PANE: "", ACME_JIRA_EMAIL: "me@example.com", ACME_JIRA_TOKEN: "jira-secret-token" };
    const r = await cli(["init", "--non-interactive", "--project", "acme", "--name", "Acme", "--tracker", "jira", "--base-url", jira.url,
      "--email-env", "ACME_JIRA_EMAIL", "--token-env", "ACME_JIRA_TOKEN", "--jql", "project = ACME",
      "--repo", "api:backend:API: pagos y modelo", "--repo", "web:frontend:", "--runtime", "my-agent --fast", "--prompt", "/skill:x {key}"], { env, cwd: parent });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /Jira: conectado como Me Myself/);
    const p = project(m, "acme");
    assert.deepEqual(p.repos, [
      { path: "~/code/acme/api", role: "backend", description: "API: pagos y modelo" },
      { path: "~/code/acme/web", role: "frontend", description: "La tienda en línea." }, // empty: proposed
    ]);
    assert.equal(p.tracker.jql, "project = ACME");
    assert.equal(p.runtime.command, "my-agent --fast");
    assert.equal(p.runtime.prompt, "/skill:x {key}");
    assert.match(envVars(m), /^ACME_JIRA_TOKEN=jira-secret-token$/m);

    const list = await cli(["project", "list", "--json"], { env, cwd: m.home });
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).map((x) => [x.id, x.tracker, x.dir]), [["acme", "jira", parent]]);

    // Same folder again, non-interactive: edits in place.
    const again = await cli(["init", "--non-interactive", "--tracker", "jira", "--base-url", jira.url, "--name", "Acme Shop", "--no-validate"], { env, cwd: parent });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(project(m, "acme").name, "Acme Shop");
    assert.equal(project(m, "acme").tracker.jql, "project = ACME");
    assert.equal(project(m, "acme").repos[0].description, "API: pagos y modelo");

    const bad = await cli(["init", "--non-interactive", "--project", "bad", "--tracker", "jira", "--base-url", jira.url, "--token-env", "NOPE_TOKEN", "--email-env", "ACME_JIRA_EMAIL"], { env: { ...env, NOPE_TOKEN: "wrong" }, cwd: parent });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /401/);

    assert.equal((await cli(["project", "remove", "acme"], { env: { ...env }, cwd: parent })).status, 1, "no terminal, no --force: nothing removed");
    const rm = await cli(["project", "remove", "acme", "--force"], { env, cwd: parent });
    assert.equal(rm.status, 0, rm.stderr);
    assert.match(rm.stderr, /siguen en env \(ACME_JIRA_TOKEN, ACME_JIRA_EMAIL\)/);
    assert.deepEqual(YAML.parse(fs.readFileSync(m.config, "utf8")).projects, {});
  } finally { jira.close(); }
});

test("cli: init --non-interactive without a project, or without a terminal, is setup (as before v0.2.1)", async () => {
  const m = machine();
  const env = { ...m.env, PATH: process.env.PATH };
  const a = await cli(["init", "--non-interactive"], { env, cwd: m.home });
  assert.equal(a.status, 0, a.stderr);
  assert.ok(fs.existsSync(m.config));
  const b = await cli(["init"], { env, cwd: m.home });
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stderr, /Sin terminal: hago overhaul setup/);
  assert.deepEqual(YAML.parse(fs.readFileSync(m.config, "utf8")).projects, {});
  assert.equal((await cli(["project", "edit"], { env, cwd: m.home })).status, 2);
});

test("project list prints one line per project", () => {
  const m = machine();
  write(m.config, "version: 2\nprojects:\n  a: { name: A, repos_root: ~/code/a, tracker: { type: kaneo } }\n");
  const lines = [];
  assert.equal(listProjects({ env: m.env, userHome: m.home, log: (l) => lines.push(l) }), 0);
  assert.match(lines[0], new RegExp(`^a\\s+kaneo\\s+${m.home}/code/a  \\(A\\)$`));
});

test("project remove asks first and keeps the config on no", async () => {
  const m = machine();
  write(m.config, "version: 2\nprojects:\n  a: { name: A }\n");
  const output = new PassThrough();
  const io = prompter({ input: Readable.from(["n\n"]), output });
  assert.equal(await removeProject("a", { env: m.env, userHome: m.home, io, self: SELF }), 1);
  assert.ok(YAML.parse(fs.readFileSync(m.config, "utf8")).projects.a);
});
