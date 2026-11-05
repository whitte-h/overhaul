#!/usr/bin/env node
// Builds the single executable for this machine's platform: dist/overhaul-<os>-<arch> and its
// .sha256. esbuild bundles src/ (and the yaml package) into one CommonJS file; Node SEA puts it
// and the assets (src/assets.mjs: public/, the helper, install.sh…) into a copy of this node.
// On macOS the copy's signature is removed before injecting and replaced by an ad-hoc one.
// Run it with the Node the executable should carry (the release workflow uses Node 24).
//
//   node scripts/build.mjs [--out DIR] [--bundle-only]
//     --bundle-only  stop after the bundle (dist/sea/overhaul.cjs), no executable
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listAssets } from "../src/assets.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
export const binaryName = (platform = process.platform, arch = process.arch) => `overhaul-${platform}-${arch}`;

export async function bundle({ out = path.join(root, "dist"), version } = {}) {
  const esbuild = await import("esbuild");
  version ??= JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const dir = path.join(out, "sea");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "overhaul.cjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/sea-main.mjs")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // import.meta.url only matters in a clone (sourceRoot); in the bundle it is the bundle's own path.
    banner: { js: 'const __overhaul_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
    define: { "import.meta.url": "__overhaul_import_meta_url", __OVERHAUL_VERSION__: JSON.stringify(version) },
    logLevel: "warning",
    legalComments: "none",
  });
  return { file, dir, version };
}

export async function build({ out = path.join(root, "dist"), version } = {}) {
  const b = await bundle({ out, version });
  const assets = Object.fromEntries(listAssets(root).map((rel) => [rel, path.join(root, rel)]));
  const blob = path.join(b.dir, "sea.blob");
  const config = path.join(b.dir, "sea-config.json");
  fs.writeFileSync(config, JSON.stringify({ main: b.file, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2));
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

  const exe = path.join(out, binaryName());
  fs.rmSync(exe, { force: true });
  fs.copyFileSync(fs.realpathSync(process.execPath), exe);
  fs.chmodSync(exe, 0o755);
  const mac = process.platform === "darwin";
  if (mac) execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
  const { inject } = await import("postject");
  await inject(exe, "NODE_SEA_BLOB", fs.readFileSync(blob), { sentinelFuse: SENTINEL, ...(mac ? { machoSegmentName: "NODE_SEA" } : {}) });
  if (mac) execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });

  const got = execFileSync(exe, ["version"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim();
  if (got !== b.version) throw new Error(`${exe} version says ${got}, expected ${b.version}`);
  const sum = crypto.createHash("sha256").update(fs.readFileSync(exe)).digest("hex");
  fs.writeFileSync(`${exe}.sha256`, `${sum}  ${path.basename(exe)}\n`);
  return { exe, checksum: `${exe}.sha256`, version: b.version, assets: Object.keys(assets).length };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : undefined;
  try {
    if (args.includes("--bundle-only")) console.log((await bundle({ out })).file);
    else {
      const r = await build({ out });
      console.log(`${r.exe} (v${r.version}, ${r.assets} assets)\n${r.checksum}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
