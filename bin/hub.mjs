#!/usr/bin/env node
// Overhaul's CLI (`overhaul`, also installed as `hub`): agent side plus a few admin commands.
//   hub ask "question" [--blocks "what it blocks"]   ask the user; returns at once, the answer
//                                                     arrives later as a message in this window
//   hub propose "q1" ["q2" ...] [--blocks X]         before starting a task: the questions you need;
//                                                     the user refines them in the hub and sends back
//                                                     one message "Preguntas iniciales revisadas"
//   hub inbox [--once]                                wait for answers/messages, print them
//   hub bridge                                        deliver queued messages for this host into tmux
//   hub restart                                       restart this agent (tmux window or Orca terminal), resuming its conversation
//   hub install-pi [--dir D] [--node N]               install the pi extension (pi/overhaul.ts) into ~/.pi/agent/extensions
//   hub config migrate [--dry-run] [--move-data] [--public-url U,..] [--agents-dir D]
//                                                     config.yaml v1 (work-hub) -> v2, with a backup
//   hub orca-layout                                   print the desktop helper's Orca layout from config.yaml
//   hub update [--check] [--version X.Y.Z]            update this installation (release or clone) and restart
//                                                     hub and bridge; --check only says if there is a new version
// Ticket comes from --project/--ticket or HUB_PROJECT/HUB_TICKET.
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ENV_FILE, hubUrls, loadEnvFile, localHost } from "../src/env.mjs";
import { materialize, withFiles } from "../src/uploads.mjs";

loadEnvFile();

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string", default: process.env.HUB_PROJECT },
    ticket: { type: "string", default: process.env.HUB_TICKET },
    from: { type: "string", default: process.env.HUB_AGENT_NAME ?? "agente" },
    blocks: { type: "string", default: "" },
    "no-wait": { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    timeout: { type: "string", default: "0" },
    host: { type: "string", default: localHost() },
    interval: { type: "string", default: "3" },
    dir: { type: "string" },
    node: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "move-data": { type: "boolean", default: false },
    "public-url": { type: "string" },
    "agents-dir": { type: "string" },
    file: { type: "string" },
    check: { type: "boolean", default: false },
    version: { type: "string" },
  },
});

const [command, ...rest] = positionals;
// Comma-separated, tried in order: e.g. the LAN address first, then a tunnel or VPN.
const HUBS = hubUrls();
let preferred = 0;
const TOKEN = process.env.HUB_AGENT_TOKEN;

const PROG = path.basename(process.argv[1] ?? "hub").replace(/\.mjs$/, "");
if (!["ask", "propose", "inbox", "bridge", "restart", "install-pi", "config", "orca-layout", "update"].includes(command)) usage();
if (command === "restart") await restart();
if (command === "install-pi") await installPi();
if (command === "config") await configCommand(rest[0]);
if (command === "orca-layout") await orcaLayoutCommand();
if (command === "update") await updateCommand();
if (command !== "bridge" && (!opt.project || !opt.ticket)) fail("Set --project and --ticket (or HUB_PROJECT / HUB_TICKET)");
if (!TOKEN) fail(`HUB_AGENT_TOKEN is not set (${ENV_FILE})`);

const base = `/agent/${encodeURIComponent(opt.project)}/${encodeURIComponent(opt.ticket)}`;
const who = { from: opt.from, host: localHost(), tmuxPane: process.env.TMUX_PANE ?? "" };
const deadline = Number(opt.timeout) > 0 ? Date.now() + Number(opt.timeout) * 1000 : Infinity;

if (command === "bridge") {
  const { runBridge } = await import("../src/bridge.mjs");
  await runBridge({ host: opt.host, intervalMs: Number(opt.interval) * 1000, call, download });
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
    const msgs = await waitMessages(null);
    for (const m of msgs) {
      const said = m.kind === "answer" ? `Respuesta a "${m.question}": ${m.text}` : `Mensaje: ${m.text}`;
      console.log(withFiles(said, await materialize(m.attachments, download)));
    }
    if (msgs.length) break;
  } while (!opt.once);
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

async function waitMessages(questionId) {
  while (Date.now() < deadline) {
    const qs = new URLSearchParams({ wait: "45", from: who.from, host: who.host, pane: who.tmuxPane });
    if (questionId) qs.set("questionId", questionId);
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

// From inside the agent: tmux kills this process along with Claude, so say it first.
async function restart() {
  if (!process.env.TMUX_PANE && process.env.ORCA_TERMINAL_HANDLE) return restartOrca();
  if (!process.env.TMUX_PANE) fail("hub restart solo funciona dentro de una ventana de tmux o una terminal de Orca");
  const { paneWindow, restartWindow } = await import("../src/restart.mjs");
  const win = await paneWindow(process.env.TMUX_PANE).catch((err) => fail(err.message));
  console.error(`Reiniciando ${win}; la conversación se retoma sola.`);
  await restartWindow(win).catch((err) => fail(err.message));
  process.exit(0);
}

// Closing the Orca terminal kills everything in it, this process too, so a detached child
// (its own session, no terminal) closes it and opens the new one. Its errors go to a log.
async function restartOrca() {
  const { currentTerminal } = await import("../src/orca.mjs");
  const { CONFIG_DIR } = await import("../src/env.mjs");
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const term = await currentTerminal().catch((err) => fail(err.message));
  const log = path.join(CONFIG_DIR, "orca-restart.log");
  const out = fs.openSync(log, "a");
  const mod = new URL("../src/orca.mjs", import.meta.url).href;
  const code = `import(${JSON.stringify(mod)}).then((m) => m.restartTerminal(${JSON.stringify(term)})).then(() => console.error(new Date().toISOString(), "restarted", ${JSON.stringify(term.title)}), (err) => { console.error(new Date().toISOString(), ${JSON.stringify(term.title)}, err.message); process.exit(1); });`;
  spawn(process.execPath, ["--input-type=module", "-e", code], { detached: true, stdio: ["ignore", out, out] }).unref();
  console.error(`Reiniciando ${term.title} en Orca; la conversación se retoma sola (errores en ${log}).`);
  process.exit(0);
}

// The pi extension, with this host's node and hook paths filled in. pi loads every file in
// ~/.pi/agent/extensions; a changed file is backed up before it is replaced. The extension
// from before the rename (work-hub.ts) is moved out too, or pi would load it twice.
async function installPi() {
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  // fnm's per-shell node paths vanish; its default alias stays.
  const fnmDefault = path.join(os.homedir(), ".local/share/fnm/aliases/default/bin/node");
  const node = opt.node ?? (fs.existsSync(fnmDefault) ? fnmDefault : fs.realpathSync(process.execPath));
  const hook = path.join(root, "bin/hub-hook.mjs");
  const text = fs.readFileSync(path.join(root, "pi/overhaul.ts"), "utf8")
    .replace('"__NODE__"', JSON.stringify(node))
    .replace('"__HOOK__"', JSON.stringify(hook));
  const dir = opt.dir ?? path.join(os.homedir(), ".pi/agent/extensions");
  const file = path.join(dir, "overhaul.ts");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(dir, { recursive: true });
  // The backups go next to the folder: pi would try to load anything inside it.
  const legacy = path.join(dir, "work-hub.ts");
  if (fs.existsSync(legacy)) {
    fs.renameSync(legacy, path.join(dir, "..", `work-hub.ts.bak-${stamp}`));
    console.log(`${legacy}: moved out (replaced by overhaul.ts)`);
  }
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (old === text) {
    console.log(`${file}: already installed`);
    process.exit(0);
  }
  if (old !== null) fs.copyFileSync(file, path.join(dir, "..", `overhaul.ts.bak-${stamp}`));
  fs.writeFileSync(file, text);
  console.log(`${file}: installed (node ${node}, hook ${hook}). pi sessions already open load it on /reload or restart.`);
  process.exit(0);
}

// Admin commands below need the yaml package (the hub's node_modules), unlike the agent ones.
async function configCommand(sub) {
  if (sub !== "migrate") fail(`Usage: ${PROG} config migrate [--file F] [--dry-run] [--move-data] [--public-url U,..] [--agents-dir D]`);
  const { CONFIG_DIR, expandHome } = await import("../src/env.mjs");
  const { migrateConfigFile, repoHasLane } = await import("../src/configmigrate.mjs");
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
  const { loadConfig, orcaLayout } = await import("../src/config.mjs");
  const cfg = loadConfig();
  // Without public_url the hub link is this machine's loopback: wrong on the helper's machine.
  if (!cfg.publicUrls.some((u) => !/\/\/(127\.0\.0\.1|localhost)[:/]?/.test(u))) console.error("aviso: config.yaml no tiene public_url; el layout apunta a 127.0.0.1, que solo sirve si el helper corre en esta misma máquina");
  console.log(JSON.stringify(orcaLayout(cfg), null, 2));
  process.exit(0);
}

// The installation this CLI belongs to: node resolves the bin link, so this is app/<version> or the clone.
async function updateCommand() {
  const { fileURLToPath } = await import("node:url");
  const { update } = await import("../src/update.mjs");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(update({ root, check: opt.check, version: opt.version }));
}

function usage() {
  fail(`Usage: ${PROG} ask "question" [--blocks X] | ${PROG} propose "q1" ["q2" ...] [--blocks X] | ${PROG} inbox [--once] [--timeout s] | ${PROG} bridge [--host name] | ${PROG} restart | ${PROG} install-pi [--dir D] [--node N] | ${PROG} config migrate [...] | ${PROG} orca-layout | ${PROG} update [--check] [--version X.Y.Z]`);
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}
