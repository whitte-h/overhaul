// The `overhaul` CLI's admin commands, always on temporary folders (HUB_CONFIG_DIR, --dir).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function cli(args, env = {}) {
  const base = { PATH: process.env.PATH, HOME: tmp("overhaul-cli-home-") };
  return spawnSync(process.execPath, [path.join(root, "bin/hub.mjs"), ...args], { env: { ...base, ...env }, encoding: "utf8" });
}

test("config migrate: dry run prints v2, then migrates with a backup", () => {
  const dir = tmp("overhaul-cli-");
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, "port: 7420\nprojects:\n  a:\n    worker: { dir: ~/a }\n    orchestrator: a:orq\n");
  const dry = cli(["config", "migrate", "--dry-run"], { HUB_CONFIG_DIR: dir });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^version: 2$/m);
  assert.equal(fs.readdirSync(dir).length, 1);
  const real = cli(["config", "migrate", "--public-url", "http://srv:7420"], { OVERHAUL_CONFIG_DIR: dir });
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stderr, /migrado a v2/);
  assert.match(fs.readFileSync(file, "utf8"), /runtime:/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("config.yaml.bak-v1-")).length, 1);
  assert.match(cli(["config", "migrate"], { HUB_CONFIG_DIR: dir }).stderr, /sin cambios/);
});

test("orca-layout prints the helper's layout from config.yaml", () => {
  const dir = tmp("overhaul-cli-");
  fs.writeFileSync(path.join(dir, "config.yaml"), "version: 2\npublic_url: http://srv:7420\nprojects:\n  a: { host: srv }\n");
  const r = cli(["orca-layout"], { HUB_CONFIG_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).projects, [{ id: "a", host: "srv", session: "a" }]);
});

test("install-pi installs overhaul.ts and moves the old work-hub.ts out", () => {
  const ext = path.join(tmp("overhaul-pi-"), "extensions");
  fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, "work-hub.ts"), "old");
  const r = cli(["install-pi", "--dir", ext]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(ext), ["overhaul.ts"]);
  // From a clone the extension runs node + bin/overhaul.mjs hook; the executable runs itself.
  const text = fs.readFileSync(path.join(ext, "overhaul.ts"), "utf8");
  const cmd = JSON.parse(text.match(/const OVERHAUL: string\[\] = (\[.*\]);/)[1]);
  assert.deepEqual(cmd.slice(1), [path.join(root, "bin/overhaul.mjs")]);
  assert.doesNotMatch(text, /__OVERHAUL__/);
  assert.equal(fs.readdirSync(path.dirname(ext)).filter((f) => f.startsWith("work-hub.ts.bak-")).length, 1);
  assert.match(cli(["install-pi", "--dir", ext]).stdout, /already installed/);
});

test("usage names the command it was run as", () => {
  const r = cli(["nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Comando desconocido: nope/);
  assert.match(r.stderr, /Usage: hub <comando> \(hub help\)/);
  assert.match(cli(["propose"], { HUB_PROJECT: "a", HUB_TICKET: "B-1", HUB_AGENT_TOKEN: "x".repeat(24) }).stderr, /^Usage: hub propose/);
});

test("worker intro asks for initial questions with overhaul propose, with or without a project prompt", async () => {
  const { workerIntro } = await import("../src/bridge.mjs");
  for (const spawn of [null, { prompt: "/skill:x {key}" }]) {
    const intro = workerIntro({ key: "ABC-1", title: "t", spawn }, { command: "claude" });
    assert.match(intro, /overhaul propose "<pregunta 1>"/);
    assert.match(intro, /overhaul ask "<pregunta>"/);
    assert.ok(intro.indexOf("overhaul propose") < intro.indexOf("overhaul ask"));
    if (spawn) assert.ok(intro.startsWith("/skill:x ABC-1\n"));
  }
});

test("install-hooks --repoint fixes hooks whose script no longer exists", () => {
  const dir = tmp("overhaul-hooks-");
  const settings = path.join(dir, "settings.json");
  const gone = "node /nowhere/work-hub/bin/hub-hook.mjs";
  const kept = `node ${path.join(root, "bin/hub-hook.mjs")}`;
  const hooks = (cmd) => ({ hooks: [{ type: "command", command: cmd, timeout: 5 }] });
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [hooks(gone)], UserPromptSubmit: [hooks(kept)] } }));
  const py = (...a) => spawnSync("python3", [path.join(root, "deploy/install-hooks.py"), ...a], { encoding: "utf8" });
  const want = `node ${path.join(root, "bin/hub-hook.mjs")} --x`;
  assert.match(py(want, settings).stdout, /changed PermissionRequest, Notification/); // without --repoint the broken one stays
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.Stop[0].hooks[0].command, gone);
  assert.match(py("--repoint", want, settings).stdout, /Stop \(repointed\)/);
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s.hooks.Stop[0].hooks[0].command, want);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, kept); // existing script: left alone
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("settings.json.bak-overhaul-")));
});

test("helper layout: OVERHAUL_LAYOUT, else ~/.overhaul, else ~/.config/overhaul, origins default to the hub", async () => {
  const { layoutFile } = await import("../helper/orca.mjs");
  const home = tmp("overhaul-layout-");
  assert.equal(layoutFile({ OVERHAUL_LAYOUT: "/x.json" }, home), "/x.json");
  if (!fs.existsSync(path.join(root, "helper/orca-layout.json"))) assert.throws(() => layoutFile({}, home), /overhaul orca-layout/);
  const f = path.join(home, ".config/overhaul/orca-layout.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{}");
  assert.equal(layoutFile({}, home), f);
  const g = path.join(home, ".overhaul/orca-layout.json");
  fs.mkdirSync(path.dirname(g), { recursive: true });
  fs.writeFileSync(g, "{}");
  assert.equal(layoutFile({}, home), g);
  assert.equal(layoutFile({ OVERHAUL_HOME: path.join(home, "x") }, home), f);
  for (const name of ["orca-layout.example.json"]) {
    const l = JSON.parse(fs.readFileSync(path.join(root, "helper", name), "utf8"));
    assert.ok(l.hub && l.agentsDir && Array.isArray(l.projects));
  }
});

test("install-hooks --repoint-only repoints and adds nothing", () => {
  const dir = tmp("overhaul-hooks-");
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /gone/bin/hub-hook.mjs" }] }] } }));
  const r = spawnSync("python3", [path.join(root, "deploy/install-hooks.py"), "--repoint-only", "node /new/hub-hook.mjs", settings], { encoding: "utf8" });
  assert.match(r.stdout, /Stop \(repointed\)$/m);
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(Object.keys(s.hooks), ["Stop"]);
  assert.equal(s.hooks.Stop[0].hooks[0].command, "node /new/hub-hook.mjs");
});

test("set-password writes the variable config.yaml names in auth.password_env", () => {
  const dir = tmp("overhaul-pw-");
  fs.writeFileSync(path.join(dir, "config.yaml"), "version: 2\nauth: { password_env: OVERHAUL_PASSWORD }\n");
  fs.writeFileSync(path.join(dir, "env"), "HUB_AGENT_TOKEN=x\n", { mode: 0o600 });
  const r = spawnSync("bash", [path.join(root, "bin/set-password"), "--no-restart"], {
    input: "a-long-password-1\na-long-password-1\n", encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, HUB_CONFIG_DIR: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "env"), "utf8"), "OVERHAUL_PASSWORD=a-long-password-1\nHUB_AGENT_TOKEN=x\n");
});
