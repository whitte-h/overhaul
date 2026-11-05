import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { frontmatter } from "../src/adapters/kanban-md.mjs";

const tmp = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), "hub-")));

test("answer reaches the agent waiting on that question", async () => {
  const s = tmp();
  const q = s.ask("alpha", "ABC-177", { text: "UTC?", from: "be" });
  const waiting = s.waitFor("alpha", "ABC-177", { questionId: q.id, timeoutMs: 1000 });
  s.answer("alpha", "ABC-177", q.id, "zona del usuario");
  const [msg] = await waiting;
  assert.equal(msg.text, "zona del usuario");
  assert.equal(s.get("alpha", "ABC-177").questions[0].status, "answered");
});

test("ask waiter wins over a general inbox waiter", async () => {
  const s = tmp();
  const q = s.ask("beta", "ORB-42", { text: "SMTP?" });
  const general = s.waitFor("beta", "ORB-42", { questionId: null, timeoutMs: 200 });
  const specific = s.waitFor("beta", "ORB-42", { questionId: q.id, timeoutMs: 1000 });
  s.answer("beta", "ORB-42", q.id, "sandbox");
  assert.equal((await specific)[0].text, "sandbox");
  assert.deepEqual(await general, []);
});

test("messages queue until an agent listens, then persist as consumed", async () => {
  const s = tmp();
  s.message("gamma", "K-251", "muéstrame el plan");
  assert.equal(s.listening("gamma", "K-251"), false);
  const msgs = await s.waitFor("gamma", "K-251", { questionId: null, timeoutMs: 10 });
  assert.equal(msgs[0].text, "muéstrame el plan");
  const again = new Store(s.dataDir);
  assert.ok(again.get("gamma", "K-251").inbox[0].consumedAt);
});

test("ticket keys cannot escape the data dir", () => {
  assert.throws(() => tmp().get("alpha", "../../etc"), /Bad project or ticket key/);
});

test("kanban-md frontmatter", () => {
  const meta = frontmatter("---\nid: 251\ntitle: Pin Caddy\nstatus: todo\ntags:\n    - infra\n---\nbody");
  assert.deepEqual([meta.id, meta.title, meta.status], ["251", "Pin Caddy", "todo"]);
});

test("bridge sees only unconsumed messages of tickets nobody is polling, and acks them", async () => {
  const s = tmp();
  s.message("alpha", "ABC-1", "hola");
  const waiting = s.waitFor("alpha", "ABC-2", { questionId: null, timeoutMs: 200 });
  assert.deepEqual(s.pending("alpha").map((t) => t.key), ["ABC-1"]);
  const [t] = s.pending("alpha");
  s.ack("alpha", "ABC-1", t.messages.map((m) => m.id), "alpha:abc-1");
  assert.deepEqual(s.pending("alpha"), []);
  assert.equal(s.get("alpha", "ABC-1").inbox[0].via, "alpha:abc-1");
  await waiting;
});

test("bridge classifies Claude pane footers", async () => {
  const { classify } = await import("../src/bridge.mjs");
  assert.equal(classify("x\n✶ Garnishing… (4m 47s · ↓ 5.6k tokens)\n❯ \n").state, "working");
  assert.equal(classify("x\n✻ Worked for 5m 9s · done 2:29 PM\n❯ \n").state, "idle");
  assert.equal(classify("Do you want to proceed?\n❯ 1. Yes\n  2. No\n").state, "needs_input");
  assert.equal(classify("").state, "idle");
});

test("PRs match the ticket key as a whole word", async () => {
  const { matchPrs } = await import("../src/prs.mjs");
  const prs = [
    { number: 84, title: "ABC-177: Analytics tab backend", url: "u1", repo: "alpha-shared-data" },
    { number: 37, title: "Analytics tab", keys: ["ABC-177"], url: "u2", repo: "alpha-orchestration-layer" },
    { number: 9, title: "ABC-1770 other", url: "u3" },
    { number: 7, title: "feat(groups): acceso por sección (XYZ-8)", url: "u4" },
  ];
  assert.deepEqual(matchPrs(prs, "ABC-177").map((p) => p.number), [84, 37]);
  assert.deepEqual(matchPrs(prs, "ABC-17"), []);
  assert.deepEqual(matchPrs(prs, "XYZ-8").map((p) => p.number), [7]);
});
