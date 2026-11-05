// Release assets and install.sh, against a local HTTP server that mimics GitHub Releases
// (OVERHAUL_RELEASES_URL, OVERHAUL_API_URL). Always a temporary HOME, --bin-dir or OVERHAUL_BIN_DIR
// in it, --no-services and a fake systemctl: never this machine's installation.
//
// The served executables are stand-ins: a script that answers `version` with its release and
// runs the real CLI from this repo for everything else (so init, migrate, install-hooks are real).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRelease, releaseFiles, sha256File, tarballName } from "../scripts/release.mjs";
import { update } from "../src/update.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasCurl = spawnSync("curl", ["--version"]).status === 0;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = ["arm64", "aarch64"].includes(os.arch()) ? "arm64" : "x64";
const ASSET = `overhaul-${OS}-${ARCH}`;
const V01 = "4e3160c"; // the v0.1.0 release commit: its tarball is the real v0.1 installer
const hasV01 = spawnSync("git", ["-C", root, "cat-file", "-e", `${V01}^{commit}`]).status === 0;

// Three releases, served as releases/download/vX.Y.Z/<file>; latest is the last one. 0.1.0's
// tarball is built from the v0.1.0 commit when the history has it.
const VERSIONS = ["0.1.0", "0.2.0", "0.3.0"];
const dist = tmp("overhaul-dist-");
for (const version of VERSIONS) buildRelease({ out: dist, version });
if (hasV01) {
  const old = tmp("overhaul-v01-src-");
  const archive = spawnSync("git", ["-C", root, "archive", V01], { maxBuffer: 64 * 1024 * 1024 });
  spawnSync("tar", ["-x", "-C", old], { input: archive.stdout });
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "v0.1.0"]]) spawnSync("git", ["-C", old, ...args]);
  buildRelease({ out: dist, version: "0.1.0", cwd: old });
}
const NODE = process.execPath;
for (const version of VERSIONS) {
  const file = path.join(dist, ASSET);
  fs.writeFileSync(`${file}-${version}`, `#!/bin/sh
[ "$1" = version ] && { echo ${version}; exit 0; }
echo "$*" >> "$HOME/overhaul-calls.log"
exec '${NODE}' '${path.join(root, "bin/overhaul.mjs")}' "$@"
`, { mode: 0o755 });
  fs.writeFileSync(`${file}-${version}.sha256`, `${sha256File(`${file}-${version}`)}  ${ASSET}\n`);
}
const servedFile = (v, name) => {
  if (name === "install.sh") return path.join(root, "install.sh");
  if (name === ASSET || name === `${ASSET}.sha256`) return path.join(dist, name.replace(ASSET, `${ASSET}-${v}`));
  return path.join(dist, name);
};

// private: the public URLs answer 404 (as github.com does for a private repo) and only the API
// with TOKEN serves the assets. requests logs what reached the server (path and Authorization).
const TOKEN = "test-token-123";
const REPO = "acme/overhaul";
const NAMES = (v) => [tarballName(v), `${tarballName(v)}.sha256`, "install.sh", ASSET, `${ASSET}.sha256`];
const releaseJson = (v) => ({
  url: `https://api.example/repos/${REPO}/releases/1`, tag_name: `v${v}`, name: `Overhaul v${v}`,
  author: { login: "someone", url: "https://api.example/users/someone" },
  assets: NAMES(v).map((name, i) => ({
    url: `https://api.example/repos/${REPO}/releases/assets/${VERSIONS.indexOf(v) * 10 + i + 1}`,
    id: VERSIONS.indexOf(v) * 10 + i + 1, name, label: "",
    uploader: { login: "someone", id: 7, url: "https://api.example/users/someone", type: "User" },
    content_type: "application/octet-stream", size: 1,
    browser_download_url: `https://example/${REPO}/releases/download/v${v}/${name}`,
  })),
});
function assetById(id) {
  const v = VERSIONS[Math.floor((id - 1) / 10)];
  const name = v && NAMES(v)[(id - 1) % 10];
  return name && { v, name };
}

function startServer({ latest = VERSIONS.at(-1), tamper = false, private: priv = false } = {}) {
  const requests = [];
  const serve = (res, v, name) => {
    const file = servedFile(v, name);
    if (!VERSIONS.includes(v) || !fs.existsSync(file)) return res.writeHead(404).end();
    let body = fs.readFileSync(file);
    if (tamper && name === ASSET) body = Buffer.concat([body, Buffer.from("x")]);
    res.writeHead(200).end(body);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ path: url.pathname, auth: req.headers.authorization ?? null, accept: req.headers.accept });
    let m;
    if ((m = url.pathname.match(/^\/api\/repos\/([^/]+\/[^/]+)\/releases\/(.+)$/))) {
      if (m[1] !== REPO || req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(404).end('{"message":"Not Found"}');
      const rest = m[2];
      let a;
      if (rest === "latest") return res.writeHead(200).end(JSON.stringify(releaseJson(latest), null, 2));
      if ((a = rest.match(/^tags\/v(.+)$/)) && VERSIONS.includes(a[1])) return res.writeHead(200).end(JSON.stringify(releaseJson(a[1]), null, 2));
      if ((a = rest.match(/^assets\/(\d+)$/)) && assetById(Number(a[1])) && req.headers.accept === "application/octet-stream") {
        // Like GitHub: a redirect to storage on another host (localhost here), where no token must arrive.
        const { v, name } = assetById(Number(a[1]));
        return res.writeHead(302, { location: `http://localhost:${server.address().port}/storage/${v}/${name}` }).end();
      }
      return res.writeHead(404).end('{"message":"Not Found"}');
    }
    if ((m = url.pathname.match(/^\/storage\/([^/]+)\/([^/]+)$/))) return serve(res, m[1], m[2]);
    if (priv) return res.writeHead(404).end();
    if (url.pathname === "/releases/latest") res.writeHead(302, { location: `/releases/tag/v${latest}` }).end();
    else if ((m = url.pathname.match(/^\/releases\/latest\/download\/(.+)$/))) res.writeHead(302, { location: `/releases/download/v${latest}/${m[1]}` }).end();
    else if (url.pathname.startsWith("/releases/tag/")) res.writeHead(200).end("release page");
    else if ((m = url.pathname.match(/^\/releases\/download\/v([^/]+)\/([^/]+)$/))) serve(res, m[1], m[2]);
    else res.writeHead(404).end();
  });
  server.requests = requests;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Fakes: npm (v0.1's installer runs npm ci: link this repo's node_modules), systemctl, gh.
const fakeBin = tmp("overhaul-fakes-");
fs.writeFileSync(path.join(fakeBin, "npm"), `#!/bin/sh\nln -sfn '${path.join(root, "node_modules")}' node_modules\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "$HOME/systemctl.log"\n`, { mode: 0o755 });
// A fake gh: logged in unless FAKE_GH=logged-out; FAKE_GH=no-access fails like a gh without the repo.
const ghBin = path.join(fakeBin, "fake-gh");
const ghLog = path.join(fakeBin, "gh.log");
fs.writeFileSync(ghBin, `#!/bin/sh
echo "gh $*" >> '${ghLog}'
case "$1 $2" in
  "auth status") [ "\${FAKE_GH:-}" != logged-out ] ;;
  "release view") [ "\${FAKE_GH:-}" = no-access ] && exit 1; echo v${VERSIONS.at(-1)} ;;
  "release download")
    [ "\${FAKE_GH:-}" = no-access ] && exit 1
    v=\${3#v}; shift 3; pattern=""; dir=.
    while [ $# -gt 0 ]; do case "$1" in --pattern) pattern=$2; shift ;; --dir) dir=$2; shift ;; esac; shift; done
    case "$pattern" in ${ASSET}|${ASSET}.sha256) cp '${dist}'/"$(echo "$pattern" | sed "s/${ASSET}/${ASSET}-$v/")" "$dir/$pattern" ;; *) cp '${dist}'/"$pattern" "$dir/" ;; esac ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

// install.sh as `curl | <shell>` would run it: the script on stdin, no file next to it.
// No gh unless extra.OVERHAUL_GH says so (this machine's gh may have a session).
function testEnv(server, home, extra = {}) {
  const port = server.address().port;
  return {
    PATH: `${fakeBin}:${process.env.PATH}`, HOME: home, USER: process.env.USER ?? "u", XDG_CONFIG_HOME: path.join(home, ".config"),
    OVERHAUL_RELEASES_URL: `http://127.0.0.1:${port}/releases`, OVERHAUL_API_URL: `http://127.0.0.1:${port}/api`,
    OVERHAUL_REPO: REPO, OVERHAUL_GH: path.join(fakeBin, "no-gh"), OVERHAUL_SYSTEMCTL: path.join(fakeBin, "systemctl"), ...extra,
  };
}
function runAsync(cmd, args, env, input = "") {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const runPiped = (server, home, args, shell = "bash", extra = {}) =>
  runAsync(shell, ["-s", "--", ...args], testEnv(server, home, extra), fs.readFileSync(path.join(root, "install.sh")));
const quiet = ["--no-services", "--non-interactive"];
const binDir = (home) => path.join(home, "bin");
const installedVersion = (home) => spawnSync(path.join(binDir(home), "overhaul"), ["version"], { encoding: "utf8" }).stdout.trim();
const calls = (home) => (fs.existsSync(path.join(home, "overhaul-calls.log")) ? fs.readFileSync(path.join(home, "overhaul-calls.log"), "utf8") : "");

test("releaseFiles: runtime files only, no tests, board, node_modules or local layout", () => {
  const files = releaseFiles(["src/server.mjs", "test/a.test.mjs", "kanban/tasks/1.md", "helper/node_modules/x/y.js",
    "helper/orca-layout.json", "helper/install.sh", "install.sh", ".gitignore", "scripts/release.mjs", "package.json", "binary"]);
  assert.deepEqual(files, ["helper/install.sh", "install.sh", "package.json", "src/server.mjs"]);
});

test("release tarball (for v0.1's updater): versioned top folder, RELEASE, src/server.mjs and install.sh, matching sha256", () => {
  const tarball = path.join(dist, tarballName("0.2.0"));
  const list = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  assert.ok(list.every((f) => f.startsWith("overhaul-v0.2.0/")));
  const rel = list.map((f) => f.slice("overhaul-v0.2.0/".length));
  for (const f of ["RELEASE", "install.sh", "package.json", "src/server.mjs", "src/cli.mjs", "bin/overhaul.mjs", "public/index.html", "pi/overhaul.ts", "config.example.yaml"]) {
    assert.ok(rel.includes(f), f);
  }
  assert.ok(!rel.some((f) => /^(test|kanban|scripts|\.github)\//.test(f) || f.includes("node_modules")));
  assert.equal(fs.readFileSync(`${tarball}.sha256`, "utf8"), `${sha256File(tarball)}  ${tarballName("0.2.0")}\n`);
  const x = tmp("overhaul-x-");
  spawnSync("tar", ["-xzf", tarball, "-C", x]);
  assert.equal(fs.readFileSync(path.join(x, "overhaul-v0.2.0/RELEASE"), "utf8"), "0.2.0\n");
  assert.ok(fs.statSync(path.join(x, "overhaul-v0.2.0/install.sh")).mode & 0o100, "install.sh keeps +x");
});

test("release: version from package.json, tag must match it", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const out = tmp("overhaul-dist-");
  assert.equal(buildRelease({ out, tag: `v${version}` }).version, version);
  assert.ok(fs.existsSync(path.join(out, tarballName(version))));
  assert.throws(() => buildRelease({ out, tag: "v9.9.9" }), /does not match/);
  assert.throws(() => buildRelease({ out, version: "latest" }), /invalid version/);
});

test("install.sh: --check prints the latest; --dry-run resolves it and changes nothing", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer();
  try {
    const home = tmp("overhaul-home-");
    const c = await runPiped(server, home, ["--check"]);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(c.stdout.trim(), "0.3.0");
    const r = await runPiped(server, home, ["--dry-run", "--bin-dir", binDir(home)]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Overhaul v0\.3\.0 desde http:\/\/127\.0\.0\.1:\d+\/releases\n/);
    assert.match(r.stdout, new RegExp(`\\+ descargar ${ASSET} y ${ASSET}\\.sha256`));
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { server.close(); }
});

test("install.sh: curl | sh installs the executable, verified, and sets up ~/.overhaul; reruns replace it in place; uninstall keeps ~/.overhaul", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer();
  try {
    const home = tmp("overhaul-home-");
    const bin = path.join(binDir(home), "overhaul");
    // sh hands over to bash by fetching install.sh from releases/latest/download.
    const r = await runPiped(server, home, [...quiet, "--bin-dir", binDir(home)], "sh");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /sha256 verificado/);
    assert.equal(installedVersion(home), "0.3.0");
    assert.match(r.stdout, /no está en tu PATH[\s\S]*export PATH=/);
    assert.ok(fs.existsSync(path.join(home, ".overhaul/config.yaml")));
    assert.match(fs.readFileSync(path.join(home, ".overhaul/env"), "utf8"), /^HUB_AGENT_TOKEN=/m);
    assert.match(calls(home), /^init$/m);
    assert.match(calls(home), /^migrate$/m); // --no-services: migrate without services
    assert.match(r.stderr, /sin contraseña/);
    assert.deepEqual(fs.readdirSync(binDir(home)), ["overhaul"], "no temporary files left");

    // Another version: same path, replaced; config untouched.
    fs.appendFileSync(path.join(home, ".overhaul/config.yaml"), "# mine\n");
    const ino = fs.statSync(bin).ino;
    const old = await runPiped(server, home, ["--version", "v0.1.0", ...quiet, "--bin-dir", binDir(home)]);
    assert.equal(old.status, 0, old.stderr + old.stdout);
    assert.equal(installedVersion(home), "0.1.0");
    assert.notEqual(fs.statSync(bin).ino, ino, "a new file renamed over the old one");
    assert.match(fs.readFileSync(path.join(home, ".overhaul/config.yaml"), "utf8"), /# mine\n$/);

    // OVERHAUL_BIN_DIR does what --bin-dir does.
    const up = await runPiped(server, home, quiet, "bash", { OVERHAUL_BIN_DIR: binDir(home) });
    assert.equal(up.status, 0, up.stderr + up.stdout);
    assert.equal(installedVersion(home), "0.3.0");

    const un = await runPiped(server, home, ["--uninstall", "--bin-dir", binDir(home)]);
    assert.equal(un.status, 0, un.stderr + un.stdout);
    assert.ok(!fs.existsSync(bin));
    assert.match(calls(home), /^service uninstall$/m);
    assert.ok(fs.existsSync(path.join(home, ".overhaul/config.yaml")));
  } finally { server.close(); }
});

test("install.sh: an executable that fails its sha256 installs nothing; an unknown version fails cleanly", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ tamper: true });
  try {
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, [...quiet, "--bin-dir", binDir(home)]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sha256 de overhaul-.* no coincide/);
    assert.deepEqual(fs.readdirSync(binDir(home)), []);
    assert.ok(!fs.existsSync(path.join(home, ".overhaul")));
    const bad = await runPiped(server, home, ["--version", "9.9.9", ...quiet, "--bin-dir", binDir(home)]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /no pude descargar Overhaul/);
  } finally { server.close(); }
});

test("install.sh --binary installs a local executable without downloading", async () => {
  const home = tmp("overhaul-home-");
  const r = spawnSync("bash", [path.join(root, "install.sh"), "--binary", path.join(dist, `${ASSET}-0.2.0`), ...quiet, "--bin-dir", binDir(home)], {
    env: { PATH: process.env.PATH, HOME: home, OVERHAUL_RELEASES_URL: "http://127.0.0.1:9/none" }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(installedVersion(home), "0.2.0");
});

// OVH-46: --bin-dir ~/.local/bin on a v0.1 machine, where ~/.local/bin/overhaul is v0.1's link.
test("install.sh: --bin-dir equal to v0.1's link replaces the link with the executable, never a link to itself", () => {
  const home = tmp("overhaul-home-");
  const local = path.join(home, ".local/bin");
  fs.mkdirSync(local, { recursive: true });
  fs.symlinkSync(path.join(home, ".overhaul/app/current/bin/hub.mjs"), path.join(local, "overhaul"));
  fs.symlinkSync(path.join(home, ".overhaul/app/current/bin/hub.mjs"), path.join(local, "hub"));
  const env = { PATH: process.env.PATH, HOME: home, OVERHAUL_RELEASES_URL: "http://127.0.0.1:9/none" };
  const args = [path.join(root, "install.sh"), "--binary", path.join(dist, `${ASSET}-0.2.0`), ...quiet, "--bin-dir", local];
  const dry = spawnSync("bash", [...args, "--dry-run"], { env, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.doesNotMatch(dry.stdout, new RegExp(`ln -sfn ${local}/overhaul ${local}/overhaul`));
  assert.match(dry.stdout, new RegExp(`ln -sfn ${local}/overhaul ${local}/hub`));
  const r = spawnSync("bash", args, { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const bin = path.join(local, "overhaul");
  assert.ok(!fs.lstatSync(bin).isSymbolicLink(), "the executable, not a link");
  assert.equal(spawnSync(bin, ["version"], { encoding: "utf8" }).stdout.trim(), "0.2.0");
  assert.equal(fs.readlinkSync(path.join(local, "hub")), bin);
});

test("install.sh: no PATH warning when a link in a PATH folder already leads to the executable", () => {
  const home = tmp("overhaul-home-");
  const local = path.join(home, ".local/bin");
  fs.mkdirSync(local, { recursive: true });
  fs.symlinkSync(path.join(home, "old/bin/hub.mjs"), path.join(local, "overhaul"));
  const run = (extraPath) => spawnSync("bash", [path.join(root, "install.sh"), "--binary", path.join(dist, `${ASSET}-0.2.0`), ...quiet, "--bin-dir", binDir(home)], {
    env: { PATH: `${extraPath}${process.env.PATH}`, HOME: home, OVERHAUL_RELEASES_URL: "http://127.0.0.1:9/none" }, encoding: "utf8",
  });
  const r = run(`${local}:`);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readlinkSync(path.join(local, "overhaul")), path.join(binDir(home), "overhaul"));
  assert.doesNotMatch(r.stdout, /no está en tu PATH/);
  // Without ~/.local/bin in the PATH the warning is still there.
  assert.match(run("").stdout, /no está en tu PATH/);
});

test("release workflow: tag push, tests first, every platform's executable and what v0.1 needs", () => {
  const wf = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  const contract = JSON.parse(fs.readFileSync(path.join(root, "contract/contract.json"), "utf8"));
  assert.match(wf, /tags: \["v\*\.\*\.\*"\]/);
  assert.ok(wf.indexOf("run: npm test") < wf.indexOf("run: node scripts/build.mjs"));
  assert.ok(wf.indexOf("run: node scripts/build.mjs") < wf.indexOf("gh release create"));
  for (const p of contract.release.platforms) {
    assert.ok(wf.includes(`platform: ${p}`), p);
    assert.ok(wf.includes(`dist/overhaul-${p} dist/overhaul-${p}.sha256`), p);
  }
  for (const asset of ['"dist/overhaul-$GITHUB_REF_NAME.tar.gz"', '"dist/overhaul-$GITHUB_REF_NAME.tar.gz.sha256"', "install.sh"]) assert.ok(wf.includes(asset), asset);
  assert.match(wf, /OVERHAUL_BIN=.*node --test test\/contract\*\.test\.mjs/);
  const sh = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(sh, /REPO="\$\{OVERHAUL_REPO:-whitte-h\/overhaul\}"/);
  assert.ok(sh.includes(contract.release.install_url.replace("https://github.com/whitte-h/overhaul/releases", "")));
  assert.match(sh, /ASSET="overhaul-\$OS-\$ARCH"/);
});

test("install.sh private repo: GH_TOKEN goes through the API, assets by id, no token after the redirect", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ private: true });
  try {
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, [...quiet, "--bin-dir", binDir(home)], "bash", { GH_TOKEN: TOKEN });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Overhaul v0\.3\.0 desde la API de GitHub con token \(acme\/overhaul\)/);
    assert.equal(installedVersion(home), "0.3.0");
    const assets = server.requests.filter((q) => q.path.includes("/releases/assets/"));
    assert.equal(assets.length, 2);
    assert.ok(assets.every((q) => q.auth === `Bearer ${TOKEN}` && q.accept === "application/octet-stream"));
    const storage = server.requests.filter((q) => q.path.startsWith("/storage/"));
    assert.deepEqual(storage.map((q) => q.path).sort(), [`/storage/0.3.0/${ASSET}`, `/storage/0.3.0/${ASSET}.sha256`]);
    assert.ok(storage.every((q) => q.auth === null), "the token never reaches storage");

    for (const extra of [{}, { GH_TOKEN: "wrong" }]) {
      const h = tmp("overhaul-home-");
      const bad = await runPiped(server, h, [...quiet, "--bin-dir", binDir(h)], "bash", extra);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /no pude descargar Overhaul/);
      assert.deepEqual(fs.readdirSync(binDir(h)), []);
    }
  } finally { server.close(); }
});

test("install.sh private repo: a logged-in gh downloads with gh; one without access falls through to the token", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ private: true });
  try {
    fs.rmSync(ghLog, { force: true });
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, [...quiet, "--bin-dir", binDir(home)], "bash", { OVERHAUL_GH: ghBin });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Overhaul v0\.3\.0 desde gh \(acme\/overhaul\)/);
    assert.match(fs.readFileSync(ghLog, "utf8"), new RegExp(`gh release download v0\\.3\\.0 --repo acme/overhaul --pattern ${ASSET} `));
    assert.equal(server.requests.length, 0, "nothing over HTTP");
    assert.equal(installedVersion(home), "0.3.0");

    const h2 = tmp("overhaul-home-");
    const noAccess = await runPiped(server, h2, [...quiet, "--bin-dir", binDir(h2)], "bash", { OVERHAUL_GH: ghBin, FAKE_GH: "no-access", GH_TOKEN: TOKEN });
    assert.equal(noAccess.status, 0, noAccess.stderr + noAccess.stdout);
    assert.match(noAccess.stderr, /gh \(acme\/overhaul\): no encontré la última release/);
    assert.match(noAccess.stdout, /desde la API de GitHub con token/);
  } finally { server.close(); }
});

test("overhaul update (executable): --check, replace it in place with the latest, then already up to date", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer();
  try {
    const home = tmp("overhaul-home-");
    assert.equal((await runPiped(server, home, ["--version", "0.1.0", ...quiet, "--bin-dir", binDir(home)])).status, 0);
    const exe = path.join(binDir(home), "overhaul");
    const env = testEnv(server, home);
    // update() blocks on spawnSync, so it runs in a child: this process serves the releases.
    const lines = [];
    const upd = async (o) => {
      const code = `import { update } from ${JSON.stringify(path.join(root, "src/update.mjs"))};
        import fs from "node:fs";
        const o = JSON.parse(process.argv[1]);
        process.exitCode = update({ ...o, installScript: fs.readFileSync(o.installScript), platform: ${JSON.stringify(OS)}, log: (m) => console.log(m) });`;
      const r = await runAsync(NODE, ["--input-type=module", "-e", code, JSON.stringify({ exe, current: "0.1.0", installScript: path.join(root, "install.sh"), ...o })], env);
      lines.push(...r.stdout.trim().split("\n"));
      return r.status;
    };
    assert.equal(await upd({ check: true }), 0);
    assert.match(lines.pop(), /Hay una versión nueva: v0\.3\.0 \(instalada: v0\.1\.0\)/);
    assert.equal(installedVersion(home), "0.1.0");

    assert.equal(await upd({}), 0, lines.join("\n"));
    assert.match(lines.join("\n"), /Actualizando v0\.1\.0 → v0\.3\.0/);
    assert.equal(installedVersion(home), "0.3.0");
    assert.match(lines.pop(), /Listo: v0\.3\.0/);

    assert.equal(await upd({ current: "0.3.0" }), 0);
    assert.match(lines.pop(), /Ya tienes la última versión \(v0\.3\.0\)/);
    assert.equal(await upd({ current: "0.3.0", version: "0.2.0" }), 0);
    assert.equal(installedVersion(home), "0.2.0");

    // Homebrew's copy is brew's to update.
    const brewLines = [];
    assert.equal(update({ exe: "/opt/homebrew/Cellar/overhaul/0.1.0/bin/overhaul", current: "0.1.0", log: (m) => brewLines.push(m), run: () => assert.fail("nothing runs") }), 0);
    assert.match(brewLines.pop(), /brew upgrade overhaul/);
  } finally { server.close(); }
});

test("v0.1 → executable: v0.1's own `overhaul update` installs the binary, repoints links and hooks, removes app/", { skip: (!hasCurl && "sin curl") || (!hasV01 && "sin el commit de v0.1.0 (fetch-depth: 0)") }, async () => {
  const server = await startServer();
  try {
    const home = tmp("overhaul-home-");
    // v0.1.0 installed the v0.1 way (its own install.sh from its release), with a hook.
    const v01Script = spawnSync("git", ["-C", root, "show", `${V01}:install.sh`], { encoding: "utf8" }).stdout;
    // v0.1 links its CLI into ~/.local/bin; OVERHAUL_BIN_DIR is only for the update (v0.1 read it too).
    const first = await runAsync("bash", ["-s", "--", "--version", "0.1.0", ...quiet], testEnv(server, home), v01Script);
    const env = testEnv(server, home, { OVERHAUL_BIN_DIR: binDir(home) });
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const app = path.join(home, ".local/share/overhaul/app");
    assert.equal(fs.readlinkSync(path.join(app, "current")), "0.1.0");
    assert.equal(fs.readlinkSync(path.join(home, ".local/bin/overhaul")), path.join(app, "current/bin/hub.mjs"));
    const settings = path.join(home, ".claude/settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${NODE} ${app}/current/bin/hub-hook.mjs`, timeout: 5 }] }] } }));
    // A port nobody uses: migrate refuses while something answers on the hub's port (7420 may be a real hub).
    const cfgFile = path.join(home, ".config/overhaul/config.yaml");
    fs.writeFileSync(cfgFile, `${fs.readFileSync(cfgFile, "utf8").replace(/^port: \d+$/m, "port: 9")}# mine\n`);

    // v0.1's CLI updates itself: it downloads v0.3.0's tarball and runs its install.sh.
    const up = await runAsync(NODE, [path.join(home, ".local/bin/overhaul"), "update"], env);
    assert.equal(up.status, 0, up.stderr + up.stdout);
    assert.match(up.stdout, /Actualizando v0\.1\.0 → v0\.3\.0/);
    assert.equal(installedVersion(home), "0.3.0");
    const bin = path.join(binDir(home), "overhaul");
    // v0.1's links now lead to the executable; app/ is gone; config and data moved to ~/.overhaul.
    assert.equal(fs.readlinkSync(path.join(home, ".local/bin/overhaul")), bin);
    assert.equal(fs.readlinkSync(path.join(home, ".local/bin/hub")), bin);
    assert.ok(!fs.existsSync(app));
    assert.match(fs.readFileSync(path.join(home, ".overhaul/config.yaml"), "utf8"), /# mine\n$/);
    assert.equal(fs.readlinkSync(path.join(home, ".config/overhaul")), path.join(home, ".overhaul"));
    // The hook runs `overhaul hook Stop` (here the repo's CLI, which the stand-in runs).
    const cmd = JSON.parse(fs.readFileSync(settings, "utf8")).hooks.Stop[0].hooks[0].command;
    assert.match(cmd, / hook Stop$/);
    assert.doesNotMatch(cmd, /hub-hook\.mjs/);
    assert.match(calls(home), /^install-hooks --repoint-only$/m);
  } finally { server.close(); }
});
