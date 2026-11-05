// Where agents call `overhaul hook`: Claude Code's settings.json and pi's extension.
// Every write keeps a timestamped backup of the file it replaces.
import fs from "node:fs";
import path from "node:path";
import { assetText } from "./assets.mjs";
import { HOOK_EVENTS } from "./hook.mjs";
import { shellLine } from "./self.mjs";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// Ours: v0.1's `node …/hub-hook.mjs` and v0.2's `… overhaul hook [Event]` (any path, quoted or not).
export const isOurHook = (cmd) => /hub-hook\.mjs\b/.test(cmd) || /(^|[\s/'"])overhaul(\.mjs)?['"]?\s+hook(\s|$)/.test(cmd);

export const hookCommand = (self, event) => shellLine([...self, "hook", event]);

// Points every hook of ours at `self hook <Event>` and, unless repointOnly, adds the events that
// have none. Returns [{ file, changed: [...] }].
export function installHooks({ self, files, repointOnly = false }) {
  const out = [];
  for (const file of files) {
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8") || "{}") : {};
    const hooks = settings.hooks ?? {};
    const changed = [];
    for (const event of HOOK_EVENTS) {
      const want = hookCommand(self, event);
      const groups = hooks[event] ?? [];
      const ours = groups.flatMap((g) => g.hooks ?? []).filter((h) => isOurHook(String(h.command ?? "")));
      if (ours.length) {
        for (const h of ours) {
          if (h.command === want) continue;
          h.command = want;
          changed.push(`${event} (repointed)`);
        }
        continue;
      }
      if (repointOnly) continue;
      groups.push({ hooks: [{ type: "command", command: want, timeout: 5 }] });
      hooks[event] = groups;
      changed.push(event);
    }
    if (changed.length) {
      settings.hooks = hooks;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-overhaul-${stamp()}`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
      fs.renameSync(tmp, file);
    }
    out.push({ file, changed });
  }
  return out;
}

// pi/overhaul.ts with the command filled in, installed as <dir>/overhaul.ts.
export function piExtension(self) {
  return assetText("pi/overhaul.ts").replace('["__OVERHAUL__"]', JSON.stringify(self));
}

export function installPiExtension({ dir, command }) {
  const log = [];
  const text = piExtension(command);
  const file = path.join(dir, "overhaul.ts");
  const s = stamp();
  fs.mkdirSync(dir, { recursive: true });
  // The backups go next to the folder: pi would try to load anything inside it.
  const legacy = path.join(dir, "work-hub.ts");
  if (fs.existsSync(legacy)) {
    fs.renameSync(legacy, path.join(dir, "..", `work-hub.ts.bak-${s}`));
    log.push(`${legacy}: moved out (replaced by overhaul.ts)`);
  }
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (old === text) return { file, changed: false, log: [...log, `${file}: already installed`] };
  if (old !== null) fs.copyFileSync(file, path.join(dir, "..", `overhaul.ts.bak-${s}`));
  fs.writeFileSync(file, text);
  log.push(`${file}: installed (${shellLine(command)} hook). pi sessions already open load it on /reload or restart.`);
  return { file, changed: true, log };
}
