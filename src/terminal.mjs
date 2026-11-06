// `overhaul terminal`, in a project's folder: opens (or brings forward) the terminal of the
// project's orchestrator. The first time it asks where the agents run, tmux or Orca, and keeps it
// in config.yaml (runtime.terminal, comments kept). With Orca it builds the project's layout in the
// Orca of this machine (src/orca.mjs ensureOrg): its group or repo, the hub's tab, the orchestrator
// and the agents. Only this machine: a hub never reaches another one. docs/contract.md, "Terminal".
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";
import { normalize, TERMINALS } from "./config.mjs";
import { tool } from "./env.mjs";
import { orcaBin } from "./orca.mjs";
import { AGENT_ENV, isPi, markPiWindow } from "./restart.mjs";
import { WizardError, load, prompter, quietIo, resolveProject, saveConfig, writeProject } from "./wizard.mjs";

const run = promisify(execFile);
export const HELPER_URL = "http://127.0.0.1:7421";

// Whether this machine has the Orca CLI (ORCA_BIN, orca in the PATH, or Orca.app's).
export const hasOrca = (env = process.env) => !!orcaBin(env);

// Where a project says its terminal is: runtime.terminal, v1's `terminals`, else unset (null).
export function projectTerminal(raw, id) {
  const p = raw.projects?.[id] ?? {};
  return p.runtime?.terminal ?? p.terminals ?? null;
}

// Writes the project's terminal (v1 projects keep v1's `terminals` key).
export function setTerminal(doc, id, terminal) {
  const p = doc.getIn(["projects", id], true);
  const legacy = YAML.isMap(p) && !p.has("runtime") && (p.has("worker") || p.has("terminals"));
  if (legacy) doc.setIn(["projects", id, "terminals"], terminal);
  else writeProject(doc, id, { runtime: { terminal } });
}

// `helper:` when the config has none, for a hub looked at from another computer with the desktop
// helper (its Orca follows the hub's tickets). Standalone (hub and Orca here) needs none.
export function ensureHelper(doc) {
  const root = doc.contents;
  if (!YAML.isMap(root) || root.has("helper") || root.has("chrome_helper") || root.has("chromeHelper")) return false;
  const pair = doc.createPair("helper", HELPER_URL);
  const i = root.items.findIndex((x) => ["defaults", "projects"].includes(YAML.isScalar(x.key) ? x.key.value : x.key));
  if (i < 0) root.items.push(pair);
  else root.items.splice(i, 0, pair);
  return true;
}

// Asks tmux or Orca (Orca first when this machine has it), or takes --terminal.
export async function chooseTerminal({ io, ni, flag, env, current = null }) {
  if (flag && !TERMINALS.includes(flag)) throw new WizardError(`--terminal: ${flag} no es tmux ni orca`, 2);
  if (flag || ni) return flag ?? current ?? "tmux";
  const orca = hasOrca(env);
  return io.choose("¿Dónde corren los agentes?", [
    { value: "tmux", label: "tmux (ventanas de tmux en esta máquina)" },
    { value: "orca", label: `orca (terminales de Orca en esta máquina${orca ? "" : "; no lo encuentro en el PATH"})` },
  ], current ?? (orca ? "orca" : "tmux"));
}

// opts: id, cwd, env, userHome, io, nonInteractive, flags.terminal; for tests: orca (the
// src/orca.mjs functions, with their exec/call), runTmux, attach.
export async function runTerminal(id, opts = {}) {
  const env = opts.env ?? process.env;
  const userHome = opts.userHome ?? env.HOME ?? os.homedir();
  const ni = !!opts.nonInteractive;
  const io = opts.io ?? (ni ? quietIo() : prompter());
  try {
    const { P, doc, raw, expand } = load(env, userHome);
    const pid = resolveProject(raw, id, opts.cwd ?? process.cwd(), expand);
    let terminal = projectTerminal(raw, pid);
    const flag = opts.flags?.terminal;
    if (!terminal || (flag && flag !== terminal)) {
      if (!terminal && ni && !flag) throw new WizardError(`${pid} no dice dónde corren sus agentes: --terminal tmux|orca`, 2);
      terminal = await chooseTerminal({ io, ni, flag, env, current: terminal });
      setTerminal(doc, pid, terminal);
      try {
        saveConfig(P.config, doc);
      } catch (err) {
        throw new WizardError(`La config resultante no es válida (${err.message}); no la guardé.`);
      }
      io.say(`Guardé runtime.terminal: ${terminal} en ${pid} (respaldo: config.yaml.bak).`);
    }
    const cfg = normalize(doc.toJS() ?? {});
    const p = cfg.projects.find((x) => x.id === pid);
    if (terminal === "orca") return await openOrca(cfg, p, { io, env, orca: opts.orca });
    return await openTmux(p, { io, env, runTmux: opts.runTmux, attach: opts.attach });
  } catch (err) {
    if (!(err instanceof WizardError)) throw err;
    io.say(`Error: ${err.message}`);
    return err.code;
  } finally {
    io.close?.();
  }
}

// The project's layout in this machine's Orca, then its orchestrator brought forward. On a
// server (orca serve) there is no window to switch: the Orca of your desktop, paired with it,
// gets there from the hub ("seguir en Orca", through the helper).
export async function buildOrca(cfg, p, { io, env, orca }) {
  const o = orca ?? (await import("./orca.mjs"));
  if (!orca && !hasOrca(env)) throw new WizardError("No encuentro Orca en esta máquina (orca en el PATH, ORCA_BIN o /Applications/Orca.app)");
  await o.ensureOrcaRunning();
  return o.ensureOrg(p, { hubUrl: cfg.publicUrls[0], log: (m) => io.say(`  ${m}`) });
}

async function openOrca(cfg, p, { io, env, orca }) {
  io.say(`Orca: armando ${p.name}…`);
  let org;
  try {
    org = await buildOrca(cfg, p, { io, env, orca });
  } catch (err) {
    if (err instanceof WizardError) throw err;
    throw new WizardError(`Orca: ${err.message}`);
  }
  const o = orca ?? (await import("./orca.mjs"));
  const res = await o.orca(["terminal", "switch", "--terminal", org.orchestrator]).catch(() => null);
  io.say(res?.focus?.navigated === false
    ? `Listo: ${p.orchestrator ?? "orq"} está en Orca. Este Orca no tiene ventana (servidor): ábrelo desde tu escritorio con "Seguir en Orca" en el hub.`
    : `Listo: ${p.orchestrator ?? "orq"} está al frente en Orca.`);
  return 0;
}

// The orchestrator's tmux window, created when missing (the project's agent command in its
// folder, pi with a fixed session so `overhaul restart` resumes it); then this terminal goes there.
export async function openTmux(p, { io, env = process.env, runTmux, attach } = {}) {
  const TMUX = tool("tmux", env.TMUX_BIN);
  const tmux = runTmux ?? ((args) => run(TMUX, args));
  const target = p.orchestrator ?? `${p.id}:orq`;
  const [session, win = "orq"] = target.split(":");
  const command = p.worker?.command ?? "claude";
  const dir = p.worker?.dir ?? p.repo ?? "~";
  const hasSession = await tmux(["has-session", "-t", `=${session}`]).then(() => true, () => false);
  const names = hasSession ? (await tmux(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"])).stdout.trim().split("\n") : [];
  if (!names.includes(win)) {
    const vars = { HUB_PROJECT: p.id, HUB_AGENT_NAME: win, ...AGENT_ENV };
    const pi = isPi(command);
    const sid = pi ? randomUUID() : null;
    const shell = `zsh -ic '${command}${pi ? ` --session-id ${sid}` : ""}; exec zsh'`;
    const flags = Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const cwd = dir.replace(/^~(?=\/|$)/, env.HOME ?? os.homedir());
    const { stdout } = hasSession
      ? await tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${session}:`, "-n", win, "-c", cwd, ...flags, shell])
      : await tmux(["new-session", "-d", "-P", "-F", "#{window_id}", "-s", session, "-n", win, "-c", cwd, ...flags, shell]);
    if (pi) await markPiWindow(stdout.trim(), sid, vars, tmux);
    io.say(`Abrí ${session}:${win} (${command} en ${dir}).`);
  }
  const to = `=${session}:${win}`;
  if (env.TMUX) {
    await tmux(["switch-client", "-t", to]);
    return 0;
  }
  if (attach) return attach(to);
  await tmux(["select-window", "-t", to]).catch(() => {});
  return spawnSync(TMUX, ["attach-session", "-t", `=${session}`], { stdio: "inherit" }).status ?? 0;
}
