// Overhaul's CLI (`overhaul`): agent side, the hub and its bridge, and the admin commands.
// docs/contract.md is the reference; `overhaul help` prints the short version.
// Ticket comes from --project/--ticket or HUB_PROJECT/HUB_TICKET.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ENV_FILE, hubUrls, loadEnvFile, localHost } from "./env.mjs";
import { materialize, withFiles } from "./uploads.mjs";
import { progName, selfCommand } from "./self.mjs";
import { VERSION } from "./version.mjs";

const HELP = `overhaul ${VERSION}

Agentes (HUB_PROJECT / HUB_TICKET o --project / --ticket):
  ask "pregunta" [--blocks X]          pregunta al usuario; la respuesta llega como mensaje
  propose "p1" ["p2" ...] [--blocks X]  preguntas iniciales antes de empezar un ticket
  inbox [--once] [--timeout s]         espera mensajes y los imprime
  restart                              reinicia este agente (tmux u Orca) retomando la conversación
  hook [Evento]                        hook de Claude Code / pi (lee el evento en stdin)

Hub:
  serve                                corre el hub (lo usa el servicio)
  bridge [--host H] [--interval s]     entrega los mensajes de este host en tmux (lo usa el servicio)
  service install|start|stop|restart|status|uninstall [--dry-run]

Instalación:
  init                                 crea config.yaml y env en ~/.overhaul si faltan
  set-password [--no-restart]          contraseña de la página (HUB_TOKEN)
  migrate [--dry-run]                  adopta ~/.config/overhaul, ~/.local/share/overhaul o work-hub
  paths [--json]                       dónde está todo
  install-hooks [--settings F] [--repoint-only]
  install-pi [--dir D]
  helper install [--dry-run]           helper de escritorio (necesita Node)
  update [--check] [--version X.Y.Z]
  version
  config migrate [--dry-run] [--move-data] [--public-url U,..] [--agents-dir D]
  orca-layout`;

const OPTIONS = {
  project: { type: "string" },
  ticket: { type: "string" },
  from: { type: "string" },
  blocks: { type: "string", default: "" },
  once: { type: "boolean", default: false },
  timeout: { type: "string", default: "0" },
  host: { type: "string" },
  interval: { type: "string", default: "3" },
  dir: { type: "string" },
  settings: { type: "string", multiple: true },
  "dry-run": { type: "boolean", default: false },
  "move-data": { type: "boolean", default: false },
  "public-url": { type: "string" },
  "agents-dir": { type: "string" },
  "repoint-only": { type: "boolean", default: false },
  "no-restart": { type: "boolean", default: false },
  "non-interactive": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  file: { type: "string" },
  check: { type: "boolean", default: false },
  version: { type: "string" },
  force: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

let PROG = "overhaul";
let opt;

export async function main(argv) {
  PROG = progName();
  if (argv[0] === "--version" || argv[0] === "-v") argv = ["version"];
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    fail(`${err.message}\n\n${HELP}`);
  }
  opt = parsed.values;
  const [command, ...rest] = parsed.positionals;
  if (!command || command === "help" || opt.help) {
    console.log(HELP);
    process.exit(command || opt.help ? 0 : 2);
  }
  const handler = COMMANDS[command];
  if (!handler) fail(`Comando desconocido: ${command}\n\nUsage: ${PROG} <comando> (${PROG} help)`);
  await handler(rest);
}

const COMMANDS = {
  ask: (rest) => agent("ask", rest),
  propose: (rest) => agent("propose", rest),
  inbox: (rest) => agent("inbox", rest),
  bridge: (rest) => agent("bridge", rest),
  restart,
  "__restart-orca": restartOrcaChild,
  hook: async ([event]) => (await import("./hook.mjs")).runHook(event),
  serve: async () => {
    await import("./server.mjs");
  },
  version: () => {
    console.log(VERSION);
    process.exit(0);
  },
  "install-pi": installPi,
  config: configCommand,
  "orca-layout": orcaLayoutCommand,
  update: updateCommand,
};

// --- Agent side: talks to the hub with HUB_AGENT_TOKEN ------------------------------------------
async function agent(command, rest) {
  loadEnvFile();
  const project = opt.project ?? process.env.HUB_PROJECT;
  const ticket = opt.ticket ?? process.env.HUB_TICKET;
  const from = opt.from ?? process.env.HUB_AGENT_NAME ?? "agente";
  // Comma-separated, tried in order: e.g. the LAN address first, then a tunnel or VPN.
  const HUBS = hubUrls();
  let preferred = 0;
  const TOKEN = process.env.HUB_AGENT_TOKEN;
  if (command !== "bridge" && (!project || !ticket)) fail("Set --project and --ticket (or HUB_PROJECT / HUB_TICKET)");
  if (!TOKEN) fail(`HUB_AGENT_TOKEN is not set (${ENV_FILE})`);

  const base = `/agent/${encodeURIComponent(project)}/${encodeURIComponent(ticket)}`;
  const who = { from, host: localHost(), tmuxPane: process.env.TMUX_PANE ?? "" };
  const deadline = Number(opt.timeout) > 0 ? Date.now() + Number(opt.timeout) * 1000 : Infinity;

  // Network errors move on to the next hub URL; HTTP errors come from a reachable hub.
  async function call(method, pathAndQuery, payload) {
    let res;
    let lastErr;
    for (let i = 0; i < HUBS.length && !res; i++) {
      const idx = (preferred + i) % HUBS.length;
      try {
        res = await fetch(HUBS[idx] + pathAndQuery, {
          method,
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: payload ? JSON.stringify(payload) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
        preferred = idx;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!res) throw new Error(`ningún hub responde (${HUBS.join(", ")}): ${lastErr?.cause?.code ?? lastErr?.message}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error ?? `HTTP ${res.status}`);
      // A long-running bridge keeps going on request errors; only a bad token stops it.
      err.fatal = command === "bridge" ? res.status === 401 : res.status < 500;
      if (err.fatal) fail(err.message);
      throw err;
    }
    return data;
  }

  // Bytes of a file attached to a message, from whichever hub answers.
  async function download(id) {
    let lastErr;
    for (const hub of HUBS) {
      try {
        const res = await fetch(`${hub}/agent/upload/${id}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`no pude bajar el adjunto ${id}: ${lastErr?.cause?.code ?? lastErr?.message}`);
  }

  async function withRetry(fn) {
    while (Date.now() < deadline) {
      try {
        return await fn();
      } catch (err) {
        console.error(`${err.message}; reintento en 10 s`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    fail("Tiempo de espera agotado sin conexión al hub");
  }

  async function waitMessages() {
    while (Date.now() < deadline) {
      const qs = new URLSearchParams({ wait: "45", from: who.from, host: who.host, pane: who.tmuxPane });
      try {
        const { messages } = await call("GET", `${base}/inbox?${qs}`);
        if (messages.length || opt.once) return messages;
      } catch (err) {
        if (err.fatal) throw err;
        console.error(`hub no responde (${err.message}); reintento en 10 s`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    fail("Tiempo de espera agotado sin respuesta");
  }

  if (command === "bridge") {
    const { runBridge } = await import("./bridge.mjs");
    await runBridge({ host: opt.host ?? localHost(), intervalMs: Number(opt.interval) * 1000, call, download });
  } else if (command === "ask") {
    const text = rest.join(" ").trim();
    if (!text) fail(`Usage: ${PROG} ask "question" [--blocks X]`);
    // Never waits: a process left waiting dies with restarts and kept other messages from
    // arriving. The answer comes like any message, pasted into the ticket's window.
    const q = await withRetry(() => call("POST", `${base}/ask`, { text, blocks: opt.blocks, ...who }));
    console.log(`Pregunta enviada al hub (${q.id}). La respuesta te llegará como mensaje en esta ventana ("[…] Respuesta a ..."); mientras, sigue con lo que no dependa de ella.`);
  } else if (command === "propose") {
    const questions = rest.map((q) => q.trim()).filter(Boolean).map((text) => ({ text, blocks: opt.blocks }));
    if (!questions.length) fail(`Usage: ${PROG} propose "pregunta 1" ["pregunta 2" ...] [--blocks X]`);
    const res = await withRetry(() => call("POST", `${base}/propose`, { questions, ...who }));
    console.log(`${res.questions.length} pregunta(s) propuesta(s) en el hub. El usuario las refina y responde allí; te llegará un mensaje "Preguntas iniciales revisadas" en esta ventana. Hasta entonces no cambies código.`);
  } else {
    do {
      const msgs = await waitMessages();
      for (const m of msgs) {
        const said = m.kind === "answer" ? `Respuesta a "${m.question}": ${m.text}` : `Mensaje: ${m.text}`;
        console.log(withFiles(said, await materialize(m.attachments, download)));
      }
      if (msgs.length) break;
    } while (!opt.once);
  }
}

// From inside the agent: tmux kills this process along with Claude, so say it first.
async function restart() {
  if (!process.env.TMUX_PANE && process.env.ORCA_TERMINAL_HANDLE) return restartOrca();
  if (!process.env.TMUX_PANE) fail(`${PROG} restart solo funciona dentro de una ventana de tmux o una terminal de Orca`);
  const { paneWindow, restartWindow } = await import("./restart.mjs");
  const win = await paneWindow(process.env.TMUX_PANE).catch((err) => fail(err.message));
  console.error(`Reiniciando ${win}; la conversación se retoma sola.`);
  await restartWindow(win).catch((err) => fail(err.message));
  process.exit(0);
}

// Closing the Orca terminal kills everything in it, this process too, so a detached child
// (`overhaul __restart-orca`, its own session, no terminal) closes it and opens the new one.
async function restartOrca() {
  const { currentTerminal } = await import("./orca.mjs");
  const { CONFIG_DIR } = await import("./env.mjs");
  const { spawn } = await import("node:child_process");
  const term = await currentTerminal().catch((err) => fail(err.message));
  const log = path.join(CONFIG_DIR, "orca-restart.log");
  const out = fs.openSync(log, "a");
  const [cmd, ...args] = selfCommand();
  spawn(cmd, [...args, "__restart-orca", JSON.stringify(term)], { detached: true, stdio: ["ignore", out, out] }).unref();
  console.error(`Reiniciando ${term.title} en Orca; la conversación se retoma sola (errores en ${log}).`);
  process.exit(0);
}

async function restartOrcaChild([json]) {
  const term = JSON.parse(json);
  const { restartTerminal } = await import("./orca.mjs");
  try {
    await restartTerminal(term);
    console.error(new Date().toISOString(), "restarted", term.title);
    process.exit(0);
  } catch (err) {
    console.error(new Date().toISOString(), term.title, err.message);
    process.exit(1);
  }
}

// The pi extension, with the command that runs `overhaul hook` filled in. pi loads every file in
// ~/.pi/agent/extensions; a changed file is backed up before it is replaced. The extension
// from before the rename (work-hub.ts) is moved out too, or pi would load it twice.
async function installPi() {
  const { installPiExtension } = await import("./hooks.mjs");
  const res = installPiExtension({ dir: opt.dir ?? path.join(os.homedir(), ".pi/agent/extensions"), command: selfCommand() });
  for (const line of res.log) console.log(line);
  process.exit(0);
}

// Admin commands below need the yaml package (bundled in the executable), unlike the agent ones.
async function configCommand([sub]) {
  if (sub !== "migrate") fail(`Usage: ${PROG} config migrate [--file F] [--dry-run] [--move-data] [--public-url U,..] [--agents-dir D]`);
  const { CONFIG_DIR, expandHome } = await import("./env.mjs");
  const { migrateConfigFile, repoHasLane } = await import("./configmigrate.mjs");
  const file = opt.file ?? path.join(CONFIG_DIR, "config.yaml");
  const res = migrateConfigFile(file, {
    dryRun: opt["dry-run"],
    moveData: opt["move-data"],
    publicUrls: opt["public-url"]?.split(",").map((u) => u.trim()).filter(Boolean),
    agentsDir: opt["agents-dir"],
    repoHasLane: repoHasLane(expandHome),
  });
  for (const n of res.notes) console.error(`- ${n}`);
  if (opt["dry-run"]) process.stdout.write(res.text);
  else if (res.changed) console.error(`${file}: migrado a v2 (respaldo en ${res.backup})`);
  else console.error(`${file}: sin cambios`);
  process.exit(0);
}

async function orcaLayoutCommand() {
  const { loadConfig, orcaLayout } = await import("./config.mjs");
  const cfg = loadConfig();
  // Without public_url the hub link is this machine's loopback: wrong on the helper's machine.
  if (!cfg.publicUrls.some((u) => !/\/\/(127\.0\.0\.1|localhost)[:/]?/.test(u))) console.error("aviso: config.yaml no tiene public_url; el layout apunta a 127.0.0.1, que solo sirve si el helper corre en esta misma máquina");
  console.log(JSON.stringify(orcaLayout(cfg), null, 2));
  process.exit(0);
}

async function updateCommand() {
  const { update } = await import("./update.mjs");
  const { sourceRoot } = await import("./self.mjs");
  process.exit(update({ root: sourceRoot(), check: opt.check, version: opt.version }));
}

export function fail(msg) {
  console.error(msg);
  process.exit(2);
}
