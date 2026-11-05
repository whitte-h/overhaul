import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Runs bin/hub-hook.mjs as an agent would, against a fake hub; returns what the hub got.
async function runHook(input, env) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "hub-hook-"));
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, HUB_CONFIG_DIR: config, HUB_HOST: "host-a", HUB_URL: `http://127.0.0.1:${server.address().port}`, ...env };
  const child = spawn(process.execPath, [path.join(root, "bin/hub-hook.mjs")], { env: childEnv, stdio: ["pipe", "ignore", "inherit"] });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((r) => child.on("exit", r));
  server.close();
  return { code, got, config };
}

test("pi events from an Orca terminal reach the hub under HUB_WINDOW", async () => {
  const prompt = await runHook(
    { agent: "pi", hook_event_name: "UserPromptSubmit", prompt: "hola", session_id: "s-1", cwd: "/w" },
    { HUB_AGENT_TOKEN: "tok", HUB_WINDOW: "personal:k-257" },
  );
  assert.equal(prompt.code, 0);
  assert.equal(prompt.got.length, 1);
  assert.equal(prompt.got[0].url, "/agent/hook");
  assert.equal(prompt.got[0].auth, "Bearer tok");
  assert.deepEqual(prompt.got[0].body, { host: "host-a", session: "personal", window: "k-257", event: "UserPromptSubmit", text: "hola", cwd: "/w" });
  assert.ok(!fs.existsSync(path.join(prompt.config, "panes")), "pi sessions are not remembered as Claude's");

  const stop = await runHook(
    { agent: "pi", hook_event_name: "Stop", last_assistant_message: "listo" },
    { HUB_AGENT_TOKEN: "tok", HUB_WINDOW: "personal:k-257" },
  );
  assert.equal(stop.got[0].body.event, "Stop");
  assert.equal(stop.got[0].body.text, "listo");
});

test("hook stays silent outside a tracked window or without a token", async () => {
  const input = { hook_event_name: "UserPromptSubmit", prompt: "hola" };
  assert.deepEqual((await runHook(input, { HUB_AGENT_TOKEN: "tok" })).got, []);
  assert.deepEqual((await runHook(input, { HUB_WINDOW: "personal:k-257" })).got, []);
  const bad = await runHook(input, { HUB_AGENT_TOKEN: "tok", HUB_WINDOW: "sin-dos-puntos" });
  assert.equal(bad.code, 0);
  assert.deepEqual(bad.got, []);
});
