#!/usr/bin/env node
// Fills packaging/homebrew/overhaul.rb for a release: the version and each executable's sha256,
// read from the overhaul-<os>-<arch>.sha256 files the build left in --dist.
//   node scripts/homebrew.mjs --version X.Y.Z --dist DIR [--out FILE]   (default: stdout)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORMS } from "./build.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE = path.join(root, "packaging/homebrew/overhaul.rb");

// sums: { "darwin-arm64": "<hex>", ... } for every platform.
export function formula(version, sums, template = fs.readFileSync(TEMPLATE, "utf8")) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid version: ${version}`);
  let text = template.replaceAll("{{VERSION}}", version);
  for (const p of PLATFORMS) {
    if (!/^[0-9a-f]{64}$/.test(sums[p] ?? "")) throw new Error(`missing or bad sha256 for ${p}`);
    text = text.replaceAll(`{{SHA_${p.toUpperCase().replace("-", "_")}}}`, sums[p]);
  }
  const left = text.match(/\{\{[A-Z0-9_]+\}\}/);
  if (left) throw new Error(`unfilled ${left[0]}`);
  return text;
}

export function sumsFrom(dist) {
  return Object.fromEntries(PLATFORMS.map((p) => {
    const file = path.join(dist, `overhaul-${p}.sha256`);
    const [hex, name] = fs.readFileSync(file, "utf8").trim().split(/\s+/);
    if (name !== `overhaul-${p}`) throw new Error(`${file} is for ${name}`);
    return [p, hex];
  }));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const text = formula(String(arg("--version") ?? "").replace(/^v/, ""), sumsFrom(arg("--dist") ?? "dist"));
    if (arg("--out")) fs.writeFileSync(arg("--out"), text);
    else process.stdout.write(text);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
