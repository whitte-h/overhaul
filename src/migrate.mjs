// `overhaul migrate`: brings an earlier installation into ~/.overhaul (OVERHAUL_HOME) without losing
// anything (docs/contract.md, "Migración"):
//   1. a ~/.overhaul put together by hand: config.yaml, env and overhaul.db found up to 3 levels
//      down are moved up to the root, with what sits next to them;
//   2. v0.1 (~/.config/overhaul + ~/.local/share/overhaul, or config.yaml's data_dir when it is
//      one of those) and work-hub (~/.config/work-hub, ~/.local/share/work-hub).
// Everything it moves is copied first to backups/migrate-<stamp>/. The old folders become links to
// the new one, so hooks, scripts and other hosts that still use them keep working. data_dir is
// dropped from config.yaml when it pointed at a folder that moved. Never runs while the hub runs
// (the CLI checks; service install and update stop the services first).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolvePaths, hasInstall, expandHomeIn } from "./paths.mjs";
import { disableRemoteHubUrls } from "./doctor.mjs";

const KINDS = ["config.yaml", "env", "overhaul.db"];
// Not searched for hand-placed files, and not copied into the backup (big, or ours).
const SKIP = new Set(["backups", "bin", "logs", "helper", "node_modules", ".git"]);

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-");
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const isRealDir = (p) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Moves src (file, folder or link) to dst; folders are merged. A file that exists on both sides
// stays where it is in dst; the src one is reported (it is in the backup) and moved to `conflicts`.
function mergeMove(src, dst, conflicts, rel, notes) {
  const s = fs.lstatSync(src);
  let d = null;
  try {
    d = fs.lstatSync(dst);
  } catch {}
  if (!d) return move(src, dst);
  if (s.isDirectory() && d.isDirectory()) {
    for (const name of fs.readdirSync(src)) mergeMove(path.join(src, name), path.join(dst, name), conflicts, path.join(rel, name), notes);
    fs.rmdirSync(src);
    return;
  }
  const keep = path.join(conflicts, rel);
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  move(src, keep);
  notes.push(`${rel}: ya existía en el destino; quedó el del destino, el otro en ${keep}`);
}

function move(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// skipOwn: back up home itself, entry by entry (the backup lives inside it), without its own
// big folders (backups, bin, helper…).
function backupCopy(src, dst, skipOwn = false) {
  fs.mkdirSync(skipOwn ? dst : path.dirname(dst), { recursive: true, mode: 0o700 });
  const opts = { recursive: true, verbatimSymlinks: true, preserveTimestamps: true };
  if (!skipOwn) return fs.cpSync(src, dst, opts);
  for (const name of fs.readdirSync(src)) if (!SKIP.has(name)) fs.cpSync(path.join(src, name), path.join(dst, name), opts);
}

// Files of each kind under home, not at its root (depth 1..3), skipping our own folders.
export function findNested(home) {
  const found = Object.fromEntries(KINDS.map((k) => [k, []]));
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!(depth === 0 && SKIP.has(e.name)) && e.name !== "node_modules") walk(path.join(dir, e.name), depth + 1);
      } else if (depth > 0 && KINDS.includes(e.name) && e.isFile()) found[e.name].push(dir);
    }
  };
  walk(home, 0);
  return found;
}

// data_dir from a config.yaml, expanded; undefined when it does not say.
function configDataDir(file, expand) {
  try {
    const raw = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
    const v = raw.data_dir ?? raw.dataDir;
    return v ? path.resolve(expand(String(v))) : undefined;
  } catch {
    return undefined;
  }
}

function dropDataDir(file, stamp) {
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  if (!YAML.isMap(doc.contents)) return false;
  let changed = false;
  for (const key of ["data_dir", "dataDir"]) if (doc.contents.has(key)) changed = doc.contents.delete(key) || changed;
  if (!changed) return false;
  fs.copyFileSync(file, `${file}.bak-migrate-${stamp}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

function linkTo(from, target) {
  fs.mkdirSync(path.dirname(from), { recursive: true });
  try {
    fs.rmSync(from, { recursive: false, force: true });
  } catch {}
  fs.symlinkSync(target, from);
}

function rmEmptyUp(dir, stop) {
  while (dir && dir !== stop && inside(dir, stop)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// What overhaul setup writes; nothing else may be in home's root for it to count as blank.
const BLANK_FILES = ["config.yaml", "env"];

// Projects in a config.yaml (0 when it is missing or unreadable).
function projectCount(file) {
  try {
    const raw = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
    return Object.keys(raw.projects ?? {}).length;
  } catch {
    return 0;
  }
}

// Home holds only what setup creates: config.yaml without projects and/or env, no database and
// nothing found below it.
function blankHome(home, nested) {
  if (fs.existsSync(path.join(home, "overhaul.db")) || fs.existsSync(path.join(home, "config.json"))) return false;
  if (Object.values(nested).some((dirs) => dirs.length)) return false;
  return projectCount(path.join(home, "config.yaml")) === 0;
}

// What migrate would do: { status, steps: [text], ... } without touching anything.
// status: "nothing" | "migrate" | "ambiguous" | "conflict"
export function planMigration({ env = process.env, userHome } = {}) {
  const P = resolvePaths(env, userHome);
  const expand = expandHomeIn(userHome ?? env.HOME);
  const home = P.home;
  const homeReal = real(home);
  const notes = [];

  // 1. A hand-made ~/.overhaul: kinds missing at the root but found below it.
  const nested = fs.existsSync(home) ? findNested(home) : {};
  const ambiguous = [];
  const normalize = new Set();
  for (const k of KINDS) {
    const dirs = nested[k] ?? [];
    if (fs.existsSync(path.join(home, k))) {
      if (dirs.length) notes.push(`${k} está en la raíz y también en ${dirs.join(", ")}: uso el de la raíz`);
      continue;
    }
    if (dirs.length > 1) ambiguous.push(`${k} en ${dirs.join(" y ")}`);
    else if (dirs.length) normalize.add(dirs[0]);
  }
  if (ambiguous.length) return { status: "ambiguous", home, notes: [`No sé cuál usar: ${ambiguous.join("; ")}. Deja uno solo y vuelve a correr overhaul migrate.`] };
  // Folders inside others: move the outer one only.
  const normalizeDirs = [...normalize].filter((d) => ![...normalize].some((o) => o !== d && inside(d, o)));

  // 2. An earlier layout outside home (explicit config dirs are left alone: they are what the
  // caller asked for).
  const sources = [];
  const aside = [];
  if (!env.HUB_CONFIG_DIR && !env.OVERHAUL_CONFIG_DIR) {
    const cfgDir = P.legacy.config.find((d) => hasInstall(d) && !inside(real(d) ?? d, homeReal ?? home));
    const homeHasInstall = hasInstall(home) || [...normalize].length > 0;
    if (cfgDir && homeHasInstall) {
      // A home that only holds what setup writes (no projects, no database) is not an
      // installation: it is set aside, with a backup, and the earlier one moves in.
      if (blankHome(home, nested)) {
        aside.push(...BLANK_FILES.filter((f) => fs.existsSync(path.join(home, f))));
        notes.push(`${home} solo tiene lo que crea overhaul setup (sin proyectos ni base de datos): lo aparto al respaldo y migro ${cfgDir}`);
      } else {
        const has = (d) => `${d} (${projectCount(path.join(d, "config.yaml"))} proyectos)`;
        return { status: "conflict", home, notes: [`Hay dos instalaciones: ${has(home)} y ${has(cfgDir)}. No junto nada; quita o mueve la que no uses y vuelve a correr overhaul migrate.`] };
      }
    }
    if (cfgDir) {
      sources.push({ kind: "config", path: cfgDir, real: real(cfgDir) });
      const dataDir = configDataDir(path.join(cfgDir, "config.yaml"), expand);
      const legacyData = P.legacy.data.filter((d) => fs.existsSync(d));
      const custom = dataDir && !P.legacy.data.some((d) => real(d) === real(dataDir) || d === dataDir);
      if (custom) {
        if (!inside(real(dataDir) ?? dataDir, homeReal ?? home)) notes.push(`data_dir (${dataDir}) es propio: no lo muevo`);
        for (const d of legacyData) notes.push(`${d} no se usa (data_dir dice ${dataDir}): no lo toco`);
      } else {
        const data = dataDir ?? legacyData[0];
        if (data && fs.existsSync(data)) {
          const r = real(data);
          if (!inside(r, homeReal ?? home) && !sources.some((s) => s.real === r)) sources.push({ kind: "data", path: data, real: r, dataDirKey: Boolean(dataDir) });
          else if (dataDir) sources.push({ kind: "data", path: data, real: r, dataDirKey: true, already: true });
        }
        for (const d of legacyData) if (real(d) !== real(data) && !inside(real(d), homeReal ?? home)) notes.push(`${d} también existe pero no es la carpeta de datos en uso: no lo toco`);
      }
    } else {
      // No config anywhere old, but data left behind (an uninstall kept it): only when home is new.
      const data = P.legacy.data.find((d) => fs.existsSync(path.join(d, "overhaul.db")) && !inside(real(d), homeReal ?? home));
      if (data && !homeHasInstall && !fs.existsSync(path.join(home, "overhaul.db"))) sources.push({ kind: "data", path: data, real: real(data) });
    }
  }

  const steps = [];
  for (const f of aside) steps.push(`apartar ${path.join(home, f)} (lo creó overhaul setup) al respaldo`);
  for (const d of normalizeDirs) steps.push(`subir ${path.relative(home, d)}/ a la raíz de ${home}`);
  for (const s of sources.filter((x) => !x.already)) steps.push(`mover ${s.path}${s.real !== s.path ? ` (${s.real})` : ""} a ${home} y dejar un enlace`);
  const cfgSource = sources.find((x) => x.kind === "config");
  const nestedCfg = normalizeDirs.length && !fs.existsSync(path.join(home, "config.yaml")) ? nested["config.yaml"]?.[0] : null;
  const cfgFile = path.join(cfgSource?.real ?? nestedCfg ?? home, "config.yaml");
  const dataDirInHome = configDataDir(cfgFile, expand);
  const drop = sources.some((s) => s.dataDirKey) || (dataDirInHome && normalizeDirs.some((d) => inside(dataDirInHome, d) || dataDirInHome === d));
  if (drop) steps.push("quitar data_dir de config.yaml (los datos quedan en la carpeta de Overhaul)");
  return { status: steps.length ? "migrate" : "nothing", home, steps, notes, normalizeDirs, sources, aside, drop, mode: P.mode, configFile: cfgFile };
}

// Runs the plan. Returns the plan plus { backup } (null when there was nothing to do).
export function migrateHome({ env = process.env, userHome, dryRun = false, log = () => {} } = {}) {
  const plan = planMigration({ env, userHome });
  for (const n of plan.notes) log(`- ${n}`);
  if (plan.status !== "migrate") return { ...plan, backup: null };
  for (const s of plan.steps) log(`${dryRun ? "+ " : ""}${s}`);
  if (dryRun) return { ...plan, backup: null };

  const { home } = plan;
  const stamp = stampNow();
  const backup = path.join(home, "backups", `migrate-${stamp}`);
  const conflicts = path.join(backup, "conflicts");
  const notes = [];
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);

  // What setup alone wrote in home goes to the backup first, so the earlier installation's files
  // take its place instead of losing to it.
  for (const f of plan.aside ?? []) {
    const keep = path.join(backup, "setup", f);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    move(path.join(home, f), keep);
    log(`${path.join(home, f)} -> ${keep}`);
  }
  // Copies first, all of them, before anything moves.
  if (plan.normalizeDirs.length) backupCopy(home, path.join(backup, "home"), true);
  for (const s of plan.sources.filter((x) => !x.already)) backupCopy(s.real, path.join(backup, s.kind));
  log(`Respaldo: ${backup}`);

  for (const d of plan.normalizeDirs) {
    for (const name of fs.readdirSync(d)) mergeMove(path.join(d, name), path.join(home, name), conflicts, name, notes);
    rmEmptyUp(d, home);
  }
  for (const s of plan.sources.filter((x) => !x.already)) {
    for (const name of fs.readdirSync(s.real)) mergeMove(path.join(s.real, name), path.join(home, name), path.join(conflicts, s.kind), name, notes);
    fs.rmdirSync(s.real);
    // The old path (and the folder it pointed at, if it was a link) now lead to home.
    linkTo(s.real, home);
    if (s.path !== s.real) linkTo(s.path, home);
    log(`${s.path} -> ${home}`);
  }
  if (plan.drop && dropDataDir(path.join(home, "config.yaml"), stamp)) log("config.yaml: quité data_dir (respaldo config.yaml.bak-migrate-*)");
  // An earlier node reported to a hub on another machine (HUB_URL); after migrating, this one runs
  // its own. The line stays, commented, to bring back by hand.
  if (fs.existsSync(path.join(home, "env"))) {
    const off = disableRemoteHubUrls(path.join(home, "env"));
    if (off.length) log(`env: comenté ${off.join(", ")} (apuntaba a un hub de otra máquina; este nodo usa el suyo)`);
  }
  for (const f of ["env", "config.yaml", "overhaul.db"]) {
    try {
      fs.chmodSync(path.join(home, f), 0o600);
    } catch {}
  }
  for (const n of notes) log(`- ${n}`);
  return { ...plan, backup, conflicts: notes };
}
