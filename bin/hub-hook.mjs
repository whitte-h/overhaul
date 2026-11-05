#!/usr/bin/env node
// The Claude Code hook as v0.1 installed it (node bin/hub-hook.mjs). Same as `overhaul hook`.
import { runHook } from "../src/hook.mjs";

await runHook(process.argv[2]);
