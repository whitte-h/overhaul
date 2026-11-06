// Host bridge: polls the hub for messages to this host's projects and pastes each into
// the tmux window named like the ticket (e.g. "abc-177"), or else into the project's
// orchestrator window. Projects with `terminals: orca` get Orca terminals titled like the
// ticket instead (src/orca.mjs). Dependency-free so it runs on any host with node and tmux.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { AGENT_ENV, isPi, markPiWindow, restartWindow } from "./restart.mjs";
import { materialize, withFiles } from "./uploads.mjs";
import { tool } from "./env.mjs";
import * as orca from "./orca.mjs";

const run = promisify(execFile);
const TMUX = tool("tmux", process.env.TMUX_BIN);

const STATUS_EVERY_MS = 10_000;
const PRS_EVERY_MS = 3 * 60_000;
const GH = tool("gh", process.env.GH_BIN);
// Opens every message pasted into an agent; the hub sends its message_tag (an older hub sends
// none: "work-hub").
let TAG = "work-hub";

export async function runBridge({ host, intervalMs, call, download }) {
  console.error(`overhaul bridge for host ${host} (tmux: ${TMUX})`);
  let lastStatus = 0;
  let lastPrs = 0;
  let watching = false;
  for (;;) {
    try {
      // While a live terminal is open the hub holds this request until you type (or 700 ms).
      const wait = watching ? "&wait=700" : "";
      const { projects, actions = [], watch = [], tag } = await call("GET", `/agent/bridge/pending?host=${encodeURIComponent(host)}${wait}`);
      TAG = tag || "work-hub";
      const windows = [...(await listWindows()), ...(await orca.listTerminals(projects.filter(isOrca)))];
      watching = watch.length > 0;
      if (watching) await sendScreens(host, watch, windows, call);
      for (const p of projects) {
        for (const t of p.tickets) await deliver(p, t, windows, call, download);
      }
      if (actions.length) {
        await runActions(host, actions, windows, call, download);
        lastStatus = 0; // report the new state right away
      }
      if (Date.now() - lastPrs >= PRS_EVERY_MS) {
        lastPrs = Date.now();
        for (const p of projects.filter((x) => x.github)) await reportPrs(p, call);
      }
      if (Date.now() - lastStatus >= STATUS_EVERY_MS) {
        lastStatus = Date.now();
        await tmuxDefaults();
        await call("POST", "/agent/bridge/status", { host, windows: await agentStatus(windows) });
      }
    } catch (err) {
      console.error(`bridge: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, watching ? 50 : intervalMs));
  }
}

// Kept on the tmux server (it may have restarted): any Claude opened in a new window renders
// classic so its history scrolls, detached sessions get a usable size instead of 80x24, and
// Shift+Enter reaches Claude as its own key (a new line) when you attach from a terminal.
async function tmuxDefaults() {
  try {
    for (const [k, v] of Object.entries(AGENT_ENV)) await run(TMUX, ["set-environment", "-g", k, v]);
    await run(TMUX, ["set-option", "-g", "default-size", "180x50"]);
    await run(TMUX, ["set-option", "-s", "extended-keys", "on"]);
    const { stdout } = await run(TMUX, ["show-options", "-s", "terminal-features"]);
    if (!stdout.includes("extkeys")) await run(TMUX, ["set-option", "-as", "terminal-features", "xterm*:extkeys"]);
  } catch {} // no tmux server running
}

const isOrca = (p) => p.terminals?.type === "orca";

// What the pane shows, with its colors (-e) and some scrollback, for the page's live terminal.
// Unchanged screens are skipped, but resent every 10 s in case the hub restarted and lost them.
const sentScreens = new Map(); // "session:window" -> { text, at } last sent

async function sendScreens(host, watch, windows, call) {
  const screens = [];
  for (const win of watch) {
    const w = windows.find((x) => `${x.session}:${x.name}` === win);
    if (!w) continue;
    try {
      if (w.backend === "orca") {
        // Orca gives the rendered screen as plain text, without colors or scrollback.
        const text = (await orca.readScreen(w.pane)).replace(/\s+$/, "");
        const last = sentScreens.get(win);
        if (last?.text === text && Date.now() - last.at < 10_000) continue;
        sentScreens.set(win, { text, at: Date.now() });
        screens.push({ win, text, cols: Math.max(0, ...text.split("\n").map((l) => l.length)) });
        continue;
      }
      const [{ stdout: text }, { stdout: cols }] = await Promise.all([
        run(TMUX, ["capture-pane", "-p", "-e", "-t", w.pane, "-S", "-1000"], { maxBuffer: 4 * 1024 * 1024 }),
        run(TMUX, ["display-message", "-p", "-t", w.pane, "#{pane_width}"]),
      ]);
      const trimmed = text.replace(/\s+$/, "");
      const last = sentScreens.get(win);
      if (last?.text === trimmed && Date.now() - last.at < 10_000) continue;
      sentScreens.set(win, { text: trimmed, at: Date.now() });
      screens.push({ win, text: trimmed, cols: Number(cols.trim()) });
    } catch {}
  }
  if (screens.length) await call("POST", "/agent/bridge/screen", { host, screens });
}

// Claude Code shows its version as the pane command (e.g. "2.1.300"); pi shows "pi".
const isAgent = (w) => /^\d+\.\d+\.\d+$/.test(w.command) || w.command === "claude" || w.command === "pi";

// pi draws its editor between two rules: empty and idle, they touch; while it works the top
// one carries a spinner ("── ⠧ Working ───").
const RULE = /^─{20,}$/;
const piWorking = (lines) => lines.find((l) => /^─+ \S+ Working/.test(l.trim()));
const piIdle = (lines) => lines.some((l, i) => RULE.test(l.trim()) && RULE.test((lines[i + 1] ?? "").trim()));

// Reads each agent pane's footer: "✶ Garnishing… (4m 47s · …)" while working,
// "✻ Worked for 5m 9s · done 2:29 PM" when finished, a numbered prompt when it needs you.
export function classify(text) {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const recent = lines.slice(-25);
  const pi = piWorking(recent);
  if (pi) return { state: "working", line: pi.trim().replace(/^─+\s*|\s*─+$/g, "").slice(0, 120) };
  if (recent.some((l) => /Do you want to|Would you like to proceed|❯ 1\. Yes/.test(l))) return { state: "needs_input", line: "Esperando tu permiso" };
  // Other dialogs (settings, setup wizards) show a key hint instead of numbered options.
  if (recent.slice(-4).some((l) => /Enter to (continue|confirm|select|submit)|Esc to (cancel|go back|exit)/.test(l))) return { state: "needs_input", line: "Claude espera una respuesta" };
  const status = [...recent].reverse().find((l) => /^\s*[✻✢✶✳✽✺·*]\s+\S/.test(l));
  if (status && /…/.test(status) && /\(/.test(status)) return { state: "working", line: status.trim().slice(0, 120) };
  return { state: "idle", line: status?.trim().slice(0, 120) ?? "" };
}

async function agentStatus(windows) {
  const out = [];
  const agents = windows.filter(isAgent);
  const states = agents.some((w) => w.backend === "orca") ? await orca.agentStates().catch(() => new Map()) : null;
  for (const w of agents) {
    try {
      const stdout = w.backend === "orca"
        ? await orca.readScreen(w.pane)
        : (await run(TMUX, ["capture-pane", "-p", "-J", "-t", w.pane, "-S", "-60"])).stdout;
      const state = w.backend === "orca" ? orca.mergeState(classify(stdout), states.get(w.paneKey)) : classify(stdout);
      out.push({ session: w.session, name: w.name, ...state, tail: stdout.replace(/\s+$/, "").split("\n").slice(-40).join("\n") });
    } catch {}
  }
  return out;
}

const spawned = new Set(); // "project/KEY" started here and not yet given their intro

async function deliver(p, t, windows, call, download) {
  const own = windows.find((w) => w.name.toLowerCase() === t.key.toLowerCase());
  if (!own && t.spawn) {
    await (isOrca(p) ? spawnOrcaWorker(p, t) : spawnWorker(p, t));
    return; // next round: paste once its Claude is ready
  }
  const orq = !own && p.orchestrator ? windows.find((w) => `${w.session}:${w.name}` === p.orchestrator) : null;
  const target = own ?? orq;
  if (!target) return; // stays queued until a window for it exists
  if (!(await ready(target))) return; // Claude still starting or busy with a dialog
  const id = `${p.id}/${t.key}`;
  const intro = own && spawned.has(id) ? workerIntro(t, own) : "";
  spawned.delete(id);
  const lines = [];
  for (const m of t.messages) {
    const said = m.kind === "answer" ? `Respuesta a "${m.question}": ${m.text}` : m.text;
    const body = withFiles(said, await materialize(m.attachments, download));
    lines.push(own ? `[${TAG}] ${body}` : `[${TAG}] Ticket ${t.key} (sin ventana propia; atiéndelo o abre un worker): ${body}`);
  }
  const text = intro + lines.join("\n");
  await send(target, text);
  await call("POST", "/agent/bridge/ack", { project: p.id, key: t.key, ids: t.messages.map((m) => m.id), via: `${target.session}:${target.name}` });
  console.error(`delivered ${t.messages.length} message(s) for ${p.id}/${t.key} to ${target.session}:${target.name}`);
}

// Open PRs plus those merged in the last 30 days for the project's GitHub owner,
// using this host's gh login (it is the one with access to the client's org).
async function reportPrs(p, call) {
  const fields = "number,title,url,state,isDraft,repository,body";
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const queries = [
    ["search", "prs", "--owner", p.github.owner, "--state", "open", "--limit", "100", "--json", fields],
    ["search", "prs", "--owner", p.github.owner, "--merged-at", `>=${since}`, "--limit", "100", "--json", fields],
  ];
  const prs = [];
  for (const q of queries) {
    try {
      const { stdout } = await run(GH, q, { maxBuffer: 20 * 1024 * 1024 });
      prs.push(...JSON.parse(stdout));
    } catch (err) {
      console.error(`bridge: gh for ${p.id}: ${String(err.stderr || err.message).trim().split("\n").pop()}`);
      return;
    }
  }
  // Only the ticket-like keys of each PR travel to the hub, not whole bodies.
  const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
  const slim = prs.map((pr) => ({
    number: pr.number, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft, repo: pr.repository?.name,
    keys: [...new Set(`${pr.title}\n${pr.body ?? ""}`.toUpperCase().match(KEY_RE) ?? [])].slice(0, 30),
  }));
  await call("POST", "/agent/bridge/prs", { project: p.id, prs: slim });
}

// One agent per ticket, in a tmux window named after it (e.g. abc-185). The project's config
// picks the agent (worker.command). pi gets a fixed session id so `hub restart` resumes it.
async function spawnWorker(p, t) {
  const id = `${p.id}/${t.key}`;
  if (spawned.has(id)) return;
  const dir = t.spawn.dir.replace(/^~(?=\/|$)/, process.env.HOME);
  const name = t.key.toLowerCase();
  const session = t.spawn.session;
  const hasSession = await run(TMUX, ["has-session", "-t", `=${session}`]).then(() => true, () => false);
  const pi = isPi(t.spawn.command);
  const piSession = pi ? randomUUID() : null;
  const shellCmd = `zsh -ic '${t.spawn.command}${pi ? ` --session-id ${piSession}` : ""}; exec zsh'`;
  const vars = { HUB_PROJECT: p.id, HUB_TICKET: t.key, HUB_AGENT_NAME: name, ...AGENT_ENV };
  const env = Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const created = hasSession
    ? await run(TMUX, ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${session}:`, "-n", name, "-c", dir, ...env, shellCmd])
    : await run(TMUX, ["new-session", "-d", "-P", "-F", "#{window_id}", "-s", session, "-n", name, "-c", dir, ...env, shellCmd]);
  if (pi) await markPiWindow(created.stdout.trim(), piSession, vars);
  spawned.add(id);
  console.error(`spawned ${session}:${name} in ${dir} for ${id}`);
}

// Same, as an Orca terminal titled like the tmux window would be: in the ticket's repo, or in the
// group's folder workspace when it runs in the project's folder (the layout is built first if
// the project has none in Orca yet). Orca has no per-terminal variables, so the command sets them
// before starting the agent, and what `hub restart` needs is kept next to the hub's config
// (orca.saveRecord).
async function spawnOrcaWorker(p, t) {
  const id = `${p.id}/${t.key}`;
  if (spawned.has(id)) return;
  if (!orca.worktreeOf(p)) throw new Error(`${p.id}: terminals: orca sin worktree`);
  const plan = orca.orcaPlan(p);
  let orq = plan.worktree;
  if (plan.grouped) {
    const ws = await orca.folderWorkspace(plan);
    orq = ws ? `id:folder:${ws}` : (await orca.ensureOrg(p, { log: (m) => console.error(`orca ${p.id}: ${m}`) })).worktree;
  }
  const dir = t.spawn.dir.replace(/^~(?=\/|$)/, process.env.HOME);
  const rec = { ...orca.ticketRecord(p, t.key, { worktree: orca.ticketWorktree(plan, dir, orq), command: t.spawn.command, dir }), sessionId: randomUUID() };
  orca.saveRecord(rec);
  await orca.createTerminal(rec);
  spawned.add(id);
  console.error(`spawned Orca terminal ${rec.title} in ${rec.worktree} for ${id}`);
}

// The project's repos with their role, when it has several or says what each one is for. A ticket
// can touch more than one: the agent works in each one it needs, on the same branch.
function repoLines(repos = []) {
  if (!repos.length || (repos.length === 1 && !repos[0].role && !repos[0].description)) return [];
  const home = process.env.HOME;
  const shown = (p) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  return [
    "Repos del proyecto (un ticket puede tocar varios; en cada uno que cambies, usa la misma rama):",
    ...repos.map((r) => `- ${shown(r.path)}${r.role ? ` (${r.role})` : ""}${r.description ? `: ${r.description}` : ""}`),
  ];
}

export function workerIntro(t, w) {
  const prompt = t.spawn?.prompt ? t.spawn.prompt.replaceAll("{key}", t.key) : "";
  const restart = w.command === "pi"
    ? "Si necesitas reiniciarte, corre `overhaul restart`: retoma esta misma sesión. No reabras la ventana a mano."
    : "Si necesitas reiniciarte (por ejemplo, para cargar un MCP nuevo), corre `overhaul restart`: retoma esta misma conversación. No uses `claude --continue` ni reabras la ventana a mano.";
  return [
    prompt,
    `[${TAG}] Eres el agente del ticket ${t.key}${t.title ? `: ${t.title}` : ""}.`,
    t.url ? `Ticket: ${t.url}` : "",
    "Este proceso es solo para este ticket: haz lo que necesite para completarlo (leer el ticket, repos, PRs, pruebas).",
    ...repoLines(t.spawn?.repos),
    `Antes de planear o cambiar código, propón las preguntas que necesitas para completarlo: overhaul propose "<pregunta 1>" "<pregunta 2>" … y detente. El usuario las refina y responde en el hub; te llega un mensaje "[${TAG}] Preguntas iniciales revisadas" en esta ventana. Si no necesitas ninguna, sáltate este paso.`,
    `Si te falta una decisión o un dato, pregúntale al usuario con: overhaul ask "<pregunta>" --blocks "<qué frena>" (HUB_PROJECT y HUB_TICKET ya están definidos). El comando no espera: la respuesta te llega después como mensaje en esta ventana; mientras, sigue con lo que no dependa de ella.`,
    "Antes de algo irreversible (merge, cambiar el estado del ticket, borrar ramas) confirma por el hub.",
    restart,
    "",
  ].filter((l, i, all) => l || i === all.length - 1).join("\n");
}

// Claude's input prompt (or pi's empty editor) is on screen and no numbered dialog is waiting.
// In Orca, its own agent state also has to say the agent is not mid-turn or waiting on you.
async function ready(w) {
  try {
    if (w.backend === "orca") {
      const agent = (await orca.agentStates()).get(w.paneKey);
      if (agent && agent.state !== "done" && agent.state !== "idle") return false;
    }
    const stdout = w.backend === "orca" ? await orca.readScreen(w.pane) : (await run(TMUX, ["capture-pane", "-p", "-t", w.pane])).stdout;
    // The classic renderer draws from the top, so a tall window ends in blank lines.
    const lines = stdout.replace(/\s+$/, "").split("\n").slice(-25);
    const tail = lines.join("\n");
    if (/Do you trust|Do you want to|❯ 1\.|Enter to (continue|confirm|select|submit)|Esc to (cancel|go back|exit)/.test(tail)) return false;
    if (piWorking(lines)) return false;
    return /^\s*❯/m.test(tail) || /^│ >/m.test(tail) || piIdle(lines);
  } catch {
    return false;
  }
}

// Things you did from the page on a specific window: send it text, or press a key
// (a permission choice like "1", or Escape).
async function runActions(host, actions, windows, call, download) {
  const done = [];
  for (const a of actions) {
    const w = windows.find((x) => `${x.session}:${x.name}` === a.win);
    if (!w) continue; // window gone or not up yet; keep it queued
    if (w.backend === "orca") {
      await orcaAction(w, a, download).catch((err) => console.error(`${a.kind} ${a.win}: ${err.message}`));
      done.push(a.id);
      continue;
    }
    if (a.kind === "text") await paste(w.pane, withFiles(a.value, await materialize(a.attachments, download)));
    else if (a.kind === "input") await typeInto(w.pane, a.value);
    else if (a.kind === "restart") await restartWindow(a.win).catch((err) => console.error(`restart ${a.win}: ${err.message}`));
    else if (a.kind === "close") await run(TMUX, ["kill-window", "-t", w.pane]);
    else await run(TMUX, ["send-keys", "-t", w.pane, a.value]);
    done.push(a.id);
  }
  if (done.length) await call("POST", "/agent/bridge/ack-actions", { host, ids: done });
}

async function orcaAction(w, a, download) {
  if (a.kind === "text") await orca.sendText(w.pane, withFiles(a.value, await materialize(a.attachments, download)));
  else if (a.kind === "input") {
    for (const i of a.value) {
      if (i.t === "key") await orca.sendKey(w.pane, i.v);
      else await orca.sendText(w.pane, i.v, { enter: false, paste: i.t === "paste" });
    }
  } else if (a.kind === "restart") await orca.restartTerminal({ handle: w.pane, worktree: w.worktree, title: w.name });
  else if (a.kind === "close") await orca.closeTerminal(w.pane);
  else await orca.sendKey(w.pane, a.value);
}

// A message into a window: tmux paste, or an Orca prompt.
const send = (w, text) => (w.backend === "orca" ? orca.sendText(w.pane, text) : paste(w.pane, text));

async function listWindows() {
  try {
    // Printable separator: newer tmux escapes control characters such as tabs in -F output.
    const { stdout } = await run(TMUX, ["list-windows", "-a", "-F", "#{session_name}|||#{window_name}|||#{pane_id}|||#{pane_current_command}"]);
    return stdout.trim().split("\n").filter(Boolean).map((l) => {
      const [session, name, pane, command] = l.split("|||");
      return { session, name, pane, command };
    }).filter((w) => !w.session.startsWith("hub-")); // views that Orca terminals attach through (helper/attach.mjs)
  } catch {
    return []; // no tmux server running
  }
}

// Keys you type in the page's live terminal, in order: literal text, a paste, or a named key.
async function typeInto(pane, items) {
  for (const i of items) {
    if (i.t === "text") await run(TMUX, ["send-keys", "-l", "-t", pane, i.v]);
    else if (i.t === "paste") await paste(pane, i.v, false);
    else await run(TMUX, ["send-keys", "-t", pane, i.v]);
  }
}

// Same sequence the orchestrators use: load-buffer from stdin, bracketed paste, Enter.
async function paste(pane, text, enter = true) {
  const buffer = `overhaul-bridge-${process.pid}`;
  await new Promise((resolve, reject) => {
    const child = execFile(TMUX, ["load-buffer", "-b", buffer, "-"], (err) => (err ? reject(err) : resolve()));
    child.stdin.end(text);
  });
  await run(TMUX, ["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane]);
  if (enter) await run(TMUX, ["send-keys", "-t", pane, "Enter"]);
}
