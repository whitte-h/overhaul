// overhaul terminal (src/terminal.mjs) and init's terminal step: a temporary HOME, answers through a
// simulated stdin, tmux and Orca faked. Nothing reaches a real tmux, Orca or ~/.overhaul.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { prompter, runInit } from "../src/wizard.mjs";
import { runTerminal, setTerminal, ensureHelper, HELPER_URL } from "../src/terminal.mjs";

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function machine() {
  const home = tmp("overhaul-term-");
  const bin = path.join(home, "fakebin");
  fs.mkdirSync(bin);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, OVERHAUL_HOME: path.join(home, ".overhaul") };
  return { home, env, config: path.join(home, ".overhaul/config.yaml") };
}
const gitRepo = (d) => { fs.mkdirSync(d, { recursive: true }); execFileSync("git", ["init", "-q", d]); return d; };
function io(answers) {
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d));
  const p = prompter({ input: Readable.from([answers.map((a) => `${a}\n`).join("")]), output });
  return { io: p, out: () => out };
}
// A project in config.yaml, with a comment of yours to keep.
function withProject(m, block) {
  fs.mkdirSync(path.dirname(m.config), { recursive: true });
  fs.writeFileSync(m.config, `# mine, keep me\nversion: 2\nport: 7420\nprojects:\n  demo:\n${YAML.stringify(block).replace(/^/gm, "    ")}`);
}
const projectOf = (m, id = "demo") => YAML.parse(fs.readFileSync(m.config, "utf8")).projects[id];
// The parts of src/orca.mjs that overhaul terminal and init use.
function fakeOrca() {
  const calls = [];
  return {
    calls,
    ensureOrcaRunning: async () => calls.push(["running"]),
    ensureOrg: async (p, o) => { calls.push(["org", p.id, o.hubUrl]); o.log("grupo Demo: creado"); return { worktree: "id:folder:f1", orchestrator: "term_orq" }; },
    orca: async (args) => { calls.push(args); return { focus: { handle: args[3], navigated: true } }; },
  };
}
// A tmux without the session: records what it is asked.
function fakeTmux(windows = null) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "has-session") { if (!windows) throw new Error("no session"); return { stdout: "" }; }
    if (args[0] === "list-windows") return { stdout: `${windows.join("\n")}\n` };
    if (args[0] === "new-session" || args[0] === "new-window") return { stdout: "@7\n" };
    return { stdout: "" };
  };
  return { calls, run };
}

test("terminal: asks tmux or orca the first time, keeps it in config.yaml with your comments, then opens Orca", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/demo"));
  withProject(m, { name: "Demo", repo, runtime: { dir: repo, command: "claude", orchestrator: "demo:orq" } });
  const orca = fakeOrca();
  const t = io(["orca"]);
  const code = await runTerminal(undefined, { cwd: repo, env: m.env, userHome: m.home, io: t.io, orca });
  assert.equal(code, 0, t.out());
  assert.match(t.out(), /¿Dónde corren los agentes\?/);
  const text = fs.readFileSync(m.config, "utf8");
  assert.match(text, /# mine, keep me/);
  assert.equal(projectOf(m).runtime.terminal, "orca");
  assert.equal(YAML.parse(text).helper, undefined); // standalone: no helper
  assert.deepEqual(orca.calls[0], ["running"]);
  assert.deepEqual(orca.calls[1], ["org", "demo", "http://127.0.0.1:7420"]);
  assert.deepEqual(orca.calls[2], ["terminal", "switch", "--terminal", "term_orq"]);
  assert.match(t.out(), /grupo Demo: creado/);
  assert.match(t.out(), /al frente en Orca/);

  // Already set: no question.
  const t2 = io([]);
  assert.equal(await runTerminal(undefined, { cwd: repo, env: m.env, userHome: m.home, io: t2.io, orca: fakeOrca() }), 0, t2.out());
  assert.doesNotMatch(t2.out(), /¿Dónde corren/);
});

test("terminal: on a server (no window) says to follow it from the desktop", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/demo"));
  withProject(m, { repo, runtime: { dir: repo, terminal: "orca" } });
  const orca = { ...fakeOrca(), orca: async () => ({ focus: { navigated: false } }) };
  const t = io([]);
  assert.equal(await runTerminal("demo", { cwd: m.home, env: m.env, userHome: m.home, io: t.io, orca }), 0, t.out());
  assert.match(t.out(), /no tiene ventana \(servidor\)/);
});

test("terminal --non-interactive needs --terminal when the project has none; Orca errors say so", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/demo"));
  withProject(m, { repo, runtime: { dir: repo } });
  const t = io([]);
  assert.equal(await runTerminal(undefined, { cwd: repo, env: m.env, userHome: m.home, nonInteractive: true, io: t.io }), 2);
  assert.match(t.out(), /--terminal tmux\|orca/);
  const t2 = io([]);
  assert.equal(await runTerminal(undefined, { cwd: repo, env: m.env, userHome: m.home, nonInteractive: true, io: t2.io, flags: { terminal: "screen" } }), 2);
  const t3 = io([]);
  const broken = { ...fakeOrca(), ensureOrg: async () => { throw new Error("socket closed"); } };
  assert.equal(await runTerminal(undefined, { cwd: repo, env: m.env, userHome: m.home, nonInteractive: true, io: t3.io, flags: { terminal: "orca" }, orca: broken }), 1);
  assert.match(t3.out(), /Orca: socket closed/);
  assert.equal(projectOf(m).runtime.terminal, "orca"); // the choice is kept
});

test("terminal with tmux: creates the orchestrator's window (pi with a fixed session) and attaches", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/demo"));
  withProject(m, { repo, runtime: { dir: repo, command: "pi", terminal: "tmux", orchestrator: "demo:jefe" } });
  const tmux = fakeTmux();
  const attached = [];
  const t = io([]);
  const code = await runTerminal(undefined, { cwd: repo, env: m.env, userHome: m.home, io: t.io, runTmux: tmux.run, attach: (to) => (attached.push(to), 0) });
  assert.equal(code, 0, t.out());
  const created = tmux.calls.find((c) => c[0] === "new-session");
  assert.deepEqual(created.slice(0, 10), ["new-session", "-d", "-P", "-F", "#{window_id}", "-s", "demo", "-n", "jefe", "-c"]);
  assert.equal(created[10], repo);
  assert.ok(created.includes("HUB_PROJECT=demo") && created.includes("HUB_AGENT_NAME=jefe"));
  assert.match(created.at(-1), /^zsh -ic 'pi --session-id [0-9a-f-]{36}; exec zsh'$/);
  assert.ok(tmux.calls.some((c) => c[0] === "set-option" && c.includes("@hub_agent") && c.includes("pi")));
  assert.deepEqual(attached, ["=demo:jefe"]);

  // The window exists and we are inside tmux: switch only.
  const tmux2 = fakeTmux(["jefe"]);
  const t2 = io([]);
  assert.equal(await runTerminal(undefined, { cwd: repo, env: { ...m.env, TMUX: "/tmp/x,1,0" }, userHome: m.home, io: t2.io, runTmux: tmux2.run }), 0, t2.out());
  assert.ok(!tmux2.calls.some((c) => c[0] === "new-window"));
  assert.deepEqual(tmux2.calls.at(-1), ["switch-client", "-t", "=demo:jefe"]);
});

test("setTerminal: v1 projects keep their terminals key; ensureHelper adds helper above projects once", () => {
  const doc = YAML.parseDocument("port: 7420\nprojects:\n  a:\n    worker: { dir: ~/a }\n  b:\n    runtime: { dir: ~/b }\n");
  setTerminal(doc, "a", "orca");
  setTerminal(doc, "b", "orca");
  assert.equal(doc.getIn(["projects", "a", "terminals"]), "orca");
  assert.equal(doc.getIn(["projects", "b", "runtime", "terminal"]), "orca");
  assert.equal(ensureHelper(doc), true);
  assert.equal(ensureHelper(doc), false);
  assert.match(doc.toString(), new RegExp(`port: 7420\\nhelper: ${HELPER_URL.replace(/[./]/g, "\\$&")}\\nprojects:`));
});

test("init --non-interactive --terminal orca: writes it, builds the project in Orca; --helper writes helper", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/demo"));
  const orca = fakeOrca();
  const out = [];
  const quiet = { say: (s = "") => out.push(s) };
  const code = await runInit({ cwd: repo, env: m.env, userHome: m.home, nonInteractive: true, io: quiet, self: ["/x/overhaul"], restart: false, orca,
    flags: { tracker: "none", project: "demo", terminal: "orca", helper: true } });
  assert.equal(code, 0, out.join("\n"));
  const cfg = YAML.parse(fs.readFileSync(m.config, "utf8"));
  assert.equal(cfg.projects.demo.runtime.terminal, "orca");
  assert.equal(cfg.helper, HELPER_URL);
  assert.deepEqual(orca.calls.map((c) => c[0]), ["running", "org"]);
  assert.match(out.join("\n"), /Orca: listo/);
});

test("init --terminal orca without Orca on the machine: saves and says how to finish", async () => {
  const m = machine();
  const repo = gitRepo(path.join(m.home, "code/demo"));
  const out = [];
  const env = { ...m.env, ORCA_BIN: path.join(m.home, "no/orca") }; // not even Orca.app's
  const code = await runInit({ cwd: repo, env, userHome: m.home, nonInteractive: true, io: { say: (s = "") => out.push(s) }, self: ["/x/overhaul"], restart: false,
    flags: { tracker: "none", project: "demo", terminal: "orca" } });
  assert.equal(code, 0, out.join("\n"));
  assert.equal(YAML.parse(fs.readFileSync(m.config, "utf8")).helper, undefined);
  assert.match(out.join("\n"), /no lo encuentro en esta máquina.*overhaul terminal/);
});
