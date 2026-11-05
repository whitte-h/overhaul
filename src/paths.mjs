// Where Overhaul keeps everything: one folder, ~/.overhaul (OVERHAUL_HOME moves it). The CLI, the
// hook, the services, `update` and the installer all ask this one function.
//
//   home     OVERHAUL_HOME, else ~/.overhaul
//   mode     "home"     everything in home (the normal case, and a fresh machine)
//            "legacy"   home has no config yet and an earlier layout does (v0.1:
//                       ~/.config/overhaul + ~/.local/share/overhaul, or work-hub): used as it is
//                       until `overhaul migrate` (or `service install` / `update`) moves it in
//            "explicit" HUB_CONFIG_DIR / OVERHAUL_CONFIG_DIR names the config folder (v0.1 services,
//                       tests); data stays where v0.1 put it unless config.yaml says data_dir
//
// Dependency-free (no yaml): the hook and the agent CLI load it on every call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_HOME = "~/.overhaul";
export const LEGACY = {
  config: ["~/.config/overhaul", "~/.config/work-hub"],
  data: ["~/.local/share/overhaul", "~/.local/share/work-hub"],
};

export const expandHomeIn = (home) => (p) => (p === "~" ? home : p && p.startsWith("~/") ? path.join(home, p.slice(2)) : p);

// A folder that holds an installation: its config or its secrets.
export const hasInstall = (dir) => ["config.yaml", "config.json", "env"].some((f) => fs.existsSync(path.join(dir, f)));

// The first existing one, else the first (as v0.1 resolved them).
const firstExisting = (dirs) => dirs.find((d) => fs.existsSync(d)) ?? dirs[0];

export function resolvePaths(env = process.env, userHome = env.HOME || os.homedir()) {
  const expand = expandHomeIn(userHome);
  const legacyConfig = LEGACY.config.map(expand);
  const legacyData = LEGACY.data.map(expand);
  const home = path.resolve(expand(env.OVERHAUL_HOME || DEFAULT_HOME));
  const explicitConfig = env.OVERHAUL_HOME ? "" : env.HUB_CONFIG_DIR || env.OVERHAUL_CONFIG_DIR || "";

  let mode = "home";
  let configDir = home;
  let dataDir = home;
  if (explicitConfig) {
    mode = "explicit";
    configDir = expand(explicitConfig);
    dataDir = firstExisting(legacyData);
  } else if (!env.OVERHAUL_HOME && !hasInstall(home)) {
    const old = legacyConfig.find(hasInstall);
    if (old) {
      mode = "legacy";
      configDir = old;
      dataDir = firstExisting(legacyData);
    }
  }
  return {
    home,
    mode,
    configDir,
    config: path.join(configDir, "config.yaml"),
    env: path.join(configDir, "env"),
    // The default for config.yaml's data_dir; overhaul.db lives there.
    dataDir,
    db: path.join(dataDir, "overhaul.db"),
    logs: path.join(home, "logs"),
    bin: path.join(home, "bin"),
    backups: path.join(home, "backups"),
    helper: path.join(home, "helper"),
    legacy: { config: legacyConfig, data: legacyData },
  };
}
