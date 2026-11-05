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
