// Overhaul's version: written into the executable at build time, else package.json's.
import fs from "node:fs";
import path from "node:path";
import { sourceRoot } from "./self.mjs";

/* global __OVERHAUL_VERSION__ */
export const VERSION =
  typeof __OVERHAUL_VERSION__ === "string"
    ? __OVERHAUL_VERSION__
    : JSON.parse(fs.readFileSync(path.join(sourceRoot(), "package.json"), "utf8")).version;
