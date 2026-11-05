// Dependency-free so the agent CLI can be copied to other hosts on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaths } from "./paths.mjs";

export const expandHome = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

export const NAME = "overhaul";

// OVERHAUL_X is accepted wherever HUB_X is read (HUB_X stays the canonical name: agents, the
// orchestrators' CLAUDE.md and older hosts use it). An explicit HUB_X wins.
for (const [k, v] of Object.entries(process.env)) {
  const hub = k.startsWith("OVERHAUL_") ? `HUB_${k.slice(9)}` : null;
  if (hub && process.env[hub] === undefined) process.env[hub] = v;
}

// Everything lives in one folder (src/paths.mjs): ~/.overhaul, OVERHAUL_HOME, or an earlier layout
// until it is migrated.
export const PATHS = resolvePaths();
export const CONFIG_DIR = PATHS.configDir;
export const defaultDataDir = () => PATHS.dataDir;
export const ENV_FILE = PATHS.env;

// KEY=value lines; values already in the environment win.
export function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// This machine's name as projects (`host`), the bridge and the hook spell it: HUB_HOST, else the
// hostname without ".local" (macOS reports "name.local"; the bridge and config say "name").
export const localHost = () => process.env.HUB_HOST || os.hostname().replace(/\.local$/, "");

// Where the hub is: HUB_URL (comma-separated, tried in order), else this machine's hub.
export const DEFAULT_HUB_URL = "http://127.0.0.1:7420";
export const hubUrls = (v = process.env.HUB_URL) =>
  (v || DEFAULT_HUB_URL).split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);

// A command-line tool by absolute path when a known install has it (launchd and tmux panes may
// start without Homebrew in PATH), else by name. `override` (TMUX_BIN, GH_BIN) always wins.
export function tool(name, override) {
  if (override) return override;
  if (process.platform !== "darwin") return name;
  return ["/opt/homebrew/bin", "/usr/local/bin"].map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) ?? name;
}
