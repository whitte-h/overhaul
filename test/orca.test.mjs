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
  assert.deepEqual(b.terminals, { type: "orca", worktree: "~/code/b" });
  assert.deepEqual(c.terminals, { type: "orca", worktree: "/w/c" });
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
