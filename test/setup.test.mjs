import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// configfile.mjs resolves config.yaml from HUB_CONFIG_DIR at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-setup-"));
process.env.HUB_CONFIG_DIR = path.join(tmp, "cfg");
fs.mkdirSync(process.env.HUB_CONFIG_DIR);
const root = path.join(tmp, "code");
for (const r of ["xyz", "delta"]) execFileSync("git", ["init", "-q", path.join(root, r)]);

const yamlText = `# top comment
data_dir: ${tmp}/data
projects:
  beta:
    host: ${os.hostname()}
    repos_root: ${root}
    tracker: { type: jira, base_url: https://x.atlassian.net, email_env: E, token_env: T }
    auto_work: false   # keep this comment
`;
fs.writeFileSync(path.join(process.env.HUB_CONFIG_DIR, "config.yaml"), yamlText);

const { loadConfig } = await import("../src/config.mjs");
const { Setup, sameRepo } = await import("../src/setup.mjs");
const { editConfig, addRepoMapping } = await import("../src/configfile.mjs");

test("asks for unmapped groups and unmapped local repos, answers update config.yaml", async () => {
  const cfg = loadConfig();
  const tickets = [{ key: "XYZ-1", group: "XYZ" }, { key: "WID-2", group: "WID" }];
  const setup = new Setup(cfg, async () => tickets, () => Object.assign(cfg, loadConfig()));

  editConfig((doc) => addRepoMapping(doc, "beta", "XYZ", path.join(root, "xyz")));
  Object.assign(cfg, loadConfig());
  const ids = (await setup.questions()).map((q) => q.id).sort();
  assert.deepEqual(ids, ["board_for_repo:beta:delta", "repo_for_group:beta:WID"]);

  const res = await setup.answer("board_for_repo:beta:delta", "https://x.atlassian.net/jira/software/projects/DEL/boards/3");
  assert.equal(res.message, "delta → DEL");
  assert.deepEqual((await setup.questions()).map((q) => q.id), ["repo_for_group:beta:WID"]);

  const text = fs.readFileSync(path.join(process.env.HUB_CONFIG_DIR, "config.yaml"), "utf8");
  assert.match(text, /# top comment/);
  assert.match(text, new RegExp(`DEL: ${root}/delta`));
  assert.equal(cfg.projects[0].autoWork.enabled, false);

  setup.ignore("repo_for_group:beta:WID");
  assert.deepEqual(await setup.questions(), []);
});

test("rejects bad answers", async () => {
  const cfg = loadConfig();
  const setup = new Setup(cfg, async () => [{ key: "Z-1", group: "Z" }], () => {});
  await assert.rejects(setup.answer("repo_for_group:beta:Z", "not a url"), /URL de git/);
  fs.rmSync(path.join(tmp, "data", "setup-ignored.json"), { force: true });
  await assert.rejects(setup.answer("board_for_repo:nope:x", "https://x"), /ya no está pendiente/);
});

test("sameRepo treats ssh and https forms as one", () => {
  assert.ok(sameRepo("git@github.com:acme/widget.git", "https://github.com/acme/widget"));
  assert.ok(!sameRepo("git@github.com:acme/widget.git", "git@github.com:acme/widget-demos.git"));
});

test("allowlist: v1 list accepts localhost, tailnet and home LAN only", async () => {
  const { allowList } = await import("../src/netallow.mjs");
  const { V1_ALLOW } = await import("../src/config.mjs");
  const ok = allowList(V1_ALLOW);
  for (const a of ["127.0.0.1", "::1", "::ffff:192.168.1.50", "100.64.0.1", "fd7a:115c:a1e0::1"]) assert.ok(ok(a), a);
  for (const a of ["172.17.0.2", "::ffff:10.0.0.5", "8.8.8.8", "", undefined]) assert.ok(!ok(a), String(a));
});

test("allowlist default answers this machine only", async () => {
  const { allowList } = await import("../src/netallow.mjs");
  const ok = allowList();
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.ok(ok(a), a);
  for (const a of ["::ffff:192.168.1.50", "100.64.0.1", "fd7a:115c:a1e0::1"]) assert.ok(!ok(a), a);
});

test("permission prompt options are read from the pane", async () => {
  const { promptOptions } = await import("../src/activity.mjs");
  const tail = "Bash command\n  gh pr view 84\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for gh commands\n  3. No, and tell Claude what to do differently (esc)\n";
  const { question, options } = promptOptions(tail);
  assert.equal(question, "Do you want to proceed?");
  assert.deepEqual(options.map((o) => o.key), ["1", "2", "3"]);
  assert.match(options[1].label, /don't ask again/);
});

test("activity keeps a bounded per-window log", async () => {
  const { Activity } = await import("../src/activity.mjs");
  const a = new Activity(fs.mkdtempSync(path.join(os.tmpdir(), "hub-act-")));
  for (let i = 0; i < 305; i++) a.add("host-b", "alpha:abc-177", { event: "Stop", text: `r${i}` });
  assert.equal(a.list("host-b", "alpha:abc-177").length, 300);
  assert.equal(a.recent("host-b", "alpha:abc-177", 1)[0].text, "r304");
});

test("orchestrator replies after a relayed ticket prompt land in that ticket's log", async () => {
  const { Activity, relayedTicket } = await import("../src/activity.mjs");
  const a = new Activity(fs.mkdtempSync(path.join(os.tmpdir(), "hub-rel-")));
  a.record("host-b", "alpha:orq", { event: "UserPromptSubmit", text: "[work-hub] Ticket ABC-185 (sin ventana propia; atiéndelo o abre un worker): ¿FE listo?" });
  a.record("host-b", "alpha:orq", { event: "Stop", text: "El FE está en el PR #37." });
  a.record("host-b", "alpha:orq", { event: "UserPromptSubmit", text: "otra cosa" });
  a.record("host-b", "alpha:orq", { event: "Stop", text: "listo" });
  assert.deepEqual(a.list("host-b", "ticket:ABC-185").map((e) => e.event), ["UserPromptSubmit", "Stop"]);
  assert.equal(a.list("host-b", "ticket:ABC-185")[1].via, "alpha:orq");
  assert.equal(a.list("host-b", "alpha:orq").length, 4);
  assert.equal(relayedTicket("[work-hub] Revisa el PR"), null);
});
