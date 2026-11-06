import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Records go under HUB_CONFIG_DIR, read when env.mjs loads.
process.env.HUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hub-orca-"));
const orca = await import("../src/orca.mjs");
const { normalize } = await import("../src/config.mjs");

// A fake `orca` CLI: answers each call from a handler and keeps the argument lists.
function fakeOrca(handler) {
  const calls = [];
  const exec = async (_bin, args) => {
    calls.push(args);
    const result = handler(args);
    if (result instanceof Error) throw Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ ok: false, error: { code: result.message, message: result.message } }) });
    return { stdout: JSON.stringify({ ok: true, result }) };
  };
  return { exec, calls };
}

test("terminals defaults to tmux; orca takes orca.worktree or worker.dir", () => {
  const cfg = normalize({
    projects: {
      a: {},
      b: { terminals: "orca", worker: { dir: "~/code/b", command: "pi" } },
      c: { terminals: "orca", orca: { worktree: "/w/c" } },
    },
  });
  const [a, b, c] = cfg.projects;
  assert.deepEqual(a.terminals, { type: "tmux" });
  assert.equal(b.terminals.worktree, "~/code/b");
  assert.equal(c.terminals.worktree, "/w/c");
  assert.deepEqual(b.terminals.orchestrator, { title: "orq", command: "pi", dir: "~/code/b" });
  assert.throws(() => normalize({ projects: { d: { terminals: "orca" } } }), /orca.worktree/);
  assert.throws(() => normalize({ projects: { e: { terminals: "screen" } } }), /tmux or orca/);
});

test("agentCommand quotes variables and resumes by agent", () => {
  const env = { HUB_PROJECT: "gamma", HUB_TICKET: "K-257", NOTE: "it's" };
  assert.equal(
    orca.agentCommand({ command: "pi", sessionId: "s-1", dir: "/w/r o", env }),
    `cd '/w/r o' && HUB_PROJECT='gamma' HUB_TICKET='K-257' NOTE='it'\\''s' pi --session-id s-1`,
  );
  assert.match(orca.agentCommand({ command: "pi", sessionId: "s-1", dir: "/w", env: {}, resume: true }), /pi --session-id s-1$/);
  assert.match(orca.agentCommand({ command: "claude", sessionId: "s-1", dir: "/w", env: {} }), /claude --session-id s-1$/);
  assert.match(orca.agentCommand({ command: "claude", sessionId: "s-1", dir: "/w", env: {}, resume: true }), /claude --resume s-1$/);
});

test("keyBytes maps tmux key names", () => {
  assert.equal(orca.keyBytes("Enter"), "\r");
  assert.equal(orca.keyBytes("Escape"), "\x1b");
  assert.equal(orca.keyBytes("C-c"), "\x03");
  assert.equal(orca.keyBytes("Up"), "\x1b[A");
  assert.equal(orca.keyBytes("1"), "1");
});

test("mergeState: Orca's agent state decides, the screen keeps dialogs and lines", () => {
  const idle = { state: "idle", line: "" };
  const asking = { state: "needs_input", line: "Esperando tu permiso" };
  const busy = { state: "working", line: "⠧ Working" };
  assert.deepEqual(orca.mergeState(idle, undefined), idle);
  assert.deepEqual(orca.mergeState(idle, { state: "working", tool: "bash" }), { state: "working", line: "Working · bash" });
  assert.deepEqual(orca.mergeState(busy, { state: "working" }), busy);
  assert.deepEqual(orca.mergeState(busy, { state: "done" }), { state: "idle", line: "" });
  assert.deepEqual(orca.mergeState(asking, { state: "done" }), asking);
  assert.equal(orca.mergeState(idle, { state: "blocked" }).state, "needs_input");
});

test("listTerminals files titled terminals under the project's session", async () => {
  const { exec, calls } = fakeOrca(() => ({
    terminals: [
      { handle: "term_1", title: "k-257", tabId: "t", leafId: "l", agentIdentity: "pi", writable: true, worktreePath: "/w/r" },
      { handle: "term_2", title: "", tabId: "t", leafId: "m", writable: true },
      { handle: "term_3", title: "k-1", tabId: "t", leafId: "n", writable: true, orphaned: true },
    ],
  }));
  const wins = await orca.listTerminals([{ id: "gamma", session: "personal", terminals: { type: "orca", worktree: "/w/r" } }], { exec });
  assert.deepEqual(calls[0], ["terminal", "list", "--worktree", "path:/w/r", "--json"]);
  assert.deepEqual(wins, [{
    backend: "orca", session: "personal", name: "k-257", pane: "term_1", command: "pi", worktree: "/w/r", paneKey: "t:l", project: "gamma",
  }]);
});

test("agentStates reads worktree ps by pane key", async () => {
  const { exec } = fakeOrca(() => ({ worktrees: [{ agents: [{ paneKey: "t:l", state: "working", toolName: "bash", lastAssistantMessage: null }] }] }));
  const states = await orca.agentStates({ exec });
  assert.deepEqual(states.get("t:l"), { state: "working", tool: "bash", last: null });
});

test("sendText: prompts with --enter, raw text, bracketed paste", async () => {
  const { exec, calls } = fakeOrca(() => ({ send: { accepted: true } }));
  await orca.sendText("term_1", "a\nb", { exec });
  await orca.sendText("term_1", "x", { enter: false, exec });
  await orca.sendText("term_1", "y", { enter: false, paste: true, exec });
  assert.deepEqual(calls, [
    ["terminal", "send", "--terminal", "term_1", "--text", "a\nb", "--enter", "--json"],
    ["terminal", "send", "--terminal", "term_1", "--text", "x", "--json"],
    ["terminal", "send", "--terminal", "term_1", "--text", "\x1b[200~y\x1b[201~", "--json"],
  ]);
});

test("orca errors carry Orca's message", async () => {
  const { exec } = fakeOrca(() => new Error("terminal_handle_stale"));
  await assert.rejects(orca.readScreen("term_x", { exec }), /terminal_handle_stale/);
});

test("restartTerminal closes the old terminal and resumes the same session", async () => {
  const sessionId = "0f0e8c1a-6c4e-4a57-9a4f-3c9f1f0d2b11";
  orca.saveRecord({ worktree: "/w/r", title: "k-257", command: "pi", sessionId, dir: "/w/r", env: { HUB_TICKET: "K-257" } });
  const { exec, calls } = fakeOrca((args) => (args[1] === "create" ? { terminal: { handle: "term_new" } } : {}));
  const rec = await orca.restartTerminal({ handle: "term_old", worktree: "/w/r", title: "k-257" }, { exec });
  assert.equal(rec.handle, "term_new");
  assert.deepEqual(calls[0], ["terminal", "close", "--terminal", "term_old", "--json"]);
  assert.deepEqual(calls[1], [
    "terminal", "create", "--worktree", "path:/w/r", "--title", "k-257",
    "--command", `cd '/w/r' && HUB_TICKET='K-257' pi --session-id ${sessionId}`, "--json",
  ]);
  await assert.rejects(orca.restartTerminal({ handle: "t", worktree: "/w/r", title: "nope" }, { exec }), /no la abrió el hub/);
});

// --- Layout in the local Orca (OVH-15) ----------------------------------------------------------------
const net = await import("node:net");
const { execFileSync } = await import("node:child_process");
const tmpDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const gitDir = (d) => { fs.mkdirSync(d, { recursive: true }); execFileSync("git", ["init", "-q", d]); return d; };

test("orcaBin: ORCA_BIN, then the PATH, then Orca.app", () => {
  const has = (set) => (f) => set.includes(f);
  assert.equal(orca.orcaBin({ ORCA_BIN: "/x/orca", PATH: "/usr/bin" }, has(["/x/orca"])), "/x/orca");
  assert.equal(orca.orcaBin({ ORCA_BIN: "/x/orca" }, has([])), null);
  assert.equal(orca.orcaBin({ PATH: "/a:/b" }, has(["/b/orca", orca.MAC_ORCA])), "/b/orca");
  assert.equal(orca.orcaBin({ PATH: "/a" }, has([orca.MAC_ORCA])), orca.MAC_ORCA);
  assert.equal(orca.orcaBin({ PATH: "/a" }, has([])), null);
});

test("runtimeFile and readRuntime: socket and token from orca-runtime.json", () => {
  assert.equal(orca.runtimeFile({}, "/h", "linux"), "/h/.config/orca/orca-runtime.json");
  assert.equal(orca.runtimeFile({}, "/h", "darwin"), "/h/Library/Application Support/orca/orca-runtime.json");
  assert.equal(orca.runtimeFile({ ORCA_USER_DATA_PATH: "/d" }, "/h", "linux"), "/d/orca-runtime.json");
  const dir = tmpDir("orca-rt-");
  const f = path.join(dir, "orca-runtime.json");
  fs.writeFileSync(f, JSON.stringify({ runtimeId: "r1", authToken: "tok", transports: [{ kind: "websocket", endpoint: "ws://x" }, { kind: "unix", endpoint: "/s.sock" }] }));
  assert.deepEqual(orca.readRuntime(f), { runtimeId: "r1", endpoint: "/s.sock", authToken: "tok" });
  assert.throws(() => orca.readRuntime(path.join(dir, "none.json")), /Orca no está corriendo/);
});

test("rpc: one JSON line with the token in, the result (or Orca's error) out", async () => {
  const dir = tmpDir("orca-sock-");
  const endpoint = path.join(dir, "o.sock");
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.trim());
      seen.push(req);
      const res = req.method === "bad" ? { id: req.id, ok: false, error: { code: "nope", message: "no such method" } } : { id: req.id, ok: true, result: { groups: [] } };
      sock.write(`${JSON.stringify(res)}\n`);
    });
  });
  await new Promise((r) => server.listen(endpoint, r));
  try {
    const runtime = { endpoint, authToken: "tok" };
    assert.deepEqual(await orca.rpc("projectGroup.list", {}, { runtime }), { groups: [] });
    assert.equal(seen[0].authToken, "tok");
    assert.equal(seen[0].method, "projectGroup.list");
    assert.deepEqual(seen[0].params, {});
    await assert.rejects(orca.rpc("bad", { a: 1 }, { runtime }), /orca bad: no such method/);
    await assert.rejects(orca.rpc("x", {}, { runtime: { endpoint: path.join(dir, "missing.sock"), authToken: "t" } }), /orca x:/);
  } finally { server.close(); }
});

test("normalize: an Orca project carries its repos, common folder and orchestrator", () => {
  const cfg = normalize({
    version: 2,
    projects: {
      nexus: { name: "Nexus", repos: ["/c/nexus/api", "/c/nexus/web"], repos_root: "/c/nexus", runtime: { dir: "/c/nexus", terminal: "orca", command: "pi", orchestrator: "nexus:jefe" } },
      solo: { repo: "/c/solo", runtime: { dir: "/c/solo", terminal: "orca" } },
    },
  });
  const [nexus, solo] = cfg.projects;
  assert.deepEqual(nexus.terminals, {
    type: "orca", worktree: "/c/nexus", name: "Nexus", repos: ["/c/nexus/api", "/c/nexus/web"], parent: "/c/nexus",
    orchestrator: { title: "jefe", command: "pi", dir: "/c/nexus" },
  });
  assert.equal(orca.orcaPlan({ ...nexus, session: undefined }).grouped, true);
  assert.equal(orca.orcaPlan(nexus).session, "nexus");
  assert.equal(orca.orcaPlan(solo).grouped, false);
  assert.equal(orca.orcaPlan(solo).orchestrator.title, "orq");
});

// A fake Orca for the layout: its CLI (exec) and its runtime RPC (call) over one shared state.
function fakeOrcaHost() {
  const st = { repos: [], groups: [], folders: [], terminals: [], tabs: [], rpc: [], cli: [] };
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const call = async (method, params = {}) => {
    st.rpc.push([method, params]);
    if (method === "projectGroup.list") return { groups: st.groups };
    if (method === "projectGroup.importNested") {
      const g = { id: id("g"), name: params.groupName, parentPath: params.parentPath };
      st.groups.push(g);
      for (const p of params.projectPaths) st.repos.push({ id: id("r"), path: p, projectGroupId: g.id });
      return {};
    }
    if (method === "projectGroup.moveProject") {
      st.repos.find((r) => `id:${r.id}` === params.repo).projectGroupId = params.groupId;
      return {};
    }
    if (method === "folderWorkspace.list") return { folderWorkspaces: st.folders };
    if (method === "folderWorkspace.create") {
      st.folders.push({ id: id("f"), projectGroupId: params.projectGroupId, name: params.name, folderPath: params.folderPath });
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  const handler = (args) => {
    st.cli.push(args);
    const opt = (k) => args[args.indexOf(k) + 1];
    const [a, b] = args;
    if (a === "status") return { runtime: { reachable: true, runtimeId: "rt-1" } };
    if (a === "repo" && b === "list") return { repos: st.repos };
    if (a === "repo" && b === "add") { st.repos.push({ id: id("r"), path: opt("--path"), projectGroupId: null }); return {}; }
    if (a === "tab" && b === "list") return { tabs: st.tabs.filter((t) => t.worktree === opt("--worktree")) };
    if (a === "tab" && b === "create") { st.tabs.push({ worktree: opt("--worktree"), url: opt("--url") }); return {}; }
    if (a === "terminal" && b === "list") return { terminals: st.terminals.filter((t) => t.sel === opt("--worktree")) };
    if (a === "terminal" && b === "create") {
      const t = { handle: id("term_"), title: opt("--title"), sel: opt("--worktree"), command: opt("--command"), writable: true, tabId: "t", leafId: String(n) };
      st.terminals.push(t);
      return { terminal: { handle: t.handle } };
    }
    if (a === "terminal" && b === "switch") return { focus: { handle: opt("--terminal"), navigated: true } };
    return {};
  };
  return { st, call, ...fakeOrca(handler) };
}
const noTmux = async () => { throw new Error("no server"); };

function nexusProject(root, id = "nexus") {
  const api = gitDir(path.join(root, "api"));
  const web = gitDir(path.join(root, "web"));
  const cfg = normalize({ version: 2, public_url: "http://127.0.0.1:7420", projects: {
    [id]: { name: "Nexus", repos: [api, web], repos_root: root, runtime: { dir: root, terminal: "orca", command: "claude", orchestrator: `${id}:orq` } },
  } });
  return { p: cfg.projects[0], api, web };
}

test("ensureOrg, several repos: a group with its repos, folder workspace, hub tab and orq; again, nothing new", async () => {
  const root = tmpDir("orca-nexus-");
  const { p, api, web } = nexusProject(root);
  const o = fakeOrcaHost();
  const log = [];
  const org = await orca.ensureOrg(p, { hubUrl: "http://127.0.0.1:7420", exec: o.exec, call: o.call, runTmux: noTmux, log: (m) => log.push(m) });
  assert.deepEqual(o.st.rpc.find(([m]) => m === "projectGroup.importNested")[1], { mode: "group", parentPath: root, groupName: "Nexus", projectPaths: [api, web] });
  assert.deepEqual(o.st.rpc.find(([m]) => m === "folderWorkspace.create")[1], { projectGroupId: o.st.groups[0].id, name: "Nexus", folderPath: root });
  const folder = `id:folder:${o.st.folders[0].id}`;
  assert.equal(org.worktree, folder);
  assert.deepEqual(o.st.tabs, [{ worktree: folder, url: "http://127.0.0.1:7420/p/nexus" }]);
  const orq = o.st.terminals.find((t) => t.title === "orq");
  assert.equal(orq.sel, folder);
  assert.equal(org.orchestrator, orq.handle);
  assert.match(orq.command, new RegExp(`^cd '${root}' && HUB_PROJECT='nexus' HUB_AGENT_NAME='orq' HUB_WINDOW='nexus:orq' .*claude --session-id [0-9a-f-]{36}$`));
  assert.ok(log.includes("grupo Nexus: creado"));

  const before = { terminals: o.st.terminals.length, tabs: o.st.tabs.length, groups: o.st.groups.length, folders: o.st.folders.length, repos: o.st.repos.length };
  const again = await orca.ensureOrg(p, { hubUrl: "http://127.0.0.1:7420", exec: o.exec, call: o.call, runTmux: noTmux });
  assert.equal(again.orchestrator, orq.handle);
  assert.deepEqual({ terminals: o.st.terminals.length, tabs: o.st.tabs.length, groups: o.st.groups.length, folders: o.st.folders.length, repos: o.st.repos.length }, before);
});

test("ensureOrg moves a repo that is loose or in another group into the project's group", async () => {
  const root = tmpDir("orca-move-");
  const { p, api, web } = nexusProject(root, "nexus2");
  const o = fakeOrcaHost();
  o.st.groups.push({ id: "g-mine", name: "Nexus", parentPath: root }, { id: "g-other", name: "Personal", parentPath: "/elsewhere" });
  o.st.repos.push({ id: "r-api", path: api, projectGroupId: "g-other" });
  const log = [];
  await orca.ensureOrg(p, { exec: o.exec, call: o.call, runTmux: noTmux, log: (m) => log.push(m) });
  assert.ok(!o.st.rpc.some(([m]) => m === "projectGroup.importNested"));
  assert.equal(o.st.repos.find((r) => r.path === api).projectGroupId, "g-mine");
  assert.equal(o.st.repos.find((r) => r.path === web).projectGroupId, "g-mine"); // added, then moved
  assert.ok(o.st.cli.some((a) => a[0] === "repo" && a[1] === "add" && a.includes(web)));
  assert.ok(log.some((m) => /api: movido al grupo Nexus \(estaba en otro grupo\)/.test(m)));
});

test("ensureOrg refuses repos outside the common folder", async () => {
  const root = tmpDir("orca-out-");
  const other = gitDir(path.join(tmpDir("orca-else-"), "lib"));
  const api = gitDir(path.join(root, "api"));
  const p = normalize({ version: 2, projects: { x: { repos: [api, other], repos_root: root, runtime: { dir: root, terminal: "orca" } } } }).projects[0];
  const o = fakeOrcaHost();
  await assert.rejects(orca.ensureOrg(p, { exec: o.exec, call: o.call, runTmux: noTmux }), /no está dentro de .*repos_root/);
});

test("ensureOrg, one repo: the repo itself holds orq and the hub tab", async () => {
  const repo = gitDir(path.join(tmpDir("orca-solo-"), "solo"));
  const p = normalize({ version: 2, projects: { solo: { repo, runtime: { dir: repo, terminal: "orca", command: "pi" } } } }).projects[0];
  const o = fakeOrcaHost();
  const org = await orca.ensureOrg(p, { hubUrl: "http://h:7420", exec: o.exec, call: o.call, runTmux: noTmux });
  assert.equal(org.worktree, repo);
  assert.deepEqual(o.st.repos.map((r) => r.path), [repo]);
  assert.equal(o.st.rpc.length, 0); // no group
  assert.deepEqual(o.st.tabs, [{ worktree: `path:${repo}`, url: "http://h:7420/p/solo" }]);
  assert.match(o.st.terminals[0].command, /pi --session-id [0-9a-f-]{36}$/);
});

test("ensureOrg brings back the hub's ticket agents (resumed) and shows live tmux windows", async () => {
  const root = tmpDir("orca-back-");
  const { p, api } = nexusProject(root, "nexus3");
  const sessionId = "3b0e8c1a-6c4e-4a57-9a4f-3c9f1f0d2b11";
  orca.saveRecord(orca.ticketRecord(p, "NX-7", { worktree: api, command: "claude", dir: api }));
  orca.saveRecord({ ...orca.loadRecord(api, "nx-7"), sessionId });
  const o = fakeOrcaHost();
  const runTmux = async () => ({ stdout: "orq claude\nnx-9 2.1.3\nnotes zsh\n" });
  await orca.ensureOrg(p, { exec: o.exec, call: o.call, runTmux });
  const t7 = o.st.terminals.find((t) => t.title === "nx-7");
  assert.equal(t7.sel, `path:${api}`);
  assert.match(t7.command, new RegExp(`HUB_TICKET='NX-7' .*claude --resume ${sessionId}$`));
  // orq and nx-9 are alive in tmux: attached, not started again; "notes" is no agent.
  const orq = o.st.terminals.find((t) => t.title === "orq");
  assert.match(orq.command, /^tmux new-session -t '=nexus3' -s hub-[0-9a-f]{8} \; set-option destroy-unattached on \; select-window -t ':orq'$/);
  assert.ok(o.st.terminals.find((t) => t.title === "nx-9"));
  assert.ok(!o.st.terminals.find((t) => t.title === "notes"));
  // The bridge lists the agent terminals, not the views of tmux windows (those are listed by tmux).
  const wins = await orca.listTerminals([{ ...p, session: "nexus3" }], { exec: o.exec, call: o.call });
  assert.deepEqual(wins.map((w) => w.name), ["nx-7"]);
});

test("ticketWorktree: the ticket's repo, else the folder workspace (group) or the project's worktree", () => {
  const plan = { grouped: true, repos: ["/c/n/api", "/c/n/web"], worktree: "/c/n" };
  assert.equal(orca.ticketWorktree(plan, "/c/n/web", "id:folder:f1"), "/c/n/web");
  assert.equal(orca.ticketWorktree(plan, "/c/n", "id:folder:f1"), "id:folder:f1");
  assert.equal(orca.ticketWorktree({ grouped: false, repos: ["/c/s"], worktree: "/c/s" }, "/c/other", null), "/c/s");
  assert.equal(orca.selector("id:folder:f1"), "id:folder:f1");
  assert.equal(orca.selector("/c/s"), "path:/c/s");
});

test("focusTerminal: an open terminal as is; a missing ticket agent opened in its repo (layout first)", async () => {
  const root = tmpDir("orca-focus-");
  const { p, web } = nexusProject(root, "nexus4");
  const o = fakeOrcaHost();
  const first = await orca.focusTerminal(p, "NX-1", { spawn: { command: "claude", dir: web }, hubUrl: "http://h", exec: o.exec, call: o.call, runTmux: noTmux });
  assert.equal(first.runtimeId, "rt-1");
  assert.equal(first.state, "created");
  const t = o.st.terminals.find((x) => x.handle === first.handle);
  assert.equal(t.title, "nx-1");
  assert.equal(t.sel, `path:${web}`);
  assert.match(t.command, /HUB_TICKET='NX-1'/);
  const again = await orca.focusTerminal(p, "NX-1", { spawn: { command: "claude", dir: web }, exec: o.exec, call: o.call, runTmux: noTmux });
  assert.deepEqual(again, { runtimeId: "rt-1", handle: first.handle, state: "existing" });
  const orq = await orca.focusTerminal(p, null, { exec: o.exec, call: o.call, runTmux: noTmux });
  assert.equal(o.st.terminals.find((x) => x.handle === orq.handle).title, "orq");
});
