import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentPrompt, diagnose, disableRemoteHubUrls, remoteHubUrls } from "../src/doctor.mjs";
import { cleanEnv, overhaul } from "./contract-lib.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, { mode: 0o600 }); };

test("remoteHubUrls: only hubs on other machines", () => {
  assert.deepEqual(remoteHubUrls({ HUB_URL: "http://127.0.0.1:7420,http://localhost:7420" }), []);
  assert.deepEqual(remoteHubUrls({ HUB_URL: "http://127.0.0.1:7420,http://joaquin:7420" }).map((r) => r.remote), [["http://joaquin:7420"]]);
});

test("disableRemoteHubUrls comments the line out and keeps everything else", () => {
  const f = path.join(tmp("doc-env-"), "env");
  write(f, "HUB_TOKEN=secret-password\nHUB_URL=http://joaquin:7420\nHUB_HOST=robots\n");
  assert.deepEqual(disableRemoteHubUrls(f, "T"), ["HUB_URL"]);
  const text = fs.readFileSync(f, "utf8");
  assert.match(text, /^# T overhaul: apagado.*\n# HUB_URL=http:\/\/joaquin:7420$/m);
  assert.match(text, /^HUB_TOKEN=secret-password$/m);
  assert.match(text, /^HUB_HOST=robots$/m);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(disableRemoteHubUrls(f), []);
});

test("diagnose: a remote HUB_URL and a project on another host are reported, with what to do; the prompt has no secrets", async () => {
  const home = tmp("doc-home-");
  const oh = path.join(home, ".overhaul");
  write(path.join(oh, "config.yaml"), "port: 1\nprojects:\n  nexus: { repo: ~/code/nexus, host: elsewhere }\n");
  write(path.join(oh, "env"), "HUB_TOKEN=secret-password\nHUB_AGENT_TOKEN=an-agent-token-of-24-chars-or-more\nHUB_URL=http://joaquin:7420\n");
  const r = await diagnose({ env: { HOME: home, PATH: process.env.PATH }, userHome: home });
  const bad = r.checks.filter((c) => !c.ok).map((c) => c.title).join("\n");
  assert.match(bad, /HUB_URL apunta a otro hub \(http:\/\/joaquin:7420\)/);
  assert.match(bad, /host «elsewhere»/);
  assert.match(bad, /El hub no responde en el puerto 1/);
  assert.ok(r.checks.find((c) => /HUB_URL/.test(c.title)).fixable);
  const prompt = agentPrompt(r, { version: "9.9.9", userHome: home });
  assert.match(prompt, /Overhaul 9\.9\.9/);
  assert.match(prompt, /HUB_TOKEN, HUB_AGENT_TOKEN, HUB_URL/);
  assert.doesNotMatch(prompt, /secret-password|an-agent-token/);
});

test("migrate: a work-hub node that reported to another hub runs its own afterwards", () => {
  const home = tmp("doc-mig-");
  const cfg = path.join(home, ".config/work-hub");
  write(path.join(cfg, "config.yaml"), "port: 1\nprojects:\n  nexus: { repo: ~/code/nexus }\n");
  write(path.join(cfg, "env"), "HUB_TOKEN=a-long-ui-password\nHUB_URL=http://joaquin:7420\n");
  const r = overhaul(["migrate"], { env: cleanEnv(home) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout + r.stderr, /env: comenté HUB_URL/);
  assert.match(fs.readFileSync(path.join(home, ".overhaul/env"), "utf8"), /^# HUB_URL=http:\/\/joaquin:7420$/m);
});
