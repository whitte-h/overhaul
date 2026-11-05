// deploy/migrate-from-work-hub.mjs on a fake work-hub install: temporary HOME, a fake
// systemctl that only logs, and (for the health check) a tiny server on the config's port.
// Never touches this machine's services or folders.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "deploy/migrate-from-work-hub.mjs");

const V1 = (port) => `# work-hub: one block per project.
port: ${port}
bind: [127.0.0.1]
data_dir: ~/.local/share/work-hub
chrome_helper: http://127.0.0.1:7421 # helper
projects:
  gamma:
    worker: { dir: ~/code/R, command: pi }
    orchestrator: personal:orq
    tracker: { type: kanban-md, dir: ~/code/R/kanban }
`;

function fakeInstall(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-migrate-"));
  const w = (rel, text, mode) => {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, mode ? { mode } : undefined);
  };
  w(".config/work-hub/config.yaml", V1(port), 0o600);
  w(".config/work-hub/env", "HUB_TOKEN=a-long-password\nHUB_AGENT_TOKEN=x\n", 0o600);
  w(".config/work-hub/panes/personal%3Ak-1.json", '{"sessionId":"s"}');
  w(".local/share/work-hub/tickets/gamma/K-1.json", '{"notes":"mías"}');
  w(".local/share/work-hub/session.key", "k");
  w(".config/systemd/user/work-hub.service", "ExecStart=/bin/zsh -lc 'exec node %h/x/src/server.mjs'\n");
  w(".config/systemd/user/work-hub-bridge.service", "ExecStart=/bin/zsh -lc 'exec node %h/x/bin/hub.mjs bridge --host otro-host'\n");
  w(".config/systemd/user/orq@.service", "untouched\n");
  const hook = (cmd) => ({ hooks: [{ type: "command", command: cmd, timeout: 5 }] });
  w(".claude/settings.json", JSON.stringify({ hooks: { Stop: [hook("node /gone/work-hub/bin/hub-hook.mjs")] } }, null, 2));
  w(".claude-other/settings.json", JSON.stringify({ theme: "dark" }));
  w(".pi/agent/extensions/work-hub.ts", "old ext");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.symlinkSync(path.join(root, "bin/hub.mjs"), path.join(home, ".local/bin/hub"));
  fs.symlinkSync("/another/checkout/bin/hub.mjs", path.join(home, ".local/bin/overhaul")); // put back by the rollback
  // systemctl that logs every call; is-enabled/is-active say yes for the work-hub units.
  w("fake/systemctl", `#!/bin/sh\necho "$*" >> "$HOME/systemctl.log"\ncase "$2" in is-enabled|is-active) case "$4" in work-hub*) exit 0 ;; *) exit 3 ;; esac ;; esac\nexit 0\n`, 0o755);
  return home;
}

function migrate(home, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME: home, SYSTEMCTL: path.join(home, "fake/systemctl"), OVERHAUL_MIGRATE_HEALTH_SECONDS: "2", OVERHAUL_MIGRATE_ANY_REPO: "1", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (status) => resolve({ status, out }));
  });
}

// Every file under HOME (except the backups and the systemctl log) with its content.
function snapshot(home) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      const rel = path.relative(home, f);
      if (rel.startsWith(".local/state") || rel === "systemctl.log") continue;
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(f)}`;
      else if (e.isDirectory()) walk(f);
      else out[rel] = fs.readFileSync(f, "utf8");
    }
  };
  walk(home);
  return out;
}

// Backups the steps leave next to what they change (config.yaml.bak-v1-*, settings.json.bak-overhaul-*,
// work-hub.ts.bak-*) stay after a rollback, on purpose.
const LEFT_BACKUPS = /config\.yaml\.bak-v1-|settings\.json\.bak-overhaul-|^\.pi\/agent\/work-hub\.ts\.bak-/;
const withoutBackups = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !LEFT_BACKUPS.test(k)));

async function freePort() {
  const s = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.on("listening", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function withHub(port, fn) {
  const s = http.createServer((req, res) => res.writeHead(req.url === "/login.html" ? 200 : 404).end()).listen(port, "127.0.0.1");
  await new Promise((r) => s.on("listening", r));
  try { return await fn(); } finally { await new Promise((r) => s.close(r)); }
}

test("dry run prints the plan and changes nothing", async () => {
  const home = fakeInstall(await freePort());
  const before = snapshot(home);
  const r = await migrate(home, ["--dry-run"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /HUB_HOST=otro-host/);
  assert.match(r.out, /no cambié nada/);
  assert.deepEqual(snapshot(home), before);
});

test("migrates in place, keeps every file reachable by both paths, then rolls back to the same state", async () => {
  const port = await freePort();
  const home = fakeInstall(port);
  const before = snapshot(home);
  const r = await withHub(port, () => migrate(home, ["--public-url", "http://srv:7420"]));
  assert.equal(r.status, 0, r.out);
  const p = (rel) => path.join(home, rel);

  // Folders moved, old paths are links to them, nothing lost.
  assert.ok(fs.lstatSync(p(".config/work-hub")).isSymbolicLink());
  assert.ok(fs.lstatSync(p(".local/share/work-hub")).isSymbolicLink());
  assert.equal(fs.readFileSync(p(".config/overhaul/panes/personal%3Ak-1.json"), "utf8"), '{"sessionId":"s"}');
  assert.equal(fs.readFileSync(p(".local/share/work-hub/tickets/gamma/K-1.json"), "utf8"), '{"notes":"mías"}');
  assert.equal(fs.statSync(p(".config/overhaul/env")).mode & 0o777, 0o600);

  // Config v2, same behavior.
  const cfg = YAML.parse(fs.readFileSync(p(".config/overhaul/config.yaml"), "utf8"));
  assert.equal(cfg.version, 2);
  assert.equal(cfg.message_tag, "work-hub");
  assert.equal(cfg.data_dir, "~/.local/share/overhaul");
  assert.equal(cfg.helper, "http://127.0.0.1:7421");
  assert.equal(cfg.public_url, "http://srv:7420");
  assert.deepEqual(cfg.projects.gamma.runtime, { command: "pi", dir: "~/code/R", orchestrator: "personal:orq" });

  // Services.
  const unit = fs.readFileSync(p(".config/systemd/user/overhaul-bridge.service"), "utf8");
  assert.match(unit, /Environment="HUB_CONFIG_DIR=.*\.config\/overhaul"/);
  assert.match(unit, /Environment="HUB_HOST=otro-host"/);
  assert.match(unit, /^ExecStart=\/bin\/zsh -lc 'exec \S+ \S+\/bin\/hub\.mjs bridge'$/m); // login shell, as before
  assert.doesNotMatch(unit, /__\w+__/);
  const log = fs.readFileSync(p("systemctl.log"), "utf8");
  for (const call of ["--user stop work-hub-bridge.service", "--user stop work-hub.service", "--user disable work-hub.service", "--user enable overhaul.service", "--user start overhaul-bridge.service"]) assert.ok(log.includes(call), call);
  assert.equal(fs.readFileSync(p(".config/systemd/user/orq@.service"), "utf8"), "untouched\n");

  // Hook, pi, CLI link.
  const hook = JSON.parse(fs.readFileSync(p(".claude/settings.json"), "utf8")).hooks.Stop[0].hooks[0].command;
  assert.ok(hook.endsWith(`${root}/bin/hub-hook.mjs`), hook);
  assert.equal(fs.readFileSync(p(".claude-other/settings.json"), "utf8"), JSON.stringify({ theme: "dark" })); // had no hook: untouched
  assert.deepEqual(fs.readdirSync(p(".pi/agent/extensions")), ["overhaul.ts"]);
  assert.equal(fs.readlinkSync(p(".local/bin/overhaul")), path.join(root, "bin/hub.mjs"));
  assert.equal(fs.readlinkSync(p(".local/bin/hub")), path.join(root, "bin/hub.mjs"));

  // A second run refuses: already migrated.
  const again = await migrate(home);
  assert.notEqual(again.status, 0);
  assert.match(again.out, /ya existe/);

  // Something written after the migration survives the rollback.
  fs.writeFileSync(p(".local/share/overhaul/tickets/gamma/K-2.json"), "{}");
  const back = await migrate(home, ["--rollback"]);
  assert.equal(back.status, 0, back.out);
  const after = snapshot(home);
  assert.equal(after[".local/share/work-hub/tickets/gamma/K-2.json"], "{}");
  delete after[".local/share/work-hub/tickets/gamma/K-2.json"];
  assert.deepEqual(withoutBackups(after), before);
  const log2 = fs.readFileSync(p("systemctl.log"), "utf8");
  assert.ok(log2.includes("--user enable work-hub.service") && log2.includes("--user start work-hub-bridge.service"));
});

test("rolls back by itself when Overhaul does not answer", async () => {
  const home = fakeInstall(await freePort()); // nothing listens on that port
  const before = snapshot(home);
  const r = await migrate(home);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no responde/);
  assert.match(r.out, /Vuelta atrás lista/);
  assert.deepEqual(withoutBackups(snapshot(home)), before);
  const manifest = fs.readdirSync(path.join(home, ".local/state/overhaul-migration"));
  assert.equal(manifest.length, 1);
});

test("refuses when there is nothing to migrate", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-migrate-empty-"));
  const r = await migrate(home, ["--dry-run"]);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /no hay .*work-hub que migrar/);
});
