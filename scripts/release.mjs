#!/usr/bin/env node
// Builds the release tarball: dist/overhaul-vX.Y.Z.tar.gz (one top folder, overhaul-vX.Y.Z/) with
// what install.sh needs to run Overhaul, plus dist/overhaul-vX.Y.Z.tar.gz.sha256 (sha256sum format).
// Files come from git (tracked files only), without tests or the board. The version is package.json's.
//
//   node scripts/release.mjs [--out DIR] [--tag vX.Y.Z] [--version X.Y.Z]
//     --tag      fail unless it matches the version (CI passes the pushed tag)
//     --version  override package.json's version (tests)
//
// The tarball carries a RELEASE file with the version: install.sh uses it to know it runs from an
// installed release (~/.local/share/overhaul/app/<version>) and not from a clone.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// What a release carries: top-level folders and files, then exclusions inside them.
// deploy: gone since v0.2, kept so a v0.1 tree still packs the same way (tests build v0.1.0).
export const INCLUDE = ["bin", "src", "public", "deploy", "helper", "pi", "docs", "contract", "package.json", "package-lock.json", "install.sh", "config.example.yaml", "README.md", "LICENSE"];
const EXCLUDE = [/(^|\/)node_modules\//, /^helper\/orca-layout\.json$/, /(^|\/)\.DS_Store$/];

export function releaseFiles(tracked) {
  return tracked
    .filter((f) => INCLUDE.some((top) => f === top || f.startsWith(`${top}/`)))
    .filter((f) => !EXCLUDE.some((re) => re.test(f)))
    .sort();
}

export const tarballName = (version) => `overhaul-v${version}.tar.gz`;

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function validVersion(v) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
}

export function buildRelease({ out = path.join(root, "dist"), version, tag, cwd = root } = {}) {
  version ??= JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version;
  if (!validVersion(version)) throw new Error(`invalid version: ${version}`);
  if (tag && tag !== `v${version}`) throw new Error(`tag ${tag} does not match package.json version ${version} (expected v${version})`);

  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = releaseFiles(tracked);
  if (!files.includes("src/server.mjs") || !files.includes("install.sh")) throw new Error("tracked files lack src/server.mjs or install.sh");

  const top = `overhaul-v${version}`;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-release-"));
  try {
    for (const f of files) {
      const dest = path.join(stage, top, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(cwd, f), dest);
      fs.chmodSync(dest, fs.statSync(path.join(cwd, f)).mode & 0o777);
    }
    fs.writeFileSync(path.join(stage, top, "RELEASE"), `${version}\n`);

    fs.mkdirSync(out, { recursive: true });
    const tarball = path.join(out, tarballName(version));
    // COPYFILE_DISABLE: no ._ files from macOS tar.
    execFileSync("tar", ["-czf", tarball, "-C", stage, top], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const sum = `${sha256File(tarball)}  ${path.basename(tarball)}\n`;
    fs.writeFileSync(`${tarball}.sha256`, sum);
    return { version, tarball, checksum: `${tarball}.sha256`, files: files.length + 1 };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, value] = [args[i], args[i + 1]];
    if (flag === "--out") opts.out = path.resolve(value);
    else if (flag === "--tag") opts.tag = value;
    else if (flag === "--version") opts.version = value;
    else { console.error(`Unknown option: ${flag}\nUsage: node scripts/release.mjs [--out DIR] [--tag vX.Y.Z] [--version X.Y.Z]`); process.exit(2); }
    i++;
  }
  try {
    const r = buildRelease(opts);
    console.log(`${r.tarball} (${r.files} files)\n${r.checksum}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
