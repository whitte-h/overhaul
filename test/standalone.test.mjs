// Standalone mode: this machine's name, default hub URL, helper off, and install.sh
// (always with a temporary HOME and --no-services or --dry-run: never this machine's services).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { normalize } from "../src/config.mjs";
import { hubUrls, localHost } from "../src/env.mjs";
import { standaloneConfig } from "../deploy/standalone/config.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("localHost: HUB_HOST, else the hostname without .local (as the bridge spells it)", () => {
  withEnv({ HUB_HOST: "host-b" }, () => assert.equal(localHost(), "host-b"));
  withEnv({ HUB_HOST: undefined }, () => {
    assert.equal(localHost(), os.hostname().replace(/\.local$/, ""));
    assert.ok(!localHost().endsWith(".local"));
  });
});

test("projects without host run on this machine, matching the bridge's default --host", () => {
  withEnv({ HUB_HOST: undefined }, () => {
    const cfg = normalize({ projects: { a: {} } });
    assert.equal(cfg.projects[0].host, localHost());
  });
});

test("hubUrls defaults to this machine's hub and splits HUB_URL", () => {
  assert.deepEqual(hubUrls(""), ["http://127.0.0.1:7420"]);
  assert.deepEqual(hubUrls(undefined), ["http://127.0.0.1:7420"]);
  assert.deepEqual(hubUrls("http://a:1/, http://b:2"), ["http://a:1", "http://b:2"]);
});

test("helper: v1 default URL, v2 off; off with null, false or empty", () => {
  assert.equal(normalize({}).chromeHelper, "http://127.0.0.1:7421");
  assert.equal(normalize({ version: 2 }).chromeHelper, null);
  for (const v of [null, false, ""]) assert.equal(normalize({ chrome_helper: v }).chromeHelper, null);
  assert.equal(normalize({ chrome_helper: "http://x:1" }).chromeHelper, "http://x:1");
});

test("standalone config: loopback, no helper, no projects, given time zone", () => {
  const text = standaloneConfig(fs.readFileSync(path.join(root, "config.example.yaml"), "utf8"), "Europe/Madrid");
  const cfg = normalize(YAML.parse(text));
  assert.deepEqual(cfg.bind, ["127.0.0.1"]);
  assert.equal(cfg.chromeHelper, null);
  assert.equal(cfg.timezone, "Europe/Madrid");
  assert.equal(cfg.port, 7420);
  assert.deepEqual(cfg.projects, []);
  assert.equal(YAML.parse(text).data_dir, "~/.local/share/overhaul"); // written out: never switches folders later
  assert.doesNotMatch(text, /^\s*host:/m);
  assert.doesNotMatch(text, /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d/);
});

test("service templates carry every placeholder install.sh fills", () => {
  const dir = path.join(root, "deploy/standalone");
  for (const f of ["overhaul.service", "overhaul-bridge.service"]) {
    const t = fs.readFileSync(path.join(dir, f), "utf8");
    for (const p of ["__NODE__", "__DIR__", "__PATH__", "__CONFIG_DIR__"]) assert.ok(t.includes(p), `${f}: ${p}`);
    assert.doesNotMatch(t, /--host|HUB_HOST/);
  }
  const plists = [
    ["deploy/standalone/hub.plist", ["__NODE__", "__DIR__", "__PATH__", "__CONFIG_DIR__", "__LOGS__"]],
    ["deploy/standalone/bridge.plist", ["__NODE__", "__DIR__", "__PATH__", "__CONFIG_DIR__", "__LOGS__"]],
    ["helper/helper.plist", ["__NODE__", "__DIR__"]],
    ["helper/orca.plist", ["__NODE__", "__DIR__"]],
  ];
  for (const [f, placeholders] of plists) {
    const t = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(t, /<key>Label<\/key>\s*<string>__LABEL__<\/string>/, `${f}: label`); // the installer names it
    for (const p of placeholders) assert.ok(t.includes(p), `${f}: ${p}`);
    for (const tag of ["dict", "array", "plist"]) assert.equal(t.match(new RegExp(`<${tag}[ >]`, "g")).length, t.split(`</${tag}>`).length - 1, `${f}: <${tag}>`);
  }
  assert.match(fs.readFileSync(path.join(root, "helper/helper.plist"), "utf8"), /__DIR__\/bin\/overhaul-helper</);
});

// install.sh with its own HOME; HUB_CONFIG_DIR, XDG and HUB_* from the real session removed.
function install(home, ...args) {
  const env = { PATH: process.env.PATH, HOME: home, OVERHAUL_SKIP_NPM: "1", USER: process.env.USER ?? "u" };
  return spawnSync("bash", [path.join(root, "install.sh"), ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-install-"));

test("install.sh --dry-run changes nothing", () => {
  const home = tmpHome();
  const r = install(home, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Overhaul: http:\/\/127\.0\.0\.1:7420/);
  assert.match(r.stdout, /\+ ln -sfn /);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("install.sh refuses a machine that already runs work-hub, unless --force", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".config/systemd/user"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/systemd/user/work-hub.service"), "");
  const r = install(home, "--dry-run");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /work-hub\n/);
  assert.match(r.stderr, /instalación anterior/);
  assert.equal(install(home, "--dry-run", "--force").status, 0);
});

test("install.sh creates config, env and link once, keeps them on rerun, uninstall keeps config", () => {
  const home = tmpHome();
  const r = install(home, "--no-services", "--non-interactive");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cfgDir = path.join(home, ".config/overhaul");
  const cfgFile = path.join(cfgDir, "config.yaml");
  const envFile = path.join(cfgDir, "env");
  assert.deepEqual(normalize(YAML.parse(fs.readFileSync(cfgFile, "utf8"))).bind, ["127.0.0.1"]);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const env = fs.readFileSync(envFile, "utf8");
  assert.match(env, /^HUB_AGENT_TOKEN=[0-9a-f]{64}$/m);
  const link = path.join(home, ".local/bin/hub");
  assert.equal(fs.readlinkSync(link), path.join(root, "bin/hub.mjs"));
  assert.equal(fs.readlinkSync(path.join(home, ".local/bin/overhaul")), path.join(root, "bin/hub.mjs"));
  assert.equal(normalize(YAML.parse(fs.readFileSync(cfgFile, "utf8"))).version, 2);
  assert.match(r.stderr, /set-password/); // no password without a terminal

  // Rerun: updates, never overwrites what you edited.
  fs.appendFileSync(cfgFile, "# mine\n");
  fs.appendFileSync(envFile, "HUB_TOKEN=a-long-password-here\n");
  const again = install(home, "--no-services", "--non-interactive");
  assert.equal(again.status, 0, again.stderr);
  assert.match(fs.readFileSync(cfgFile, "utf8"), /# mine\n$/);
  assert.equal(fs.readFileSync(envFile, "utf8"), `${env}HUB_TOKEN=a-long-password-here\n`);
  assert.match(again.stdout, /ya existe, no la toco/);

  const un = install(home, "--uninstall");
  assert.equal(un.status, 0, un.stderr);
  assert.ok(!fs.existsSync(link));
  assert.ok(!fs.existsSync(path.join(home, ".local/bin/overhaul")));
  assert.ok(fs.existsSync(cfgFile) && fs.existsSync(envFile));
});

test("install.sh keeps using ~/.config/work-hub when that is the only config", () => {
  const home = tmpHome();
  const legacy = path.join(home, ".config/work-hub");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "config.yaml"), "port: 7420\n");
  const r = install(home, "--no-services", "--non-interactive");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /work-hub\/config\.yaml ya existe/);
  assert.ok(!fs.existsSync(path.join(home, ".config/overhaul")));
});

// deploy/labels.sh: this version's service names, and the ones earlier installations left.
function labels(shell, script) {
  const r = spawnSync(shell, ["-c", `. ${JSON.stringify(path.join(root, "deploy/labels.sh"))}; ${script}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean).sort();
}
const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
function agentsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-agents-"));
  const plist = (body) => `<plist><dict><key>ProgramArguments</key><array>${body}</array></dict></plist>\n`;
  const files = {
    "overhaul.hub.plist": plist("<string>/r/src/server.mjs</string>"), // current: never "previous"
    "overhaul.bridge.plist": plist("<string>/r/bin/hub.mjs</string><string>bridge</string>"),
    "overhaul.helper.plist": plist("<string>/r/helper/bin/overhaul-helper</string>"),
    "overhaul.orca.plist": plist("<string>/r/helper/orca-restore.mjs</string>"),
    "com.example.overhaul.plist": plist("<string>/old/src/server.mjs</string>"),
    "com.example.overhaul-bridge.plist": plist("<string>/old/bin/hub.mjs</string><string>bridge</string>"),
    "org.sample.work-hub-tunnel.plist": plist("<string>/usr/bin/ssh</string>"),
    "org.sample.work-hub-chrome.plist": plist("<string>/old/x/chrome-helper.mjs</string>"),
    "org.sample.work-hub-orca.plist": plist("<string>/old/x/orca-restore.mjs</string>"),
    "com.vendor.updater.plist": plist("<string>/usr/bin/true</string>"),
  };
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

test("labels.sh: fixed generic names for this version", () => {
  assert.deepEqual(labels("bash", 'echo "$OVERHAUL_HUB_LABEL $OVERHAUL_BRIDGE_LABEL $OVERHAUL_HELPER_LABEL $OVERHAUL_ORCA_LABEL"'),
    ["overhaul.hub overhaul.bridge overhaul.helper overhaul.orca"]);
});

test("labels.sh: earlier LaunchAgents by pattern, split into hub side and helper side", () => {
  const dir = agentsDir();
  for (const shell of hasZsh ? ["bash", "zsh"] : ["bash"]) {
    assert.deepEqual(labels(shell, `previous_launch_agents '${dir}' hub`),
      ["com.example.overhaul", "com.example.overhaul-bridge", "org.sample.work-hub-tunnel"], shell);
    assert.deepEqual(labels(shell, `previous_launch_agents '${dir}' helper`),
      ["org.sample.work-hub-chrome", "org.sample.work-hub-orca"], shell);
    assert.deepEqual(labels(shell, `previous_launch_agents '${dir}/missing' hub`), [], shell);
  }
});

test("labels.sh: earlier systemd units by pattern, never the current ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-units-"));
  for (const u of ["overhaul", "overhaul-bridge", "work-hub", "work-hub-bridge", "overhaul-old", "other"]) fs.writeFileSync(path.join(dir, `${u}.service`), "");
  assert.deepEqual(labels("bash", `previous_units '${dir}'`), ["overhaul-old", "work-hub", "work-hub-bridge"]);
});

test("install.sh: services of an earlier installation block it without a terminal; uninstall lists and keeps them", () => {
  const home = tmpHome();
  const units = path.join(home, ".config/systemd/user");
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(units, "overhaul-old.service"), "");
  const r = install(home, "--no-services", "--non-interactive");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /overhaul-old/);
  assert.match(r.stderr, /--force/);
  assert.ok(!fs.existsSync(path.join(home, ".config/overhaul")), "nothing installed");
  assert.equal(install(home, "--no-services", "--non-interactive", "--force").status, 0);
  const un = install(home, "--uninstall", "--non-interactive");
  assert.equal(un.status, 0, un.stderr);
  assert.match(un.stdout, /overhaul-old[\s\S]*siguen ahí/);
  assert.ok(fs.existsSync(path.join(units, "overhaul-old.service")));
});

test("helper/install.sh --dry-run: removes only earlier helper LaunchAgents, installs overhaul.helper and overhaul.orca", { skip: !hasZsh && "sin zsh" }, () => {
  const dir = agentsDir();
  const layout = path.join(dir, "layout.json");
  fs.writeFileSync(layout, "{}");
  const before = fs.readdirSync(dir).sort();
  const r = spawnSync("zsh", [path.join(root, "helper/install.sh"), "--dry-run"], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, OVERHAUL_LAYOUT: layout, OVERHAUL_LAUNCH_AGENTS: dir },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const l of ["org.sample.work-hub-chrome", "org.sample.work-hub-orca"]) assert.match(r.stdout, new RegExp(`\\+ rm -f ${dir}/${l}\\.plist`));
  assert.doesNotMatch(r.stdout, /work-hub-tunnel|com\.example/); // hub side: not the helper's to remove
  for (const l of ["overhaul.helper", "overhaul.orca"]) assert.match(r.stdout, new RegExp(`\\+ escribir ${dir}/${l}\\.plist`));
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});
