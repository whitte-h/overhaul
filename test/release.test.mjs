// Release tarball (scripts/release.mjs) and install.sh in release mode, against a local HTTP server
// that mimics GitHub Releases (OVERHAUL_RELEASES_URL). Always with a temporary HOME, --no-services
// and no npm: never this machine's installation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRelease, releaseFiles, sha256File, tarballName } from "../scripts/release.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasCurl = spawnSync("curl", ["--version"]).status === 0;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Three releases built once, served as releases/download/vX.Y.Z/<file>; latest is the last one.
const VERSIONS = ["0.1.0", "0.2.0", "0.3.0"];
const dist = tmp("overhaul-dist-");
for (const version of VERSIONS) buildRelease({ out: dist, version });

// private: the public URLs answer 404 (as github.com does for a private repo) and only the API
// with TOKEN serves the assets. requests logs what reached the server (path and Authorization).
const TOKEN = "test-token-123";
const REPO = "acme/overhaul";
const releaseJson = (v) => ({
  url: `https://api.example/repos/${REPO}/releases/1`, assets_url: `https://api.example/repos/${REPO}/releases/1/assets`,
  tag_name: `v${v}`, name: `Overhaul v${v}`,
  author: { login: "someone", url: "https://api.example/users/someone" },
  assets: [tarballName(v), `${tarballName(v)}.sha256`, "install.sh"].map((name, i) => ({
    url: `https://api.example/repos/${REPO}/releases/assets/${VERSIONS.indexOf(v) * 10 + i + 1}`,
    id: VERSIONS.indexOf(v) * 10 + i + 1, node_id: "X", name, label: "",
    uploader: { login: "someone", id: 7, url: "https://api.example/users/someone", type: "User" },
    content_type: "application/octet-stream", size: 1,
    browser_download_url: `https://example/${REPO}/releases/download/v${v}/${name}`,
  })),
});
function assetById(id) {
  const v = VERSIONS[Math.floor((id - 1) / 10)];
  const name = v && [tarballName(v), `${tarballName(v)}.sha256`, "install.sh"][(id - 1) % 10];
  return name && (name === "install.sh" ? path.join(root, "install.sh") : path.join(dist, name));
}

function startServer({ latest = VERSIONS.at(-1), tamper = false, private: priv = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ path: url.pathname, auth: req.headers.authorization ?? null, accept: req.headers.accept });
    let m;
    if ((m = url.pathname.match(/^\/api\/repos\/([^/]+\/[^/]+)\/releases\/(.+)$/))) {
      if (m[1] !== REPO || req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(404).end('{"message":"Not Found"}');
      const [, , rest] = m;
      let a;
      if (rest === "latest") return res.writeHead(200).end(JSON.stringify(releaseJson(latest), null, 2));
      if ((a = rest.match(/^tags\/v(.+)$/)) && VERSIONS.includes(a[1])) return res.writeHead(200).end(JSON.stringify(releaseJson(a[1]), null, 2));
      if ((a = rest.match(/^assets\/(\d+)$/)) && assetById(Number(a[1])) && req.headers.accept === "application/octet-stream") {
        // Like GitHub: a redirect to storage on another host (localhost here), where no token must arrive.
        return res.writeHead(302, { location: `http://localhost:${server.address().port}/storage/${path.basename(assetById(Number(a[1])))}` }).end();
      }
      return res.writeHead(404).end('{"message":"Not Found"}');
    }
    if ((m = url.pathname.match(/^\/storage\/([^/]+)$/))) {
      const file = m[1] === "install.sh" ? path.join(root, "install.sh") : path.join(dist, m[1]);
      return fs.existsSync(file) ? res.writeHead(200).end(fs.readFileSync(file)) : res.writeHead(404).end();
    }
    if (priv) return res.writeHead(404).end();
    if (url.pathname === "/releases/latest") {
      res.writeHead(302, { location: `/releases/tag/v${latest}` }).end();
    } else if ((m = url.pathname.match(/^\/releases\/latest\/download\/(.+)$/))) {
      res.writeHead(302, { location: `/releases/download/v${latest}/${m[1]}` }).end();
    } else if (url.pathname.startsWith("/releases/tag/")) {
      res.writeHead(200).end("release page");
    } else if ((m = url.pathname.match(/^\/releases\/download\/v([^/]+)\/([^/]+)$/))) {
      const file = m[2] === "install.sh" ? path.join(root, "install.sh") : path.join(dist, m[2]);
      if (!VERSIONS.includes(m[1]) || !fs.existsSync(file)) return res.writeHead(404).end();
      let body = fs.readFileSync(file);
      if (tamper && file.endsWith(".tar.gz")) body = Buffer.concat([body, Buffer.from("x")]);
      res.writeHead(200).end(body);
    } else res.writeHead(404).end();
  });
  server.requests = requests;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// A fake npm: links this repo's node_modules (offline) and logs how it was called.
const fakeBin = tmp("overhaul-bin-");
const npmLog = path.join(fakeBin, "npm.log");
fs.writeFileSync(path.join(fakeBin, "npm"),
  `#!/bin/sh\necho "$PWD npm $*" >> '${npmLog}'\nln -sfn '${path.join(root, "node_modules")}' node_modules\n`, { mode: 0o755 });

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
    v=$3; shift 3; pattern=""; dir=.
    while [ $# -gt 0 ]; do case "$1" in --pattern) pattern=$2; shift ;; --dir) dir=$2; shift ;; esac; shift; done
    cp '${dist}'/"$pattern" "$dir/" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

// install.sh as `curl | <shell>` would run it: the script on stdin, no file next to it.
// No gh unless extra.OVERHAUL_GH says so (this machine's gh may have a session).
function testEnv(server, home, extra = {}) {
  const port = server.address().port;
  return {
    PATH: `${fakeBin}:${process.env.PATH}`, HOME: home, USER: process.env.USER ?? "u",
    OVERHAUL_RELEASES_URL: `http://127.0.0.1:${port}/releases`, OVERHAUL_API_URL: `http://127.0.0.1:${port}/api`,
    OVERHAUL_REPO: REPO, OVERHAUL_GH: path.join(fakeBin, "no-gh"), ...extra,
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
// The installed CLI (app/current/bin/hub.mjs), as `overhaul` would run it.
const runCli = (server, home, args, extra = {}) =>
  runAsync(process.execPath, [path.join(home, ".local/bin/overhaul"), ...args], testEnv(server, home, extra));
const quiet = ["--no-services", "--non-interactive"];

test("releaseFiles: runtime files only, no tests, board, node_modules or local layout", () => {
  const files = releaseFiles(["src/server.mjs", "test/a.test.mjs", "kanban/tasks/1.md", "helper/node_modules/x/y.js",
    "helper/orca-layout.json", "helper/install.sh", "install.sh", ".gitignore", "scripts/release.mjs", "package.json", "binary"]);
  assert.deepEqual(files, ["helper/install.sh", "install.sh", "package.json", "src/server.mjs"]);
});

test("release tarball: versioned top folder, RELEASE file, runtime files, matching sha256", () => {
  const tarball = path.join(dist, tarballName("0.1.0"));
  const list = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  assert.ok(list.every((f) => f.startsWith("overhaul-v0.1.0/")));
  const rel = list.map((f) => f.slice("overhaul-v0.1.0/".length));
  for (const f of ["RELEASE", "install.sh", "package.json", "package-lock.json", "src/server.mjs", "bin/hub.mjs", "public/index.html",
    "deploy/labels.sh", "deploy/standalone/overhaul.service", "helper/install.sh", "helper/package.json", "pi/overhaul.ts", "config.example.yaml"]) {
    assert.ok(rel.includes(f), f);
  }
  assert.ok(!rel.some((f) => /^(test|kanban|scripts|\.github)\//.test(f) || f.includes("node_modules")));
  assert.equal(fs.readFileSync(`${tarball}.sha256`, "utf8"), `${sha256File(tarball)}  ${tarballName("0.1.0")}\n`);
  const x = tmp("overhaul-x-");
  spawnSync("tar", ["-xzf", tarball, "-C", x]);
  assert.equal(fs.readFileSync(path.join(x, "overhaul-v0.1.0/RELEASE"), "utf8"), "0.1.0\n");
  assert.ok(fs.statSync(path.join(x, "overhaul-v0.1.0/install.sh")).mode & 0o100, "install.sh keeps +x");
});

test("release: version from package.json, tag must match it", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const out = tmp("overhaul-dist-");
  assert.equal(buildRelease({ out, tag: `v${version}` }).version, version);
  assert.ok(fs.existsSync(path.join(out, tarballName(version))));
  assert.throws(() => buildRelease({ out, tag: "v9.9.9" }), /does not match/);
  assert.throws(() => buildRelease({ out, version: "latest" }), /invalid version/);
});

test("install.sh release mode: --dry-run resolves the latest release and changes nothing", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer();
  try {
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Overhaul v0\.3\.0 desde http:\/\/127\.0\.0\.1:\d+\/releases\n/);
    assert.match(r.stdout, /\+ descargar .*overhaul-v0\.3\.0\.tar\.gz/);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { server.close(); }
});

test("install.sh release mode: curl | sh installs the latest, updates keep one previous, uninstall removes the app", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer();
  try {
    const home = tmp("overhaul-home-");
    const app = path.join(home, ".local/share/overhaul/app");
    const cli = path.join(home, ".local/bin/overhaul");

    // sh hands over to bash by fetching install.sh from releases/latest/download.
    const r = await runPiped(server, home, quiet, "sh");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /sha256 verificado/);
    assert.equal(fs.readlinkSync(path.join(app, "current")), "0.3.0");
    assert.equal(fs.readlinkSync(cli), path.join(app, "current/bin/hub.mjs"));
    assert.equal(fs.readlinkSync(path.join(home, ".local/bin/hub")), path.join(app, "current/bin/hub.mjs"));
    assert.ok(fs.existsSync(path.join(home, ".config/overhaul/config.yaml")));
    assert.match(fs.readFileSync(npmLog, "utf8"), new RegExp(`${app}/0\\.3\\.0 npm ci --omit=dev`));

    // Older versions with --version, then back to the latest: current flips, one previous stays.
    for (const [args, current, kept] of [
      [["--version", "0.1.0"], "0.1.0", ["0.1.0", "0.3.0"]],
      [["--version", "v0.2.0"], "0.2.0", ["0.1.0", "0.2.0"]],
      [[], "0.3.0", ["0.2.0", "0.3.0"]],
    ]) {
      const u = await runPiped(server, home, [...args, ...quiet]);
      assert.equal(u.status, 0, u.stderr + u.stdout);
      assert.equal(fs.readlinkSync(path.join(app, "current")), current);
      assert.deepEqual(fs.readdirSync(app).filter((d) => d !== "current").sort(), kept);
      assert.match(u.stdout, /ya existe, no la toco/);
    }

    const un = await runPiped(server, home, ["--uninstall"]);
    assert.equal(un.status, 0, un.stderr + un.stdout);
    assert.ok(!fs.existsSync(cli));
    assert.ok(!fs.existsSync(app));
    assert.ok(fs.existsSync(path.join(home, ".config/overhaul/config.yaml")));
  } finally { server.close(); }
});

test("install.sh release mode: a tarball that fails its sha256 installs nothing", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ tamper: true });
  try {
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, quiet);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sha256 .* no coincide/);
    assert.deepEqual(fs.readdirSync(path.join(home, ".local/share/overhaul/app")), []);
    assert.ok(!fs.existsSync(path.join(home, ".local/bin")));
  } finally { server.close(); }
});

test("install.sh release mode: unknown version fails cleanly; --version is refused from a clone", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer();
  try {
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, ["--version", "9.9.9", ...quiet]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no pude descargar/);
  } finally { server.close(); }
  const clone = spawnSync("bash", [path.join(root, "install.sh"), "--version", "0.1.0", "--dry-run"], {
    env: { PATH: process.env.PATH, HOME: tmp("overhaul-home-"), OVERHAUL_SKIP_NPM: "1" }, encoding: "utf8",
  });
  assert.notEqual(clone.status, 0);
  assert.match(clone.stderr, /solo para instalar desde una release/);
});

test("release workflow: tag push, tests first, uploads what install.sh downloads", () => {
  const wf = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(wf, /tags: \["v\*\.\*\.\*"\]/);
  assert.ok(wf.indexOf("npm test") < wf.indexOf("scripts/release.mjs --tag"));
  for (const asset of ['"dist/overhaul-$GITHUB_REF_NAME.tar.gz"', '"dist/overhaul-$GITHUB_REF_NAME.tar.gz.sha256"', "install.sh"]) assert.ok(wf.includes(asset), asset);
  const sh = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(sh, /REPO="\$\{OVERHAUL_REPO:-[^/]+\/overhaul\}"/);
  assert.match(sh, /RELEASES_URL="\$\{OVERHAUL_RELEASES_URL:-https:\/\/github\.com\/\$REPO\/releases\}"/);
  assert.match(sh, /name="overhaul-v\$v\.tar\.gz"/);
});

test("install.sh private repo: GH_TOKEN goes through the API, assets by id, no token after the redirect", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ private: true });
  try {
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, quiet, "bash", { GH_TOKEN: TOKEN });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Overhaul v0\.3\.0 desde la API de GitHub con token \(acme\/overhaul\)/);
    assert.match(r.stdout, /sha256 verificado/);
    assert.equal(fs.readlinkSync(path.join(home, ".local/share/overhaul/app/current")), "0.3.0");
    const assets = server.requests.filter((q) => q.path.includes("/releases/assets/"));
    assert.equal(assets.length, 2);
    assert.ok(assets.every((q) => q.auth === `Bearer ${TOKEN}` && q.accept === "application/octet-stream"));
    const storage = server.requests.filter((q) => q.path.startsWith("/storage/"));
    assert.deepEqual(storage.map((q) => q.path).sort(), ["/storage/overhaul-v0.3.0.tar.gz", "/storage/overhaul-v0.3.0.tar.gz.sha256"]);
    assert.ok(storage.every((q) => q.auth === null), "the token never reaches storage");

    const v1 = await runPiped(server, home, ["--version", "0.1.0", ...quiet], "bash", { GITHUB_TOKEN: TOKEN });
    assert.equal(v1.status, 0, v1.stderr + v1.stdout);
    assert.equal(fs.readlinkSync(path.join(home, ".local/share/overhaul/app/current")), "0.1.0");
  } finally { server.close(); }
});

test("install.sh private repo: without gh or a valid token it fails, installing nothing", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ private: true });
  try {
    for (const extra of [{}, { GH_TOKEN: "wrong" }]) {
      const home = tmp("overhaul-home-");
      const r = await runPiped(server, home, quiet, "bash", extra);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no pude descargar la release/);
      assert.ok(!fs.existsSync(path.join(home, ".local/share/overhaul/app/current")));
    }
  } finally { server.close(); }
});

test("install.sh private repo: a logged-in gh downloads with gh; one without access falls through to the token", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ private: true });
  try {
    fs.rmSync(ghLog, { force: true });
    const home = tmp("overhaul-home-");
    const r = await runPiped(server, home, quiet, "bash", { OVERHAUL_GH: ghBin });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Overhaul v0\.3\.0 desde gh \(acme\/overhaul\)/);
    const log = fs.readFileSync(ghLog, "utf8");
    assert.match(log, /gh release view --repo acme\/overhaul --json tagName/);
    assert.match(log, /gh release download v0\.3\.0 --repo acme\/overhaul --pattern overhaul-v0\.3\.0\.tar\.gz /);
    assert.equal(server.requests.length, 0, "nothing over HTTP");

    const noAccess = await runPiped(server, tmp("overhaul-home-"), quiet, "bash", { OVERHAUL_GH: ghBin, FAKE_GH: "no-access", GH_TOKEN: TOKEN });
    assert.equal(noAccess.status, 0, noAccess.stderr + noAccess.stdout);
    assert.match(noAccess.stderr, /gh \(acme\/overhaul\): no encontré la última release/);
    assert.match(noAccess.stdout, /desde la API de GitHub con token/);

    const loggedOut = await runPiped(server, tmp("overhaul-home-"), ["--dry-run"], "bash", { OVERHAUL_GH: ghBin, FAKE_GH: "logged-out", GH_TOKEN: TOKEN });
    assert.equal(loggedOut.status, 0, loggedOut.stderr);
    assert.match(loggedOut.stdout, /desde la API de GitHub con token/);
  } finally { server.close(); }
});

test("overhaul update from a release: --check, update to the latest keeping config, then already up to date", { skip: !hasCurl && "sin curl" }, async () => {
  const server = await startServer({ private: true });
  try {
    const home = tmp("overhaul-home-");
    const auth = { GH_TOKEN: TOKEN };
    const app = path.join(home, ".local/share/overhaul/app");
    assert.equal((await runPiped(server, home, ["--version", "0.1.0", ...quiet], "bash", auth)).status, 0);
    const cfgFile = path.join(home, ".config/overhaul/config.yaml");
    fs.appendFileSync(cfgFile, "# mine\n");

    const check = await runCli(server, home, ["update", "--check"], auth);
    assert.equal(check.status, 0, check.stderr + check.stdout);
    assert.match(check.stdout, /Hay una versión nueva: v0\.3\.0 \(instalada: v0\.1\.0\)/);
    assert.equal(fs.readlinkSync(path.join(app, "current")), "0.1.0");

    const up = await runCli(server, home, ["update"], auth);
    assert.equal(up.status, 0, up.stderr + up.stdout);
    assert.match(up.stdout, /Actualizando v0\.1\.0 → v0\.3\.0/);
    assert.match(up.stdout, /Listo: v0\.3\.0/);
    assert.equal(fs.readlinkSync(path.join(app, "current")), "0.3.0");
    assert.match(fs.readFileSync(cfgFile, "utf8"), /# mine\n$/);

    const again = await runCli(server, home, ["update"], auth);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /Ya tienes la última versión \(v0\.3\.0\)/);
    assert.match((await runCli(server, home, ["update", "--check"], auth)).stdout, /Al día: v0\.3\.0/);

    const back = await runCli(server, home, ["update", "--version", "0.2.0"], auth);
    assert.equal(back.status, 0, back.stderr + back.stdout);
    assert.equal(fs.readlinkSync(path.join(app, "current")), "0.2.0");

    const noAuth = await runCli(server, home, ["update", "--check"]);
    assert.notEqual(noAuth.status, 0);
    assert.match(noAuth.stdout, /no pude consultar la última release/);
  } finally { server.close(); }
});
