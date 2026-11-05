#!/usr/bin/env node
// The CLI under its v0.1 names (`hub`, and `overhaul` linked here by v0.1's install.sh).
import { main } from "../src/cli.mjs";

await main(process.argv.slice(2));
