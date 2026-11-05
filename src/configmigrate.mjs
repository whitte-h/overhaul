// config.yaml v1 (work-hub) -> v2 (overhaul), in place with the yaml Document API so your
// comments survive. Everything v1 left to a default that v2 changes is written out, so a
// migrated install behaves exactly as before: helper URL, allow_from, timezone, message tag.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { V1_ALLOW } from "./config.mjs";

const V1_DEFAULTS = { helper: "http://127.0.0.1:7421", timezone: "America/Bogota", message_tag: "work-hub" };
const OLD_DATA = "~/.local/share/work-hub";

// opts: { moveData: rewrite data_dir ~/.local/share/work-hub -> ~/.local/share/overhaul,
//         publicUrls: [..], agentsDir, repoHasLane: (dir) => bool }
// Returns { text, changed, notes }.
export function migrateConfigText(text, opts = {}) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const notes = [];
  const version = Number(doc.get("version") ?? 1);
  if (version === 2) return { text, changed: false, notes: ["ya es v2"] };
  if (version !== 1) throw new Error(`versión de config desconocida: ${doc.get("version")}`);
  if (!YAML.isMap(doc.contents)) throw new Error("config.yaml no es un mapa");
  const root = doc.contents;

  if (root.has("version")) root.set("version", 2);
  else root.items.unshift(doc.createPair("version", 2));
  if (doc.commentBefore) {
    doc.commentBefore = doc.commentBefore
      .replace(/^ ?work-hub:/m, " overhaul (config v2):")
      .replaceAll("~/.config/work-hub/env", "~/.config/overhaul/env")
      .replace(/systemctl --user restart work-hub\b/g, "systemctl --user restart overhaul");
  }

  // chrome_helper -> helper, keeping its comment; v1's default written out.
  const helperPair = root.items.find((p) => keyOf(p) === "chrome_helper");
  if (helperPair) {
    helperPair.key = doc.createNode("helper");
    notes.push("chrome_helper -> helper");
  } else if (!root.has("helper")) {
    addTop(root, doc.createPair("helper", V1_DEFAULTS.helper));
    notes.push(`helper: ${V1_DEFAULTS.helper} (default de v1)`);
  }
  if (!root.has("allow_from") && !root.has("allowFrom")) {
    insertAfter(root, "bind", doc.createPair("allow_from", flow(doc, V1_ALLOW)));
    notes.push("allow_from explícito (default de v1: localhost, rangos de VPN y una LAN privada)");
  }
  for (const key of ["timezone", "message_tag"]) {
    if (!root.has(key)) {
      addTop(root, doc.createPair(key, V1_DEFAULTS[key]));
      notes.push(`${key}: ${V1_DEFAULTS[key]} (default de v1)`);
    }
  }
  const dataDir = root.get("data_dir");
  if (opts.moveData && (dataDir === undefined || dataDir === OLD_DATA)) {
    if (dataDir === undefined) addTop(root, doc.createPair("data_dir", "~/.local/share/overhaul"));
    else root.set("data_dir", "~/.local/share/overhaul");
    notes.push("data_dir: ~/.local/share/overhaul");
  }
  if (opts.publicUrls?.length && !root.has("public_url")) {
    addTop(root, doc.createPair("public_url", opts.publicUrls.length === 1 ? opts.publicUrls[0] : flow(doc, opts.publicUrls)));
    notes.push(`public_url: ${opts.publicUrls.join(", ")}`);
  }
  if (opts.agentsDir && !root.has("orca")) {
    addTop(root, doc.createPair("orca", doc.createNode({ agents_dir: opts.agentsDir })));
    notes.push(`orca.agents_dir: ${opts.agentsDir}`);
  }

  const projects = root.get("projects", true);
  if (YAML.isMap(projects)) {
    for (const pair of projects.items) {
      const id = keyOf(pair);
      if (YAML.isMap(pair.value)) notes.push(...migrateProject(doc, id, pair.value, opts));
    }
  }
  return { text: doc.toString(), changed: true, notes };
}

// worker, terminals, orca and orchestrator -> one runtime block, where worker was.
function migrateProject(doc, id, p, opts) {
  const notes = [];
  if (!p.has("runtime")) {
    const worker = p.get("worker")?.toJSON?.() ?? p.get("worker");
    const runtime = {};
    if (worker && typeof worker === "object") {
      if (worker.command && worker.command !== "claude") runtime.command = worker.command;
      if (worker.prompt) runtime.prompt = worker.prompt;
      runtime.dir = worker.dir ?? "~";
    }
    const terminal = p.get("terminals");
    if (terminal && terminal !== "tmux") runtime.terminal = terminal;
    const orcaWt = p.getIn(["orca", "worktree"]);
    if (orcaWt) runtime.orca_worktree = orcaWt;
    const orq = p.get("orchestrator");
    if (orq) runtime.orchestrator = orq;
    if (!worker && Object.keys(runtime).length) runtime.per_ticket = false;
    if (Object.keys(runtime).length) {
      const at = Math.max(0, p.items.findIndex((x) => ["worker", "orchestrator", "terminals", "orca"].includes(keyOf(x))));
      const node = doc.createNode(runtime, { flow: false });
      for (const k of ["worker", "terminals", "orchestrator"]) p.delete(k);
      // orca.worktree moved to runtime; any other orca key stays where it was.
      const orca = p.get("orca", true);
      if (YAML.isMap(orca)) {
        orca.delete("worktree");
        if (!orca.items.length) p.delete("orca");
        else notes.push(`${id}: orca conserva ${orca.items.map(keyOf).join(", ")}`);
      } else p.delete("orca");
      p.items.splice(at, 0, doc.createPair("runtime", node));
      notes.push(`${id}: worker/terminals/orca/orchestrator -> runtime`);
    }
  }
  if (!p.has("agents")) {
    const dir = p.getIn(["runtime", "dir"]) ?? p.get("repos")?.toJSON?.()?.[0];
    const location = dir && opts.repoHasLane?.(String(dir)) ? "repo" : "external";
    insertAfter(p, p.has("runtime") ? "runtime" : "name", doc.createPair("agents", doc.createNode({ location }, { flow: true })));
    notes.push(`${id}: agents.location ${location}${location === "repo" ? " (el repo tiene su propio lane)" : ""}`);
  }
  return notes;
}

// Whether a repo governs its own agents (ORCA.md or .pi/): then its profile lives there.
export const repoHasLane = (expand) => (dir) => {
  const d = expand(dir);
  return fs.existsSync(path.join(d, "ORCA.md")) || fs.existsSync(path.join(d, ".pi"));
};

const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key);
const flow = (doc, list) => doc.createNode(list, { flow: true });
function insertAfter(map, key, pair) {
  const i = map.items.findIndex((p) => keyOf(p) === key);
  map.items.splice(i < 0 ? map.items.length : i + 1, 0, pair);
}
// Install settings go above `defaults` and `projects`, with the others.
function addTop(map, pair) {
  const i = map.items.findIndex((p) => ["defaults", "projects"].includes(keyOf(p)));
  if (i < 0) return map.items.push(pair);
  map.items.splice(i, 0, pair);
}

// Writes the migrated file next to a timestamped backup of the old one. Returns the result.
export function migrateConfigFile(file, opts = {}) {
  const before = fs.readFileSync(file, "utf8");
  const res = migrateConfigText(before, opts);
  if (!res.changed || opts.dryRun) return res;
  const backup = `${file}.bak-v1-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, res.text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ...res, backup };
}
