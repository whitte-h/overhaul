// Contract tests for the installation layout (docs/contract.md, "~/.overhaul", "Migración"):
// init, paths, OVERHAUL_HOME and migrate from every earlier layout. Black box (OVERHAUL_BIN),
// always on a temporary HOME.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTRACT, cleanEnv, freePort, overhaul, tmp } from "./contract-lib.mjs";

const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
};
const read = (file) => fs.readFileSync(file, "utf8");
const paths = (env) => {
  const r = overhaul(["paths", "--json"], { env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
// A real SQLite file with one row, as the hub leaves it.
function makeDb(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("node_id", value);
  db.close();
}
const dbValue = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").get("node_id").value;
  } finally {
    db.close();
  }
};
// Every file under dir (relative path -> contents), links listed as "-> target".
function tree(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, f);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) out[f] = `-> ${fs.readlinkSync(p)}`;
    else if (st.isFile()) out[f] = f.endsWith(".db") ? "<db>" : read(p);
  }
  return out;
}

test("init: a fresh machine gets ~/.overhaul with config.yaml and env (0600), and init is idempotent", async () => {
  const home = tmp("overhaul-init-");
  const env = cleanEnv(home);
  const r = overhaul(["init"], { env });
  assert.equal(r.status, 0, r.stderr);
  const oh = path.join(home, ".overhaul");
  assert.equal(fs.statSync(oh).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(oh, "env")).mode & 0o777, 0o600);
  assert.match(read(path.join(oh, "env")), /^HUB_AGENT_TOKEN=[0-9a-f]{64}$/m);
  const cfg = read(path.join(oh, "config.yaml"));
  assert.match(cfg, /^version: 2$/m);
  assert.doesNotMatch(cfg, /^data_dir:/m);
  const before = tree(oh);
  assert.equal(overhaul(["init"], { env }).status, 0);
  assert.deepEqual(tree(oh), before);

  const p = paths(env);
  assert.deepEqual(Object.keys(p).sort(), [...CONTRACT.paths_json_keys].sort());
  assert.equal(p.home, oh);
  assert.equal(p.mode, "home");
  assert.equal(p.config, path.join(oh, CONTRACT.layout.files.config));
  assert.equal(p.env, path.join(oh, CONTRACT.layout.files.env));
  assert.equal(p.db, path.join(oh, CONTRACT.layout.files.db));
  assert.equal(p.logs, path.join(oh, CONTRACT.layout.dirs.logs));
  assert.equal(p.bin, path.join(oh, CONTRACT.layout.dirs.bin));
});

test("OVERHAUL_HOME moves the whole installation", () => {
  const home = tmp("overhaul-init-");
  const elsewhere = path.join(home, "apps/oh");
  const env = cleanEnv(home, { OVERHAUL_HOME: elsewhere });
  assert.equal(overhaul(["init"], { env }).status, 0);
  assert.ok(fs.existsSync(path.join(elsewhere, "config.yaml")));
  assert.ok(!fs.existsSync(path.join(home, ".overhaul")));
  const p = paths(env);
  assert.equal(p.home, elsewhere);
  assert.equal(p.db, path.join(elsewhere, "overhaul.db"));
});

// The layout v0.1 left on this kind of machine: config and data apart, work-hub links to them,
// data_dir written out in config.yaml.
function v01Home({ port = 1 } = {}) {
  const home = tmp("overhaul-v01-");
  const cfg = path.join(home, ".config/overhaul");
  const data = path.join(home, ".local/share/overhaul");
  write(path.join(cfg, "config.yaml"), `# mine, keep me\nversion: 2\nport: ${port}\ndata_dir: ~/.local/share/overhaul # old place\nprojects: {}\n`, 0o600);
  write(path.join(cfg, "env"), "HUB_TOKEN=a-long-ui-password\nHUB_AGENT_TOKEN=an-agent-token-of-24-chars-or-more\n", 0o600);
  write(path.join(cfg, "panes/personal%3Aorq.json"), '{"sessionId":"s"}');
  write(path.join(cfg, "uploads/term/1/a.txt"), "from config");
  write(path.join(cfg, "ssh-config"), "Host x\n");
  makeDb(path.join(data, "overhaul.db"), "node-1");
  write(path.join(data, "session.key"), "k");
  write(path.join(data, "backups/tickets-json-1/alpha/A-1.json"), "{}");
  write(path.join(data, "activity/w.json"), "[]");
  write(path.join(data, "uploads/term/1/a.txt"), "from data");
  fs.symlinkSync(cfg, path.join(home, ".config/work-hub"));
  fs.symlinkSync(data, path.join(home, ".local/share/work-hub"));
  return { home, cfg, data };
}

test("migrate: v0.1 (~/.config/overhaul + ~/.local/share/overhaul, work-hub links) moves into ~/.overhaul, nothing lost", () => {
  const { home, cfg, data } = v01Home();
  const env = cleanEnv(home);
  const oh = path.join(home, ".overhaul");
  // Before: used where it is.
  const before = paths(env);
  assert.equal(before.mode, "legacy");
  assert.equal(before.env, path.join(cfg, "env"));
  assert.equal(before.db, path.join(data, "overhaul.db"));
  const cfgTree = tree(cfg);
  const dataTree = tree(data);

  const dry = overhaul(["migrate", "--dry-run"], { env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /mover .*\.config\/overhaul/);
  assert.match(dry.stdout, /quitar data_dir/);
  assert.ok(!fs.existsSync(oh));
  assert.deepEqual(tree(cfg), cfgTree);

  const r = overhaul(["migrate"], { env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // Everything is in ~/.overhaul; the old paths are links to it.
  assert.equal(fs.readlinkSync(cfg), oh);
  assert.equal(fs.readlinkSync(data), oh);
  assert.equal(read(path.join(home, ".config/work-hub/env")), read(path.join(oh, "env")));
  assert.equal(dbValue(path.join(oh, "overhaul.db")), "node-1");
  for (const f of ["panes/personal%3Aorq.json", "ssh-config", "session.key", "backups/tickets-json-1/alpha/A-1.json", "activity/w.json"]) assert.ok(fs.existsSync(path.join(oh, f)), f);
  // Same file on both sides: the config one stays, the data one is kept aside.
  assert.equal(read(path.join(oh, "uploads/term/1/a.txt")), "from config");
  assert.match(r.stdout, /uploads\/term\/1\/a\.txt: ya existía/);
  // data_dir is gone (it pointed at the old place); comments survive; a backup of the file.
  const yaml = read(path.join(oh, "config.yaml"));
  assert.doesNotMatch(yaml, /data_dir/);
  assert.match(yaml, /# mine, keep me/);
  assert.ok(fs.readdirSync(oh).some((f) => f.startsWith("config.yaml.bak-migrate-")));
  assert.equal(fs.statSync(path.join(oh, "env")).mode & 0o777, 0o600);
  // The backup holds both folders as they were.
  const [backup] = fs.readdirSync(path.join(oh, "backups")).filter((f) => f.startsWith("migrate-"));
  const b = path.join(oh, "backups", backup);
  assert.deepEqual(tree(path.join(b, "config")), cfgTree);
  assert.deepEqual(tree(path.join(b, "data")), dataTree);

  const after = paths(env);
  assert.equal(after.mode, "home");
  assert.equal(after.db, path.join(oh, "overhaul.db"));
  assert.match(overhaul(["migrate"], { env }).stdout, /Nada que migrar/);
});

test("migrate: work-hub only (real folders, never renamed) moves into ~/.overhaul", () => {
  const home = tmp("overhaul-wh-");
  const cfg = path.join(home, ".config/work-hub");
  const data = path.join(home, ".local/share/work-hub");
  write(path.join(cfg, "config.yaml"), "port: 1\nprojects: {}\n");
  write(path.join(cfg, "env"), "HUB_AGENT_TOKEN=x\n", 0o600);
  makeDb(path.join(data, "overhaul.db"), "wh");
  const env = cleanEnv(home);
  assert.equal(paths(env).env, path.join(cfg, "env"));
  const r = overhaul(["migrate"], { env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const oh = path.join(home, ".overhaul");
  assert.equal(dbValue(path.join(oh, "overhaul.db")), "wh");
  assert.equal(read(path.join(oh, "config.yaml")), "port: 1\nprojects: {}\n"); // no data_dir to drop: untouched
  assert.equal(fs.readlinkSync(cfg), oh);
  assert.equal(fs.readlinkSync(data), oh);
  assert.ok(!fs.existsSync(path.join(home, ".config/overhaul")));
});

test("migrate: a ~/.overhaul put together by hand is normalized, with a backup", () => {
  const home = tmp("overhaul-hand-");
  const oh = path.join(home, ".overhaul");
  write(path.join(oh, "config/config.yaml"), "version: 2\nport: 1\ndata_dir: ~/.overhaul/data\nprojects: {}\n");
  write(path.join(oh, "secrets/env"), "HUB_AGENT_TOKEN=x\n");
  makeDb(path.join(oh, "data/overhaul.db"), "hand");
  write(path.join(oh, "data/uploads/u.txt"), "u");
  write(path.join(oh, "notes.txt"), "mine");
  const env = cleanEnv(home);
  const r = overhaul(["migrate"], { env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ["config.yaml", "env", "overhaul.db", "uploads/u.txt", "notes.txt"]) assert.ok(fs.existsSync(path.join(oh, f)), f);
  for (const d of ["config", "secrets", "data"]) assert.ok(!fs.existsSync(path.join(oh, d)), d);
  assert.doesNotMatch(read(path.join(oh, "config.yaml")), /data_dir/);
  assert.equal(dbValue(path.join(oh, "overhaul.db")), "hand");
  const [backup] = fs.readdirSync(path.join(oh, "backups"));
  assert.ok(fs.existsSync(path.join(oh, "backups", backup, "home/data/overhaul.db")));
  const p = paths(env);
  assert.equal(p.mode, "home");
  assert.equal(p.db, path.join(oh, "overhaul.db"));
});

test("migrate refuses to guess: two config.yaml inside ~/.overhaul, or two installations", () => {
  const home = tmp("overhaul-amb-");
  const oh = path.join(home, ".overhaul");
  write(path.join(oh, "a/config.yaml"), "port: 1\n");
  write(path.join(oh, "b/config.yaml"), "port: 1\n");
  const before = tree(oh);
  const r = overhaul(["migrate"], { env: cleanEnv(home) });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /No sé cuál usar: config\.yaml/);
  assert.deepEqual(tree(oh), before);

  const { home: h2 } = v01Home();
  write(path.join(h2, ".overhaul/config.yaml"), "port: 1\n");
  const r2 = overhaul(["migrate"], { env: cleanEnv(h2) });
  assert.equal(r2.status, 1);
  assert.match(r2.stdout + r2.stderr, /Hay dos instalaciones/);
  assert.ok(fs.lstatSync(path.join(h2, ".config/overhaul")).isDirectory());
});

test("migrate: data_dir pointing elsewhere is respected and not moved", () => {
  const { home, cfg } = v01Home();
  const custom = path.join(home, "srv/data");
  makeDb(path.join(custom, "overhaul.db"), "custom");
  fs.writeFileSync(path.join(cfg, "config.yaml"), `version: 2\nport: 1\ndata_dir: ${custom}\nprojects: {}\n`);
  const env = cleanEnv(home);
  const r = overhaul(["migrate"], { env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /data_dir .* es propio/);
  assert.match(read(path.join(home, ".overhaul/config.yaml")), /data_dir/);
  assert.equal(paths(env).db, path.join(custom, "overhaul.db"));
  assert.ok(fs.lstatSync(path.join(home, ".local/share/overhaul")).isDirectory()); // unused, left alone
});

test("migrate does not run while the hub answers on its port", async () => {
  const port = await freePort();
  const { home, cfg } = v01Home({ port });
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  try {
    const { spawn } = await import("node:child_process");
    const { BIN } = await import("./contract-lib.mjs");
    const child = spawn(BIN[0], [...BIN.slice(1), "migrate"], { env: cleanEnv(home), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 2);
    assert.match(out, /El hub está corriendo/);
    assert.ok(fs.lstatSync(cfg).isDirectory());
  } finally {
    server.close();
  }
});
