// The executable's build (scripts/build.mjs): the bundle runs on its own and every asset it embeds
// exists. The full Node SEA build runs in the release workflow, per platform, followed by the
// contract tests against the result (OVERHAUL_BIN).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { ASSET_FILES, listAssets } from "../src/assets.mjs";
import { binaryName, bundle } from "../scripts/build.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("bundle: one CommonJS file with no imports of its own, that runs version and help", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-bundle-"));
  const { file } = await bundle({ out, version: "9.8.7" });
  const text = fs.readFileSync(file, "utf8");
  // Only node built-ins are required: no node_modules next to the executable.
  const required = [...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(required.filter((m) => !m.startsWith("node:") && !builtinModules.includes(m)), []);
  const env = { PATH: process.env.PATH, HOME: out };
  assert.equal(spawnSync(process.execPath, [file, "version"], { env, encoding: "utf8" }).stdout.trim(), "9.8.7");
  assert.match(spawnSync(process.execPath, [file, "help"], { env, encoding: "utf8" }).stdout, /service install/);
});

test("assets: every embedded file exists; the page and install.sh are among them", () => {
  const list = listAssets(root);
  for (const f of list) assert.ok(fs.statSync(path.join(root, f)).isFile(), f);
  for (const f of ["public/index.html", "public/login.html", "public/app.js", "public/style.css", "install.sh", "config.example.yaml", "pi/overhaul.ts"]) assert.ok(list.includes(f), f);
  assert.ok(ASSET_FILES.every((f) => list.includes(f)));
});

test("binary names follow the contract", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, "contract/contract.json"), "utf8"));
  for (const p of contract.release.platforms) {
    const [osName, arch] = p.split("-");
    assert.equal(binaryName(osName, arch), contract.release.binary.replace("{os}", osName).replace("{arch}", arch));
  }
});
