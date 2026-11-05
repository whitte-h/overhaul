// `overhaul helper install [--dry-run]`: the desktop helper (Chrome profiles, Orca terminals, port
// forwards). It still runs on Node in v0.2 (node-pty), so this needs the system's node and npm:
// copies the helper the executable carries to ~/.overhaul/helper, runs npm install there and, on
// macOS, installs the LaunchAgents overhaul.helper and overhaul.orca with that node. LaunchAgents
// of an earlier helper (other names or paths) are removed, so it never runs twice on port 7421.
import fs from "node:fs";
import path from "node:path";
import { ASSET_FILES, assetText, readAsset } from "./assets.mjs";
import { resolvePaths } from "./paths.mjs";
import { HELPER_LABELS } from "./service.mjs";
import { stableNode } from "./self.mjs";

const [HELPER_LABEL, ORCA_LABEL] = HELPER_LABELS;
const MIN_NODE = 18;

// The first executable `name` in PATH.
export function which(name, env = process.env) {
  for (const dir of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

export function layoutFile(env, home) {
  if (env.OVERHAUL_LAYOUT) return env.OVERHAUL_LAYOUT;
  const files = [path.join(env.OVERHAUL_HOME || path.join(home, ".overhaul"), "orca-layout.json"), path.join(home, ".config/overhaul/orca-layout.json")];
  return files.find((f) => fs.existsSync(f)) ?? null;
}

// Helper LaunchAgents of earlier installations: named with work-hub or overhaul, running the
// helper or the Orca restore, not today's labels.
export function previousHelperAgents(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".plist") && /work-hub|overhaul/.test(f))
    .map((f) => f.slice(0, -6))
    .filter((l) => !HELPER_LABELS.includes(l) && !["overhaul.hub", "overhaul.bridge"].includes(l))
    .filter((l) => /chrome-helper|orca-restore|overhaul-helper/.test(fs.readFileSync(path.join(dir, `${l}.plist`), "utf8")))
    .sort();
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ctx: service.mjs context (platform, run, log, launchctl, agentsDir, uid, dryRun, env, home).
export function installHelper(ctx) {
  const { env, log, dryRun } = ctx;
  const nodeInPath = which("node", env);
  if (!nodeInPath) {
    log("Falta Node: el helper de escritorio todavía corre en Node (node-pty). Instálalo y vuelve a correr overhaul helper install:");
    log(ctx.platform === "darwin" ? "  brew install node   (o fnm: brew install fnm && fnm install 22 && fnm default 22)" : "  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22 && fnm default 22");
    return 1;
  }
  const node = stableNode(fs.realpathSync(nodeInPath), ctx.home);
  const r = ctx.run(node, ["-p", "process.versions.node"]);
  const major = Number(String(r.stdout ?? "").split(".")[0]);
  if (r.status !== 0 || major < MIN_NODE) {
    log(`Node ${String(r.stdout ?? "?").trim()} (${node}) es muy viejo para el helper: necesita ${MIN_NODE} o más.`);
    return 1;
  }
  const npm = which("npm", env);
  if (!npm) {
    log(`Falta npm junto a ${node}: reinstala Node con npm.`);
    return 1;
  }
  // The layout (hub URL, origins, hosts) lives on this machine; the helper does not start without it.
  const layout = layoutFile(env, ctx.home);
  if (!layout) {
    const P = resolvePaths(env, ctx.home);
    log(`Falta ${path.join(P.home, "orca-layout.json")}: genéralo en el host del hub con \`overhaul orca-layout > orca-layout.json\` y cópialo aquí (ejemplo en el repo: helper/orca-layout.example.json).`);
    return 1;
  }

  const dir = resolvePaths(env, ctx.home).helper;
  log(`Helper: ${dir} (node ${node})`);
  const files = ASSET_FILES.filter((f) => f.startsWith("helper/"));
  for (const f of files) {
    const dest = path.join(dir, f.slice("helper/".length));
    if (dryRun) {
      log(`+ escribir ${dest}`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readAsset(f));
    if (f === "helper/bin/overhaul-helper") fs.chmodSync(dest, 0o755);
  }
  if (dryRun) log(`+ npm install (en ${dir})`);
  else {
    const i = ctx.run(npm, ["install", "--no-audit", "--no-fund", "--omit=dev"], { cwd: dir, stdio: "inherit", env: { ...env, PATH: `${path.dirname(node)}${path.delimiter}${env.PATH ?? ""}` } });
    if (i.status !== 0) {
      log("Error: npm install falló en el helper (ver arriba).");
      return 1;
    }
  }

  if (ctx.platform !== "darwin") {
    log(`Helper instalado. Sin LaunchAgents fuera de macOS: córrelo con ${node} ${path.join(dir, "bin/overhaul-helper")}`);
    return 0;
  }
  for (const label of previousHelperAgents(ctx.agentsDir)) {
    exec(ctx, ["bootout", `gui/${ctx.uid}/${label}`]);
    if (!dryRun) fs.rmSync(path.join(ctx.agentsDir, `${label}.plist`), { force: true });
    log(`LaunchAgent ${label} quitado (instalación anterior)`);
  }
  if (!dryRun) fs.mkdirSync(ctx.agentsDir, { recursive: true });
  let ok = true;
  for (const [template, label] of [["helper/helper.plist", HELPER_LABEL], ["helper/orca.plist", ORCA_LABEL]]) {
    const target = path.join(ctx.agentsDir, `${label}.plist`);
    const text = assetText(template).replaceAll("__NODE__", xml(node)).replaceAll("__DIR__", xml(dir)).replaceAll("__LABEL__", label);
    if (dryRun) log(`+ escribir ${target}`);
    else fs.writeFileSync(target, text);
    exec(ctx, ["bootout", `gui/${ctx.uid}/${label}`]);
    ok = exec(ctx, ["bootstrap", `gui/${ctx.uid}`, target]) && ok;
    log(`LaunchAgent ${label} instalado`);
  }
  if (!fs.existsSync("/Applications/Orca.app/Contents/Resources/bin/orca")) log(`Orca no está instalado: brew install --cask stablyai/orca/orca (luego: ${node} ${path.join(dir, "orca-restore.mjs")})`);
  return ok ? 0 : 1;
}

function exec(ctx, args) {
  if (ctx.dryRun) {
    ctx.log(`+ ${ctx.launchctl} ${args.join(" ")}`);
    return true;
  }
  return ctx.run(ctx.launchctl, args).status === 0;
}
