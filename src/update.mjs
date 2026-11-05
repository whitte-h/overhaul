// `overhaul update [--check] [--version X.Y.Z]`: brings this installation to the latest version.
//   Executable (the release binary): asks install.sh (carried inside it) for the latest release and
//   runs it with --bin-dir set to where this executable is: it downloads the new one, checks its
//   sha256, replaces this file atomically and runs `overhaul service install` with it, which
//   restarts hub and bridge. Installed by Homebrew: brew upgrade overhaul.
//   Release (v0.1's app/<version> with a RELEASE file): asks install.sh for the latest release (same
//   sources: gh, GH_TOKEN/GITHUB_TOKEN, public URLs) and installs it with that same install.sh,
//   which keeps config and data and restarts hub and bridge.
//   Clone (.git): git pull --ff-only, npm ci when the lockfile changed, restart hub and bridge.
// --check only says whether there is something new.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assetText } from "./assets.mjs";
import { isHomebrew } from "./self.mjs";

const HUB_LABEL = "overhaul.hub";
const BRIDGE_LABEL = "overhaul.bridge";
const UNITS = ["overhaul", "overhaul-bridge"];

export function installKind(root) {
  const marker = path.join(root, "RELEASE");
  if (fs.existsSync(marker) && path.basename(path.dirname(root)) === "app") {
    return { kind: "release", version: fs.readFileSync(marker, "utf8").trim() };
  }
  if (fs.existsSync(path.join(root, ".git"))) return { kind: "clone" };
  return { kind: "unknown" };
}

// -1, 0, 1 on X.Y.Z (a pre-release suffix sorts before its version).
export function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre = ""] = String(v).replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function serviceFiles({ env, platform }) {
  const home = env.HOME ?? os.homedir();
  if (platform === "darwin") return [HUB_LABEL, BRIDGE_LABEL].map((l) => path.join(home, "Library/LaunchAgents", `${l}.plist`));
  const systemd = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd/user");
  return UNITS.map((u) => path.join(systemd, `${u}.service`));
}
export const servicesInstalled = (ctx) => serviceFiles(ctx).some((f) => fs.existsSync(f));

function restartServices(ctx) {
  const { env, platform, log, run } = ctx;
  if (!servicesInstalled(ctx)) {
    log("Servicios: no están instalados (--no-services); reinicia a mano el hub (node src/server.mjs) y el puente (overhaul bridge).");
    return true;
  }
  if (platform === "darwin") {
    const uid = process.getuid?.() ?? env.UID;
    let ok = true;
    for (const label of [HUB_LABEL, BRIDGE_LABEL]) ok = run("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]).status === 0 && ok;
    log(ok ? "Hub y puente reiniciados." : "Aviso: no pude reiniciar los LaunchAgents; mira launchctl print gui/$(id -u)/overhaul.hub");
    return ok;
  }
  const ok = run("systemctl", ["--user", "restart", ...UNITS.map((u) => `${u}.service`)]).status === 0;
  log(ok ? "Hub y puente reiniciados." : "Aviso: no pude reiniciar los servicios; mira systemctl --user status overhaul overhaul-bridge");
  return ok;
}

// install.sh through stdin runs in release mode (it has no folder of its own), like curl | bash.
function installer(ctx, args, capture) {
  return ctx.run("bash", ["-s", "--", ...args], {
    input: fs.readFileSync(path.join(ctx.root, "install.sh")),
    stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"],
  });
}

function updateRelease(ctx, current, { check, version }) {
  const { log } = ctx;
  let target = version?.replace(/^v/, "");
  if (!target || check) {
    const r = installer(ctx, ["--check"], true);
    if (r.status !== 0) { log("Error: no pude consultar la última release (ver arriba)."); return 1; }
    const latest = String(r.stdout).trim().split("\n").pop();
    if (check) {
      const cmp = compareVersions(latest, current);
      log(cmp > 0 ? `Hay una versión nueva: v${latest} (instalada: v${current}). Actualiza con: overhaul update`
        : `Al día: v${current} (última release: v${latest}).`);
      return 0;
    }
    target = latest;
  }
  if (!version && compareVersions(target, current) <= 0) {
    log(`Ya tienes la última versión (v${current}).`);
    return 0;
  }
  log(`Actualizando v${current} → v${target}`);
  const args = ["--version", target, "--non-interactive"];
  if (!servicesInstalled(ctx)) args.push("--no-services");
  const r = installer(ctx, args, false);
  if (r.status !== 0) { log(`Error: la instalación de v${target} falló; sigues en v${current}.`); return 1; }
  log(`Listo: v${target}. Config y datos intactos.`);
  return 0;
}

function updateClone(ctx, { check, version }) {
  const { root, log, run } = ctx;
  if (version) { log(`Error: --version es para instalaciones desde una release; en un clon: git -C ${root} checkout v${version.replace(/^v/, "")}`); return 2; }
  const git = (...args) => run("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const dirty = String(git("status", "--porcelain", "--untracked-files=no").stdout ?? "").trim();
  if (dirty) log(`Aviso: hay cambios locales en ${root}:\n${dirty.split("\n").map((l) => `  ${l}`).join("\n")}`);
  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream.status !== 0) { log(`Error: la rama de ${root} no sigue ninguna rama remota (git branch --set-upstream-to).`); return 1; }
  const up = String(upstream.stdout).trim();

  if (check) {
    const f = git("fetch", "--quiet");
    if (f.status !== 0) { log(`Error: git fetch falló: ${String(f.stderr).trim()}`); return 1; }
    const n = Number(String(git("rev-list", "--count", `HEAD..${up}`).stdout).trim());
    log(n > 0 ? `Hay ${n} commit${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"} en ${up}. Actualiza con: overhaul update` : `Al día con ${up}.`);
    return 0;
  }

  const before = String(git("rev-parse", "HEAD").stdout).trim();
  const pull = git("pull", "--ff-only");
  if (pull.status !== 0) {
    log(`Error: git pull --ff-only falló${dirty ? " (¿por los cambios locales?)" : ""}:\n${String(pull.stderr).trim()}`);
    return 1;
  }
  const after = String(git("rev-parse", "HEAD").stdout).trim();
  if (after === before) { log(`Al día con ${up}; nada que reiniciar.`); return 0; }
  log(`Actualizado ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
  const changed = String(git("diff", "--name-only", before, after).stdout).split("\n");
  if (changed.includes("package-lock.json") || changed.includes("package.json")) {
    log("Dependencias cambiaron: npm ci --omit=dev");
    if (run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" }).status !== 0) {
      log("Error: npm ci falló; no reinicio los servicios.");
      return 1;
    }
  }
  return restartServices(ctx) ? 0 : 1;
}

function updateBinary(ctx, current, { check, version }) {
  const { log, exe } = ctx;
  if (isHomebrew(exe)) {
    log(check ? "Instalado con Homebrew: brew outdated overhaul" : "Instalado con Homebrew: actualiza con brew upgrade overhaul (y luego overhaul service restart).");
    return 0;
  }
  const script = ctx.installScript ?? assetText("install.sh");
  const installer = (args, capture) => ctx.run("bash", ["-s", "--", ...args], { input: script, stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"] });
  let target = version?.replace(/^v/, "");
  if (!target || check) {
    const r = installer(["--check"], true);
    if (r.status !== 0) { log("Error: no pude consultar la última release (ver arriba)."); return 1; }
    const latest = String(r.stdout).trim().split("\n").pop();
    if (check) {
      log(compareVersions(latest, current) > 0 ? `Hay una versión nueva: v${latest} (instalada: v${current}). Actualiza con: overhaul update`
        : `Al día: v${current} (última release: v${latest}).`);
      return 0;
    }
    target = latest;
  }
  if (!version && compareVersions(target, current) <= 0) {
    log(`Ya tienes la última versión (v${current}).`);
    return 0;
  }
  const dir = path.dirname(exe);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    log(`Error: no puedo escribir en ${dir}. Corre sudo overhaul update, o reinstala con install.sh --bin-dir <carpeta tuya>.`);
    return 1;
  }
  log(`Actualizando v${current} → v${target} (${exe})`);
  const args = ["--version", target, "--non-interactive", "--bin-dir", dir];
  if (!servicesInstalled(ctx)) args.push("--no-services");
  const r = installer(args, false);
  if (r.status !== 0) { log(`Error: la instalación de v${target} falló; sigues en v${current}.`); return 1; }
  log(`Listo: v${target}. Config y datos intactos.`);
  return 0;
}

// exe: this executable when running as one (IS_SEA); then root is meaningless.
export function update({ root, exe, current, installScript, check = false, version, env = process.env, platform = process.platform, log = (m) => console.log(m), run } = {}) {
  run ??= (cmd, args, opts = {}) => spawnSync(cmd, args, { env, stdio: "inherit", ...opts });
  const ctx = { root, exe, installScript, env, platform, log, run };
  if (exe) return updateBinary(ctx, current, { check, version });
  const kind = installKind(root);
  if (kind.kind === "release") return updateRelease(ctx, kind.version, { check, version });
  if (kind.kind === "clone") return updateClone(ctx, { check, version });
  log(`Error: ${root} no es una release instalada ni un clon de git; reinstala con install.sh.`);
  return 1;
}
