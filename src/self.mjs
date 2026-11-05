// What this program is and how to run it again: the single executable (Node SEA) or, in a
// clone, node + bin/overhaul.mjs. Services, hooks and the pi extension are written with
// selfCommand(), so they keep working whichever way Overhaul was installed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";

export const IS_SEA = (() => {
  try {
    return isSea();
  } catch {
    return false;
  }
})();

// The clone (or unpacked release) this code runs from; meaningless inside the executable.
export const sourceRoot = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Homebrew runs <prefix>/Cellar/overhaul/<version>/bin/overhaul through <prefix>/bin/overhaul;
// the link survives `brew upgrade`, the Cellar path does not.
export function stableBinPath(p) {
  const m = /^(.*)\/Cellar\/overhaul\/[^/]+\/bin\/overhaul$/.exec(p);
  if (m && fs.existsSync(path.join(m[1], "bin/overhaul"))) return path.join(m[1], "bin/overhaul");
  return p;
}
export const isHomebrew = (p = process.execPath) => /\/Cellar\/overhaul\/[^/]+\/bin\/overhaul$/.test(p);

// A node that outlives this shell: fnm's per-shell paths vanish, its default alias stays.
export function stableNode(execPath = process.execPath, home = os.homedir()) {
  if (!/fnm_multishells/.test(execPath)) return execPath;
  for (const alias of [path.join(home, ".local/share/fnm/aliases/default/bin/node"), path.join(home, "Library/Application Support/fnm/aliases/default/bin/node")]) {
    if (fs.existsSync(alias)) return alias;
  }
  return fs.realpathSync(execPath);
}

// argv to run `overhaul <args>` again: [binary] or [node, bin/overhaul.mjs].
export function selfCommand() {
  if (IS_SEA) return [stableBinPath(process.execPath)];
  return [stableNode(), path.join(sourceRoot(), "bin/overhaul.mjs")];
}

// The name it was run as (overhaul, or the old alias hub), for usage messages.
export const progName = () => path.basename(IS_SEA ? process.argv0 : process.argv[1] ?? "overhaul").replace(/\.mjs$/, "");

// A command line for a shell (hooks): each word quoted only when it needs it.
export const shellQuote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, `'\\''`)}'`);
export const shellLine = (argv) => argv.map(shellQuote).join(" ");
