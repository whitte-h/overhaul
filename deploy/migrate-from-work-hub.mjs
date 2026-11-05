#!/usr/bin/env node
// Migrates a work-hub install (Linux, systemd user services) to Overhaul in place, without
// losing tickets, notes, activity or agent conversations:
//
//   1. backs up config, data, units, Claude settings and the pi extension;
//   2. stops work-hub and work-hub-bridge;
//   3. moves ~/.config/work-hub -> ~/.config/overhaul and ~/.local/share/work-hub ->
//      ~/.local/share/overhaul, leaving the old paths as symlinks (hosts, scripts and agents
//      that still use them keep working);
//   4. migrates config.yaml to v2 (same behavior: message_tag stays work-hub);
//   5. installs and enables overhaul and overhaul-bridge, disables the work-hub units;
//   6. points Claude hooks whose script no longer exists at this repo, swaps the pi
//      extension, links `overhaul` next to `hub`;
//   7. starts Overhaul and checks it answers; if it does not, rolls everything back.
//
// Agents keep running: tmux sessions, Claude sessions (~/.claude) and pi sessions are not
// touched. While the hub restarts (seconds) hooks fail silently and messages wait in the queue.
//
//   node deploy/migrate-from-work-hub.mjs --dry-run         print the plan, change nothing
//   node deploy/migrate-from-work-hub.mjs [--public-url U1,U2] [--agents-dir D]
//   node deploy/migrate-from-work-hub.mjs --rollback [backup dir]   (default: the latest)
//
// Run it from the repo the services should run (the one with this file). Env for tests:
// HOME, XDG_CONFIG_HOME, SYSTEMCTL (default systemctl), OVERHAUL_MIGRATE_HEALTH_SECONDS (30),
// OVERHAUL_MIGRATE_ANY_REPO=1 (allow running from a git worktree).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { localHost } from "../src/env.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME || os.homedir();
const P = {
  oldCfg: path.join(HOME, ".config/work-hub"),
  newCfg: path.join(HOME, ".config/overhaul"),
  oldData: path.join(HOME, ".local/share/work-hub"),
  newData: path.join(HOME, ".local/share/overhaul"),
  units: path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "systemd/user"),
  backups: path.join(HOME, ".local/state/overhaul-migration"),
  piExt: path.join(HOME, ".pi/agent/extensions"),
  bin: path.join(HOME, ".local/bin"),
};
const OLD_UNITS = ["work-hub.service", "work-hub-bridge.service"];
const NEW_UNITS = ["overhaul.service", "overhaul-bridge.service"];
const SYSTEMCTL = process.env.SYSTEMCTL || "systemctl";
const HEALTH_S = Number(process.env.OVERHAUL_MIGRATE_HEALTH_SECONDS || 30);

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    rollback: { type: "boolean", default: false },
    "public-url": { type: "string" },
    "agents-dir": { type: "string" },
  },
});

const say = (m) => console.log(m);
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };


// --- Migrate ------------------------------------------------------------------------------------

async function migrate() {
  const plan = preflight();
  say("Plan:");
  for (const line of plan.lines) say(`  - ${line}`);
  if (opt["dry-run"]) return say("(--dry-run: no cambié nada)");

  const backup = path.join(P.backups, new Date().toISOString().replace(/[:.]/g, "-"));
  const m = { at: new Date().toISOString(), home: HOME, repo: REPO, backup, done: [], status: "running", units: plan.units, settings: [], pi: false, binLink: false };
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const save = () => fs.writeFileSync(path.join(backup, "manifest.json"), JSON.stringify(m, null, 2), { mode: 0o600 });
  const step = (name, fn) => { fn(); m.done.push(name); save(); say(`ok  ${name}`); };

  try {
    step("respaldo", () => takeBackup(backup, plan, m));
    step("detener work-hub", () => {
      for (const u of [...OLD_UNITS].reverse()) if (plan.units[u]?.exists) ctl("stop", u);
    });
    step("mover config", () => moveWithLink(P.oldCfg, P.newCfg));
    if (plan.moveData) step("mover datos", () => moveWithLink(P.oldData, P.newData));
    step("config v2", () => migrateConfig(plan));
    step("servicios overhaul", () => installUnits(plan, m));
    step("hooks de Claude", () => fixHooks(plan, m));
    if (plan.pi) step("extensión de pi", () => { run(process.execPath, [path.join(REPO, "bin/hub.mjs"), "install-pi"]); m.pi = true; });
    step("enlace overhaul", () => {
      const link = path.join(P.bin, "overhaul");
      if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) return say(`    ${link} existe y no es un enlace; no lo toco`);
      fs.mkdirSync(P.bin, { recursive: true });
      // An existing link (another checkout) is put back by the rollback.
      m.overhaulLinkWas = fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ? fs.readlinkSync(link) : null;
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(REPO, "bin/hub.mjs"), link);
      m.binLink = true;
    });
    step("arrancar overhaul", () => { for (const u of NEW_UNITS) ctl("start", u); });
    if (!(await healthy(plan.port))) throw new Error(`Overhaul no responde en 127.0.0.1:${plan.port} tras ${HEALTH_S} s`);
    m.status = "done";
    save();
  } catch (err) {
    console.error(`\nFalló: ${err.message}\nVuelvo atrás (respaldo en ${backup})…`);
    m.status = "failed";
    save();
    await rollback(backup);
    process.exit(1);
  }
  say(`\nListo. Overhaul corre en http://127.0.0.1:${plan.port} (respaldo en ${backup}).`);
  say("Para volver atrás: node deploy/migrate-from-work-hub.mjs --rollback");
  for (const n of plan.after) say(`- ${n}`);
}

function preflight() {
  if (process.platform !== "linux") die("solo Linux (systemd de usuario); en macOS migra a mano");
  if (!fs.existsSync(path.join(REPO, "src/configmigrate.mjs"))) die(`${REPO} no tiene la versión con config v2`);
  if (REPO.includes(`${path.sep}.worktrees${path.sep}`) && !opt["dry-run"] && !process.env.OVERHAUL_MIGRATE_ANY_REPO) {
    die(`${REPO} es un worktree: corre el script desde el checkout que quedará en vivo (o OVERHAUL_MIGRATE_ANY_REPO=1)`);
  }
  if (fs.existsSync(P.newCfg)) die(`${P.newCfg} ya existe: ¿ya migraste? (rollback: --rollback)`);
  if (!fs.existsSync(P.oldCfg) || fs.lstatSync(P.oldCfg).isSymbolicLink()) die(`no hay ${P.oldCfg} que migrar`);
  const cfgFile = path.join(P.oldCfg, "config.yaml");
  if (!fs.existsSync(cfgFile)) die(`falta ${cfgFile}`);
  const text = fs.readFileSync(cfgFile, "utf8");
  const port = Number(text.match(/^port:\s*(\d+)/m)?.[1] ?? 7420);
  const dataDir = text.match(/^data_dir:\s*(\S+)/m)?.[1];
  // Only the default data folder moves; a custom data_dir stays where it is.
  const moveData = (!dataDir || dataDir === "~/.local/share/work-hub") && fs.existsSync(P.oldData) && !fs.lstatSync(P.oldData).isSymbolicLink();
  if (moveData && fs.existsSync(P.newData)) die(`${P.newData} ya existe`);
  const units = Object.fromEntries(OLD_UNITS.map((u) => {
    const file = path.join(P.units, u);
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return [u, {
      exists: !!text, enabled: isOk("is-enabled", u), active: isOk("is-active", u),
      host: text.match(/--host\s+(\S+?)['"\s]/)?.[1] ?? null,
      // `ExecStart=/bin/zsh -lc '…'`: the old unit got the login shell's environment.
      loginShell: text.match(/^ExecStart=(\S+) -lc /m)?.[1] ?? null,
    }];
  }));
  for (const u of NEW_UNITS) if (fs.existsSync(path.join(P.units, u))) die(`${path.join(P.units, u)} ya existe`);
  const settings = claudeSettings().filter((f) => fs.readFileSync(f, "utf8").includes("hub-hook.mjs"));
  const pi = fs.existsSync(path.join(P.piExt, "work-hub.ts"));
  const host = units["work-hub-bridge.service"].host;
  const lines = [
    `repo que correrán los servicios, el hook y el CLI: ${REPO}`,
    `respaldo en ${P.backups}/<fecha>/ (config, datos, unidades, settings de Claude, extensión de pi)`,
    `detener ${OLD_UNITS.filter((u) => units[u].exists).join(", ") || "(no hay unidades work-hub)"}`,
    `mover ${P.oldCfg} -> ${P.newCfg} (y enlace en la ruta vieja)`,
    moveData ? `mover ${P.oldData} -> ${P.newData} (y enlace en la ruta vieja)` : `datos: se quedan donde están (${dataDir ?? P.oldData})`,
    `config.yaml a v2 (message_tag: work-hub, mismo comportamiento${opt["public-url"] ? `, public_url ${opt["public-url"]}` : ""}${opt["agents-dir"] ? `, orca.agents_dir ${opt["agents-dir"]}` : ""})`,
    `instalar y habilitar ${NEW_UNITS.join(", ")}${host && host !== localHost() ? ` (HUB_HOST=${host})` : ""}${units["work-hub.service"].loginShell ? ` vía ${units["work-hub.service"].loginShell} -lc, como antes` : ""}; deshabilitar las de work-hub`,
    settings.length ? `hooks de Claude en ${settings.join(", ")}: los que apuntan a un hub-hook.mjs que no existe pasan a ${REPO}/bin/hub-hook.mjs (no se agregan hooks)` : "hooks de Claude: ninguno que revisar",
    pi ? "extensión de pi: work-hub.ts -> overhaul.ts" : "extensión de pi: no instalada",
    `enlace ${path.join(P.bin, "overhaul")} -> ${REPO}/bin/hub.mjs (hub se queda)`,
    `arrancar y comprobar http://127.0.0.1:${port}/login.html (${HEALTH_S} s); si falla, vuelta atrás automática`,
  ];
  const after = [
    "Los orquestadores siguen recibiendo \"[work-hub] …\" (message_tag). Para pasar a \"[overhaul]\": actualiza sus CLAUDE.md, cambia message_tag y reinicia.",
    "Máquina del helper de escritorio: ANTES de actualizar su checkout (el layout ya no vive en el repo), copia su layout a ~/.config/overhaul/orca-layout.json, generado en el hub con `overhaul orca-layout` (usa --public-url y --agents-dir de la migración).",
    "Otros hosts de agentes no cambian: siguen con su CLI y ~/.config/work-hub, y llegan al mismo puerto.",
  ];
  return { lines, after, port, moveData, units, settings, pi, host };
}

function takeBackup(backup, plan, m) {
  copy(P.oldCfg, path.join(backup, "config"));
  if (plan.moveData) copy(P.oldData, path.join(backup, "data"));
  for (const u of OLD_UNITS) if (plan.units[u].exists) copy(path.join(P.units, u), path.join(backup, "units", u));
  plan.settings.forEach((f, i) => copy(f, path.join(backup, "claude", `${i}-settings.json`)));
  m.settingsFiles = plan.settings;
  if (plan.pi) copy(path.join(P.piExt, "work-hub.ts"), path.join(backup, "pi/work-hub.ts"));
}

function migrateConfig(plan) {
  const args = [path.join(REPO, "bin/hub.mjs"), "config", "migrate"];
  if (plan.moveData) args.push("--move-data");
  if (opt["public-url"]) args.push("--public-url", opt["public-url"]);
  if (opt["agents-dir"]) args.push("--agents-dir", opt["agents-dir"]);
  run(process.execPath, args, { HUB_CONFIG_DIR: P.newCfg });
}

function installUnits(plan, m) {
  const node = stableNode();
  const env = { __NODE__: node, __DIR__: REPO, __PATH__: stablePath(node), __CONFIG_DIR__: P.newCfg };
  fs.mkdirSync(P.units, { recursive: true });
  for (const u of NEW_UNITS) {
    let text = fs.readFileSync(path.join(REPO, "deploy/standalone", u), "utf8");
    for (const [k, v] of Object.entries(env)) text = text.replaceAll(k, v);
    // Same environment as before: through the login shell the old unit used (.zprofile, .zshenv).
    const shell = plan.units[u.replace("overhaul", "work-hub")]?.loginShell;
    if (shell) text = text.replace(/^ExecStart=(.*)$/m, (_, cmd) => `ExecStart=${shell} -lc 'exec ${cmd}'`);
    // The old bridge ran with --host; keep that name if it is not this machine's.
    if (u === "overhaul-bridge.service" && plan.host && plan.host !== localHost()) {
      text = text.replace(/^(Environment="HUB_CONFIG_DIR=.*")$/m, `$1\nEnvironment="HUB_HOST=${plan.host}"`);
    }
    fs.writeFileSync(path.join(P.units, u), text);
  }
  m.unitsWritten = true;
  ctl("daemon-reload");
  for (const u of OLD_UNITS) if (plan.units[u].exists) ctl("disable", u);
  for (const u of NEW_UNITS) ctl("enable", u);
}

function fixHooks(plan, m) {
  const cmd = `${stableNode()} ${path.join(REPO, "bin/hub-hook.mjs")}`;
  for (const f of plan.settings) {
    const before = fs.readFileSync(f, "utf8");
    run("python3", [path.join(REPO, "deploy/install-hooks.py"), "--repoint-only", cmd, f]);
    if (fs.readFileSync(f, "utf8") !== before) m.settings.push(f);
  }
}

// --- Rollback -----------------------------------------------------------------------------------

async function rollback(backup) {
  const mf = path.join(backup, "manifest.json");
  if (!fs.existsSync(mf)) die(`no hay manifest en ${backup}`);
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const done = new Set(m.done);
  const warn = (what, err) => console.error(`    ${what}: ${err.message}`);
  const tryStep = (name, fn) => { try { fn(); say(`ok  deshacer ${name}`); } catch (err) { warn(name, err); } };

  tryStep("servicios overhaul", () => {
    for (const u of NEW_UNITS) { ctl("stop", u, true); ctl("disable", u, true); }
    if (m.unitsWritten) for (const u of NEW_UNITS) fs.rmSync(path.join(P.units, u), { force: true });
  });
  if (done.has("mover datos")) tryStep("mover datos", () => unmoveWithLink(P.oldData, P.newData));
  if (done.has("mover config")) {
    tryStep("mover config", () => unmoveWithLink(P.oldCfg, P.newCfg));
    // config.yaml back to v1 for the work-hub units; everything else keeps what happened since.
    tryStep("config v2", () => fs.copyFileSync(path.join(backup, "config/config.yaml"), path.join(P.oldCfg, "config.yaml")));
  }
  tryStep("hooks de Claude", () => {
    (m.settingsFiles ?? []).forEach((f, i) => {
      if ((m.settings ?? []).includes(f)) fs.copyFileSync(path.join(backup, "claude", `${i}-settings.json`), f);
    });
  });
  if (m.pi) tryStep("extensión de pi", () => {
    fs.rmSync(path.join(P.piExt, "overhaul.ts"), { force: true });
    fs.copyFileSync(path.join(backup, "pi/work-hub.ts"), path.join(P.piExt, "work-hub.ts"));
  });
  if (m.binLink) tryStep("enlace overhaul", () => {
    const link = path.join(P.bin, "overhaul");
    fs.rmSync(link, { force: true });
    if (m.overhaulLinkWas) fs.symlinkSync(m.overhaulLinkWas, link);
  });
  tryStep("servicios work-hub", () => {
    for (const u of OLD_UNITS) {
      const saved = path.join(backup, "units", u);
      if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(P.units, u));
    }
    ctl("daemon-reload", null, true);
    for (const u of OLD_UNITS) {
      if (m.units?.[u]?.enabled) ctl("enable", u, true);
      if (m.units?.[u]?.active) ctl("start", u, true);
    }
  });
  m.status = "rolled-back";
  m.rolledBackAt = new Date().toISOString();
  fs.writeFileSync(mf, JSON.stringify(m, null, 2), { mode: 0o600 });
  say(`Vuelta atrás lista: work-hub como antes (respaldo intacto en ${backup}).`);
}

// --- Helpers ------------------------------------------------------------------------------------

// Moves a folder and leaves a symlink at the old path.
function moveWithLink(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  fs.symlinkSync(to, from);
}

function unmoveWithLink(from, to) {
  if (fs.existsSync(from) && !fs.lstatSync(from).isSymbolicLink()) throw new Error(`${from} no es un enlace; no lo toco`);
  if (!fs.existsSync(to)) throw new Error(`${to} no existe`);
  fs.rmSync(from, { force: true });
  fs.renameSync(to, from);
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

function ctl(verb, unit, quiet = false) {
  const r = spawnSync(SYSTEMCTL, ["--user", verb, ...(unit ? [unit] : [])], { encoding: "utf8" });
  if (r.status !== 0 && !quiet) throw new Error(`systemctl --user ${verb} ${unit ?? ""}: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
}

const isOk = (verb, unit) => spawnSync(SYSTEMCTL, ["--user", verb, "--quiet", unit]).status === 0;

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });
  if (r.stdout?.trim()) say(r.stdout.trim().replace(/^/gm, "    "));
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(1, 3).join(" ")}: ${(r.stderr || r.error?.message || "").trim()}`);
  if (r.stderr?.trim()) say(r.stderr.trim().replace(/^/gm, "    "));
}

async function healthy(port) {
  const until = Date.now() + HEALTH_S * 1000;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/login.html`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// fnm's per-shell node paths vanish when that shell closes; its default alias stays.
function stableNode() {
  const fnmDefault = path.join(HOME, ".local/share/fnm/aliases/default/bin/node");
  return fs.existsSync(fnmDefault) ? fnmDefault : fs.realpathSync(process.execPath);
}

function stablePath(node) {
  const dirs = (process.env.PATH ?? "").split(":").filter((d) => d && !d.includes("fnm_multishells"));
  return [...new Set([path.dirname(node), ...dirs])].join(":");
}

function claudeSettings() {
  return fs.readdirSync(HOME).filter((d) => /^\.claude(-[\w.-]+)?$/.test(d))
    .map((d) => path.join(HOME, d, "settings.json")).filter((f) => fs.existsSync(f));
}

function latestBackup() {
  if (!fs.existsSync(P.backups)) return null;
  const all = fs.readdirSync(P.backups).filter((d) => fs.existsSync(path.join(P.backups, d, "manifest.json"))).sort();
  return all.length ? path.join(P.backups, all.at(-1)) : null;
}


// --- Entry (last: the helpers above must exist before it runs) -----------------------------------

if (opt.rollback) {
  const dir = positionals[0] ?? latestBackup();
  if (!dir) die(`no hay respaldos en ${P.backups}`);
  await rollback(path.resolve(dir));
  process.exit(0);
}
await migrate();
