// Contract tests for `overhaul service`, `install-hooks` and `set-password` (docs/contract.md,
// "Servicios", "Hook"). Black box (OVERHAUL_BIN) on a temporary HOME, with recording fakes for
// systemctl and launchctl (OVERHAUL_SYSTEMCTL, OVERHAUL_LAUNCHCTL): never this machine's services.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONTRACT, PKG_VERSION, cleanEnv, overhaul, tmp } from "./contract-lib.mjs";

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file) => fs.readFileSync(file, "utf8");

// A fake systemctl / launchctl that logs its arguments, one call per line.
function fakeTool(dir, name, script = "") {
  const log = path.join(dir, `${name}.log`);
  const file = path.join(dir, name);
  write(file, `#!/bin/sh\necho "$*" >> "${log}"\n${script}\nexit 0\n`);
  fs.chmodSync(file, 0o755);
  return { file, calls: () => (fs.existsSync(log) ? read(log).trim().split("\n") : []) };
}

// Shell words (no spaces in our temporary paths, but quotes are allowed).
const words = (line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
// The command a service or hook runs is this program: running it with `version` says so.
function assertRunsOverhaul(argv, env) {
  const r = spawnSync(argv[0], [...argv.slice(1), "version"], { env, encoding: "utf8" });
  assert.equal(r.stdout.trim(), PKG_VERSION, `${argv.join(" ")} version: ${r.stderr}`);
}

function v01(home) {
  write(path.join(home, ".config/overhaul/config.yaml"), "version: 2\nport: 1\ndata_dir: ~/.local/share/overhaul\nprojects: {}\n");
  write(path.join(home, ".config/overhaul/env"), "HUB_TOKEN=a-long-ui-password\nHUB_AGENT_TOKEN=an-agent-token-of-24-chars-or-more\n");
  write(path.join(home, ".local/share/overhaul/session.key"), "k");
  const hook = (cmd) => ({ hooks: [{ type: "command", command: cmd, timeout: 5 }] });
  write(path.join(home, ".claude/settings.json"), JSON.stringify({
    hooks: {
      Stop: [hook("/n/node /old/app/current/bin/hub-hook.mjs"), hook("say done")],
      UserPromptSubmit: [hook("/n/node /old/app/current/bin/hub-hook.mjs")],
    },
  }));
  write(path.join(home, ".pi/agent/extensions/overhaul.ts"), 'const NODE = "/n/node";\nconst HOOK = "/old/bin/hub-hook.mjs";\n');
}

test("service install (Linux): stops, removes earlier services, migrates, writes units that run the executable, repoints hooks", () => {
  const home = tmp("overhaul-svc-");
  v01(home);
  const units = path.join(home, ".config/systemd/user");
  write(path.join(units, "overhaul.service"), "[Service]\nExecStart=/n/node /old/src/server.mjs\n");
  write(path.join(units, "work-hub.service"), "[Service]\nExecStart=/n/node /wh/src/server.mjs\n");
  write(path.join(units, "unrelated.service"), "x");
  const sc = fakeTool(home, "systemctl", '[ "$2" = is-active ] && echo active');
  const env = cleanEnv(home, { OVERHAUL_SYSTEMCTL: sc.file, OVERHAUL_PLATFORM: "linux" });

  const dry = overhaul(["service", "install", "--dry-run"], { env });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.equal(sc.calls().length, 0);
  assert.match(read(path.join(units, "overhaul.service")), /server\.mjs/);

  const r = overhaul(["service", "install"], { env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const oh = path.join(home, ".overhaul");
  assert.ok(fs.existsSync(path.join(oh, "session.key")), "data migrated before starting");
  assert.ok(!fs.existsSync(path.join(units, "work-hub.service")));
  assert.ok(fs.existsSync(path.join(units, "unrelated.service")));
  for (const [unit, args] of Object.entries(CONTRACT.services.linux.units)) {
    const text = read(path.join(units, unit));
    const exec = words(text.match(/^ExecStart=(.*)$/m)[1]);
    assert.deepEqual(exec.slice(-args.length), args, unit);
    assertRunsOverhaul(exec.slice(0, -args.length), env);
    assert.match(text, new RegExp(`^Environment="OVERHAUL_HOME=${oh}"$`, "m"));
    assert.match(text, /^Environment="PATH=/m);
    assert.match(text, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(text, /server\.mjs|hub-hook/);
  }
  const calls = sc.calls();
  assert.ok(calls.includes("--user stop overhaul.service"), calls.join("\n"));
  assert.ok(calls.includes("--user disable --now work-hub.service"));
  assert.ok(calls.indexOf("--user daemon-reload") < calls.indexOf("--user restart overhaul.service overhaul-bridge.service"));
  assert.ok(calls.includes("--user enable overhaul.service overhaul-bridge.service"));

  // Hooks of v0.1 now run the executable; other hooks are left alone; pi too.
  const settings = JSON.parse(read(path.join(home, ".claude/settings.json")));
  const stop = settings.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
  assert.equal(stop[1], "say done");
  const w = words(stop[0]);
  assert.deepEqual(w.slice(-2), ["hook", "Stop"]);
  assertRunsOverhaul(w.slice(0, -2), env);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["Stop", "UserPromptSubmit"]); // repoint only
  assert.match(read(path.join(home, ".pi/agent/extensions/overhaul.ts")), /const OVERHAUL: string\[\] = \[/);

  const st = overhaul(["service", "status"], { env });
  assert.equal(st.status, 0, st.stdout);
  assert.match(st.stdout, /hub\s+corriendo/);
  assert.match(st.stdout, /bridge\s+corriendo/);

  // Again: the same files, nothing migrated twice.
  const again = overhaul(["service", "install"], { env });
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.doesNotMatch(again.stdout, /migrados/);

  const un = overhaul(["service", "uninstall"], { env });
  assert.equal(un.status, 0);
  for (const unit of Object.keys(CONTRACT.services.linux.units)) assert.ok(!fs.existsSync(path.join(units, unit)));
  assert.ok(fs.existsSync(path.join(oh, "config.yaml")), "uninstall keeps ~/.overhaul");
  assert.equal(overhaul(["service", "start"], { env }).status, 1);
});

test("service install (macOS): LaunchAgents overhaul.hub and overhaul.bridge, logs in ~/.overhaul/logs; helper agents kept", () => {
  const home = tmp("overhaul-svc-");
  const agents = path.join(home, "Library/LaunchAgents");
  write(path.join(agents, "com.me.work-hub.plist"), "<plist>server.mjs</plist>");
  write(path.join(agents, "com.me.work-hub-helper.plist"), "<plist>chrome-helper</plist>");
  write(path.join(agents, "overhaul.helper.plist"), "<plist>overhaul-helper</plist>");
  const lc = fakeTool(home, "launchctl");
  const env = cleanEnv(home, { OVERHAUL_LAUNCHCTL: lc.file, OVERHAUL_PLATFORM: "darwin" });
  const r = overhaul(["service", "install"], { env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const oh = path.join(home, ".overhaul");
  for (const [label, args] of Object.entries(CONTRACT.services.darwin.labels)) {
    const text = read(path.join(agents, `${label}.plist`));
    assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${label.replace(".", "\\.")}</string>`));
    const prog = [...text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    assert.deepEqual(prog.slice(-args.length), args);
    assertRunsOverhaul(prog.slice(0, -args.length), env);
    assert.match(text, new RegExp(`<string>${path.join(oh, CONTRACT.services.darwin.logs[label])}</string>`));
    assert.match(text, new RegExp(`<key>OVERHAUL_HOME</key>\\s*<string>${oh}</string>`));
    assert.ok(lc.calls().some((c) => c.startsWith("bootstrap gui/") && c.endsWith(`${label}.plist`)));
  }
  assert.ok(fs.existsSync(path.join(oh, "logs")));
  assert.ok(!fs.existsSync(path.join(agents, "com.me.work-hub.plist")));
  assert.ok(fs.existsSync(path.join(agents, "com.me.work-hub-helper.plist")), "helper side is the helper installer's");
  assert.ok(fs.existsSync(path.join(agents, "overhaul.helper.plist")));
  assert.match(r.stdout, /sin contraseña/);
});

test("install-hooks: adds `overhaul hook <Event>` for every event, repoints v0.1 hooks, keeps a backup", () => {
  const home = tmp("overhaul-hooks-");
  const env = cleanEnv(home);
  const fresh = path.join(home, ".claude/settings.json");
  const r = overhaul(["install-hooks"], { env });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(read(fresh));
  assert.deepEqual(Object.keys(s.hooks).sort(), [...CONTRACT.hook.events].sort());
  for (const ev of CONTRACT.hook.events) {
    const [h] = s.hooks[ev][0].hooks;
    const w = words(h.command);
    assert.deepEqual(w.slice(-2), ["hook", ev]);
    assert.equal(h.timeout, 5);
  }
  assert.match(overhaul(["install-hooks"], { env }).stdout, /already installed/);

  const other = path.join(home, "other.json");
  write(other, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /gone/bin/hub-hook.mjs" }] }] }, model: "x" }));
  const only = overhaul(["install-hooks", "--settings", other, "--repoint-only"], { env });
  assert.match(only.stdout, /Stop \(repointed\)/);
  const o = JSON.parse(read(other));
  assert.deepEqual(Object.keys(o.hooks), ["Stop"]);
  assert.equal(o.model, "x");
  assert.deepEqual(words(o.hooks.Stop[0].hooks[0].command).slice(-2), ["hook", "Stop"]);
  assert.ok(fs.readdirSync(home).some((f) => f.startsWith("other.json.bak-overhaul-")));
});

test("set-password writes the variable auth.password_env names, only that line; refuses short or different ones", () => {
  const home = tmp("overhaul-pw-");
  const oh = path.join(home, ".overhaul");
  write(path.join(oh, "config.yaml"), "version: 2\nauth: { password_env: OVERHAUL_PASSWORD }\n");
  write(path.join(oh, "env"), "HUB_AGENT_TOKEN=x\n");
  const env = cleanEnv(home);
  const ok = overhaul(["set-password", "--no-restart"], { env, input: "a-long-password-1\na-long-password-1\n" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(read(path.join(oh, "env")), "OVERHAUL_PASSWORD=a-long-password-1\nHUB_AGENT_TOKEN=x\n");
  assert.equal(fs.statSync(path.join(oh, "env")).mode & 0o777, 0o600);
  assert.equal(overhaul(["set-password", "--no-restart"], { env, input: "short\nshort\n" }).status, 2);
  assert.equal(overhaul(["set-password", "--no-restart"], { env, input: "a-long-password-2\na-long-password-3\n" }).status, 2);
  assert.match(read(path.join(oh, "env")), /^OVERHAUL_PASSWORD=a-long-password-1$/m);
});
