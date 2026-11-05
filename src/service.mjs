// `overhaul service install|start|stop|restart|status|uninstall`: the hub (`overhaul serve`) and its
// bridge (`overhaul bridge`) as user services that run this executable (docs/contract.md, "Servicios").
//   Linux: systemd user units overhaul.service, overhaul-bridge.service
//   macOS: LaunchAgents overhaul.hub, overhaul.bridge (logs in ~/.overhaul/logs)
// install stops what runs, removes services of earlier installations, migrates the data into
// ~/.overhaul, writes the files and starts them. It never touches config or data otherwise.
// OVERHAUL_SYSTEMCTL / OVERHAUL_LAUNCHCTL / OVERHAUL_PLATFORM: tests only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePaths } from "./paths.mjs";

export const HUB_LABEL = "overhaul.hub";
export const BRIDGE_LABEL = "overhaul.bridge";
export const HELPER_LABELS = ["overhaul.helper", "overhaul.orca"];
export const UNITS = ["overhaul", "overhaul-bridge"];

// The two services: what they run and how they restart.
const SERVICES = [
  { id: "hub", unit: "overhaul", label: HUB_LABEL, args: ["serve"], desc: "Overhaul hub", log: "hub.log", restart: "on-failure", sec: 5 },
  { id: "bridge", unit: "overhaul-bridge", label: BRIDGE_LABEL, args: ["bridge"], desc: "Overhaul bridge", log: "bridge.log", restart: "always", sec: 10, after: "overhaul.service" },
];

export function context({ env = process.env, platform, run, log = (m) => console.log(m), self, dryRun = false } = {}) {
  const home = env.HOME || os.homedir();
  platform ??= env.OVERHAUL_PLATFORM || process.platform;
  run ??= (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return {
    env,
    home,
    platform,
    run,
    log,
    self,
    dryRun,
    systemctl: env.OVERHAUL_SYSTEMCTL || "systemctl",
    launchctl: env.OVERHAUL_LAUNCHCTL || "launchctl",
    systemdDir: path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd/user"),
    agentsDir: path.join(home, "Library/LaunchAgents"),
    uid: process.getuid?.() ?? 501,
  };
}

const fileOf = (ctx, s) => (ctx.platform === "darwin" ? path.join(ctx.agentsDir, `${s.label}.plist`) : path.join(ctx.systemdDir, `${s.unit}.service`));
export const serviceFiles = (ctx) => SERVICES.map((s) => fileOf(ctx, s));
export const installed = (ctx) => serviceFiles(ctx).some((f) => fs.existsSync(f));

// The environment the services get: where the installation is, and this shell's PATH so the
// bridge finds tmux, claude, pi and gh like you do.
export function serviceEnv(env = process.env, userHome) {
  const P = resolvePaths(env, userHome);
  const out = { PATH: env.PATH || "/usr/bin:/bin" };
  if (P.mode === "explicit") out.HUB_CONFIG_DIR = P.configDir;
  else if (P.mode === "home") out.OVERHAUL_HOME = P.home;
  return { vars: out, paths: P };
}

// systemd: one word, quoted when needed; % doubled.
const sdWord = (w) => {
  const s = String(w).replace(/%/g, "%%");
  return /^[\w@+=:,./-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};
const sdEnv = (k, v) => `Environment="${`${k}=${v}`.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function unitText(s, self, vars) {
  return [
    `# ${s.desc}: written by \`overhaul service install\`; rerun it instead of editing this file.`,
    "[Unit]",
    `Description=${s.desc}`,
    ...(s.after ? [`After=${s.after}`] : ["After=network-online.target", "Wants=network-online.target"]),
    "",
    "[Service]",
    `ExecStart=${[...self, ...s.args].map(sdWord).join(" ")}`,
    ...Object.entries(vars).map(([k, v]) => sdEnv(k, v)),
    `Restart=${s.restart}`,
    `RestartSec=${s.sec}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function plistText(s, self, vars, logs) {
  const strings = (list) => list.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const envs = Object.entries(vars).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n");
  const log = path.join(logs, s.log);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${xml(s.desc)}: written by \`overhaul service install\`; rerun it instead of editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${s.label}</string>
  <key>ProgramArguments</key>
  <array>
${strings([...self, ...s.args])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envs}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

// Services of earlier installations: a unit or LaunchAgent named with work-hub or overhaul that is
// not one of ours (on macOS, only the hub side: the helper's are the helper installer's).
export function previousServices(ctx) {
  const pattern = /work-hub|overhaul/;
  if (ctx.platform === "darwin") {
    if (!fs.existsSync(ctx.agentsDir)) return [];
    return fs.readdirSync(ctx.agentsDir)
      .filter((f) => f.endsWith(".plist") && pattern.test(f))
      .map((f) => f.slice(0, -6))
      .filter((l) => ![HUB_LABEL, BRIDGE_LABEL, ...HELPER_LABELS].includes(l))
      .filter((l) => !/chrome-helper|orca-restore|overhaul-helper/.test(fs.readFileSync(path.join(ctx.agentsDir, `${l}.plist`), "utf8")))
      .sort();
  }
  if (!fs.existsSync(ctx.systemdDir)) return [];
  return fs.readdirSync(ctx.systemdDir)
    .filter((f) => f.endsWith(".service") && pattern.test(f))
    .map((f) => f.slice(0, -8))
    .filter((u) => !UNITS.includes(u))
    .sort();
}

function exec(ctx, cmd, args, { check = true } = {}) {
  if (ctx.dryRun) {
    ctx.log(`+ ${[cmd, ...args].join(" ")}`);
    return true;
  }
  const r = ctx.run(cmd, args);
  if (r.status !== 0 && check) ctx.log(`Aviso: ${cmd} ${args.join(" ")} falló: ${String(r.stderr ?? r.error?.message ?? "").trim()}`);
  return r.status === 0;
}

const systemctl = (ctx, ...args) => exec(ctx, ctx.systemctl, ["--user", ...args]);
const target = (ctx, label) => `gui/${ctx.uid}/${label}`;

function stopAll(ctx, { quiet = true } = {}) {
  if (ctx.platform === "darwin") {
    for (const s of [...SERVICES].reverse()) if (fs.existsSync(fileOf(ctx, s))) exec(ctx, ctx.launchctl, ["bootout", target(ctx, s.label)], { check: !quiet });
  } else {
    const units = SERVICES.filter((s) => fs.existsSync(fileOf(ctx, s))).map((s) => `${s.unit}.service`);
    if (units.length) exec(ctx, ctx.systemctl, ["--user", "stop", ...units], { check: !quiet });
  }
}

function removePrevious(ctx) {
  const prev = previousServices(ctx);
  for (const name of prev) {
    if (ctx.platform === "darwin") {
      exec(ctx, ctx.launchctl, ["bootout", target(ctx, name)], { check: false });
      if (!ctx.dryRun) fs.rmSync(path.join(ctx.agentsDir, `${name}.plist`), { force: true });
    } else {
      exec(ctx, ctx.systemctl, ["--user", "disable", "--now", `${name}.service`], { check: false });
      if (!ctx.dryRun) fs.rmSync(path.join(ctx.systemdDir, `${name}.service`), { force: true });
    }
    ctx.log(`Quité ${name} (instalación anterior)`);
  }
  return prev;
}

// Writes and starts both services. Returns 0 or 1.
export async function install(ctx) {
  const { migrateHome, planMigration } = await import("./migrate.mjs");
  const { setup } = await import("./init.mjs");
  const plan = planMigration({ env: ctx.env, userHome: ctx.home });
  if (["ambiguous", "conflict"].includes(plan.status)) {
    for (const n of plan.notes) ctx.log(`Error: ${n}`);
    return 1;
  }
  stopAll(ctx);
  removePrevious(ctx);
  if (plan.status === "migrate") {
    const res = migrateHome({ env: ctx.env, userHome: ctx.home, dryRun: ctx.dryRun, log: ctx.log });
    if (!ctx.dryRun) ctx.log(`Datos migrados a ${res.home} (respaldo en ${res.backup})`);
  }
  if (!ctx.dryRun) {
    setup({ env: ctx.env, userHome: ctx.home, log: ctx.log });
    await repointAgents(ctx);
    const { hasPassword } = await import("./password.mjs");
    if (!hasPassword({ env: ctx.env, userHome: ctx.home })) ctx.log("Aviso: sin contraseña todavía: el hub no arranca hasta que corras overhaul set-password");
  }
  const { vars, paths } = serviceEnv(ctx.env, ctx.home);
  // After migrating, the services run against home even if this shell resolved the old layout.
  if (plan.status === "migrate" && !vars.HUB_CONFIG_DIR) {
    vars.OVERHAUL_HOME = plan.home;
    delete vars.HUB_CONFIG_DIR;
  }
  const logs = path.join(vars.OVERHAUL_HOME ?? paths.home, "logs");
  for (const s of SERVICES) {
    const file = fileOf(ctx, s);
    const text = ctx.platform === "darwin" ? plistText(s, ctx.self, vars, logs) : unitText(s, ctx.self, vars);
    if (ctx.dryRun) {
      ctx.log(`+ escribir ${file}:\n${text}`);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  if (ctx.platform === "darwin") {
    if (!ctx.dryRun) fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    let ok = true;
    for (const s of SERVICES) {
      exec(ctx, ctx.launchctl, ["bootout", target(ctx, s.label)], { check: false });
      ok = exec(ctx, ctx.launchctl, ["bootstrap", `gui/${ctx.uid}`, fileOf(ctx, s)]) && ok;
    }
    ctx.log(`Servicios: LaunchAgents ${HUB_LABEL} y ${BRIDGE_LABEL} (logs en ${logs})`);
    return ok ? 0 : 1;
  }
  const units = SERVICES.map((s) => `${s.unit}.service`);
  let ok = systemctl(ctx, "daemon-reload");
  ok = systemctl(ctx, "enable", ...units) && ok;
  ok = systemctl(ctx, "restart", ...units) && ok;
  ctx.log("Servicios: systemctl --user status overhaul overhaul-bridge (logs: journalctl --user -u overhaul)");
  const linger = ctx.run("loginctl", ["show-user", ctx.env.USER ?? "", "-p", "Linger", "--value"]);
  if (linger.status === 0 && String(linger.stdout).trim() !== "yes") ctx.log(`Para que sigan corriendo sin sesión abierta: loginctl enable-linger ${ctx.env.USER ?? "$USER"}`);
  return ok ? 0 : 1;
}

// Hooks and the pi extension that already exist (v0.1's node + hub-hook.mjs, or another path to
// overhaul) now run this executable. Nothing is added: that is install-hooks / install-pi.
export async function repointAgents(ctx) {
  const { installHooks, installPiExtension } = await import("./hooks.mjs");
  const settings = path.join(ctx.home, ".claude/settings.json");
  if (fs.existsSync(settings)) {
    for (const r of installHooks({ self: ctx.self, files: [settings], repointOnly: true })) {
      if (r.changed.length) ctx.log(`Hook de Claude: ${r.file}: ${r.changed.join(", ")}`);
    }
  }
  const pi = path.join(ctx.home, ".pi/agent/extensions");
  if (fs.existsSync(path.join(pi, "overhaul.ts"))) {
    const r = installPiExtension({ dir: pi, command: ctx.self });
    if (r.changed) ctx.log(`Extensión de pi: ${r.file} actualizada`);
  }
}

export function uninstall(ctx) {
  stopAll(ctx);
  let removed = 0;
  for (const s of SERVICES) {
    const file = fileOf(ctx, s);
    if (!fs.existsSync(file)) continue;
    if (ctx.platform !== "darwin") exec(ctx, ctx.systemctl, ["--user", "disable", `${s.unit}.service`], { check: false });
    if (!ctx.dryRun) fs.rmSync(file, { force: true });
    ctx.log(`Quité ${file}`);
    removed++;
  }
  if (removed && ctx.platform !== "darwin") systemctl(ctx, "daemon-reload");
  ctx.log("Config y datos intactos.");
  return 0;
}

// start | stop | restart, for both or only one (hub | bridge).
export function control(ctx, action, only) {
  if (!installed(ctx)) {
    ctx.log("Los servicios no están instalados: overhaul service install");
    return 1;
  }
  const list = SERVICES.filter((s) => !only || s.id === only);
  if (ctx.platform === "darwin") {
    let ok = true;
    for (const s of action === "stop" ? [...list].reverse() : list) {
      if (action === "stop") ok = exec(ctx, ctx.launchctl, ["bootout", target(ctx, s.label)], { check: false }) && ok;
      else if (action === "start") ok = exec(ctx, ctx.launchctl, ["bootstrap", `gui/${ctx.uid}`, fileOf(ctx, s)], { check: false }) && ok;
      else {
        // kickstart only works on a loaded job; a stopped one is bootstrapped instead.
        ok = (exec(ctx, ctx.launchctl, ["kickstart", "-k", target(ctx, s.label)], { check: false }) || exec(ctx, ctx.launchctl, ["bootstrap", `gui/${ctx.uid}`, fileOf(ctx, s)])) && ok;
      }
    }
    return ok ? 0 : 1;
  }
  return systemctl(ctx, action, ...list.map((s) => `${s.unit}.service`)) ? 0 : 1;
}

export function status(ctx) {
  let all = true;
  for (const s of SERVICES) {
    const file = fileOf(ctx, s);
    if (!fs.existsSync(file)) {
      ctx.log(`${s.id.padEnd(7)} no instalado`);
      all = false;
      continue;
    }
    let state;
    if (ctx.platform === "darwin") {
      const r = ctx.run(ctx.launchctl, ["print", target(ctx, s.label)]);
      state = r.status !== 0 ? "no cargado" : /state = running/.test(r.stdout) ? "corriendo" : "cargado, detenido";
    } else {
      const r = ctx.run(ctx.systemctl, ["--user", "is-active", `${s.unit}.service`]);
      state = String(r.stdout ?? "").trim() || "desconocido";
      if (state === "active") state = "corriendo";
    }
    const text = fs.readFileSync(file, "utf8");
    const runsSelf = text.includes(ctx.self[0]);
    ctx.log(`${s.id.padEnd(7)} ${state}  ${file}${runsSelf ? "" : `  (corre otro ejecutable: overhaul service install lo apunta a ${ctx.self[0]})`}`);
    all = all && state === "corriendo";
  }
  return all ? 0 : 1;
}

export async function serviceCommand(action, ctx, only) {
  switch (action) {
    case "install":
      return install(ctx);
    case "uninstall":
      return uninstall(ctx);
    case "start":
    case "stop":
    case "restart":
      return control(ctx, action, only);
    case "status":
      return status(ctx);
    default:
      return null;
  }
}
