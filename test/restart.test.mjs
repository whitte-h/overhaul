import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// A private tmux server, so the test never touches the user's sessions.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-restart-"));
const socket = path.join(dir, "tmux.sock");
const wrapper = path.join(dir, "tmux");
fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -S ${socket} "$@"\n`, { mode: 0o755 });
process.env.TMUX_BIN = wrapper;
process.env.HUB_CONFIG_DIR = dir;
const { paneWindow, restartWindow } = await import("../src/restart.mjs");
const tmux = (...args) => execFileSync(wrapper, args).toString().trim();

test("windows seen through hub-* views keep their own session's name", async (t) => {
  t.after(() => { try { tmux("kill-server"); } catch {} });
  tmux("new-session", "-d", "-s", "personal", "-n", "overhaul", "sleep 600");
  tmux("new-session", "-d", "-s", "hub-view-x", "-t", "personal"); // grouped view, like helper/attach.mjs
  const pane = tmux("display-message", "-p", "-t", "=personal:overhaul", "#{pane_id}");
  assert.equal(await paneWindow(pane), "personal:overhaul");

  // A session remembered under the view's name (before this fix) is still found by the real one.
  const sessionId = "0f0e8c1a-6c4e-4a57-9a4f-3c9f1f0d2b11";
  fs.mkdirSync(path.join(dir, "panes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "panes", `${encodeURIComponent("hub-view-x:overhaul")}.json`), JSON.stringify({ sessionId, cwd: dir, env: {}, at: "2026-11-02T00:00:00Z" }));
  const saved = await restartWindow("personal:overhaul");
  assert.equal(saved.sessionId, sessionId);
});
