#!/usr/bin/env node
// Rebuilds the hub's layout in Orca from the Orca layout (see layoutFile in orca.mjs): projects, hub tabs and agent
// terminals. Idempotent: what exists is left as is. Run at login (LaunchAgent
// overhaul.orca) or by hand on a fresh Orca:  node helper/orca-restore.mjs [project]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ORCA, layout, restoreProject } from "./orca.mjs";

const run = promisify(execFile);
const only = process.argv[2];

// Launches Orca if needed and waits until its runtime answers.
await run(ORCA, ["open"], { timeout: 120_000 }).catch((err) => {
  console.error(`No pude abrir Orca: ${err.message}`);
  process.exit(1);
});

let failed = false;
for (const p of layout().projects.filter((x) => !only || x.id === only)) {
  try {
    await restoreProject(p, console.log);
  } catch (err) {
    failed = true;
    console.error(`${p.id}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
