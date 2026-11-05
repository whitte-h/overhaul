// Files Overhaul ships with (the page, config.example.yaml, the pi extension, install.sh, the
// desktop helper): inside the executable they are SEA assets keyed by their path in the repo;
// in a clone they are read from disk. ASSETS lists them; scripts/build.mjs embeds exactly these.
import fs from "node:fs";
import path from "node:path";
import { getAsset } from "node:sea";
import { IS_SEA, sourceRoot } from "./self.mjs";

export const ASSET_DIRS = ["public"];
export const ASSET_FILES = [
  "config.example.yaml",
  "install.sh",
  "pi/overhaul.ts",
  "helper/package.json",
  "helper/package-lock.json",
  "helper/overhaul-helper.mjs",
  "helper/orca.mjs",
  "helper/orca-restore.mjs",
  "helper/ports.mjs",
  "helper/attach.mjs",
  "helper/bin/overhaul-helper",
  "helper/helper.plist",
  "helper/orca.plist",
  "helper/orca-layout.example.json",
];

// Every asset path, from a source tree (the build uses this on the repo).
export function listAssets(root = sourceRoot()) {
  const out = [...ASSET_FILES];
  for (const dir of ASSET_DIRS) {
    for (const f of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      const rel = path.posix.join(dir, String(f).split(path.sep).join("/"));
      if (fs.statSync(path.join(root, rel)).isFile() && !rel.endsWith(".DS_Store")) out.push(rel);
    }
  }
  return out.sort();
}

const SAFE = /^(?!.*(^|\/)\.\.?(\/|$))[\w@.+-]+(\/[\w@.+-]+)*$/;

// The asset's bytes, or null when there is no such asset.
export function readAsset(rel) {
  if (!SAFE.test(rel)) return null;
  if (IS_SEA) {
    try {
      return Buffer.from(getAsset(rel));
    } catch {
      return null;
    }
  }
  if (!ASSET_FILES.includes(rel) && !ASSET_DIRS.some((d) => rel.startsWith(`${d}/`))) return null;
  const file = path.join(sourceRoot(), rel);
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

export function assetText(rel) {
  const b = readAsset(rel);
  if (!b) throw new Error(`missing asset ${rel}`);
  return b.toString("utf8");
}
