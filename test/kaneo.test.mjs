import test from "node:test";
import assert from "node:assert/strict";
import { listKaneo } from "../src/adapters/kaneo.mjs";
import { normalize } from "../src/config.mjs";

const TASKS = [
  { id: "1", number: 1, title: "a", projectSlug: "abc", projectName: "Alpha", status: "todo" },
  { id: "2", number: 2, title: "b", projectSlug: "xyz", projectName: "Beta", status: "todo" },
  { id: "3", number: 3, title: "c", projectSlug: "abc", projectName: "Alpha", status: "todo" },
];

async function keys(tracker) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ tasks: TASKS }), { headers: { "content-type": "application/json" } });
  process.env.KANEO_TEST_TOKEN = "t";
  try {
    const cfg = normalize({ version: 2, projects: { p: { tracker: { type: "kaneo", base_url: "https://k.example", workspace_id: "w", token_env: "KANEO_TEST_TOKEN", ...tracker } } } });
    return (await listKaneo(cfg.projects[0].tracker)).map((t) => t.key);
  } finally {
    globalThis.fetch = real;
  }
}

test("kaneo: without a filter, every task of the workspace", async () => {
  assert.deepEqual(await keys({}), ["ABC-1", "XYZ-2", "ABC-3"]);
});

test("kaneo: projects keeps only those projects, by slug or name, any case", async () => {
  assert.deepEqual(await keys({ projects: ["XYZ"] }), ["XYZ-2"]);
  assert.deepEqual(await keys({ projects: "alpha" }), ["ABC-1", "ABC-3"]);
});

test("kaneo: exclude_projects leaves those projects out", async () => {
  assert.deepEqual(await keys({ exclude_projects: ["xyz"] }), ["ABC-1", "ABC-3"]);
});

test("jira: Cloud uses Basic email:token and API v3; Server (no email_env) a Bearer token and API v2", async () => {
  const { listJira } = await import("../src/adapters/jira.mjs");
  const { hasDetails } = await import("../src/adapters/index.mjs");
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.authorization });
    return new Response(JSON.stringify({ issues: [{ key: "A-1", fields: { summary: "s", status: { name: "To Do" } } }] }), { headers: { "content-type": "application/json" } });
  };
  process.env.JT_EMAIL = "me@example.com";
  process.env.JT_TOKEN = "tok";
  try {
    const [cloud, server] = normalize({ version: 2, projects: {
      c: { tracker: { type: "jira", base_url: "https://x.atlassian.net", email_env: "JT_EMAIL", token_env: "JT_TOKEN" } },
      s: { tracker: { type: "jira", base_url: "https://jira.example", token_env: "JT_TOKEN" } },
    } }).projects.map((p) => p.tracker);
    assert.equal((await listJira(cloud))[0].key, "A-1");
    assert.equal((await listJira(server))[0].url, "https://jira.example/browse/A-1");
    assert.match(calls[0].url, /\/rest\/api\/3\/search\/jql\?/);
    assert.equal(calls[0].auth, `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
    assert.match(calls[1].url, /\/rest\/api\/2\/search\?/);
    assert.equal(calls[1].auth, "Bearer tok");
    assert.equal(hasDetails(cloud), true);
    assert.equal(hasDetails(server), false);
  } finally {
    globalThis.fetch = real;
  }
});
