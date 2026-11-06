import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { hasDetails, listTickets, ticketDetails } from "./adapters/index.mjs";
import { Store, httpError } from "./store.mjs";
import { importJsonTickets } from "./jsonimport.mjs";
import { pasteToTmux, formatForAgent } from "./deliver.mjs";
import { Daily } from "./daily.mjs";
import { AutoWork, capturePane } from "./autowork.mjs";
import { Setup } from "./setup.mjs";
import { allowList } from "./netallow.mjs";
import { Activity, promptOptions } from "./activity.mjs";
import { matchPrs } from "./prs.mjs";
import { materialize, safeName, withFiles } from "./uploads.mjs";
import { CONFIG_DIR, ENV_FILE, NAME, localHost } from "./env.mjs";
import { readAsset } from "./assets.mjs";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
store.nodeId();
// Tickets from the JSON store move into the database once, on the first start that finds them.
try {
  const imp = importJsonTickets(store);
  if (imp.status === "imported") console.log(`tickets JSON importados a SQLite: ${imp.tickets} tickets, ${imp.questions} preguntas, ${imp.messages} mensajes (respaldo en ${imp.backup})`);
  if (imp.status === "skipped") console.warn(`tickets JSON no importados: ${imp.reason}`);
  for (const f of imp.ignored ?? []) if (imp.status === "imported") console.warn(`ignorado (nombre no válido): ${f}`);
} catch (err) {
  console.error(`No pude importar los tickets JSON a ${store.file}: ${err.message}. Los JSON siguen intactos; la base no cambió.`);
  process.exit(1);
}
const TRACKER_TTL_MS = 60_000;
const MAX_WAIT_S = 50;
// Attachments you send to agents; kept a month, then removed at startup.
const UPLOADS = path.join(cfg.dataDir, "uploads");
const MAX_UPLOAD = 25 * 1024 * 1024;
const UPLOAD_DAYS = 30;

const UI_TOKEN = required(cfg.auth.passwordEnv, 12);
const AGENT_TOKEN = required("HUB_AGENT_TOKEN", 24);
// Keyed with a stored random secret: a stolen cookie must not allow offline guessing of a short password.
const SESSION = createHmac("sha256", sessionKey()).update(UI_TOKEN).digest("hex");

// One person uses this hub, so failures are counted globally: after 5 in a row
// every attempt waits 30 s, doubling up to 15 min, until a correct login.
const throttle = { fails: 0, until: 0 };

const trackerCache = new Map(); // project id -> { at, tickets, error }
const detailsCache = new Map(); // "project/KEY" -> { at, data }

async function trackerTickets(project, refresh) {
  const hit = trackerCache.get(project.id);
  if (!refresh && hit && Date.now() - hit.at < TRACKER_TTL_MS) return hit;
  let entry;
  try {
    entry = { at: Date.now(), tickets: project.tracker ? await listTickets(project.tracker) : [], error: null };
  } catch (err) {
    entry = { at: Date.now(), tickets: hit?.tickets ?? [], error: err.message };
  }
  trackerCache.set(project.id, entry);
  return entry;
}

// For daily and auto_work: a failed tracker read must not look like "no tickets".
async function ticketsFor(project, refresh) {
  const { tickets, error } = await trackerTickets(project, refresh);
  if (error) throw httpError(502, `${project.name}: ${error}`);
  return tickets;
}
const daily = new Daily(cfg, store, ticketsFor);
const autoWork = new AutoWork(cfg, store, ticketsFor);
const projectById = (id) => cfg.projects.find((p) => p.id === id);
const bridges = new Map(); // host -> last poll time
const hostWindows = new Map(); // host -> { at, windows: [{ session, name, state, line, tail }] }
const activity = new Activity(cfg.dataDir);
const windowActions = new Map(); // host -> [{ id, win, kind: "text" | "keys", value }]
let actionSeq = 0;
// Live terminal: windows someone is looking at, and their latest screen from the bridge.
const watching = new Map(); // "host|session:window" -> last time the page asked for it
const screens = new Map(); // "host|session:window" -> { at, text, cols }
const WATCH_MS = 5000;
const watchedOn = (host) => [...watching].filter(([k, at]) => k.startsWith(`${host}|`) && Date.now() - at < WATCH_MS).map(([k]) => k.slice(host.length + 1));
const projectPrs = new Map(); // project id -> { at, prs: [{ number, title, url, state, isDraft, repo, body }] }

// What the bridge needs to start a ticket's own Claude: title and link for its intro, and
// the folder (the ticket group's repo when mapped, else the project's worker dir).
function pendingWithSpawn(p) {
  const tracker = trackerCache.get(p.id)?.tickets ?? [];
  return store.pending(p.id).map((t) => {
    const info = tracker.find((x) => x.key === t.key) ?? {};
    const repo = p.autoWork.repoByGroup[String(info.group ?? "").toLowerCase()];
    return {
      ...t,
      title: info.title ?? "",
      url: info.url ?? "",
      spawn: p.worker ? { dir: repo ?? p.worker.dir, command: p.worker.command, prompt: p.worker.prompt, session: p.orchestrator?.split(":")[0] ?? p.id, repos: p.repoInfo } : null,
    };
  });
}

const prsFor = (projectId, key) => matchPrs(projectPrs.get(projectId)?.prs ?? [], key);

// What the page needs about one agent window: state, permission choices, last exchanges.
function windowView(host, w) {
  const win = `${w.session}:${w.name}`;
  const view = { host, name: win, state: w.state, line: w.line, recent: activity.recent(host, win, 4) };
  if (w.state === "needs_input") Object.assign(view, promptOptions(w.tail));
  return view;
}

function queueAction(host, win, kind, value, attachments = []) {
  const list = windowActions.get(host) ?? [];
  list.push({ id: String(++actionSeq), win, kind, value, attachments });
  windowActions.set(host, list);
  for (const wake of actionWaiters.get(host) ?? []) wake();
}

// While you type in a live terminal the bridge long-polls (?wait=ms), so keys go out at once.
const actionWaiters = new Map(); // host -> Set of resolvers
function waitForActions(host, ms) {
  if ((windowActions.get(host) ?? []).length || !ms) return Promise.resolve();
  return new Promise((resolve) => {
    const set = actionWaiters.get(host) ?? new Set();
    actionWaiters.set(host, set);
    const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

// Keys typed in the page's terminal: literal text, pasted text, or one named tmux key.
const INPUT_KEY = /^(Enter|S-Enter|M-Enter|BSpace|DC|Up|Down|Left|Right|Tab|BTab|Escape|Home|End|PPage|NPage|Space|C-[a-z])$/;
function inputItems(list) {
  if (!Array.isArray(list) || !list.length || list.length > 200) throw httpError(400, "Bad input");
  return list.map((i) => {
    const v = String(i?.v ?? "");
    if (i?.t === "key" && INPUT_KEY.test(v)) return { t: "key", v };
    if ((i?.t === "text" || i?.t === "paste") && v && v.length <= 20_000) return { t: i.t, v };
    throw httpError(400, "Bad input");
  });
}

// Agent windows the host bridge reported for this project (its orchestrator's tmux session).
function projectWindows(p) {
  const hw = hostWindows.get(p.host);
  if (!hw || Date.now() - hw.at > 60_000) return [];
  const session = p.orchestrator?.split(":")[0];
  return hw.windows.filter((w) => !session || w.session === session);
}
// Daily, AutoWork and Setup keep a reference to `cfg`, so reload in place.
const setup = new Setup(cfg, ticketsFor, () => Object.assign(cfg, loadConfig()));

async function state(refresh) {
  const stored = store.listStored();
  const projects = await Promise.all(
    cfg.projects.map(async (p) => {
      const { tickets, error } = await trackerTickets(p, refresh);
      const byKey = new Map(tickets.map((t) => [t.key, { ...t, inTracker: true }]));
      // Tickets with hub-only state (closed upstream, or added by an agent) stay visible.
      for (const s of stored.filter((s) => s.project === p.id)) {
        if (!byKey.has(s.key)) byKey.set(s.key, { key: s.key, title: "", status: "", url: null, inTracker: false });
      }
      const windows = projectWindows(p);
      const list = [...byKey.values()].map((t) => {
        const s = store.get(p.id, t.key);
        const w = windows.find((x) => x.name.toLowerCase() === t.key.toLowerCase());
        return {
          ...t,
          notes: s.notes,
          questions: s.questions,
          pending: s.inbox.filter((m) => !m.consumedAt).length,
          agent: s.agent,
          listening: store.listening(p.id, t.key),
          auto: s.auto ?? null,
          window: w ? windowView(p.host, w) : null,
          prs: prsFor(p.id, t.key),
          relayed: activity.recent(p.host, `ticket:${t.key}`, 4),
          autoBlocker: p.autoWork.enabled ? autoWork.ticketBlocker(p, t) : null,
        };
      });
      return {
        id: p.id,
        name: p.name,
        host: p.host,
        chromeProfile: p.chromeProfile,
        links: p.links,
        trackerType: p.tracker?.type,
        orchestrator: p.orchestrator ?? null,
        terminal: p.terminals?.type ?? "tmux",
        // Orca terminals in this hub's own Orca: "follow in Orca" works without the helper.
        orcaLocal: p.terminals?.type === "orca" && p.host === localHost(),
        createTickets: p.createTickets,
        error,
        bridge: bridgeUp(p.host),
        windows: windows.map((w) => windowView(p.host, w)),
        daily: { enabled: p.daily.enabled, at: p.daily.at, latest: daily.latest(p.id)?.date ?? null },
        autoWork: { enabled: p.autoWork.enabled, blocker: autoWork.blocker(p), statuses: p.autoWork.statuses },
        tickets: list,
      };
    }),
  );
  return { projects, setup: await setup.questions(), chromeHelper: cfg.chromeHelper, orcaHere: projects.some((p) => p.orcaLocal), name: NAME };
}

const bridgeUp = (host) => Date.now() - (bridges.get(host) ?? 0) < 30_000;

// After queueing, push straight into tmux if no agent is long-polling for it.
// `live` is whether an agent was long-polling before the message was queued.
async function deliver(project, key, live) {
  if (live) return "inbox";
  const t = store.get(project, key);
  const pending = t.inbox.filter((m) => !m.consumedAt);
  if (pending.length && (await pasteToTmux(t.agent, formatForAgent(await withLocalFiles(pending), cfg.messageTag)))) {
    store.take(t);
    return "tmux";
  }
  return bridgeUp(projectById(project).host) ? "bridge" : "queued";
}

// The hub's own host: attachments are copied from its store to where the agents read them.
async function withLocalFiles(msgs) {
  return Promise.all(msgs.map(async (m) => ({ ...m, text: withFiles(m.text, await materialize(m.attachments, uploadBytes)) })));
}

const uploadFile = (id) => path.join(UPLOADS, id);
const uploadBytes = async (id) => fs.readFileSync(uploadFile(id));

// [{id, name}] from the page, each one an upload this hub holds.
function attachments(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 10) throw httpError(400, "Bad attachments");
  return list.map((a) => {
    const id = String(a?.id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id) || !fs.existsSync(uploadFile(id))) throw httpError(400, "Unknown attachment");
    return { id, name: safeName(a.name), size: fs.statSync(uploadFile(id)).size };
  });
}

// Text is optional when the message carries files; then the file names stand in for it.
const messageText = (v, files) => (files.length && !String(v ?? "").trim() ? `Adjuntos: ${files.map((f) => f.name).join(", ")}` : text(v));

function pruneUploads() {
  if (!fs.existsSync(UPLOADS)) return;
  const cutoff = Date.now() - UPLOAD_DAYS * 86400_000;
  for (const f of fs.readdirSync(UPLOADS)) {
    const file = path.join(UPLOADS, f);
    if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}

// "Host x" blocks of an ssh config: { x: { hostname, user, proxyjump } }.
function parseSshConfig(text) {
  const blocks = {};
  let cur = null;
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\w+)\s+(.+)$/);
    if (!m || line.trim().startsWith("#")) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "host") blocks[value] = cur = {};
    else if (cur) cur[key] = value;
  }
  return blocks;
}

// A command that works on a computer with no ssh config: full user@address, and -J for the jump.
function sshCommand(name, blocks) {
  const dest = (n) => (blocks[n] ? `${blocks[n].user ? `${blocks[n].user}@` : ""}${blocks[n].hostname ?? n}` : n);
  const jump = blocks[name]?.proxyjump;
  return jump ? `ssh -J ${dest(jump)} ${dest(name)}` : `ssh ${dest(name)}`;
}

const routes = [
  ["GET", /^\/api\/state$/, "ui", async (req, res, _m, url) => send(res, 200, await state(url.searchParams.has("refresh")))],
  ["POST", /^\/api\/t\/([^/]+)\/([^/]+)\/answer$/, "ui", async (req, res, [p, k]) => {
    const b = await body(req);
    const files = attachments(b.attachments);
    const live = store.listening(p, k);
    store.answer(p, k, b.questionId, messageText(b.answer, files), files);
    send(res, 200, { delivery: await deliver(p, k, live) });
  }],
  ["POST", /^\/api\/t\/([^/]+)\/([^/]+)\/status$/, "ui", async (req, res, [p, k]) => {
    const { questionId, status } = await body(req);
    // "dismissed": closed without an answer (nobody waits for it any more); nothing goes to the agent.
    if (!["open", "client", "dismissed"].includes(status)) throw httpError(400, "Bad status");
    send(res, 200, store.setStatus(p, k, String(questionId), status));
  }],
  // `initial`: a question of your own added to the agent's initial round, still to review.
  ["POST", /^\/api\/t\/([^/]+)\/([^/]+)\/question$/, "ui", async (req, res, [p, k]) => {
    const b = await body(req);
    send(res, 200, store.ask(p, k, { text: text(b.text), ...(b.initial ? { status: "proposed", kind: "initial" } : {}) }));
  }],
  ["POST", /^\/api\/t\/([^/]+)\/([^/]+)\/refine$/, "ui", async (req, res, [p, k]) => {
    const b = await body(req);
    send(res, 200, store.refine(p, k, String(b.questionId), { text: text(b.text), blocks: b.blocks == null ? undefined : short(b.blocks) }));
  }],
  // Closes the initial round: answers given here go with it, in one message to the agent.
  ["POST", /^\/api\/t\/([^/]+)\/([^/]+)\/initial\/release$/, "ui", async (req, res, [p, k]) => {
    const b = await body(req);
    const answers = b.answers && typeof b.answers === "object" ? b.answers : {};
    const live = store.listening(p, k);
    const out = store.releaseInitial(p, k, answers);
    send(res, 200, { questions: out.questions, delivery: await deliver(p, k, live) });
  }],
  ["GET", /^\/api\/t\/([^/]+)\/([^/]+)\/history$/, "ui", async (req, res, [p, k], url) => {
    send(res, 200, { events: store.history(p, k, String(url.searchParams.get("questionId") ?? "")) });
  }],
  ["POST", /^\/api\/t\/([^/]+)\/([^/]+)\/message$/, "ui", async (req, res, [p, k]) => {
    const b = await body(req);
    const files = attachments(b.attachments);
    const live = store.listening(p, k);
    store.message(p, k, messageText(b.text, files), files);
    send(res, 200, { delivery: await deliver(p, k, live) });
  }],
  // Raw file in the body, its name in X-File-Name (URI-encoded).
  ["POST", /^\/api\/upload$/, "ui", async (req, res) => {
    const bytes = await readRaw(req, MAX_UPLOAD);
    if (!bytes.length) throw httpError(400, "Empty file");
    const id = randomUUID();
    fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
    fs.writeFileSync(uploadFile(id), bytes, { mode: 0o600 });
    let name = "";
    try { name = decodeURIComponent(String(req.headers["x-file-name"] ?? "")); } catch {}
    send(res, 200, { id, name: safeName(name), size: bytes.length });
  }],
  // The ticket's description and comments from its tracker, cached a minute.
  ["GET", /^\/api\/t\/([^/]+)\/([^/]+)\/details$/, "ui", async (req, res, [p, k]) => {
    const project = projectById(p);
    if (!hasDetails(project.tracker) || !/^[A-Z][A-Z0-9]+-\d+$/.test(k)) return send(res, 200, { supported: false });
    const id = `${p}/${k}`;
    const hit = detailsCache.get(id);
    if (!hit || Date.now() - hit.at > 60_000) detailsCache.set(id, { at: Date.now(), data: await ticketDetails(project.tracker, k) });
    send(res, 200, { supported: true, ...detailsCache.get(id).data });
  }],
  // Plain shells on the agent hosts, for installing or checking things by hand. The SSH config
  // for another computer lives outside the repo (ssh-config in the hub's config folder).
  ["GET", /^\/api\/consoles$/, "ui", async (req, res) => {
    const file = path.join(CONFIG_DIR, "ssh-config");
    const sshConfig = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const blocks = parseSshConfig(sshConfig ?? "");
    const hosts = [...new Set(cfg.projects.map((p) => p.host).filter(Boolean))].map((name) => ({ name, command: sshCommand(name, blocks), local: name === localHost() }));
    send(res, 200, { hosts, sshConfig });
  }],
  ["PUT", /^\/api\/t\/([^/]+)\/([^/]+)\/notes$/, "ui", async (req, res, [p, k]) => {
    const { notes } = await body(req);
    store.setNotes(p, k, String(notes ?? "").slice(0, 50_000));
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/api\/setup\/answer$/, "ui", async (req, res) => {
    const { id, answer } = await body(req);
    send(res, 200, await setup.answer(String(id), answer));
  }],
  ["POST", /^\/api\/setup\/ignore$/, "ui", async (req, res) => {
    setup.ignore(String((await body(req)).id));
    send(res, 200, { ok: true });
  }],
  ["GET", /^\/api\/daily\/([^/]+)$/, "ui", async (req, res, [p]) => send(res, 200, daily.latest(p) ?? { date: null, markdown: "" })],
  ["POST", /^\/api\/daily\/([^/]+)$/, "ui", async (req, res, [p]) => send(res, 200, await daily.generate(projectById(p)))],
  ["GET", /^\/api\/t\/([^/]+)\/([^/]+)\/pane$/, "ui", async (req, res, [p, k]) => {
    const agent = store.get(p, k).agent;
    // Pane ids are per machine; another host's pane id could match an unrelated local pane.
    const local = agent?.host === localHost() ? await capturePane(agent.tmuxPane) : null;
    const reported = projectWindows(projectById(p)).find((w) => w.name.toLowerCase() === k.toLowerCase())?.tail ?? null;
    send(res, 200, { text: local ?? reported });
  }],
  ["POST", /^\/api\/t\/([^/]+)\/([^/]+)\/launch$/, "ui", async (req, res, [p, k]) => {
    const project = projectById(p);
    const ticket = (await ticketsFor(project, false)).find((t) => t.key === k) ?? { key: k, title: "", url: null };
    const blocker = autoWork.ticketBlocker(project, ticket);
    if (blocker) throw httpError(409, `auto_work: ${blocker}`);
    autoWork.reset(p, k);
    await autoWork.launch(project, ticket);
    send(res, 200, store.get(p, k).auto);
  }],
  // "Follow in Orca" for projects with Orca terminals: the hub finds (or creates, layout first)
  // the terminal of the ticket or of the orchestrator in the Orca of this machine and returns
  // { runtimeId, handle }; the page hands it to the desktop helper, which switches its Orca
  // (paired with this one) to it. Only this machine's Orca: hubs never reach each other.
  ["POST", /^\/api\/orca\/([^/]+)\/focus$/, "ui", async (req, res, [p]) => {
    const project = projectById(p);
    if (project.terminals?.type !== "orca") throw httpError(409, `${p} no usa terminales de Orca`);
    if (project.host !== localHost()) throw httpError(409, `${p} corre en ${project.host}, no en este hub`);
    const b = await body(req);
    const key = b.key ? short(b.key) : null;
    let spawn = null;
    if (key && project.worker) {
      const info = (trackerCache.get(p)?.tickets ?? []).find((t) => t.key === key) ?? {};
      spawn = { command: project.worker.command, dir: project.autoWork.repoByGroup[String(info.group ?? "").toLowerCase()] ?? project.worker.dir };
    }
    const orca = await import("./orca.mjs");
    try {
      await orca.ensureOrcaRunning();
      // No hub tab from here: this page is already open (often in Orca's own browser).
      // `overhaul terminal` builds the layout with it.
      const target = await orca.focusTerminal(project, key, { spawn, log: (m) => console.log(`orca ${p}: ${m}`) });
      // Orca with a window here (standalone: hub and desktop Orca on one machine) switches now;
      // a server (orca serve) has no window, and the page asks the desktop helper instead.
      const sw = await orca.orca(["terminal", "switch", "--terminal", target.handle]).catch(() => null);
      send(res, 200, { ...target, navigated: sw?.focus?.navigated === true });
    } catch (err) {
      throw httpError(502, err.message);
    }
  }],
  // The other way: the agent terminal Orca's window shows here (standalone), so the page follows
  // what you pick in Orca. Kept a second: every open page asks.
  ["GET", /^\/api\/orca\/focus$/, "ui", async (req, res) => {
    if (Date.now() - orcaFocus.at > 1000) {
      const projects = cfg.projects.filter((p) => p.terminals?.type === "orca" && p.host === localHost())
        .map((p) => ({ ...p, session: p.orchestrator?.split(":")[0] ?? p.id }));
      const orca = await import("./orca.mjs");
      const hit = projects.length ? await orca.focusedAgent(projects).catch(() => null) : null;
      const p = hit && projects.find((x) => x.id === hit.project);
      orcaFocus.at = Date.now();
      orcaFocus.value = hit && {
        project: hit.project,
        // The orchestrator's terminal is the project's chat; any other is the ticket of that key.
        key: hit.title === orca.orcaPlan(p).orchestrator.title ? null : hit.title,
      };
    }
    send(res, 200, { focus: orcaFocus.value });
  }],
  ["GET", /^\/agent\/bridge\/pending$/, "agent", async (req, res, _m, url) => {
    const host = short(url.searchParams.get("host"));
    bridges.set(host, Date.now());
    await waitForActions(host, Math.min(Number(url.searchParams.get("wait")) || 0, 1500));
    bridges.set(host, Date.now());
    const projects = cfg.projects.filter((p) => p.host === host);
    send(res, 200, {
      projects: projects.map((p) => ({
        id: p.id, orchestrator: p.orchestrator, github: p.github, tickets: pendingWithSpawn(p),
        // Orca terminals are listed under the project's tmux session name, like its windows.
        terminals: p.terminals, session: p.orchestrator?.split(":")[0] ?? p.id,
      })),
      actions: windowActions.get(host) ?? [],
      watch: watchedOn(host),
      tag: cfg.messageTag,
    });
  }],
  // For `overhaul doctor`: which bridges reported lately (ms ago) and this hub's own host name.
  ["GET", /^\/agent\/bridge\/seen$/, "agent", async (req, res) => {
    send(res, 200, { host: localHost(), hosts: Object.fromEntries([...bridges].map(([h, at]) => [h, Date.now() - at])) });
  }],
  ["POST", /^\/agent\/bridge\/status$/, "agent", async (req, res) => {
    const b = await body(req);
    const windows = (Array.isArray(b.windows) ? b.windows : []).slice(0, 50).map((w) => ({
      session: short(w.session), name: short(w.name), state: short(w.state), line: short(w.line), tail: String(w.tail ?? "").slice(-8000),
    }));
    hostWindows.set(short(b.host), { at: Date.now(), windows });
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/agent\/bridge\/prs$/, "agent", async (req, res) => {
    const b = await body(req);
    if (!projectById(b.project)) throw httpError(404, "Unknown project");
    const prs = (Array.isArray(b.prs) ? b.prs : []).slice(0, 300).map((pr) => ({
      number: Number(pr.number), title: short(pr.title), url: String(pr.url ?? "").startsWith("https://github.com/") ? String(pr.url) : "",
      state: short(pr.state), isDraft: !!pr.isDraft, repo: short(pr.repo),
      keys: (Array.isArray(pr.keys) ? pr.keys : []).slice(0, 30).map((k) => short(k).toUpperCase()),
    })).filter((pr) => pr.url);
    projectPrs.set(b.project, { at: Date.now(), prs });
    send(res, 200, { ok: true });
  }],
  // Screens of watched panes (tmux capture with colors), sent only when they change.
  ["POST", /^\/agent\/bridge\/screen$/, "agent", async (req, res) => {
    const b = await body(req, 2 * 1024 * 1024);
    for (const sc of (Array.isArray(b.screens) ? b.screens : []).slice(0, 10)) {
      screens.set(`${short(b.host)}|${short(sc.win)}`, { at: Date.now(), text: String(sc.text ?? "").slice(-400_000), cols: Number(sc.cols) || 0 });
    }
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/agent\/bridge\/ack-actions$/, "agent", async (req, res) => {
    const b = await body(req);
    const done = new Set((b.ids ?? []).map(String));
    windowActions.set(short(b.host), (windowActions.get(short(b.host)) ?? []).filter((a) => !done.has(a.id)));
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/agent\/hook$/, "agent", async (req, res) => {
    const b = await body(req);
    const win = `${short(b.session)}:${short(b.window)}`;
    activity.record(short(b.host), win, { event: short(b.event), text: String(b.text ?? "").slice(0, 20_000) });
    send(res, 200, { ok: true });
  }],
  ["GET", /^\/api\/activity$/, "ui", async (req, res, _m, url) => {
    const q = url.searchParams;
    send(res, 200, { entries: activity.recent(short(q.get("host")), short(q.get("win")), Math.min(Number(q.get("limit") ?? 50), 300)) });
  }],
  // The page polls this while a terminal is on screen; asking is what makes the bridge send it.
  ["GET", /^\/api\/screen$/, "ui", async (req, res, _m, url) => {
    const key = `${short(url.searchParams.get("host"))}|${short(url.searchParams.get("win"))}`;
    watching.set(key, Date.now());
    const sc = screens.get(key);
    send(res, 200, sc ? { ...sc, live: bridgeUp(key.split("|")[0]) } : { text: null, live: bridgeUp(key.split("|")[0]) });
  }],
  ["POST", /^\/api\/window\/send$/, "ui", async (req, res) => {
    const b = await body(req);
    // Messages to a project's general agent carry what it may do, read live from the config.
    const p = cfg.projects.find((x) => x.host === short(b.host) && x.orchestrator === short(b.win));
    const header = p ? `[${cfg.messageTag}] Agente general de ${p.name} · crear tickets: ${p.createTickets ? "permitido" : "NO permitido"}\n` : "";
    const files = attachments(b.attachments);
    queueAction(short(b.host), short(b.win), "text", header + messageText(b.text, files), files);
    send(res, 200, { delivery: bridgeUp(short(b.host)) ? "bridge" : "queued" });
  }],
  ["POST", /^\/api\/window\/input$/, "ui", async (req, res) => {
    const b = await body(req, 64 * 1024);
    queueAction(short(b.host), short(b.win), "input", inputItems(b.items));
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/api\/window\/close$/, "ui", async (req, res) => {
    const b = await body(req);
    queueAction(short(b.host), short(b.win), "close", "");
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/api\/window\/restart$/, "ui", async (req, res) => {
    const b = await body(req);
    queueAction(short(b.host), short(b.win), "restart", "");
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/api\/window\/keys$/, "ui", async (req, res) => {
    const b = await body(req);
    if (!/^([1-9]|Escape|Enter|Up|Down|Left|Right|Tab|BTab|Space)$/.test(String(b.keys))) throw httpError(400, "Bad keys");
    queueAction(short(b.host), short(b.win), "keys", String(b.keys));
    send(res, 200, { ok: true });
  }],
  // No capture group: route captures are read as project/ticket.
  ["GET", /^\/agent\/upload\/[0-9a-f-]{36}$/, "agent", async (req, res, _m, url) => {
    const id = url.pathname.split("/").pop();
    if (!fs.existsSync(uploadFile(id))) throw httpError(404, "Not found");
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(uploadFile(id)).pipe(res);
  }],
  ["POST", /^\/agent\/bridge\/ack$/, "agent", async (req, res) => {
    const b = await body(req);
    if (!projectById(b.project)) throw httpError(404, "Unknown project");
    store.ack(b.project, String(b.key), (b.ids ?? []).map(String), short(b.via));
    send(res, 200, { ok: true });
  }],
  ["POST", /^\/agent\/([^/]+)\/([^/]+)\/ask$/, "agent", async (req, res, [p, k]) => {
    const b = await body(req);
    store.seenAgent(p, k, agentInfo(b));
    send(res, 200, store.ask(p, k, { text: text(b.text), from: short(b.from), blocks: short(b.blocks) }));
  }],
  // The questions an agent needs before it starts (`hub propose`); you review them in the hub.
  ["POST", /^\/agent\/([^/]+)\/([^/]+)\/propose$/, "agent", async (req, res, [p, k]) => {
    const b = await body(req);
    store.seenAgent(p, k, agentInfo(b));
    const list = (Array.isArray(b.questions) ? b.questions : []).slice(0, 30).map((q) => ({ text: text(q?.text), blocks: short(q?.blocks) }));
    send(res, 200, { questions: store.propose(p, k, { questions: list, from: short(b.from) }) });
  }],
  ["GET", /^\/agent\/([^/]+)\/([^/]+)\/inbox$/, "agent", async (req, res, [p, k], url) => {
    const q = url.searchParams;
    store.seenAgent(p, k, agentInfo({ from: q.get("from"), host: q.get("host"), tmuxPane: q.get("pane") }));
    const wait = Math.min(Number(q.get("wait") ?? 0), MAX_WAIT_S);
    const messages = await store.waitFor(p, k, { questionId: q.get("questionId") || null, timeoutMs: wait * 1000 });
    send(res, 200, { messages });
  }],
];

const orcaFocus = { at: 0, value: null };
const allowed = allowList(cfg.allowFrom);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://hub");
  if (!allowed(req.socket.remoteAddress)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (req.method === "POST" && url.pathname === "/login") return login(req, res);
    if (req.method === "GET" && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/agent/")) {
      // The login page and its stylesheet are public; everything else needs a session.
      const open = url.pathname === "/style.css" || url.pathname === "/login.html";
      return staticFile(res, isUi(req) || open ? url.pathname : "/login.html");
    }
    for (const [method, re, auth, handler] of routes) {
      const m = url.pathname.match(re);
      if (!m || req.method !== method) continue;
      if (auth === "ui" && !isUi(req)) throw httpError(401, "Sign in first");
      if (auth === "ui" && method !== "GET" && req.headers["x-hub"] !== "1") throw httpError(403, "Missing X-Hub header");
      if (auth === "agent" && !isAgent(req)) throw httpError(401, "Bad agent token");
      const [p, k] = m.slice(1).map(decodeURIComponent);
      if (p && !cfg.projects.some((x) => x.id === p)) throw httpError(404, `Unknown project ${p}`);
      return await handler(req, res, [p, k], url);
    }
    throw httpError(404, "Not found");
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status ?? 500, { error: err.status ? err.message : "Internal error" });
  }
});

daily.start();
autoWork.start();
pruneUploads();

// An address can be missing for a while (a VPN or DHCP still coming up after boot):
// keep the others serving and retry that one instead of crashing.
for (const host of cfg.bind) {
  const s = host === cfg.bind[0] ? server : http.createServer(server.listeners("request")[0]);
  const listen = () => s.listen(cfg.port, host);
  s.on("listening", () => console.log(`${NAME} on http://${host}:${cfg.port}`));
  s.on("error", (err) => {
    if (err.code !== "EADDRNOTAVAIL") throw err;
    console.warn(`${host} not available yet; retrying in 30 s`);
    setTimeout(listen, 30_000);
  });
  listen();
}

async function login(req, res) {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);
  const token = form.get("token") ?? "";
  // Only a path on this hub: "/x", never "//host" or a full URL.
  const next = /^\/(?!\/)[^\s\\]*$/.test(form.get("next") ?? "") ? form.get("next") : "/";
  if (Date.now() < throttle.until) {
    res.writeHead(303, { location: "/login.html?error=wait" });
    return res.end();
  }
  if (!same(sha256(token), sha256(UI_TOKEN))) {
    throttle.fails++;
    if (throttle.fails >= 5) throttle.until = Date.now() + Math.min(30_000 * 2 ** (throttle.fails - 5), 15 * 60_000);
    console.warn(`login failed (${throttle.fails} in a row)`);
    res.writeHead(303, { location: "/login.html?error=1" });
    return res.end();
  }
  throttle.fails = 0;
  res.writeHead(303, {
    location: next,
    "set-cookie": `hub_session=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}`,
  });
  res.end();
}

const isUi = (req) => same(cookie(req, "hub_session"), SESSION);
const isAgent = (req) => same(sha256((req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), sha256(AGENT_TOKEN));

function cookie(req, name) {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : "";
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

function staticFile(res, pathname) {
  // "/" is the full hub; "/p/<project>" the same page locked to one project (used inside Orca).
  // public/ is read from the executable's assets (or the clone): readAsset refuses ".." and the like.
  const rel = pathname === "/" || /^\/p\/[a-z0-9-]+\/?$/.test(pathname) ? "index.html" : pathname.slice(1);
  const bytes = readAsset(`public/${rel}`);
  if (!bytes) throw httpError(404, "Not found");
  res.writeHead(200, { "content-type": TYPES[path.extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(bytes);
}

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return (await readRaw(req, 64 * 1024)).toString("utf8");
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) reject(httpError(413, max > 64 * 1024 ? `El archivo pasa de ${Math.round(max / 1024 / 1024)} MB` : "Body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function body(req, max = 64 * 1024) {
  try {
    return JSON.parse((await readRaw(req, max)).toString("utf8") || "{}");
  } catch (err) {
    throw err.status ? err : httpError(400, "Invalid JSON");
  }
}

function text(v) {
  const s = String(v ?? "").trim();
  if (!s) throw httpError(400, "Text is required");
  return s.slice(0, 8000);
}

const short = (v) => (v == null ? "" : String(v).slice(0, 120));
const agentInfo = (b) => ({ from: short(b.from), host: short(b.host), tmuxPane: short(b.tmuxPane) });
function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function same(a, b) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function required(name, min) {
  const v = process.env[name];
  if (!v || v.length < min) throw new Error(`${name} must be set (${min}+ chars) in ${ENV_FILE}`);
  return v;
}

function sessionKey() {
  const file = path.join(cfg.dataDir, "session.key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(file, "utf8").trim();
}
