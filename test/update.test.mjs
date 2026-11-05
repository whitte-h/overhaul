// `overhaul update` on a clone (temporary git repos, fake npm and systemctl) and version compare.
// The release side runs end to end in release.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareVersions, installKind, update } from "../src/update.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// origin (bare) <- seed pushes; work is the installed clone.
function setup({ services = true } = {}) {
  const base = tmp("overhaul-update-");
  const origin = path.join(base, "origin.git");
  const seed = path.join(base, "seed");
  const work = path.join(base, "work");
  git(base, "init", "--bare", origin);
  git(base, "clone", origin, seed);
  fs.writeFileSync(path.join(seed, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(seed, "a.txt"), "1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "one");
  git(seed, "push", "origin", "HEAD:main");
  git(base, "clone", origin, work);

  const home = path.join(base, "home");
  if (services) {
    fs.mkdirSync(path.join(home, ".config/systemd/user"), { recursive: true });
    for (const u of ["overhaul", "overhaul-bridge"]) fs.writeFileSync(path.join(home, ".config/systemd/user", `${u}.service`), "");
  }
  const calls = [];
  // npm and systemctl are recorded, never run; git runs for real on the temporary repos.
  const run = (cmd, args, opts = {}) => {
    if (cmd === "git") return spawnSync(cmd, args, { encoding: "utf8", ...opts });
    calls.push(`${cmd} ${args.join(" ")}${opts.cwd ? ` (${opts.cwd})` : ""}`);
    return { status: 0 };
  };
  const lines = [];
  const opts = { root: work, env: { HOME: home }, platform: "linux", log: (m) => lines.push(m), run };
  const push = (file, text) => {
    fs.writeFileSync(path.join(seed, file), text);
    git(seed, "commit", "-am", `change ${file}`);
    git(seed, "push", "origin", "HEAD:main");
  };
  return { work, calls, lines, opts, push };
}

test("compareVersions: numeric parts, v prefix, pre-releases first", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
});

test("installKind: release folder with RELEASE, git clone, anything else", () => {
  const app = path.join(tmp("overhaul-kind-"), "app", "0.4.0");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "RELEASE"), "0.4.0\n");
  assert.deepEqual(installKind(app), { kind: "release", version: "0.4.0" });
  const { work } = setup();
  assert.deepEqual(installKind(work), { kind: "clone" });
  assert.deepEqual(installKind(tmp("overhaul-kind-")), { kind: "unknown" });
});

test("update on a clone: --check counts new commits, update pulls, runs npm ci when the lockfile changed, restarts", () => {
  const s = setup();
  assert.equal(update({ ...s.opts, check: true }), 0);
  assert.match(s.lines.pop(), /Al día con origin\/main/);

  s.push("a.txt", "2\n");
  s.push("package-lock.json", '{"x":1}\n');
  assert.equal(update({ ...s.opts, check: true }), 0);
  assert.match(s.lines.pop(), /Hay 2 commits nuevos en origin\/main/);
  assert.equal(s.calls.length, 0);

  assert.equal(update(s.opts), 0);
  assert.equal(fs.readFileSync(path.join(s.work, "a.txt"), "utf8"), "2\n");
  assert.deepEqual(s.calls, [
    `npm ci --omit=dev --no-audit --no-fund (${s.work})`,
    "systemctl --user restart overhaul.service overhaul-bridge.service",
  ]);
  assert.match(s.lines.join("\n"), /Hub y puente reiniciados/);

  s.calls.length = 0;
  assert.equal(update(s.opts), 0);
  assert.match(s.lines.pop(), /nada que reiniciar/);
  assert.deepEqual(s.calls, []);
});

test("update on a clone: warns about local changes; a conflicting pull fails without restarting", () => {
  const s = setup();
  fs.writeFileSync(path.join(s.work, "package-lock.json"), '{"local":true}\n');
  s.push("a.txt", "2\n");
  assert.equal(update(s.opts), 0);
  assert.match(s.lines.join("\n"), /Aviso: hay cambios locales en .*\n  M package-lock\.json/);
  assert.deepEqual(s.calls, ["systemctl --user restart overhaul.service overhaul-bridge.service"]);

  s.calls.length = 0;
  s.lines.length = 0;
  s.push("package-lock.json", '{"x":2}\n');
  assert.equal(update(s.opts), 1);
  assert.match(s.lines.join("\n"), /git pull --ff-only falló \(¿por los cambios locales\?\)/);
  assert.deepEqual(s.calls, []);
});

test("update on a clone: without services says to restart by hand; --version is refused", () => {
  const s = setup({ services: false });
  s.push("a.txt", "2\n");
  assert.equal(update(s.opts), 0);
  assert.match(s.lines.join("\n"), /no están instalados .*reinicia a mano/);
  assert.deepEqual(s.calls, []);
  assert.equal(update({ ...s.opts, version: "1.0.0" }), 2);
  assert.match(s.lines.pop(), /checkout v1\.0\.0/);
});

test("update on macOS restarts the LaunchAgents with kickstart", () => {
  const s = setup({ services: false });
  const agents = path.join(s.opts.env.HOME, "Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "overhaul.hub.plist"), "");
  s.push("a.txt", "2\n");
  assert.equal(update({ ...s.opts, platform: "darwin" }), 0);
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[0], /^launchctl kickstart -k gui\/\d+\/overhaul\.hub$/);
  assert.match(s.calls[1], /^launchctl kickstart -k gui\/\d+\/overhaul\.bridge$/);
});
