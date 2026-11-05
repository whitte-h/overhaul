// The Homebrew formula (packaging/homebrew/overhaul.rb, scripts/homebrew.mjs): one URL per platform
// with the contract's asset names, the release's sha256s, the executable installed as `overhaul`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formula, sumsFrom } from "../scripts/homebrew.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(fs.readFileSync(path.join(root, "contract/contract.json"), "utf8"));
const hex = (c) => c.repeat(64);

test("formula: version, each platform's URL and sha256, binary installed as overhaul, service runs serve", () => {
  const sums = { "darwin-arm64": hex("a"), "darwin-x64": hex("b"), "linux-arm64": hex("c"), "linux-x64": hex("d") };
  const rb = formula("1.2.3", sums);
  assert.match(rb, /^class Overhaul < Formula$/m);
  assert.match(rb, /^  version "1\.2\.3"$/m);
  assert.doesNotMatch(rb, /\{\{/);
  for (const p of contract.release.platforms) {
    const [o, a] = p.split("-");
    const url = `https://github.com/${contract.release.repo}/releases/download/v1.2.3/${contract.release.binary.replace("{os}", o).replace("{arch}", a)}`;
    const i = rb.indexOf(`url "${url}"`);
    assert.ok(i > 0, url);
    assert.equal(rb.slice(i).match(/sha256 "([0-9a-f]{64})"/)[1], sums[p], p);
  }
  // on_macos/on_linux blocks hold the right architectures.
  const block = (name) => rb.slice(rb.indexOf(`on_${name} do`), rb.indexOf("\n  end\n", rb.indexOf(`on_${name} do`)));
  assert.match(block("macos"), /darwin-arm64[\s\S]*darwin-x64/);
  assert.match(block("linux"), /linux-arm64[\s\S]*linux-x64/);
  assert.match(rb, /bin\.install Dir\["overhaul-\*"\]\.first => "overhaul"/);
  assert.match(rb, /run \[opt_bin\/"overhaul", "serve"\]/);
  assert.match(rb, /overhaul service install/);
  // Balanced do/end (no Ruby here to parse it).
  const opens = (rb.match(/\bdo\b|^\s*(class|def)\b/gm) ?? []).length;
  const ends = (rb.match(/^\s*end$/gm) ?? []).length;
  assert.equal(opens, ends);
  if (spawnSync("ruby", ["-v"]).status === 0) {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-rb-")), "overhaul.rb");
    fs.writeFileSync(f, rb);
    assert.equal(spawnSync("ruby", ["-c", f]).status, 0);
  }
});

test("formula: refuses a missing sha256 or a bad version; reads sums from the build's .sha256 files", () => {
  assert.throws(() => formula("1.2.3", { "darwin-arm64": hex("a") }), /darwin-x64/);
  assert.throws(() => formula("latest", {}), /invalid version/);
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "overhaul-sums-"));
  for (const [i, p] of contract.release.platforms.entries()) fs.writeFileSync(path.join(dist, `overhaul-${p}.sha256`), `${hex(String(i))}  overhaul-${p}\n`);
  assert.deepEqual(sumsFrom(dist), Object.fromEntries(contract.release.platforms.map((p, i) => [p, hex(String(i))])));
  const r = spawnSync(process.execPath, [path.join(root, "scripts/homebrew.mjs"), "--version", "v0.2.0", "--dist", dist], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /version "0\.2\.0"/);
});

test("release workflow renders the formula, attaches it, and touches the tap only with its token", () => {
  const wf = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(wf, /scripts\/homebrew\.mjs --version .* --dist dist --out dist\/overhaul\.rb/);
  assert.match(wf, /install\.sh dist\/overhaul\.rb/);
  const tap = wf.slice(wf.indexOf("  homebrew:"));
  assert.equal((tap.match(/if: env\.TAP_TOKEN != ''/g) ?? []).length, 2);
});
