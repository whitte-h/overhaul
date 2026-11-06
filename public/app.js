const POLL_MS = 5000;
let data = { projects: [] };
// /p/<project> is the hub locked to one project, for its tab inside Orca: no project tabs and
// no web terminal (Orca shows the real one beside it, following the selected ticket).
const EMBED = location.pathname.match(/^\/p\/([a-z0-9-]+)/)?.[1] ?? null;
if (EMBED) document.documentElement.classList.add("embedded");
// ?p=<project> opens on that project's tab.
let filter = EMBED ?? (new URLSearchParams(location.search).get("p") || localGet("filter") || "all");
const flashes = new Map(); // ticket id -> message shown under the card
const openDetails = new Set(); // ids of open <details>, kept across re-renders
const lazy = new Map(); // details id -> fetched text (terminal output, daily markdown)
let selectedWin = localGet("win"); // "host|session:window" opened from the windows popover
let openDaily = null; // project id whose daily draft is shown under the metrics
// Selected ticket per project tab ("all" included), remembered across reloads.
const selectedTicket = (() => { try { return JSON.parse(localGet("tickets") || "{}"); } catch { return {}; } })();

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-hub": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Sign in"); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

let lastJson = "";
let lastRender = 0;

// Only rebuild the DOM when something changed (or once a minute for the "hace N min" labels),
// so a tap never lands on a node that was just replaced.
async function load(refresh) {
  try {
    const next = await api("GET", `/api/state${refresh ? "?refresh=1" : ""}`);
    const json = JSON.stringify(next);
    if (json === lastJson && Date.now() - lastRender < 60_000) return;
    lastJson = json;
    lastRender = Date.now();
    data = next;
    if (!data.chromeHelper) document.documentElement.classList.add("no-helper");
    document.documentElement.classList.toggle("orca-here", !!data.orcaHere);
    probeHelper();
    render();
  } catch (err) {
    console.error(err);
  }
}

// Re-rendering while typing would wipe the field, so polls wait until focus leaves.
function busy() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

// What waits on you: open questions and the agent's proposed initial ones.
const openQs = (t) => t.questions.filter((q) => q.status === "open" || q.status === "proposed");
const tid = (p, t) => `${p.id}/${t.key}`;
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
};

// Counts for the current project tab, plus each project's daily draft (a tile that opens it).
// Counts for the project tab you are on (all projects under "Todos"), not for the open ticket.
const scopeProjects = () => data.projects.filter((p) => filter === "all" || p.id === filter);
const scopeLabel = () => (filter === "all" ? "todos los proyectos" : data.projects.find((p) => p.id === filter)?.name ?? filter);

function summaryTiles() {
  const all = scopeProjects().flatMap((p) => p.tickets.map((t) => ({ p, t })));
  const working = scopeProjects().reduce((n, p) => n + p.windows.filter((w) => w.state === "working").length, 0);
  const today = new Date().toLocaleDateString("en-CA");
  return [
    metric("Agentes trabajando", working),
    metric("Bloqueados por ti", all.filter(({ t }) => openQs(t).length).length),
    metric("Preguntas abiertas", all.reduce((n, { t }) => n + openQs(t).length, 0)),
    ...data.projects
      .filter((p) => p.daily.enabled && (filter === "all" || p.id === filter))
      .map((p) =>
        metric(`Daily ${p.name}`, p.daily.latest === today ? "listo" : `a las ${p.daily.at}`, {
          class: `metric daily-tile${openDaily === p.id ? " on" : ""}`,
          role: "button",
          tabindex: "0",
          onclick: () => { openDaily = openDaily === p.id ? null : p.id; if (openDaily) openDetails.add(`daily:${p.id}`); render(); },
        }),
      ),
  ];
}

function metric(label, value, attrs = {}) {
  return h("div", { class: "metric", ...attrs }, h("small", {}, label), h("b", {}, String(value)));
}

function render() {
  if (EMBED) document.getElementById("title").textContent = data.projects.find((p) => p.id === EMBED)?.name ?? EMBED;
  const all = data.projects.flatMap((p) => p.tickets.map((t) => ({ p, t })));
  const inFilter = all.filter(({ p }) => filter === "all" || p.id === filter);

  const dailyProject = data.projects.find((p) => p.id === openDaily);
  document.getElementById("daily-panel").replaceChildren(...(dailyProject ? [dailyCard(dailyProject)] : []));

  document.getElementById("chips").replaceChildren(
    h("button", { class: filter === "all" ? "tab on" : "tab", onclick: () => setFilter("all") }, `Todos · ${all.length}`),
    ...data.projects.map((p) => {
      const blocked = p.tickets.some((t) => openQs(t).length || t.window?.state === "needs_input");
      return h("button", { class: `tab${filter === p.id ? " on" : ""}${blocked ? " alert" : ""}`, onclick: () => setFilter(p.id) }, `${p.name} · ${p.tickets.length}`);
    }),
  );

  document.getElementById("banners").replaceChildren(
    ...data.projects.filter((p) => p.error).map((p) => h("div", { class: "banner" }, `${p.name}: no pude leer ${p.trackerType} (${p.error})`)),
    ...data.projects
      .filter((p) => (filter === "all" || p.id === filter) && p.host && !p.bridge)
      .map((p) => h("div", { class: "banner" }, `${p.name}: el puente de ${p.host} está desconectado; los mensajes quedan en cola.`)),
  );

  const selProject = data.projects.find((p) => p.windows.some((w) => `${w.host}|${w.name}` === selectedWin));
  const sel = selProject?.windows.find((w) => `${w.host}|${w.name}` === selectedWin && w.name !== selProject.orchestrator && !selProject.tickets.some((t) => ticketWindows(selProject, t).includes(w)));
  document.getElementById("window-panel").replaceChildren(...(sel ? [windowPanel(sel, selProject)] : []));

  document.getElementById("setup").replaceChildren(
    // A project with a general agent shows its setup questions in that agent's panel instead.
    ...setupQs().filter((q) => (filter === "all" || q.project === filter) && !data.projects.find((p) => p.id === q.project)?.orchestrator).map((q) => setupCard(q)),
  );

  const setupFlash = document.getElementById("setup-flash");
  setupFlash.textContent = flashes.get("setup") ?? "";

  // Every open ticket assigned to you, grouped by tracker status; agent trouble first inside a group.
  const rank = ({ t }) => (openQs(t).length || t.window?.state === "needs_input" ? 0 : t.window?.state === "working" ? 1 : 2);
  const groups = new Map(); // normalized status -> { label, items }
  for (const item of inFilter) {
    const label = item.t.status || "Fuera del tracker";
    const k = statusKey(label);
    if (!groups.has(k)) groups.set(k, { label, items: [] });
    groups.get(k).items.push(item);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => statusOrder(a) - statusOrder(b)).map(([, g]) => g);
  for (const g of ordered) g.items.sort((a, b) => rank(a) - rank(b));
  const shown = ordered.flatMap((g) => g.items);
  // The chat icon opens the project's own agent (its orchestrator) instead of a ticket.
  const chatProject = data.projects.find((p) => p.id === filter && p.orchestrator);
  const chatOn = !!chatProject && selectedTicket[filter] === CHAT;
  const current = chatOn ? null : shown.find(({ p, t }) => tid(p, t) === selectedTicket[filter]) ?? shown[0];
  // Windows that are neither a ticket's agent nor the orchestrator still get a tab of their own.
  const loose = data.projects
    .filter((p) => filter === "all" || p.id === filter)
    .flatMap((p) => p.windows.filter((w) => w.name !== p.orchestrator && !p.tickets.some((t) => ticketWindows(p, t).includes(w))).map((w) => ({ p, w })));

  popContent.clear();
  document.getElementById("ticket-tabs").replaceChildren(
    ...ordered.map((g) =>
      h("div", { class: "tab-group" },
        h("span", { class: "tab-group-label" }, g.label),
        ...g.items.map(({ p, t }) => {
          const wins = ticketWindows(p, t);
          // Amber when it waits on you, green while an agent works; both can show at once.
          const alert = openQs(t).length || wins.some((w) => w.state === "needs_input") ? " alert" : "";
          const busy = wins.some((w) => w.state === "working") ? " busy" : "";
          return h("button", {
            class: `tab${current && tid(p, t) === tid(current.p, current.t) ? " on" : ""}${alert}${busy}`,
            ...hoverable(tid(p, t), () => ticketPop(p, t, wins)),
            onclick: () => selectTicket(tid(p, t)),
          }, t.key);
        }),
      ),
    ),
    ...(loose.length ? [h("div", { class: "tab-group" },
      h("span", { class: "tab-group-label" }, "Otras ventanas"),
      ...loose.map(({ p, w }) => {
        const key = `${w.host}|${w.name}`;
        const state = w.state === "needs_input" ? " alert" : w.state === "working" ? " busy" : "";
        return h("button", {
          class: `tab${selectedWin === key ? " on" : ""}${state}`,
          ...hoverable(key, () => [windowRow(w, () => toggleWindow(key))]),
          onclick: () => toggleWindow(key),
        }, shortName(w));
      }),
    )] : []),
    ...(chatProject ? [chatButton(chatProject, chatOn)] : []),
  );
  if (hoverTab) showPop(hoverTab);

  const empty = h("p", { class: "empty" }, "No hay tickets abiertos asignados a ti.");
  const view = chatOn ? projectAgentPanel(chatProject) : current ? card(current.p, current.t) : empty;
  document.getElementById("tickets").replaceChildren(view);
  // The summary lives in the general agent's panel; it sits on top only when there is nothing to show.
  document.getElementById("metrics").replaceChildren(...(view === empty ? summaryTiles() : []));
}

const CHAT = "chat";
const orchestratorWindow = (p) => p.windows.find((w) => w.name === p.orchestrator);

const shortName = (w) => w.name.split(":").pop();
// A ticket's agents: its own window (named after the key) plus any extra ones like abc-179-fe.
function ticketWindows(p, t) {
  const k = t.key.toLowerCase();
  return p.windows.filter((w) => { const n = shortName(w).toLowerCase(); return n === k || n.startsWith(`${k}-`); });
}

// Hovering a ticket tab shows its agents in a popover, redrawn with fresh data on each render.
let hoverTab = null; // id of the tab whose popover is open
let hideTimer;
const popContent = new Map(); // tab id -> () => popover children, from the last render

function hoverable(id, content) {
  popContent.set(id, content);
  return {
    "data-tab": id,
    onmouseenter: () => { hoverTab = id; showPop(id); },
    onmouseleave: () => schedulePopHide(),
  };
}

function schedulePopHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePop, 200);
}

function hidePop() {
  clearTimeout(hideTimer);
  hoverTab = null;
  document.getElementById("windows-pop")?.remove();
}

function showPop(id) {
  clearTimeout(hideTimer);
  const anchor = [...document.querySelectorAll("#ticket-tabs [data-tab]")].find((b) => b.dataset.tab === id);
  const content = popContent.get(id);
  if (!anchor || !content) return hidePop();
  let el = document.getElementById("windows-pop");
  if (!el) {
    el = h("div", { id: "windows-pop", class: "pop", onmouseenter: () => clearTimeout(hideTimer), onmouseleave: () => schedulePopHide() });
    document.body.append(el);
  }
  el.replaceChildren(...content().filter(Boolean));
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom + 4}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
}

function windowRow(w, onclick) {
  const [cls, label] = WINDOW_STATE[w.state] ?? WINDOW_STATE.idle;
  return h("button", { class: "pop-row", onclick: () => { hidePop(); onclick(); } },
    h("span", { class: `dot ${cls}` }),
    h("span", { class: "pop-body" },
      h("span", { class: "key" }, shortName(w)), " ", h("span", { class: "pop-what" }, label),
      w.line && h("span", { class: "pop-line" }, w.line),
    ),
  );
}

function ticketPop(p, t, wins) {
  const n = openQs(t).length;
  return [
    h("div", { class: "pop-head" }, h("span", { class: "key" }, t.key), " ", t.title || "(sin título)", filter === "all" && h("span", { class: "faint" }, ` · ${p.name}`)),
    h("div", { class: "sec" }, wins.length ? `Agentes · ${wins.length}` : "Sin agente corriendo"),
    ...wins.map((w) => windowRow(w, () => selectTicket(tid(p, t)))),
    n > 0 && h("div", { class: "meta pop-warn" }, `${n} ${n > 1 ? "preguntas pendientes" : "pregunta pendiente"}`),
  ];
}

function chatButton(p, on) {
  const w = orchestratorWindow(p);
  const state = w?.state === "needs_input" || setupQs(p.id).length ? " alert" : w?.state === "working" ? " busy" : "";
  const btn = h("button", {
    class: `tab chat${on ? " on" : ""}${state}`,
    title: `Agente general de ${p.name} (crear tickets, preguntas del proyecto)`,
    "aria-label": `Agente general de ${p.name}`,
    onclick: () => selectTicket(on ? "" : CHAT),
  });
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>';
  return btn;
}

// The project's general agent: not tied to a ticket, e.g. to create tickets or ask about the project.
function projectAgentPanel(p) {
  const w = orchestratorWindow(p);
  if (!w) {
    return h("section", { class: "card" },
      h("div", { class: "head" }, h("span", { class: "title" }, `Agente general de ${p.name}`), h("span", { class: "badge b-warn" }, "No está corriendo")),
      h("div", { class: "meta" }, p.bridge ? `No encuentro la ventana ${p.orchestrator} en ${p.host}.` : `El puente de ${p.host} está desconectado.`),
      summarySection(),
      setupSection(p),
    );
  }
  const [cls, label] = WINDOW_STATE[w.state] ?? WINDOW_STATE.idle;
  return splitCard(
    h("div", { class: "head" },
      h("span", { class: "title" }, `Agente general de ${p.name}`),
      h("span", { class: `badge ${cls}` }, label),
    ),
    [permissionBox(w), !EMBED && terminalView(w), windowSender(w)],
    [
      summarySection(),
      sideSection("Agente",
        h("div", { class: "meta" }, `${w.name} · ${w.host}`),
        h("div", { class: "meta", title: "create_tickets en la config del proyecto" }, p.createTickets ? "Puede crear tickets" : "No crea tickets"),
        w.state === "working" && w.line && h("div", { class: "meta" }, w.line),
        h("div", { class: "actions" }, orcaButton(p, w), restartButton(w)),
        (helperUp || p.orcaLocal) && h("div", { class: "actions" }, h("button", { title: "Abre en Orca todas las ventanas de agentes del proyecto", onclick: () => reopenAll(p) }, "Reabrir terminales")),
      ),
      devServersSection(p),
      setupSection(p),
      consolesSection(),
    ],
  );
}

function toggleWindow(key) {
  selectedWin = selectedWin === key ? null : key;
  localSet("win", selectedWin ?? "");
  render();
}

function selectTicket(id) {
  selectedTicket[filter] = id;
  localSet("tickets", JSON.stringify(selectedTicket));
  render();
  window.scrollTo({ top: 0 });
  if (followOrca) followInOrca(id);
}

// Orca (on the helper's machine) holds the agents' real terminals; the helper opens or switches to them.
let followOrca = EMBED ? true : localGet("followOrca") === "1";

// The desktop helper (Chrome profiles, Orca, port forwards) runs on one computer, if any. Anywhere
// else (phone, a hub without `helper`) it does not answer: its buttons are hidden and nothing calls it.
// Probed with /ports, which also lists the forwarded dev servers: every 15 s, or every minute
// while it does not answer (each refused probe is a network line in the browser console).
let helperUp = false;
let devPorts = null; // [{ host, port, cwd, state, error? }] from the helper
let helperAt = 0;
function probeHelper() {
  if (!data.chromeHelper || Date.now() - helperAt < (helperUp ? 15_000 : 60_000)) return;
  helperAt = Date.now();
  const settle = (up, list) => {
    const changed = up !== helperUp || JSON.stringify(list) !== JSON.stringify(devPorts);
    helperUp = up;
    devPorts = list;
    document.documentElement.classList.toggle("no-helper", !up);
    if (changed && !busy()) render();
  };
  fetch(`${data.chromeHelper}/ports`, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((list) => settle(true, Array.isArray(list) ? list : null), () => settle(false, null));
}

async function openInOrca(p, w, quiet = false) {
  if (p.terminal === "orca") return focusInOrca(p, w.name === p.orchestrator ? null : shortName(w), quiet);
  if (!helperUp) return;
  try {
    const res = await fetch(`${data.chromeHelper}/terminal?${new URLSearchParams({ project: p.id, host: w.host, win: w.name })}`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
  } catch (e) {
    if (!quiet) toast(`No pude abrir la terminal en Orca (necesita el helper de Overhaul y Orca abierto): ${e.message}`);
  }
}

// Projects with Orca terminals: the hub finds or creates the terminal (orchestrator with key null)
// in its own Orca and switches to it. That Orca has a window when it runs on the same machine
// (standalone); a server's has none, and the helper switches the Orca on this computer, paired
// with it.
async function focusInOrca(p, key, quiet = false) {
  if (!p.orcaLocal && !helperUp) return false;
  try {
    const { runtimeId, handle, navigated } = await api("POST", `/api/orca/${encodeURIComponent(p.id)}/focus`, { key });
    if (navigated) return true;
    if (!helperUp) throw new Error("el Orca del hub no tiene ventana; ábrelo desde el Orca de tu escritorio (helper de Overhaul)");
    const res = await fetch(`${data.chromeHelper}/orca/switch?${new URLSearchParams({ runtimeId: runtimeId ?? "", handle })}`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return true;
  } catch (e) {
    if (!quiet) toast(`No pude abrir la terminal en Orca: ${e.message}`);
    return false;
  }
}

function followInOrca(id) {
  const p = data.projects.find((x) => x.id === filter) ?? data.projects.find((x) => id.startsWith(`${x.id}/`));
  if (!p) return;
  const t = id === CHAT ? null : p.tickets.find((x) => tid(p, x) === id);
  if (p.terminal === "orca") return focusInOrca(p, t?.key ?? null, true);
  const w = id === CHAT ? orchestratorWindow(p) : ticketWindows(p, t ?? { key: "" })[0];
  if (w) openInOrca(p, w, true);
}

const orcaButton = (p, w) => (helperUp || p.orcaLocal) && h("button", { title: "Terminal real en Orca (necesita el helper de Overhaul)", onclick: () => openInOrca(p, w) }, "Abrir en Orca");

// Rebuilds the project in Orca (hub tab and every agent terminal), e.g. after Orca restarted.
async function reopenAll(p) {
  if (p.terminal === "orca") return focusInOrca(p, null).then((ok) => ok && toast(`${p.name} restaurado en Orca`));
  try {
    const res = await fetch(`${data.chromeHelper}/orca/restore?${new URLSearchParams({ project: p.id })}`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    toast(`${p.name} restaurado en Orca`);
  } catch (e) {
    toast(`No pude restaurar ${p.name} en Orca (necesita el helper de Overhaul y Orca abierto): ${e.message}`);
  }
}

// "In Progress", "in-progress" and "IN_PROGRESS" are one group across trackers.
const statusKey = (status) => String(status).toLowerCase().replace(/[-_]+/g, " ").trim();

function statusOrder(key) {
  const order = [/progress|doing|develop/, /review|qa|test/, /ready|selected/, /to ?do|open|new/, /block|hold|wait/, /backlog/, /fuera del tracker/];
  const i = order.findIndex((re) => re.test(key));
  return i === -1 ? 3.5 : i;
}

function setFilter(f) {
  if (EMBED) return;
  filter = f;
  localSet("filter", f);
  render();
}

// A <details> whose body is fetched when opened and kept in `lazy` across re-renders.
function lazyDetails(id, summary, fetchText, extra = []) {
  const body = h("pre", { class: "pre" }, lazy.get(id) ?? "Cargando…");
  const load = async () => {
    try { lazy.set(id, await fetchText()); } catch (e) { lazy.set(id, e.message); }
    body.textContent = lazy.get(id);
  };
  return h("details", {
    open: openDetails.has(id),
    ontoggle: (e) => {
      if (e.target.open) { openDetails.add(id); load(); } else openDetails.delete(id);
    },
  }, h("summary", {}, summary), ...extra, body);
}

function dailyCard(p) {
  const id = `daily:${p.id}`;
  const fetchDaily = async () => (await api("GET", `/api/daily/${enc(p.id)}`)).markdown || "Todavía no hay daily.";
  const generate = async () => {
    lazy.set(id, (await api("POST", `/api/daily/${enc(p.id)}`)).markdown);
    openDetails.add(id);
    lastJson = "";
    load();
  };
  const copy = async () => {
    const text = lazy.get(id) ?? (await fetchDaily());
    try { await navigator.clipboard.writeText(text); flashes.set(id, "Copiado"); } catch { flashes.set(id, "No pude copiar; selecciona el texto"); }
    render();
  };
  return h("section", { class: "card daily wide" },
    h("div", { class: "head" },
      h("span", { class: "title" }, `Daily ${p.name}`),
      h("span", { class: "badge b-idle" }, p.daily.latest ? `último ${p.daily.latest}` : `a las ${p.daily.at}`),
    ),
    h("div", { class: "actions" }, h("button", { onclick: generate }, "Generar ahora"), h("button", { onclick: copy }, "Copiar")),
    flashes.has(id) && h("div", { class: "flash" }, flashes.get(id)),
    lazyDetails(id, "Ver borrador", fetchDaily),
  );
}

// Config gaps: a tracker project without repo, or a local repo without tracker project.
function setupCard(q, compact = false) {
  const err = h("div", { class: "err" });
  const placeholder = q.kind === "repo_for_group" ? "git@github.com:Org/repo.git" : "URL del board o de una tarea del proyecto";
  const input = h("input", { type: "text", placeholder, "aria-label": placeholder, oninput: () => (err.textContent = "") });
  const busyNote = h("div", { class: "flash" });
  const submit = async () => {
    if (!input.value.trim()) { err.textContent = "Pega la URL primero"; return; }
    busyNote.textContent = q.kind === "repo_for_group" ? "Clonando…" : "Buscando el proyecto…";
    try {
      const { message } = await api("POST", "/api/setup/answer", { id: q.id, answer: input.value.trim() });
      flashes.set("setup", `Configurado: ${message}`);
      input.blur();
      lastJson = "";
      load();
    } catch (e) { busyNote.textContent = ""; err.textContent = e.message; }
  };
  onEnter(input, submit);
  const ignore = async () => {
    await api("POST", "/api/setup/ignore", { id: q.id });
    lastJson = "";
    load();
  };
  const body = [
    h("div", { class: "row" }, input, h("button", { onclick: submit }, "Guardar"), h("button", { onclick: ignore }, "Ignorar")),
    busyNote,
    err,
  ];
  if (compact) return h("div", { class: "q setup" }, h("div", {}, q.text), ...body);
  return h("section", { class: "card setup" },
    h("div", { class: "head" },
      h("span", { class: "badge b-warn" }, "Configuración"),
      h("span", { class: "title" }, q.text),
    ),
    ...body,
  );
}

const setupQs = (projectId) => (data.setup ?? []).filter((q) => !projectId || q.project === projectId);

// Setup questions of a project, in its general agent's side panel; collapsible, remembered.
function setupSection(p) {
  const qs = setupQs(p.id);
  if (!qs.length) return null;
  const key = `setup:${p.id}`;
  const collapsed = collapsedQs.has(key);
  const toggle = () => {
    if (collapsed) collapsedQs.delete(key); else collapsedQs.add(key);
    localSet("collapsedQs", JSON.stringify([...collapsedQs]));
    render();
  };
  return h("section", { class: "side-sec" },
    h("button", { class: "side-title", "aria-expanded": String(!collapsed), onclick: toggle },
      `${collapsed ? "▸" : "▾"} Configuración pendiente`, h("span", { class: "faint" }, `· ${qs.length}`),
    ),
    ...(collapsed ? [] : qs.map((q) => setupCard(q, true))),
  );
}

function autoBadge(t) {
  const a = t.auto;
  if (!a) return null;
  if (a.status === "running") return h("span", { class: "badge b-ok" }, `Auto · corriendo ${ago(a.launchedAt)}`);
  if (a.status === "failed") return h("span", { class: "badge b-warn", title: a.error }, "Auto · falló al lanzar");
  return h("span", { class: "badge b-idle" }, "Auto · terminó");
}

async function launch(p, t) {
  try {
    await api("POST", `/api/t/${enc(p.id)}/${enc(t.key)}/launch`);
    flashes.set(tid(p, t), "Agente lanzado");
  } catch (e) {
    flashes.set(tid(p, t), e.message);
  }
  lastJson = "";
  load();
}

// Live terminal: the agent's tmux pane as it is now, colors included, refreshed about once a
// second while it is on screen. Asking for it is what makes the host bridge send it.
const screenCache = new Map(); // "host|win" -> { text, cols, at, live }
const termScroll = new Map(); // "host|win" -> px from the bottom (0 = following the end)
const TERM_POLL_MS = 800;

function terminalView(w) {
  const key = `${w.host}|${w.name}`;
  const pre = h("pre", { class: "term", "data-key": key, "data-host": w.host, "data-win": w.name });
  pre.addEventListener("scroll", () => {
    const d = pre.scrollHeight - pre.clientHeight - pre.scrollTop;
    termScroll.set(key, d < 30 ? 0 : d);
  }, { passive: true });
  const status = h("div", { class: "term-status meta" });
  requestAnimationFrame(() => drawScreen(pre, status));
  return h("div", { class: "term-wrap" }, pre, status);
}

function drawScreen(pre, status) {
  const sc = screenCache.get(pre.dataset.key);
  if (!sc?.text) {
    pre.replaceChildren();
    status.textContent = sc && !sc.live ? "Puente desconectado: no llega la pantalla." : "Conectando con la terminal…";
    return;
  }
  pre.replaceChildren(ansiToFragment(sc.text));
  fitTerminal(pre, sc.cols);
  pre.scrollTop = pre.scrollHeight - pre.clientHeight - (termScroll.get(pre.dataset.key) ?? 0);
  const age = Math.round((Date.now() - sc.at) / 1000);
  status.textContent = !sc.live ? "Puente desconectado: lo último que llegó." : age > 15 ? `Sin cambios hace ${age} s` : "";
}

// Shrinks the font so the pane's full width fits, down to a readable minimum; past that it scrolls.
let charRatio;
function fitTerminal(pre, cols) {
  if (!cols) return;
  if (!charRatio) {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = "100px ui-monospace, Menlo, monospace";
    charRatio = ctx.measureText("M").width / 100;
  }
  const width = pre.clientWidth - 20;
  pre.style.fontSize = `${Math.max(9, Math.min(13, Math.floor((width / (cols * charRatio)) * 10) / 10))}px`;
}

async function pollTerminal() {
  const pre = document.querySelector("pre.term");
  if (!pre || document.hidden) return;
  try {
    const sc = await api("GET", `/api/screen?${new URLSearchParams({ host: pre.dataset.host, win: pre.dataset.win })}`);
    const prev = screenCache.get(pre.dataset.key);
    screenCache.set(pre.dataset.key, sc);
    const now = document.querySelector(`pre.term[data-key="${CSS.escape(pre.dataset.key)}"]`);
    if (now && (prev?.text !== sc.text || prev?.live !== sc.live || !now.childNodes.length)) drawScreen(now, now.parentElement.querySelector(".term-status"));
  } catch {}
}
setInterval(pollTerminal, TERM_POLL_MS);

// SGR colors from `tmux capture-pane -e` into spans; any other escape sequence is dropped.
const ANSI16 = ["#1e1e1e", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d4d4d4",
  "#5c6370", "#ff7b86", "#b5e890", "#ffd88a", "#7cc4ff", "#de96f2", "#7fd8e3", "#ffffff"];

function color256(n) {
  if (n < 16) return ANSI16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = n - 16, k = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${k(Math.floor(c / 36))},${k(Math.floor(c / 6) % 6)},${k(c % 6)})`;
}

function ansiToFragment(text) {
  const frag = document.createDocumentFragment();
  const st = {};
  const clean = text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, "");
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  const push = (s) => {
    if (!s) return;
    if (!st.fg && !st.bg && !st.bold && !st.dim && !st.italic && !st.underline && !st.inverse) { frag.append(s); return; }
    const span = document.createElement("span");
    const [fg, bg] = st.inverse ? [st.bg ?? "var(--term-bg)", st.fg ?? "var(--term-fg)"] : [st.fg, st.bg];
    if (fg) span.style.color = fg;
    if (bg) span.style.background = bg;
    if (st.bold) span.style.fontWeight = "600";
    if (st.dim) span.style.opacity = "0.6";
    if (st.italic) span.style.fontStyle = "italic";
    if (st.underline) span.style.textDecoration = "underline";
    span.textContent = s;
    frag.append(span);
  };
  while ((m = re.exec(clean))) {
    push(clean.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) for (const k of Object.keys(st)) delete st[k];
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c >= 30 && c <= 37) st.fg = ANSI16[c - 30];
      else if (c >= 90 && c <= 97) st.fg = ANSI16[c - 82];
      else if (c >= 40 && c <= 47) st.bg = ANSI16[c - 40];
      else if (c >= 100 && c <= 107) st.bg = ANSI16[c - 92];
      else if (c === 39) delete st.fg;
      else if (c === 49) delete st.bg;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) { st[c === 38 ? "fg" : "bg"] = color256(codes[i + 2]); i += 2; }
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) { st[c === 38 ? "fg" : "bg"] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
  }
  push(clean.slice(last));
  return frag;
}

// Claude is showing a numbered prompt (usually a permission request): answer it from here.
function permissionBox(w) {
  if (w.state !== "needs_input") return null;
  const press = async (keys) => {
    await api("POST", "/api/window/keys", { host: w.host, win: w.name, keys });
    lastJson = "";
    setTimeout(load, 1500);
  };
  // Dialogs without numbered options (settings, wizards) are answered with these keys.
  const NAV = [["Up", "↑"], ["Down", "↓"], ["Left", "←"], ["Right", "→"], ["Tab", "Tab"], ["Space", "Espacio"], ["Enter", "Enter"]];
  return h("div", { class: "perm" },
    h("div", { class: "perm-q" }, w.question || "El agente espera tu respuesta"),
    h("div", { class: "actions" },
      ...(w.options ?? []).map((o) => h("button", { onclick: () => press(o.key) }, `${o.key}. ${o.label}`)),
      h("button", { onclick: () => press("Escape") }, "Cancelar (Esc)"),
    ),
    !w.options?.length && h("div", { class: "actions" }, ...NAV.map(([k, label]) => h("button", { onclick: () => press(k) }, label))),
  );
}

// Multi-line box for messages: Enter sends, Shift+Enter adds a line, and it grows as you type.
function messageBox(placeholder, onInput) {
  const box = h("textarea", { rows: "1", class: "msg", placeholder, "aria-label": placeholder });
  box.addEventListener("input", () => {
    onInput?.();
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
  });
  return box;
}

function onEnter(el, submit) {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    submit();
  });
}

function windowSender(w) {
  const err = h("div", { class: "err" });
  const note = h("div", { class: "flash" });
  const input = messageBox(`Escribe a ${w.name}`, () => (err.textContent = ""));
  const files = attacher(`win:${w.host}|${w.name}`, input, err);
  const submit = async () => {
    try {
      const attachments = await files.ready();
      if (!input.value.trim() && !attachments.length) { err.textContent = "Escribe algo primero"; return; }
      const { delivery } = await api("POST", "/api/window/send", { host: w.host, win: w.name, text: input.value.trim(), attachments });
      note.textContent = deliveryText(delivery);
      input.value = "";
      input.style.height = "";
      files.clear();
      input.blur();
    } catch (e) { err.textContent = e.message; }
  };
  onEnter(input, submit);
  return h("div", {}, files.chips, h("div", { class: "row" }, input, files.button, h("button", { onclick: submit }, "Enviar")), note, err);
}

// Restarts Claude in that window resuming the same conversation (e.g. to load a new MCP).
function restartButton(w) {
  return h("button", {
    onclick: async () => {
      if (!confirm(`¿Reiniciar ${w.name}? Retoma la misma conversación (sirve para cargar un MCP nuevo).`)) return;
      await api("POST", "/api/window/restart", { host: w.host, win: w.name });
      toast(`Reiniciando ${w.name}…`);
      lastJson = "";
      setTimeout(load, 6000);
    },
  }, "Reiniciar");
}

function closeButton(w) {
  return h("button", {
    class: "danger",
    onclick: async () => {
      if (!confirm(`¿Cerrar ${w.name}? Su sesión de Claude termina (se puede retomar con claude --resume).`)) return;
      await api("POST", "/api/window/close", { host: w.host, win: w.name });
      toast(`Cerrando ${w.name}…`);
      lastJson = "";
      setTimeout(load, 4000);
    },
  }, "Cerrar proceso");
}

function windowPanel(w, p) {
  const [cls, label] = WINDOW_STATE[w.state] ?? WINDOW_STATE.idle;
  return h("section", { class: "card" },
    h("div", { class: "head" },
      h("span", { class: "key" }, w.name),
      h("span", { class: "title" }, w.host),
      h("span", { class: `badge ${cls}` }, label),
    ),
    w.state === "working" && w.line && h("div", { class: "meta" }, w.line),
    permissionBox(w),
    !EMBED && terminalView(w),
    windowSender(w),
    h("div", { class: "actions" }, orcaButton(p, w), restartButton(w), closeButton(w)),
  );
}

const WINDOW_STATE = {
  working: ["b-ok", "Trabajando"],
  needs_input: ["b-warn", "Esperando tu permiso"],
  idle: ["b-idle", "En espera"],
};

function agentBadge(t) {
  const n = openQs(t).length;
  if (n) return h("span", { class: "badge b-warn" }, `Bloqueado · ${n} ${n > 1 ? "preguntas" : "pregunta"}`);
  if (t.window) {
    const [cls, label] = WINDOW_STATE[t.window.state] ?? WINDOW_STATE.idle;
    return h("span", { class: `badge ${cls}`, title: t.window.line }, `${label} · ${t.window.name}`);
  }
  if (t.listening) return h("span", { class: "badge b-ok" }, "Agente escuchando");
  if (t.agent?.lastSeen) return h("span", { class: "badge b-idle" }, `Agente visto ${ago(t.agent.lastSeen)}`);
  return null;
}

function card(p, t) {
  const id = tid(p, t);
  const trackerClass = p.trackerType === "kaneo" ? "badge b-kaneo" : "badge b-tracker";
  const meta = [p.name, p.host, t.group, t.agent?.from && `agente ${t.agent.from}`, !t.inTracker && "fuera del tracker"].filter(Boolean).join(" · ");

  // Questions and the agent take the wide column; ticket info and actions sit in the side panel.
  return splitCard(
    h("div", { class: "head" },
      h("span", { class: "key" }, t.key),
      h("span", { class: "title" }, t.title || "(sin título)"),
      t.status && h("span", { class: trackerClass }, `${p.trackerType ?? "hub"} · ${t.status}`),
      agentBadge(t),
      autoBadge(t),
    ),
    [
      t.window && permissionBox(t.window),
      EMBED ? null : t.window
        ? terminalView(t.window)
        : h("div", { class: "no-agent" },
            h("div", {}, "Sin agente corriendo para este ticket."),
            h("div", { class: "meta" }, p.autoWork.enabled && !t.autoBlocker ? "Lánzalo desde el panel de la derecha, o escríbele: el mensaje queda en cola." : "Si le escribes, el mensaje queda en cola hasta que haya un agente."),
          ),
      composer(p, t, "message", "Instrucción para el agente", "Enviar al agente"),
      flashes.has(id) && h("div", { class: "flash" }, flashes.get(id)),
    ],
    [
      questionsSection(p, t),
      ...trackerSections(p, t),
      sideSection("Ticket",
        h("div", { class: "meta" }, meta),
        t.window?.state === "working" && t.window.line && h("div", { class: "meta" }, t.window.line),
        t.auto?.status === "failed" && h("div", { class: "err" }, t.auto.error),
        h("div", { class: "actions" },
          ...p.links.map((l) => h("button", { onclick: () => openLink(p, l.url) }, `${l.label}${p.chromeProfile ? ` · ${p.chromeProfile}` : ""}`)),
          t.url && h("button", { onclick: () => openLink(p, t.url) }, `Ver en ${p.trackerType}`),
          ...(t.prs ?? []).map((pr) =>
            h("button", { class: `pr pr-${pr.isDraft ? "draft" : pr.state}`, title: pr.title, onclick: () => openLink(p, pr.url) },
              `PR ${pr.repo}#${pr.number}${pr.isDraft ? " · borrador" : pr.state === "merged" ? " · merged" : ""}`),
          ),
        ),
        p.autoWork.enabled && t.autoBlocker && !p.autoWork.blocker && h("div", { class: "meta" }, `auto_work: ${t.autoBlocker}`),
      ),
      (t.window || p.autoWork.enabled && !t.autoBlocker && t.auto?.status !== "running") && sideSection("Agente",
        t.window && h("div", { class: "meta" }, `${t.window.name} · ${p.host}`),
        h("div", { class: "actions" },
          t.window && orcaButton(p, t.window),
          t.window && restartButton(t.window),
          t.window && closeButton(t.window),
          p.autoWork.enabled && !t.autoBlocker && t.auto?.status !== "running" &&
            h("button", { onclick: () => launch(p, t) }, t.auto ? "Relanzar agente" : "Lanzar agente"),
        ),
      ),
      devServersSection(p),
      sideSection("Notas privadas",
        notesBox(p, t),
        h("div", { class: "meta" }, "Pregunta propia (para ti, no le llega al agente)"),
        composer(p, t, "question", "Anotar una pregunta propia", "Agregar"),
      ),
    ],
  );
}

// Side panel: one titled section per entry.
function splitCard(head, main, side) {
  return h("section", { class: "card split" },
    head,
    h("div", { class: "split-body" },
      h("div", { class: "split-main" }, ...main),
      h("aside", { class: "split-side" }, ...side),
    ),
  );
}

// Which tickets hold the open questions counted above; each one opens that ticket.
function blockedList() {
  const items = scopeProjects().flatMap((p) => p.tickets.filter((t) => openQs(t).length).map((t) => ({ p, t })));
  if (!items.length) return null;
  return h("div", { class: "blocked-list" },
    h("span", { class: "meta" }, "Preguntas abiertas en:"),
    ...items.map(({ p, t }) => h("button", { class: "chip-q", title: t.title, onclick: () => selectTicket(tid(p, t)) }, `${t.key} · ${openQs(t).length}`)),
  );
}

// Plain shells on the agent hosts. "Abrir aquí" asks the helper to open Terminal.app;
// elsewhere, copy the command (needs the SSH config below on that computer).
let consoles = null; // { hosts, sshConfig } once fetched
function consolesSection() {
  if (!consoles) {
    consoles = { hosts: [], loading: true };
    api("GET", "/api/consoles").then((c) => { consoles = c; if (!busy()) render(); }, () => (consoles = null));
  }
  if (!consoles.hosts.length) return null;
  // Standalone: the only host is this machine and nothing here can open a shell for it.
  if (!helperUp && consoles.hosts.every((c) => c.local)) return null;
  const open = async (host) => {
    try {
      const res = await fetch(`${data.chromeHelper}/console?${new URLSearchParams({ host, project: filter === "all" ? "" : filter })}`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
    } catch {
      toast("No pude abrir la terminal aquí (necesita el helper de Overhaul): usa Copiar");
    }
  };
  return collapsible("consoles", "Consolas", "",
    h("div", { class: "meta" }, "Funciona en cualquier computador que llegue a esos hosts por SSH con tu llave autorizada."),
    ...consoles.hosts.map(({ name, command }) => h("div", { class: "console-row" },
      h("div", { class: "meta" }, name),
      h("div", { class: "row" },
        h("code", { class: "console-cmd" }, command),
        h("button", { onclick: (e) => copyText(command, e.currentTarget) }, "Copiar"),
        helperUp && h("button", { title: "Necesita el helper de Overhaul", onclick: () => open(name) }, "Abrir aquí"),
      ),
    )),
    consoles.sshConfig && h("div", { class: "actions" },
      h("button", { onclick: () => download("overhaul-ssh-config.txt", consoles.sshConfig) }, "Config SSH para otro equipo"),
    ),
  );
}

// Dev servers the agents started on the project's host. The helper forwards each port, so
// http://localhost:<port> (the link the agent prints) opens here as on that host. Only with the helper.
function devServersSection(p) {
  if (!helperUp) return null;
  const mine = (devPorts ?? []).filter((d) => d.host === p.host);
  if (!mine.length) return null;
  const note = { busy: "otro proceso usa ese puerto en este computador", conflict: "el mismo puerto ya viene de otro host", error: "no pude reenviarlo" };
  return sideSection("Servidores de desarrollo",
    ...mine.map((d) => {
      const url = `http://localhost:${d.port}`;
      return h("div", { class: "dev-row" },
        h("a", { href: url, class: "link", onclick: (e) => { e.preventDefault(); openLink(p, url); } }, `localhost:${d.port}`),
        h("span", { class: "meta" }, d.cwd),
        d.state !== "forwarded" && h("div", { class: "err", title: d.error ?? "" }, note[d.state] ?? d.state),
      );
    }),
  );
}

// The page is plain http, where navigator.clipboard is unavailable: copy through a selection.
function copyText(text, button) {
  const ta = h("textarea", { style: "position:fixed;opacity:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (button) { const old = button.textContent; button.textContent = ok ? "Copiado" : "No pude copiar"; setTimeout(() => (button.textContent = old), 1500); }
}

function download(name, text) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// The project's summary lives in its general agent's panel, not on each ticket.
const summarySection = () => sideSection(`Resumen de ${scopeLabel()}`, h("div", { class: "side-metrics" }, ...summaryTiles()), blockedList());

function sideSection(title, ...children) {
  return h("section", { class: "side-sec" }, h("div", { class: "side-title" }, title), ...children);
}

// The ticket's description and comments from the tracker (Jira), read with the hub's token
// so you don't need to open Jira. Fetched when the ticket is shown, refreshed each minute.
const ticketInfo = new Map(); // ticket id -> { at, data, loading, error }

function trackerSections(p, t) {
  if (p.trackerType !== "jira" || !t.inTracker) return [];
  const id = tid(p, t);
  const info = ticketInfo.get(id);
  if (!info?.loading && (!info || Date.now() - info.at > 60_000)) {
    ticketInfo.set(id, { ...info, loading: true });
    api("GET", `/api/t/${enc(p.id)}/${enc(t.key)}/details`)
      .then((data) => ticketInfo.set(id, { at: Date.now(), data }), (e) => ticketInfo.set(id, { at: Date.now(), error: e.message }))
      .finally(() => !busy() && render());
  }
  const d = info?.data;
  if (!d) return [sideSection("Descripción", h("div", { class: "meta" }, info?.error ? `No pude leer Jira: ${info.error}` : "Cargando de Jira…"))];
  if (!d.supported) return [];
  const facts = [d.type, d.priority && `prioridad ${d.priority}`, d.reporter && `creado por ${d.reporter}`].filter(Boolean).join(" · ");
  const comments = [...d.comments].reverse(); // newest first
  return [
    collapsible(`desc:${id}`, "Descripción", "",
      facts && h("div", { class: "meta" }, facts),
      h("div", { class: "adf" }, ...(d.description ? adfNodes(d.description, p) : [h("span", { class: "meta" }, "Sin descripción.")])),
    ),
    collapsible(`com:${id}`, "Comentarios", `· ${comments.length}`,
      ...(comments.length ? comments.map((c) => h("div", { class: "comment" },
        h("div", { class: "meta" }, `${c.author} · ${ago(c.created)}`),
        h("div", { class: "adf" }, ...adfNodes(c.body, p)),
      )) : [h("div", { class: "meta" }, "Sin comentarios.")]),
    ),
  ];
}

// A side section whose title folds it; folded state remembered with the questions'.
function collapsible(key, title, suffix, ...children) {
  const collapsed = collapsedQs.has(key);
  const toggle = () => {
    if (collapsed) collapsedQs.delete(key); else collapsedQs.add(key);
    localSet("collapsedQs", JSON.stringify([...collapsedQs]));
    render();
  };
  return h("section", { class: "side-sec" },
    h("button", { class: "side-title", "aria-expanded": String(!collapsed), onclick: toggle }, `${collapsed ? "▸" : "▾"} ${title}`, suffix && h("span", { class: "faint" }, suffix)),
    ...(collapsed ? [] : children),
  );
}

// Atlassian Document Format into DOM nodes; text always goes in as text, links only if http(s).
function adfNodes(node, p) {
  const kids = () => (node.content ?? []).flatMap((c) => adfNodes(c, p));
  const a = node.attrs ?? {};
  switch (node.type) {
    case "doc": return kids();
    case "text": {
      let el = document.createTextNode(node.text ?? "");
      for (const m of node.marks ?? []) {
        const tag = { strong: "strong", em: "em", code: "code", strike: "s", underline: "u" }[m.type];
        if (tag) el = h(tag, {}, el);
        else if (m.type === "link" && /^https?:\/\//.test(m.attrs?.href ?? "")) el = h("a", { href: m.attrs.href, class: "link", onclick: (e) => { e.preventDefault(); openLink(p, m.attrs.href); } }, el);
      }
      return [el];
    }
    case "paragraph": return [h("p", {}, ...kids())];
    case "heading": return [h(`h${Math.min(6, Math.max(3, (a.level ?? 3) + 2))}`, {}, ...kids())];
    case "bulletList": return [h("ul", {}, ...kids())];
    case "orderedList": return [h("ol", {}, ...kids())];
    case "listItem": return [h("li", {}, ...kids())];
    case "blockquote": return [h("blockquote", {}, ...kids())];
    case "codeBlock": return [h("pre", { class: "pre" }, (node.content ?? []).map((c) => c.text ?? "").join(""))];
    case "rule": return [h("hr", {})];
    case "hardBreak": return [h("br", {})];
    case "mention": case "emoji": case "status": case "date": return [a.text ?? a.shortName ?? (a.timestamp ? new Date(Number(a.timestamp)).toLocaleDateString() : "")];
    case "inlineCard": case "blockCard": case "embedCard":
      return /^https?:\/\//.test(a.url ?? "") ? [h("a", { href: a.url, class: "link", onclick: (e) => { e.preventDefault(); openLink(p, a.url); } }, a.url)] : [];
    case "mediaSingle": case "mediaGroup": case "media": case "mediaInline": return [h("span", { class: "meta" }, "[adjunto en Jira]")];
    case "table": return [h("table", { class: "adf-table" }, ...kids())];
    case "tableRow": return [h("tr", {}, ...kids())];
    case "tableHeader": return [h("th", {}, ...kids())];
    case "tableCell": return [h("td", {}, ...kids())];
    case "panel": return [h("div", { class: "adf-panel" }, ...kids())];
    default: return kids();
  }
}

// Always shown in the side panel, even empty. Collapsible, with Pendientes | Respondidas tabs;
// both choices remembered per ticket.
const collapsedQs = new Set((() => { try { return JSON.parse(localGet("collapsedQs") || "[]"); } catch { return []; } })());
const qTab = new Map(); // ticket id -> "pending" | "answered"

function questionsSection(p, t) {
  const id = tid(p, t);
  // Dismissed questions (closed without an answer) are listed with the answered ones. Refined
  // ones were replaced by a reworded question; their history is under the new one.
  const answered = t.questions.filter((q) => q.status === "answered" || q.status === "dismissed").reverse(); // newest first
  const pending = t.questions.filter((q) => q.status === "open" || q.status === "client");
  const proposed = t.questions.filter((q) => q.status === "proposed");
  const collapsed = collapsedQs.has(id);
  const tab = qTab.get(id) ?? (pending.length || !answered.length ? "pending" : "answered");
  const toggle = () => {
    if (collapsed) collapsedQs.delete(id); else collapsedQs.add(id);
    localSet("collapsedQs", JSON.stringify([...collapsedQs]));
    render();
  };
  const tabButton = (key, label, n) =>
    h("button", { class: `tab${tab === key ? " on" : ""}${key === "pending" && n ? " alert" : ""}`, onclick: () => { qTab.set(id, key); render(); } }, `${label} · ${n}`);
  return h("section", { class: "side-sec qs" },
    h("button", { class: "side-title", "aria-expanded": String(!collapsed), onclick: toggle },
      `${collapsed ? "▸" : "▾"} Preguntas del agente`,
      collapsed && h("span", { class: "faint" }, `${proposed.length ? ` · ${proposed.length} iniciales por revisar` : ""} · ${pending.length} pendientes · ${answered.length} respondidas`),
    ),
    !collapsed && proposed.length && initialRound(p, t, proposed),
    !collapsed && h("div", { class: "tabs qtabs" }, tabButton("pending", "Pendientes", pending.length), tabButton("answered", "Respondidas", answered.length)),
    ...(collapsed ? [] : tab === "pending"
      ? (pending.length ? pending.map((q) => questionBox(p, t, q)) : [h("div", { class: "meta" }, "No hay preguntas pendientes.")])
      : (answered.length ? answered.map((q) =>
          h("div", { class: "q done" },
            h("div", {}, q.text),
            q.status === "dismissed"
              ? h("div", { class: "meta" }, "Descartada, sin respuesta")
              : h("div", { class: "ans" }, `Tú: ${q.answer} · ${ago(q.answeredAt)}`),
            ...historyView(p, t, q),
          )) : [h("div", { class: "meta" }, "Todavía no has respondido ninguna.")])),
  );
}

function questionBox(p, t, q) {
  const err = h("div", { class: "err" });
  const input = messageBox("Tu respuesta", () => (err.textContent = ""));
  const files = attacher(`q:${q.id}`, input, err);
  const submit = async () => {
    const answer = input.value.trim();
    try {
      const attachments = await files.ready();
      if (!answer && !attachments.length) { err.textContent = "Escribe una respuesta primero"; return; }
      const { delivery } = await api("POST", `/api/t/${enc(p.id)}/${enc(t.key)}/answer`, { questionId: q.id, answer, attachments });
      flashes.set(tid(p, t), deliveryText(delivery));
      files.clear();
      input.blur();
      load();
    } catch (e) { err.textContent = e.message; }
  };
  onEnter(input, submit);
  const toggle = () => api("POST", `/api/t/${enc(p.id)}/${enc(t.key)}/status`, { questionId: q.id, status: q.status === "client" ? "open" : "client" }).then(() => load());
  const dismiss = () => confirm("¿Descartar esta pregunta? Se cierra sin respuesta y al agente no le llega nada.") &&
    api("POST", `/api/t/${enc(p.id)}/${enc(t.key)}/status`, { questionId: q.id, status: "dismissed" }).then(() => load());
  return h("div", { class: "q" },
    h("div", {}, q.text),
    h("div", { class: "from" }, [q.from, ago(q.createdAt), q.blocks && `bloquea: ${q.blocks}`, q.status === "client" && "pendiente del cliente"].filter(Boolean).join(" · ")),
    files.chips,
    h("div", { class: "row" }, input, files.button, h("button", { onclick: submit }, "Responder")),
    h("div", { class: "row" },
      h("button", { onclick: toggle }, q.status === "client" ? "Ya no depende del cliente" : "Depende del cliente"),
      h("button", { title: "Cerrarla sin responder; al agente no le llega nada", onclick: dismiss }, "Descartar"),
      refineButton(p, t, q, err),
    ),
    ...historyView(p, t, q),
    err,
  );
}

const STATUS_ES = { proposed: "propuesta", open: "abierta", client: "pendiente del cliente", refined: "refinada", answered: "respondida", dismissed: "descartada" };

// Rewords a pending question: the new one replaces it and keeps the link to the old one.
function refineButton(p, t, q, err) {
  return h("button", {
    title: "Reescribirla; la anterior queda en el historial",
    onclick: async () => {
      const text = prompt("Nueva redacción de la pregunta", q.text)?.trim();
      if (!text || text === q.text) return;
      try {
        await api("POST", `/api/t/${enc(p.id)}/${enc(t.key)}/refine`, { questionId: q.id, text });
        load();
      } catch (e) { err.textContent = e.message; }
    },
  }, "Refinar");
}

// Every change of a question (and of the ones it refines), fetched when opened.
const histories = new Map(); // question id -> events, or null while loading
function historyView(p, t, q) {
  const open = histories.has(q.id);
  const toggle = async () => {
    if (open) { histories.delete(q.id); render(); return; }
    histories.set(q.id, null);
    render();
    try {
      const { events } = await api("GET", `/api/t/${enc(p.id)}/${enc(t.key)}/history?questionId=${enc(q.id)}`);
      histories.set(q.id, events);
    } catch (e) {
      histories.set(q.id, [{ type: "error", text: e.message }]);
    }
    render();
  };
  const events = histories.get(q.id);
  return [
    h("button", { class: "link-btn", onclick: toggle }, open ? "Ocultar historial" : "Historial"),
    open && h("ul", { class: "history" }, ...(events ? events.map((e) => h("li", {}, eventText(e, q))) : [h("li", {}, "Cargando…")])),
  ];
}

function eventText(e, q) {
  if (e.type === "error") return e.text;
  const what = {
    created: `creada (${STATUS_ES[e.to] ?? e.to})`,
    imported: `traída del hub anterior (${STATUS_ES[e.to] ?? e.to})`,
    refined: "refinada: la reemplaza otra redacción",
    answered: "respondida",
    released: `revisada y enviada al agente (${STATUS_ES[e.to] ?? e.to})`,
    status: `${STATUS_ES[e.from] ?? e.from} → ${STATUS_ES[e.to] ?? e.to}`,
  }[e.type] ?? e.type;
  const quote = e.questionId !== q.id && e.type === "created" ? ` · “${e.text}”` : "";
  return `${ago(e.at)} · ${e.actor ?? ""} · ${what}${quote}`;
}

// The agent's initial round: you reword, drop, add and answer before it starts. Answers
// typed here go out together on "Enviar y empezar"; until then they live in this page.
const initialDrafts = new Map(); // question id -> answer typed in the initial round
function initialRound(p, t, list) {
  const err = h("div", { class: "err" });
  const base = `/api/t/${enc(p.id)}/${enc(t.key)}`;
  const items = list.map((q) => {
    const ans = messageBox("Respuesta (opcional: vacía, queda abierta)", () => { err.textContent = ""; initialDrafts.set(q.id, ans.value); });
    ans.value = initialDrafts.get(q.id) ?? "";
    const drop = () => api("POST", `${base}/status`, { questionId: q.id, status: "dismissed" })
      .then(() => { initialDrafts.delete(q.id); load(); }, (e) => (err.textContent = e.message));
    return h("div", { class: "q initial" },
      h("div", {}, q.text),
      h("div", { class: "from" }, [q.from, ago(q.createdAt), q.refines && "refinada por ti", q.blocks && `bloquea: ${q.blocks}`].filter(Boolean).join(" · ")),
      h("div", { class: "row" }, ans),
      h("div", { class: "row" },
        refineButton(p, t, q, err),
        h("button", { title: "No hace falta; no se la mando al agente", onclick: drop }, "Descartar"),
      ),
      ...historyView(p, t, q),
    );
  });
  const add = messageBox("Agregar una pregunta tuya a la ronda", () => (err.textContent = ""));
  const addQuestion = async () => {
    const text = add.value.trim();
    if (!text) return;
    try {
      await api("POST", `${base}/question`, { text, initial: true });
      add.value = "";
      load();
    } catch (e) { err.textContent = e.message; }
  };
  onEnter(add, addQuestion);
  const release = async () => {
    const answers = Object.fromEntries(list.map((q) => [q.id, (initialDrafts.get(q.id) ?? "").trim()]).filter(([, a]) => a));
    const open = list.length - Object.keys(answers).length;
    if (open && !confirm(`${open} pregunta(s) quedan sin respuesta y pasan a abiertas. ¿Enviar igual?`)) return;
    try {
      const { delivery } = await api("POST", `${base}/initial/release`, { answers });
      for (const q of list) initialDrafts.delete(q.id);
      flashes.set(tid(p, t), deliveryText(delivery));
      load();
    } catch (e) { err.textContent = e.message; }
  };
  return h("div", { class: "initial-round" },
    h("div", { class: "side-sub" }, `Preguntas iniciales · ${list.length}`),
    h("div", { class: "meta" }, "El agente las propone antes de empezar y espera. Refínalas, descarta las que sobran, agrega las tuyas y responde las que ya sepas."),
    ...items,
    h("div", { class: "row" }, add, h("button", { onclick: addQuestion }, "Agregar")),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: release }, "Enviar y empezar")),
    err,
  );
}

// Messages to the agent can carry files; your own notes-questions cannot.
function composer(p, t, kind, placeholder, label) {
  const err = h("div", { class: "err" });
  const input = messageBox(placeholder, () => (err.textContent = ""));
  const files = kind === "message" ? attacher(`${kind}:${tid(p, t)}`, input, err) : null;
  const submit = async () => {
    const text = input.value.trim();
    try {
      const attachments = files ? await files.ready() : [];
      if (!text && !attachments.length) { err.textContent = "Escribe algo primero"; return; }
      const res = await api("POST", `/api/t/${enc(p.id)}/${enc(t.key)}/${kind}`, { text, attachments });
      if (res.delivery) flashes.set(tid(p, t), deliveryText(res.delivery));
      input.value = "";
      input.style.height = "";
      files?.clear();
      input.blur();
      load();
    } catch (e) { err.textContent = e.message; }
  };
  onEnter(input, submit);
  return h("div", {}, files?.chips, h("div", { class: "row" }, input, files?.button, h("button", { onclick: submit }, label)), err);
}

// Files for a message: paste or drop them on the box, or pick them with the clip. They upload
// right away; the message carries their ids. Kept per box so a re-render does not drop them.
const pendingFiles = new Map(); // box id -> [{ name, status: "up" | "ok" | "err", id, error, done }]
const CLIP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/></svg>';

function attacher(boxId, input, err) {
  if (!pendingFiles.has(boxId)) pendingFiles.set(boxId, []);
  const list = pendingFiles.get(boxId);
  const chips = h("div", { class: "atts" });
  const draw = () => chips.replaceChildren(...list.map((a) =>
    h("span", { class: `att ${a.status}`, title: a.error ?? "" },
      a.name,
      a.status === "up" && h("span", { class: "faint" }, " · subiendo…"),
      a.status === "err" && h("span", {}, ` · ${a.error}`),
      h("button", { class: "att-x", title: "Quitar", "aria-label": `Quitar ${a.name}`, onclick: () => { list.splice(list.indexOf(a), 1); draw(); } }, "×"),
    )));
  const add = (files) => {
    for (const f of files) {
      // Pasted screenshots all come as "image.png".
      const name = /^image\.\w+$/.test(f.name) ? `captura-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}${f.name.slice(5)}` : f.name;
      const a = { name, status: "up" };
      a.done = upload(f, name).then((r) => Object.assign(a, { id: r.id, name: r.name, status: "ok" }), (e) => Object.assign(a, { status: "err", error: e.message })).finally(draw);
      list.push(a);
    }
    err.textContent = "";
    draw();
  };
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) { e.preventDefault(); add(files); }
  });
  input.addEventListener("dragover", (e) => { e.preventDefault(); input.classList.add("drop"); });
  input.addEventListener("dragleave", () => input.classList.remove("drop"));
  input.addEventListener("drop", (e) => {
    e.preventDefault();
    input.classList.remove("drop");
    add([...(e.dataTransfer?.files ?? [])]);
  });
  const picker = h("input", { type: "file", multiple: true, hidden: true, onchange: (e) => { add([...e.target.files]); e.target.value = ""; } });
  const clip = h("button", { class: "clip", type: "button", title: "Adjuntar (o pega / arrastra en la caja)", "aria-label": "Adjuntar archivo", onclick: () => picker.click() });
  clip.innerHTML = CLIP;
  draw();
  return {
    chips,
    button: h("span", { class: "clip-wrap" }, clip, picker),
    async ready() {
      await Promise.all(list.map((a) => a.done));
      if (list.some((a) => a.status === "err")) throw new Error("Quita los adjuntos que fallaron");
      return list.map(({ id, name }) => ({ id, name }));
    },
    clear() { list.length = 0; draw(); },
  };
}

async function upload(file, name) {
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "x-hub": "1", "x-file-name": encodeURIComponent(name), "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Sign in"); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function notesBox(p, t) {
  const status = h("div", { class: "flash" });
  const area = h("textarea", { "aria-label": "Notas privadas", placeholder: "Qué conseguir, decisiones, contexto…" });
  area.value = t.notes || "";
  let timer;
  area.addEventListener("input", () => {
    clearTimeout(timer);
    status.textContent = "";
    timer = setTimeout(async () => {
      try {
        await api("PUT", `/api/t/${enc(p.id)}/${enc(t.key)}/notes`, { notes: area.value });
        t.notes = area.value;
        status.textContent = "Guardado";
      } catch (e) { status.textContent = e.message; }
    }, 600);
  });
  return h("div", { style: "margin-top:8px" }, area, status);
}

function deliveryText(d) {
  if (d === "inbox") return "Entregado al agente";
  if (d === "tmux") return "Pegado en la terminal del agente";
  if (d === "bridge") return "Enviado: llega a la ventana en unos segundos";
  return "En cola: el puente de ese host no está conectado; se entrega cuando vuelva";
}

// The helper opens the project's Chrome profile and, for localhost links of a project
// on another host, forwards that port first. Elsewhere (phone) the link opens as is.
async function openLink(p, url) {
  // Inside Orca, dev server links open in a browser tab of the project's Orca; the rest (Jira,
  // GitHub) still go to the project's Chrome profile, where you are signed in.
  if (EMBED && helperUp && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    try {
      const res = await fetch(`${data.chromeHelper}/browse?${new URLSearchParams({ project: p.id, url, host: p.host ?? "" })}`, { method: "POST" });
      if (res.ok) return;
      if (res.status === 502) { toast(`No pude abrir ${url}: ${await res.text()}`); return; }
    } catch {}
  }
  if (p.chromeProfile && helperUp) {
    try {
      const res = await fetch(`${data.chromeHelper}/open?${new URLSearchParams({ profile: p.chromeProfile, url, host: p.host ?? "" })}`, { method: "POST" });
      if (res.ok) return;
      if (res.status === 502) { toast(`No pude abrir ${url}: ${await res.text()}`); return; }
    } catch {}
  }
  window.open(url, "_blank", "noopener");
}

function toast(msg) {
  const el = document.getElementById("setup-flash");
  el.textContent = msg;
  setTimeout(() => el.textContent === msg && (el.textContent = ""), 8000);
}

// Plain text with http(s) URLs turned into links that open through openLink.
function linkify(text, p) {
  const parts = String(text).split(/(https?:\/\/[^\s<>"'`)\]]+)/g);
  return parts.map((part, i) =>
    i % 2
      ? h("a", { href: part, class: "link", onclick: (e) => { e.preventDefault(); e.stopPropagation(); openLink(p, part.replace(/[.,;:]+$/, "")); } }, part)
      : part,
  );
}

const enc = encodeURIComponent;

document.getElementById("refresh").addEventListener("click", () => load(true));
const followBox = document.getElementById("follow-orca");
followBox.checked = followOrca;
followBox.addEventListener("change", () => { followOrca = followBox.checked; localSet("followOrca", followOrca ? "1" : ""); });
// The agents popover closes on a tap elsewhere, Esc or scroll (it is fixed to its tab).
document.addEventListener("click", (e) => hoverTab && !e.target.closest("#windows-pop") && hidePop());
document.addEventListener("keydown", (e) => e.key === "Escape" && hoverTab && hidePop());
window.addEventListener("scroll", () => hoverTab && hidePop(), { passive: true });

// The top bar slides away while scrolling down and comes back on any scroll up.
let lastY = 0;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  const bar = document.getElementById("topbar");
  if (y > lastY + 8 && y > 80) bar.classList.add("hidden");
  else if (y < lastY - 8 || y < 80) bar.classList.remove("hidden");
  lastY = y;
}, { passive: true });
document.documentElement.classList.add("no-helper"); // until the helper answers
setInterval(() => !busy() && !document.hidden && load(), POLL_MS);
load();
