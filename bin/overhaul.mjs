#!/usr/bin/env node
// `overhaul` from a clone. The release executable runs the same code (src/cli.mjs).
import { main } from "../src/cli.mjs";

await main(process.argv.slice(2));
