// Standalone mode: this machine's name, default hub URL, helper off, and install.sh
// (always with a temporary HOME and --no-services or --dry-run: never this machine's services).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { normalize } from "../src/config.mjs";
import { hubUrls, localHost } from "../src/env.mjs";
import { standaloneConfig } from "../src/init.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("localHost: HUB_HOST, else the hostname without .local (as the bridge spells it)", () => {
  withEnv({ HUB_HOST: "host-b" }, () => assert.equal(localHost(), "host-b"));
  withEnv({ HUB_HOST: undefined }, () => {
    assert.equal(localHost(), os.hostname().replace(/\.local$/, ""));
    assert.ok(!localHost().endsWith(".local"));
  });
});

test("projects without host run on this machine, matching the bridge's default --host", () => {
  withEnv({ HUB_HOST: undefined }, () => {
    const cfg = normalize({ projects: { a: {} } });
    assert.equal(cfg.projects[0].host, localHost());
  });
});

test("hubUrls defaults to this machine's hub and splits HUB_URL", () => {
  assert.deepEqual(hubUrls(""), ["http://127.0.0.1:7420"]);
  assert.deepEqual(hubUrls(undefined), ["http://127.0.0.1:7420"]);
  assert.deepEqual(hubUrls("http://a:1/, http://b:2"), ["http://a:1", "http://b:2"]);
});

test("helper: v1 default URL, v2 off; off with null, false or empty", () => {
  assert.equal(normalize({}).chromeHelper, "http://127.0.0.1:7421");
  assert.equal(normalize({ version: 2 }).chromeHelper, null);
  for (const v of [null, false, ""]) assert.equal(normalize({ chrome_helper: v }).chromeHelper, null);
  assert.equal(normalize({ chrome_helper: "http://x:1" }).chromeHelper, "http://x:1");
});

test("standalone config: loopback, no helper, no projects, given time zone", () => {
  const text = standaloneConfig(fs.readFileSync(path.join(root, "config.example.yaml"), "utf8"), "Europe/Madrid");
  const cfg = normalize(YAML.parse(text));
  assert.deepEqual(cfg.bind, ["127.0.0.1"]);
  assert.equal(cfg.chromeHelper, null);
  assert.equal(cfg.timezone, "Europe/Madrid");
  assert.equal(cfg.port, 7420);
  assert.deepEqual(cfg.projects, []);
  assert.equal(YAML.parse(text).data_dir, undefined); // the data stays in ~/.overhaul (OVERHAUL_HOME)
  assert.doesNotMatch(text, /^\s*host:/m);
  assert.doesNotMatch(text, /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d/);
});

test("helper LaunchAgent templates carry their placeholders and are balanced", () => {
  for (const [f, placeholders] of [["helper/helper.plist", ["__NODE__", "__DIR__"]], ["helper/orca.plist", ["__NODE__", "__DIR__"]]]) {
    const t = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(t, /<key>Label<\/key>\s*<string>__LABEL__<\/string>/, `${f}: label`); // the installer names it
    for (const p of placeholders) assert.ok(t.includes(p), `${f}: ${p}`);
    for (const tag of ["dict", "array", "plist"]) assert.equal(t.match(new RegExp(`<${tag}[ >]`, "g")).length, t.split(`</${tag}>`).length - 1, `${f}: <${tag}>`);
  }
  assert.match(fs.readFileSync(path.join(root, "helper/helper.plist"), "utf8"), /__DIR__\/bin\/overhaul-helper</);
});
