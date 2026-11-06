// `overhaul init`: the project wizard, run in the project's folder (one repo, or a folder with
// several). Tracker first, then its credentials (checked against its API), the repos with their
// role, how the agents run, the hooks, and the project's block in config.yaml (comments kept).
// `--non-interactive` takes the same answers as flags. Also `overhaul project list|edit|remove`
// and `overhaul open`. docs/contract.md, "Proyectos".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import YAML from "yaml";
import { normalize, TRACKERS } from "./config.mjs";
import { setup } from "./init.mjs";
import { resolvePaths, expandHomeIn } from "./paths.mjs";
import { HOOK_EVENTS } from "./hook.mjs";

export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const KANBAN_MD_URL = "https://github.com/antopolskiy/kanban-md";
const RUNTIMES = ["claude", "pi"];

// --- Questions -------------------------------------------------------------------------------------
// Answers come from the terminal, or line by line from stdin when it is not one (tests, scripts).
// Secrets are read without echo on a terminal.
export function prompter({ input = process.stdin, output = process.stderr } = {}) {
  const tty = !!input.isTTY;
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) output.write(chunk); cb(); } });
  const rl = readline.createInterface({ input, output: out, terminal: tty });
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on("close", () => { closed = true; for (const w of waiting.splice(0)) w(null); });
  rl.on("SIGINT", () => { muted = false; output.write("\nCancelado: no cambié nada.\n"); process.exit(130); });
  const line = (text, secret) => {
    if (tty) {
      return new Promise((resolve) => {
        rl.question(text, (l) => { if (secret) { muted = false; output.write("\n"); } resolve(l); });
        muted = !!secret;
      });
    }
    output.write(text);
    const got = lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve(null) : new Promise((r) => waiting.push(r));
    return got.then((l) => { output.write("\n"); return l; });
  };
  const read = async (text, secret = false) => {
    const l = await line(text, secret);
    if (l === null) throw new WizardError("La entrada terminó antes de responder todas las preguntas; no cambié nada.");
    return l.trim();
  };
  const io = {
    say: (m = "") => output.write(`${m}\n`),
    // "Pregunta [default]: "; Enter keeps the default.
    async ask(q, def = "") {
      const v = await read(`${q}${def !== "" && def != null ? ` [${def}]` : ""}: `);
      return v === "" ? String(def ?? "") : v;
    },
    // Hidden. With a value already saved, Enter keeps it (returns null).
    async secret(q, saved = false) {
      const v = await read(`${q}${saved ? " [guardado; Enter lo mantiene]" : ""}: `, true);
      return v === "" ? (saved ? null : "") : v;
    },
    async yes(q, def = true) {
      for (;;) {
        const v = (await read(`${q} [${def ? "S/n" : "s/N"}]: `)).toLowerCase();
        if (v === "") return def;
        if (["s", "si", "sí", "y", "yes"].includes(v)) return true;
        if (["n", "no"].includes(v)) return false;
        io.say("Responde s o n.");
      }
    },
    // options: [{ value, label }]; the answer is a number or a value.
    async choose(q, options, def) {
      options.forEach((o, i) => io.say(`  ${i + 1}) ${o.label}`));
      for (;;) {
        const v = await io.ask(q, def);
        const hit = /^\d+$/.test(v) ? options[Number(v) - 1] : options.find((o) => o.value === v);
        if (hit) return hit.value;
        io.say(`Opción no válida: ${v}. Usa un número de 1 a ${options.length}.`);
      }
    },
    close: () => rl.close(),
  };
  return io;
}

export class WizardError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// --- What a folder holds ---------------------------------------------------------------------------
const isRepo = (dir) => fs.existsSync(path.join(dir, ".git"));
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// The repo itself, or its git children (one level down, hidden folders left out).
export function findRepos(dir) {
  if (isRepo(dir)) return { single: true, repos: [dir] };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  const repos = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && isRepo(path.join(dir, d.name)))
    .map((d) => path.join(dir, d.name))
    .sort();
  return { single: false, repos };
}

// Role, description and stack proposed from the repo's name, package.json, go.mod, README...
export function proposeRepo(dir) {
  const name = path.basename(dir).toLowerCase();
  const pkg = readJson(path.join(dir, "package.json"));
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  const has = (...names) => names.some((n) => deps.includes(n) || deps.some((d) => d.startsWith(`${n}/`)));
  const exists = (f) => fs.existsSync(path.join(dir, f));
  const stack = [];
  let role = null;
  if (pkg) {
    if (has("react-native", "expo")) { stack.push(has("expo") ? "Expo" : "React Native"); role = "mobile"; }
    else if (has("next")) { stack.push("Next.js"); role = "frontend"; }
    else if (has("nuxt")) { stack.push("Nuxt"); role = "frontend"; }
    else if (has("@angular/core")) { stack.push("Angular"); role = "frontend"; }
    else if (has("svelte", "@sveltejs/kit")) { stack.push("Svelte"); role = "frontend"; }
    else if (has("vue")) { stack.push("Vue"); role = "frontend"; }
    else if (has("react")) { stack.push("React"); role = "frontend"; }
    if (has("@nestjs/core")) { stack.push("NestJS"); role ??= "backend"; }
    else if (has("express")) { stack.push("Express"); role ??= "backend"; }
    else if (has("fastify")) { stack.push("Fastify"); role ??= "backend"; }
    else if (has("hono")) { stack.push("Hono"); role ??= "backend"; }
    if (has("vite") && !stack.length) stack.push("Vite");
    stack.push(has("typescript") || exists("tsconfig.json") ? "TypeScript" : "Node.js");
    if (!role && pkg.bin) role = "cli";
  }
  const gomod = readText(path.join(dir, "go.mod"));
  if (gomod) stack.push("Go");
  if (exists("Cargo.toml")) stack.push("Rust");
  if (exists("pyproject.toml") || exists("requirements.txt")) stack.push("Python");
  if (exists("Gemfile")) stack.push("Ruby");
  if (exists("pom.xml") || exists("build.gradle") || exists("build.gradle.kts")) stack.push("JVM");
  if (exists("pubspec.yaml")) { stack.push("Flutter"); role ??= "mobile"; }
  const tf = (() => { try { return fs.readdirSync(dir).some((f) => f.endsWith(".tf")); } catch { return false; } })();
  if (tf) { stack.push("Terraform"); role ??= "infra"; }
  if (exists("Chart.yaml")) { stack.push("Helm"); role ??= "infra"; }

  const byName = [
    [/(^|[-_.])(api|backend|server|be|svc|service)([-_.]|$)/, "backend"],
    [/(^|[-_.])(web|frontend|front|fe|ui|site|dashboard|admin)([-_.]|$)/, "frontend"],
    [/(^|[-_.])(mobile|app-?(ios|android)|ios|android)([-_.]|$)/, "mobile"],
    [/(^|[-_.])(infra|terraform|deploy|ops|k8s|helm)([-_.]|$)/, "infra"],
    [/(^|[-_.])(docs?|wiki)([-_.]|$)/, "docs"],
    [/(^|[-_.])(lib|sdk|shared|common|core)([-_.]|$)/, "library"],
  ];
  role = byName.find(([re]) => re.test(name))?.[1] ?? role;
  if (!role && gomod) role = fs.existsSync(path.join(dir, "main.go")) || fs.existsSync(path.join(dir, "cmd")) ? "backend" : "library";
  if (!role && stack.some((s) => ["Python", "Ruby", "JVM", "Rust"].includes(s))) role = "backend";
  role ??= "app";

  const description = oneLine(pkg?.description) ?? readmeLine(dir) ?? (stack.length ? `${ROLE_TEXT[role] ?? role} (${stack.join(", ")})` : ROLE_TEXT[role] ?? role);
  return { role, description, stack: stack.join(", ") };
}

const ROLE_TEXT = { backend: "Backend", frontend: "Frontend", mobile: "App móvil", infra: "Infraestructura", docs: "Documentación", library: "Librería compartida", cli: "Herramienta de línea de comandos", app: "Aplicación" };
const oneLine = (s) => (s && String(s).trim() ? String(s).trim().replace(/\s+/g, " ").slice(0, 120) : null);

// The README's first paragraph line that is not a title, badge, HTML or a list.
function readmeLine(dir) {
  const file = ["README.md", "readme.md", "README", "README.rst"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const text = file && readText(file);
  if (!text) return null;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !/^(#|!\[|\[!\[|<|=|-{3,}|```|[-*] |\|)/.test(l));
  return line ? oneLine(line.replace(/[*_`]/g, "")) : null;
}

// A repo that brings its own way of running agents (ORCA.md, .pi/): respected as it is.
export function findLane(dirs) {
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, "ORCA.md"))) return { dir, what: "ORCA.md", pi: fs.existsSync(path.join(dir, ".pi")) };
    if (fs.existsSync(path.join(dir, ".pi"))) return { dir, what: ".pi/", pi: true };
  }
  return null;
}

export function which(name, env = process.env) {
  if (!name) return null;
  if (name.includes("/")) return fs.existsSync(name) ? name : null;
  for (const d of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

// --- Trackers' APIs ----------------------------------------------------------------------------------
async function http(fetchFn, url, headers, what) {
  let res;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new WizardError(`No pude conectar con ${new URL(url).host}: ${err.cause?.code ?? err.cause?.message ?? err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new WizardError(`${what}: ${res.status}, la credencial no sirve (o no tiene permiso)`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = (() => { try { const j = JSON.parse(body); return j.errorMessages?.join(" ") || j.message || j.error || ""; } catch { return ""; } })();
    const err = new WizardError(`${what}: ${res.status} ${res.statusText}${msg ? ` (${msg})` : ""}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => { throw new WizardError(`${what}: la respuesta no es JSON (¿es la URL correcta?)`); });
}

const jiraAuth = (j) => (j.cloud ? `Basic ${Buffer.from(`${j.email}:${j.token}`).toString("base64")}` : `Bearer ${j.token}`);
const jiraApi = (j) => `${j.baseUrl}/rest/api/${j.cloud ? 3 : 2}`;

export const jira = {
  myself: (f, j) => http(f, `${jiraApi(j)}/myself`, { authorization: jiraAuth(j) }, "Jira"),
  async projects(f, j) {
    if (!j.cloud) return (await http(f, `${jiraApi(j)}/project`, { authorization: jiraAuth(j) }, "Jira")).map((p) => ({ key: p.key, name: p.name }));
    const out = [];
    for (let start = 0; start < 1000;) {
      const page = await http(f, `${jiraApi(j)}/project/search?maxResults=100&orderBy=key&startAt=${start}`, { authorization: jiraAuth(j) }, "Jira");
      out.push(...(page.values ?? []).map((p) => ({ key: p.key, name: p.name })));
      if (page.isLast !== false || !(page.values ?? []).length) break;
      start += page.values.length;
    }
    return out;
  },
  // How many open tickets the JQL brings (up to 50): a JQL Jira rejects fails here.
  async count(f, j, jql) {
    const url = j.cloud
      ? `${jiraApi(j)}/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=50`
      : `${jiraApi(j)}/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=50`;
    return ((await http(f, url, { authorization: jiraAuth(j) }, "JQL")).issues ?? []).length;
  },
};

export const jiraCloud = (url) => /\.(atlassian\.net|jira\.com)$/i.test(new URL(url).hostname);
export const projectJql = (key) => (key ? `project = ${/^[A-Z][A-Z0-9_]*$/.test(key) ? key : JSON.stringify(key)} AND ${DEFAULT_JQL}` : DEFAULT_JQL);
const jqlProject = (jql) => jql?.match(/project\s*=\s*"?([A-Za-z][\w]*)"?/)?.[1] ?? null;

export const kaneo = {
  // Kaneo's workspaces are better-auth organizations; older servers may not list them.
  async workspaces(f, k) {
    try {
      const data = await http(f, `${k.baseUrl}/api/auth/organization/list`, { authorization: `Bearer ${k.token}` }, "Kaneo");
      const list = Array.isArray(data) ? data : data?.data ?? data?.organizations ?? null;
      return Array.isArray(list) ? list.map((w) => ({ id: String(w.id), name: String(w.name ?? w.slug ?? w.id) })) : null;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },
  async projects(f, k, workspaceId) {
    const data = await http(f, `${k.baseUrl}/api/project?workspaceId=${encodeURIComponent(workspaceId)}`, { authorization: `Bearer ${k.token}` }, "Kaneo");
    return (Array.isArray(data) ? data : data.projects ?? []).map((p) => ({ id: p.id, slug: String(p.slug ?? p.id), name: String(p.name ?? p.slug) }));
  },
};

// --- config.yaml and env ---------------------------------------------------------------------------
function readConfig(P) {
  const text = readText(P.config);
  if (text == null) throw new WizardError(`No encuentro ${P.config}`);
  return { text, doc: YAML.parseDocument(text), raw: YAML.parse(text) ?? {} };
}

export function readEnv(file) {
  const out = {};
  for (const line of (readText(file) ?? "").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Sets NAME=value in env (0600), replacing that line or adding it at the end.
export function setEnvVars(file, vars) {
  let text = readText(file) ?? "";
  for (const [name, value] of Object.entries(vars)) {
    if (/[\r\n]/.test(value)) throw new WizardError(`${name}: el valor no puede tener saltos de línea`);
    const line = `${name}=${value}`;
    const re = new RegExp(`^${name}=.*$`, "m");
    text = re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export const envPrefix = (id) => id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
export const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "proyecto";

// Folders that say a project lives in dir: runtime.dir, repos_root, repo, the first repo.
function projectDirs(p, expand) {
  const first = Array.isArray(p?.repos) ? p.repos[0] : p?.repos;
  return [p?.runtime?.dir, p?.repos_root, p?.repo, first?.path ?? first].filter((x) => typeof x === "string").map((d) => path.resolve(expand(d)));
}
const real = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };

export function projectAt(raw, dir, expand) {
  const here = real(dir);
  for (const [id, p] of Object.entries(raw.projects ?? {})) {
    if (projectDirs(p, expand).some((d) => real(d) === here)) return id;
  }
  return null;
}

// The project's block, written key by key so other keys (daily_summary, auto_work, links...) and
// their comments stay. null removes a key.
export function writeProject(doc, id, block) {
  const projects = doc.get("projects", true);
  if (!YAML.isMap(projects)) doc.set("projects", doc.createNode({}));
  doc.get("projects", true).flow = false;
  if (!doc.hasIn(["projects", id]) || !YAML.isMap(doc.getIn(["projects", id], true))) doc.setIn(["projects", id], doc.createNode({}));
  for (const [key, value] of Object.entries(block)) {
    const at = ["projects", id, key];
    if (value == null) { doc.deleteIn(at); continue; }
    if (key === "runtime" || key === "agents") {
      if (!YAML.isMap(doc.getIn(at, true))) doc.setIn(at, doc.createNode({}));
      doc.getIn(at, true).flow = false;
      for (const [k, v] of Object.entries(value)) {
        if (v == null) doc.deleteIn([...at, k]);
        else doc.setIn([...at, k], doc.createNode(v));
      }
      continue;
    }
    doc.setIn(at, doc.createNode(value));
  }
}

// Validates the whole config before it replaces config.yaml (backup in config.yaml.bak).
export function saveConfig(file, doc) {
  if (doc.errors.length) throw new WizardError(doc.errors[0].message);
  normalize(doc.toJS() ?? {});
  fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- The wizard --------------------------------------------------------------------------------------
// opts: cwd, nonInteractive, flags, restart, self, env, userHome, io, fetch, openUrl, runServices.
export async function runInit(opts = {}) {
  const env = opts.env ?? process.env;
  const userHome = opts.userHome ?? env.HOME ?? os.homedir();
  const io = opts.io ?? (opts.nonInteractive ? quietIo() : prompter());
  try {
    return await wizard({ ...opts, env, userHome, io });
  } catch (err) {
    if (!(err instanceof WizardError)) throw err;
    io.say(`Error: ${err.message}`);
    return err.code;
  } finally {
    io.close?.();
  }
}

export const quietIo = () => ({ say: (m = "") => process.stderr.write(`${m}\n`) });

async function wizard(o) {
  const { io, env, userHome } = o;
  const flags = o.flags ?? {};
  const ni = !!o.nonInteractive;
  const fetchFn = o.fetch ?? globalThis.fetch;
  const expand = expandHomeIn(userHome);
  // ~ for the home, also as its real path (macOS: /var is /private/var), so cwd's realpath matches.
  const homes = [...new Set([userHome, real(userHome)])];
  const tilde = (p) => {
    for (const h of homes) if (p === h || p.startsWith(h + path.sep)) return p === h ? "~" : `~/${p.slice(h.length + 1)}`;
    return p;
  };
  const cwd = real(o.cwd ?? process.cwd());
  const P = setup({ env, userHome });
  const cfg = readConfig(P);
  const savedEnv = readEnv(P.env);
  const pending = {}; // env vars to write

  // An existing project: the one in this folder, or the --project id.
  let id = flags.project ?? null;
  if (id && !/^[a-z0-9-]+$/.test(id)) throw new WizardError(`Id inválido: ${id} (minúsculas, números y guiones)`, 2);
  let editing = (id && cfg.raw.projects?.[id] ? id : null) ?? (o.editId ?? projectAt(cfg.raw, cwd, expand));
  if (editing && !id && !ni && !o.editId) {
    const where = cfg.raw.projects[editing].name ?? editing;
    io.say(`Esta carpeta ya es el proyecto «${where}» (${editing}).`);
    if (!(await io.yes("¿Lo edito? (si no, no cambio nada)", true))) { io.say("No cambié nada."); return 1; }
  }
  const cur = editing ? cfg.raw.projects[editing] ?? {} : {};
  io.say(editing ? `Editando el proyecto ${editing} (${tilde(cwd)}). Enter mantiene lo que está entre corchetes.` : `Proyecto nuevo en ${tilde(cwd)}. Enter acepta lo que está entre corchetes.`);

  const found = findRepos(cwd);
  const childKanban = [cwd, ...found.repos].map((d) => path.join(d, "kanban")).find((d) => fs.existsSync(path.join(d, "config.yml")));

  // 1. Tracker -------------------------------------------------------------------------------------
  let type = flags.tracker ?? cur.tracker?.type ?? null;
  if (type && ![...TRACKERS, "none"].includes(type)) throw new WizardError(`--tracker: ${type} no es jira, kaneo, kanban-md ni none`, 2);
  if (!ni) {
    io.say("");
    io.say("1. Tracker: de dónde salen los tickets.");
    if (!type && !childKanban) io.say(`   ¿No tienes uno? Te recomiendo kanban-md: tareas en archivos Markdown junto al código, sin servidor (${KANBAN_MD_URL}).`);
    type = await io.choose("¿Qué tracker usa el proyecto?", [
      { value: "jira", label: "jira" },
      { value: "kaneo", label: "kaneo" },
      { value: "kanban-md", label: `kanban-md${childKanban ? ` (hay un board en ${tilde(childKanban)})` : " (recomendado si no tienes tracker)"}` },
      { value: "none", label: "ninguno por ahora" },
    ], type ?? "kanban-md");
  }
  if (!type) throw new WizardError("Falta --tracker (jira, kaneo, kanban-md o none)", 2);

  // 2. Name and id ---------------------------------------------------------------------------------
  let name = flags.name ?? cur.name ?? path.basename(cwd);
  if (!ni) {
    io.say("");
    name = await io.ask("2. Nombre del proyecto", name);
    if (!editing) {
      for (;;) {
        id = await io.ask("   Id (minúsculas, números y guiones; va en la URL /p/<id>)", id ?? slug(name));
        if (!/^[a-z0-9-]+$/.test(id)) { io.say("   Solo minúsculas, números y guiones."); continue; }
        if (!cfg.raw.projects?.[id]) break;
        const other = projectDirs(cfg.raw.projects[id], expand)[0];
        if (await io.yes(`   Ya existe el proyecto ${id}${other ? ` (en ${tilde(other)})` : ""}. ¿Lo edito en vez de crear otro?`, true)) { editing = id; break; }
        id = null;
      }
    }
  }
  id = editing ?? id ?? slug(name);
  if (!/^[a-z0-9-]+$/.test(id)) throw new WizardError(`Id inválido: ${id}`, 2);
  const PFX = envPrefix(id);
  const old = editing ? cfg.raw.projects[editing] ?? {} : {};

  // 3. Credentials, board ----------------------------------------------------------------------------
  let tracker = { type };
  if (type === "jira") tracker = await jiraStep({ io, ni, flags, old: old.tracker?.type === "jira" ? old.tracker : {}, PFX, env, savedEnv, pending, fetchFn, validate: !flags["no-validate"] });
  else if (type === "kaneo") tracker = await kaneoStep({ io, ni, flags, old: old.tracker?.type === "kaneo" ? old.tracker : {}, PFX, env, savedEnv, pending, fetchFn, raw: cfg.raw, id, expand, validate: !flags["no-validate"] });
  else if (type === "kanban-md") tracker = await kanbanStep({ io, ni, flags, old: old.tracker?.type === "kanban-md" ? old.tracker : {}, cwd, found, childKanban, id, name, env, expand, tilde });

  // 4. Repos -----------------------------------------------------------------------------------------
  const repos = await reposStep({ io, ni, flags, cwd, found, old, expand, tilde });

  // 5. Agents ----------------------------------------------------------------------------------------
  const agents = await agentsStep({ io, ni, flags, cwd, repos, old, id, env });

  // The block ---------------------------------------------------------------------------------------
  const single = repos.length === 1 && found.single && real(repos[0].path) === cwd;
  const block = {
    name,
    repo: single ? tilde(repos[0].path) : null,
    repos: repos.length ? repos.map((r) => ({ path: tilde(r.path), ...(r.role ? { role: r.role } : {}), ...(r.description ? { description: r.description } : {}) })) : null,
    repos_root: single ? null : tilde(cwd),
    tracker,
    agents: agents.agents,
    runtime: { dir: tilde(cwd), ...agents.runtime },
  };

  io.say("");
  io.say(`Así queda ${id} en ${tilde(P.config)}:`);
  io.say(YAML.stringify({ [id]: Object.fromEntries(Object.entries(block).filter(([, v]) => v != null)) }).replace(/^/gm, "  ").trimEnd());
  const secrets = Object.keys(pending);
  if (secrets.length) io.say(`Y en ${tilde(P.env)} (600): ${secrets.join(", ")}`);
  if (!ni && !(await io.yes("¿Lo guardo?", true))) { io.say("No cambié nada."); return 1; }

  if (secrets.length) setEnvVars(P.env, pending);
  writeProject(cfg.doc, id, block);
  const { ensureHelper, HELPER_URL } = await import("./terminal.mjs");
  if (agents.helper && ensureHelper(cfg.doc)) io.say(`Agrego helper: ${HELPER_URL} a la config (el hub llama al helper de tu escritorio).`);
  try {
    saveConfig(P.config, cfg.doc);
  } catch (err) {
    throw new WizardError(`La config resultante no es válida (${err.message}); no la guardé.`);
  }
  io.say(`Guardé el proyecto ${id} en ${tilde(P.config)} (respaldo: config.yaml.bak).`);

  // 6. Hooks -------------------------------------------------------------------------------------------
  const self = o.self ?? (await import("./self.mjs")).selfCommand();
  await hooksStep({ io, ni, flags, env, userHome, self, tilde });

  // 7. Services and the link ---------------------------------------------------------------------------
  await restartServices({ io, env, userHome, self, enabled: o.restart !== false, run: o.runServices });

  // 8. Orca: the project's layout in this machine's Orca, right away when Orca is here.
  if (block.runtime.terminal === "orca") await orcaStep({ io, env, doc: cfg.doc, id, orca: o.orca });
  const url = projectUrl(cfg.raw, id);
  io.say("");
  io.say(`Listo: ${url}`);
  if (!ni) (o.openUrl ?? openUrl)(url);
  return 0;
}

// Jira: URL, email (Cloud) and API token, checked with /myself; then the project and the JQL.
async function jiraStep({ io, ni, flags, old, PFX, env, savedEnv, pending, fetchFn, validate }) {
  const emailEnv = flags["email-env"] ?? old.email_env ?? `${PFX}_JIRA_EMAIL`;
  const tokenEnv = flags["token-env"] ?? old.token_env ?? `${PFX}_JIRA_TOKEN`;
  let baseUrl = flags["base-url"] ?? old.base_url ?? "";
  let jql = flags.jql ?? old.jql ?? null;
  if (ni) {
    if (!baseUrl) throw new WizardError("Falta --base-url (https://tuempresa.atlassian.net)", 2);
    baseUrl = cleanUrl(baseUrl);
    const cloud = !!(flags["email-env"] || old.email_env) || jiraCloud(baseUrl);
    const j = { baseUrl, cloud, email: env[emailEnv] ?? savedEnv[emailEnv], token: env[tokenEnv] ?? savedEnv[tokenEnv] };
    if (env[tokenEnv]) pending[tokenEnv] = env[tokenEnv];
    if (cloud && env[emailEnv]) pending[emailEnv] = env[emailEnv];
    if (validate) {
      if (!j.token || (cloud && !j.email)) throw new WizardError(`Para validar necesito ${cloud ? `${emailEnv} y ` : ""}${tokenEnv} en el entorno o en env (o --no-validate)`, 2);
      const me = await jira.myself(fetchFn, j);
      io.say(`Jira: conectado como ${me.displayName ?? me.emailAddress ?? me.name ?? "?"}`);
      if (jql) await jira.count(fetchFn, j, jql);
    }
    return { type: "jira", base_url: baseUrl, ...(cloud ? { email_env: emailEnv } : {}), token_env: tokenEnv, jql: jql ?? DEFAULT_JQL };
  }

  io.say("");
  io.say("3. Credenciales de Jira (se guardan en env, nunca en config.yaml).");
  for (;;) {
    baseUrl = cleanUrl(await askUrl(io, "URL de Jira (p. ej. https://tuempresa.atlassian.net)", baseUrl));
    const cloud = jiraCloud(baseUrl) || (await io.yes("Ese host no es atlassian.net. ¿Es Jira Cloud igual? (no: Jira Server/Data Center, con token personal)", !!old.email_env));
    const j = { baseUrl, cloud };
    if (cloud) {
      j.email = await io.ask(`Email de tu cuenta de Jira (va en env como ${emailEnv})`, savedEnv[emailEnv] ?? "");
      const t = await io.secret(`API token (https://id.atlassian.com/manage-profile/security/api-tokens; va en env como ${tokenEnv}, no se ve al escribir)`, !!savedEnv[tokenEnv]);
      j.token = t ?? savedEnv[tokenEnv];
    } else {
      const t = await io.secret(`Token personal de Jira (perfil → Personal Access Tokens; va en env como ${tokenEnv}, no se ve al escribir)`, !!savedEnv[tokenEnv]);
      j.token = t ?? savedEnv[tokenEnv];
    }
    try {
      if (!j.token || (cloud && !j.email)) throw new WizardError("faltan el email o el token");
      const me = await jira.myself(fetchFn, j);
      io.say(`Conectado como ${me.displayName ?? me.emailAddress ?? me.name ?? "?"}.`);
      const projects = await jira.projects(fetchFn, j);
      if (cloud) pending[emailEnv] = j.email;
      pending[tokenEnv] = j.token;
      let key = jqlProject(jql);
      if (projects.length) {
        io.say(`Proyectos de Jira que ves (${projects.length}):`);
        key = await io.choose("¿Cuál es el de este proyecto? (número o clave)", [
          ...projects.map((p) => ({ value: p.key, label: `${p.key} — ${p.name}` })),
        ].concat([{ value: "*", label: "todos los proyectos" }]), key && projects.some((p) => p.key === key) ? key : projects.length === 1 ? projects[0].key : "");
      } else io.say("No ves ningún proyecto con esa cuenta; el JQL queda sin filtro de proyecto.");
      const proposed = key === "*" || !key ? DEFAULT_JQL : old.jql && jqlProject(old.jql) === key ? old.jql : projectJql(key);
      for (;;) {
        jql = await io.ask("JQL de tus tickets (asignados a ti, sin terminar)", proposed);
        try {
          const n = await jira.count(fetchFn, j, jql);
          io.say(`Ese JQL trae ${n === 50 ? "50 o más" : n} ticket(s) abiertos.`);
          break;
        } catch (err) {
          io.say(`Jira no aceptó el JQL: ${err.message}`);
        }
      }
      return { type: "jira", base_url: baseUrl, ...(cloud ? { email_env: emailEnv } : {}), token_env: tokenEnv, jql };
    } catch (err) {
      if (!(err instanceof WizardError)) throw err;
      io.say(`No pude validar: ${err.message}`);
      if (!(await io.yes("¿Pruebo con otros datos?", true))) throw new WizardError("Sin credenciales válidas de Jira; no cambié nada.");
    }
  }
}

// Kaneo: URL and token, the workspace, and a filter when the workspace is shared.
async function kaneoStep({ io, ni, flags, old, PFX, env, savedEnv, pending, fetchFn, raw, id, expand, validate }) {
  const tokenEnv = flags["token-env"] ?? old.token_env ?? `${PFX}_KANEO_TOKEN`;
  let baseUrl = flags["base-url"] ?? old.base_url ?? "";
  const listFlag = (v) => (v == null ? null : String(v).split(",").map((s) => s.trim()).filter(Boolean));
  const block = (base, ws, filter) => ({ type: "kaneo", base_url: base, workspace_id: ws, token_env: tokenEnv, ...filter, ...(old.task_url ? { task_url: old.task_url } : {}) });
  if (ni) {
    if (!baseUrl) throw new WizardError("Falta --base-url (https://kaneo.tuempresa.com)", 2);
    const ws = flags["workspace-id"] ?? old.workspace_id;
    if (!ws) throw new WizardError("Falta --workspace-id", 2);
    baseUrl = cleanUrl(baseUrl);
    const token = env[tokenEnv] ?? savedEnv[tokenEnv];
    if (env[tokenEnv]) pending[tokenEnv] = env[tokenEnv];
    if (validate) {
      if (!token) throw new WizardError(`Para validar necesito ${tokenEnv} en el entorno o en env (o --no-validate)`, 2);
      const projects = await kaneo.projects(fetchFn, { baseUrl, token }, ws);
      io.say(`Kaneo: workspace con ${projects.length} proyecto(s)`);
    }
    const filter = {};
    if (listFlag(flags["kaneo-projects"])) filter.projects = listFlag(flags["kaneo-projects"]);
    if (listFlag(flags["exclude-projects"])) filter.exclude_projects = listFlag(flags["exclude-projects"]);
    if (!flags["kaneo-projects"] && !flags["exclude-projects"]) Object.assign(filter, old.projects ? { projects: old.projects } : {}, old.exclude_projects ? { exclude_projects: old.exclude_projects } : {});
    return block(baseUrl, ws, filter);
  }

  io.say("");
  io.say("3. Credenciales de Kaneo (se guardan en env, nunca en config.yaml).");
  for (;;) {
    baseUrl = cleanUrl(await askUrl(io, "URL de Kaneo (p. ej. https://kaneo.tuempresa.com)", baseUrl));
    const t = await io.secret(`Token de API de Kaneo (va en env como ${tokenEnv}, no se ve al escribir)`, !!savedEnv[tokenEnv]);
    const k = { baseUrl, token: t ?? savedEnv[tokenEnv] };
    try {
      if (!k.token) throw new WizardError("falta el token");
      const workspaces = await kaneo.workspaces(fetchFn, k);
      let ws;
      if (workspaces?.length) {
        io.say(`Workspaces que ves (${workspaces.length}):`);
        ws = await io.choose("¿Cuál es el de este proyecto?", workspaces.map((w) => ({ value: w.id, label: `${w.name} (${w.id})` })), workspaces.some((w) => w.id === old.workspace_id) ? old.workspace_id : workspaces.length === 1 ? workspaces[0].id : "");
      } else {
        ws = await io.ask("ID del workspace (está en la URL del workspace en Kaneo)", old.workspace_id ?? "");
      }
      const projects = await kaneo.projects(fetchFn, k, ws);
      pending[tokenEnv] = k.token;
      io.say(`Conectado: el workspace tiene ${projects.length} proyecto(s)${projects.length ? `: ${projects.map((p) => `${p.name} (${p.slug})`).join(", ")}` : ""}.`);
      let filter = {};
      // Another Overhaul project on this same workspace: it is shared.
      const sharedWith = Object.entries(raw.projects ?? {}).filter(([pid, p]) => pid !== id && p?.tracker?.type === "kaneo" && cleanUrl(String(p.tracker.base_url ?? "")) === baseUrl && String(p.tracker.workspace_id) === String(ws)).map(([pid]) => pid);
      if (sharedWith.length) io.say(`Ese workspace también lo usa: ${sharedWith.join(", ")}.`);
      const wasFiltered = !!(old.projects || old.exclude_projects);
      if (projects.length > 1 && (await io.yes("¿El workspace es compartido (tiene proyectos que no son de este)?", sharedWith.length > 0 || wasFiltered))) {
        const mode = await io.choose("¿Cómo filtro los tickets?", [
          { value: "projects", label: "solo algunos proyectos de Kaneo (projects)" },
          { value: "exclude_projects", label: "todos menos algunos (exclude_projects)" },
        ], old.exclude_projects ? "exclude_projects" : "projects");
        projects.forEach((p, i) => io.say(`  ${i + 1}) ${p.name} (${p.slug})`));
        const prev = (old[mode] ?? []).join(", ");
        for (;;) {
          const picked = (await io.ask(mode === "projects" ? "Proyectos de este (números o slugs, separados por coma)" : "Proyectos que no son de este (números o slugs, separados por coma)", prev)).split(",").map((s) => s.trim()).filter(Boolean);
          const slugs = picked.map((s) => (/^\d+$/.test(s) ? projects[Number(s) - 1]?.slug : projects.find((p) => [p.slug, p.name].some((x) => x.toLowerCase() === s.toLowerCase()))?.slug ?? null));
          if (slugs.length && slugs.every(Boolean)) { filter = { [mode]: slugs }; break; }
          io.say("No reconozco alguno; usa los números o slugs de la lista.");
        }
      }
      return block(baseUrl, ws, filter);
    } catch (err) {
      if (!(err instanceof WizardError)) throw err;
      io.say(`No pude validar: ${err.message}`);
      if (!(await io.yes("¿Pruebo con otros datos?", true))) throw new WizardError("Sin credenciales válidas de Kaneo; no cambié nada.");
    }
  }
}

// kanban-md: the board's folder (created with kanban-md init if missing) and the keys' prefix.
async function kanbanStep({ io, ni, flags, old, cwd, childKanban, id, name, env, expand, tilde }) {
  let dir = flags["kanban-dir"] ?? old.dir ?? (childKanban ? tilde(childKanban) : tilde(path.join(cwd, "kanban")));
  let prefix = flags.prefix ?? old.prefix ?? (id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "K");
  if (!ni) {
    io.say("");
    io.say("3. Board de kanban-md.");
    dir = await io.ask("Carpeta del board", dir);
    prefix = (await io.ask("Prefijo de las claves de los tickets (ABC → ABC-12)", prefix)).toUpperCase();
  }
  const abs = path.resolve(cwd, expand(dir));
  if (!fs.existsSync(path.join(abs, "config.yml"))) {
    const bin = which("kanban-md", env);
    if (!bin) {
      io.say(`kanban-md no está instalado. Instálalo (${KANBAN_MD_URL}, p. ej. go install github.com/antopolskiy/kanban-md@latest) y crea el board con: kanban-md init --dir ${dir}`);
      io.say("Dejo el tracker configurado; el hub lo lee cuando el board exista.");
    } else if (ni || (await io.yes(`No hay board en ${dir}. ¿Lo creo con kanban-md init?`, true))) {
      const r = spawnSync(bin, ["init", "--dir", abs, "--name", name], { encoding: "utf8", env });
      if (r.status === 0) io.say(`Creé el board en ${dir}.`);
      else io.say(`kanban-md init falló (${(r.stderr || r.stdout || "").trim().split("\n").pop()}); créalo a mano: kanban-md init --dir ${dir}`);
    }
  }
  return { type: "kanban-md", dir: tilde(abs), prefix, ...(old.statuses ? { statuses: old.statuses } : {}), ...(old.tasks_dir ? { tasks_dir: old.tasks_dir } : {}) };
}

// The repos: this one, or the chosen git children, each with a role and a description.
async function reposStep({ io, ni, flags, cwd, found, old, expand, tilde }) {
  const before = new Map();
  for (const r of [old.repos ?? []].flat()) {
    const p = typeof r === "string" ? r : r?.path;
    if (p) before.set(real(path.resolve(cwd, expand(p))), typeof r === "string" ? {} : r);
  }
  if (flags.repo?.length) {
    return flags.repo.map((spec) => {
      const [p, role, ...desc] = String(spec).split(":");
      const abs = real(path.resolve(cwd, expand(p)));
      if (!fs.existsSync(abs)) throw new WizardError(`--repo ${p}: no existe`, 2);
      const guess = proposeRepo(abs);
      return { path: abs, role: role || guess.role, description: desc.join(":") || guess.description };
    });
  }
  const all = found.repos.map(real);
  if (ni) {
    const keep = before.size ? all.filter((r) => before.has(r)) : all;
    return (keep.length ? keep : all).map((r) => ({ path: r, role: before.get(r)?.role ?? proposeRepo(r).role, description: before.get(r)?.description ?? proposeRepo(r).description }));
  }
  io.say("");
  if (!all.length) {
    io.say(`4. Repos: no encontré repos git en ${tilde(cwd)} ni en sus carpetas. El proyecto queda sin repos (agrégalos con overhaul project edit).`);
    return [];
  }
  let chosen = all;
  if (found.single) io.say(`4. Repo: ${tilde(all[0])}`);
  else {
    io.say(`4. Repos: encontré ${all.length} en ${tilde(cwd)} (un ticket puede tocar varios):`);
    all.forEach((r, i) => io.say(`  ${i + 1}) ${path.basename(r)}${proposeRepo(r).stack ? ` — ${proposeRepo(r).stack}` : ""}`));
    const prev = before.size ? all.map((r, i) => (before.has(r) ? i + 1 : null)).filter(Boolean).join(",") : "todos";
    for (;;) {
      const v = await io.ask("¿Cuáles son de este proyecto? (números separados por coma)", prev || "todos");
      if (v === "todos") break;
      const picked = v.split(",").map((s) => Number(s.trim()));
      if (picked.length && picked.every((n) => Number.isInteger(n) && n >= 1 && n <= all.length)) { chosen = [...new Set(picked)].sort((a, b) => a - b).map((n) => all[n - 1]); break; }
      io.say(`Usa números de 1 a ${all.length}, separados por coma, o "todos".`);
    }
  }
  io.say("   Rol y descripción de cada repo: los agentes los leen para saber qué cambiar en cada uno.");
  const out = [];
  for (const r of chosen) {
    const guess = proposeRepo(r);
    const prev = before.get(r) ?? {};
    const n = path.basename(r);
    const role = await io.ask(`   ${n}: rol (backend, frontend, mobile, infra, docs, library...)`, prev.role ?? guess.role);
    const description = await io.ask(`   ${n}: descripción`, prev.description ?? guess.description);
    out.push({ path: r, role, description });
  }
  return out;
}

// How agents run: claude, pi or an own command; a repo with its own lane decides for itself.
async function agentsStep({ io, ni, flags, cwd, repos, old, id, env }) {
  const lane = findLane([cwd, ...repos.map((r) => r.path)]);
  const r = old.runtime ?? {};
  let command = flags.runtime ?? r.command ?? (lane?.pi ? "pi" : "claude");
  let prompt = flags.prompt ?? r.prompt ?? null;
  let orchestrator = flags.orchestrator ?? r.orchestrator ?? `${id}:orq`;
  let location = flags["agents-location"] ?? old.agents?.location ?? (lane ? "repo" : "external");
  if (!["external", "repo"].includes(location)) throw new WizardError(`--agents-location: ${location} no es external ni repo`, 2);
  let terminal = flags.terminal ?? r.terminal ?? null;
  if (terminal && !["tmux", "orca"].includes(terminal)) throw new WizardError(`--terminal: ${terminal} no es tmux ni orca`, 2);
  let helper = !!flags.helper;
  if (!ni) {
    io.say("");
    io.say("5. Agentes.");
    if (lane) io.say(`   ${path.basename(lane.dir)} tiene lane propio (${lane.what}): lo respeto. Sus agentes, roles y modelos los define el repo; el perfil queda ahí.`);
    const kind = await io.choose("Runtime de los agentes", [
      { value: "claude", label: "claude (Claude Code)" },
      { value: "pi", label: "pi" },
      { value: "own", label: "comando propio" },
    ], RUNTIMES.includes(command) ? command : "own");
    if (kind === "own") command = await io.ask("Comando que abre el agente (corre en la carpeta del ticket)", RUNTIMES.includes(command) ? "" : command);
    else command = kind;
    if (!which(command.split(/\s+/)[0], env)) io.say(`   Aviso: no encuentro ${command.split(/\s+/)[0]} en el PATH de esta terminal.`);
    const p = await io.ask("Primer mensaje de cada agente de ticket ({key} = la clave; - = ninguno)", prompt ?? "-");
    prompt = p === "-" || p === "" ? null : p;
    const { chooseTerminal } = await import("./terminal.mjs");
    terminal = await chooseTerminal({ io, ni, flag: flags.terminal, env, current: terminal });
    orchestrator = await io.ask(terminal === "orca"
      ? "Nombre del orquestador (sesión:título; su terminal de Orca se titula así y recibe los tickets sin terminal propia)"
      : "Ventana de tmux del orquestador (sesión:ventana; recibe los tickets sin ventana propia)", orchestrator);
    if (terminal === "orca") helper = await io.yes("¿Miras este hub también desde otro computador con el helper de Overhaul (su Orca sigue los tickets)?", helper);
    if (!lane) {
      location = await io.choose("¿Dónde vive el perfil de agentes?", [
        { value: "external", label: "fuera del repo, en la config de Overhaul (recomendado)" },
        { value: "repo", label: "dentro del repo (AGENTS.md, .claude/agents)" },
      ], location);
    }
  }
  // profile: the crew the orchestrator uses. "default" is Overhaul's (code-agents crew plus the
  // questions agent, OVH-29); a repo with its own lane keeps its own and has none here.
  const profile = lane ? null : old.agents?.profile ?? "default";
  return {
    runtime: { command, prompt, orchestrator, terminal },
    agents: { location, profile },
    helper,
  };
}

async function orcaStep({ io, env, doc, id, orca }) {
  const { buildOrca, hasOrca } = await import("./terminal.mjs");
  if (!orca && !hasOrca(env)) {
    io.say("Orca: no lo encuentro en esta máquina (orca en el PATH, ORCA_BIN o /Applications/Orca.app). Cuando esté, corre overhaul terminal en la carpeta del proyecto.");
    return;
  }
  const cfg = normalize(doc.toJS() ?? {});
  io.say("");
  io.say("Orca: armando el proyecto…");
  try {
    await buildOrca(cfg, cfg.projects.find((p) => p.id === id), { io, env, orca });
    io.say("Orca: listo (overhaul terminal abre el orquestador).");
  } catch (err) {
    io.say(`Orca: no pude armarlo (${err.message}). Reintenta con overhaul terminal.`);
  }
}

// Claude Code's hook and pi's extension, when missing (asking first).
async function hooksStep({ io, ni, flags, env, userHome, self, tilde }) {
  if (ni && !flags.hooks) return;
  const { installHooks, installPiExtension, isOurHook } = await import("./hooks.mjs");
  const settings = path.join(userHome, ".claude/settings.json");
  const hooked = (() => {
    const s = readJson(settings);
    return !!s && HOOK_EVENTS.every((e) => (s.hooks?.[e] ?? []).some((g) => (g.hooks ?? []).some((h) => isOurHook(String(h.command ?? ""), self))));
  })();
  const hasClaude = which("claude", env) || fs.existsSync(path.join(userHome, ".claude"));
  if (!hooked && hasClaude) {
    if (!ni) io.say("");
    if (ni || (await io.yes(`6. ¿Instalo el hook de Claude Code en ${tilde(settings)}? (la página ve qué hacen los agentes; respalda el archivo)`, true))) {
      const [res] = installHooks({ self, files: [settings] });
      io.say(`Hook de Claude: ${res.changed.length ? `instalado (${res.changed.join(", ")})` : "ya estaba"}`);
    } else io.say("Hook de Claude: no instalado (después: overhaul install-hooks)");
  }
  const piDir = path.join(userHome, ".pi/agent/extensions");
  if (which("pi", env) && !fs.existsSync(path.join(piDir, "overhaul.ts"))) {
    if (ni || (await io.yes(`¿Instalo la extensión de pi en ${tilde(piDir)}?`, true))) {
      for (const l of installPiExtension({ dir: piDir, command: self }).log) io.say(l);
    } else io.say("Extensión de pi: no instalada (después: overhaul install-pi)");
  }
}

async function restartServices({ io, env, userHome, self, enabled, run }) {
  if (!enabled) return;
  const { context, control, installed } = await import("./service.mjs");
  const ctx = context({ env: { ...env, HOME: userHome }, self, run, log: () => {} });
  if (!installed(ctx)) io.say("Servicios no instalados: el hub toma el proyecto cuando lo arranques (overhaul service install).");
  else if (control(ctx, "restart") === 0) io.say("Reinicié el hub y el puente.");
  else io.say("No pude reiniciar los servicios: overhaul service restart");
}

function projectUrl(raw, id) {
  const port = Number(raw.port) || 7420;
  return `http://localhost:${port}/p/${encodeURIComponent(id)}`;
}

// The browser on this machine when there is one to open; otherwise only the printed link.
export function openUrl(url, { platform = process.platform, env = process.env } = {}) {
  const cmd = platform === "darwin" ? "open" : env.DISPLAY || env.WAYLAND_DISPLAY ? "xdg-open" : null;
  if (!cmd || !which(cmd, env)) return false;
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

const cleanUrl = (u) => {
  let s = String(u).trim();
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
};
async function askUrl(io, q, def) {
  for (;;) {
    const v = await io.ask(q, def);
    try { if (v && new URL(cleanUrl(v))) return v; } catch {}
    io.say("Escribe una URL, como https://tuempresa.atlassian.net");
  }
}

// --- overhaul project list | edit | remove, overhaul open --------------------------------------------
export function load(env = process.env, userHome = env.HOME ?? os.homedir()) {
  const P = resolvePaths(env, userHome);
  if (!fs.existsSync(P.config)) throw new WizardError(`No existe ${P.config}: corre overhaul setup (o overhaul init en la carpeta de un proyecto)`);
  return { P, ...readConfig(P), expand: expandHomeIn(userHome) };
}

export function listProjects({ json = false, env, userHome, log = (m) => console.log(m) } = {}) {
  try {
    const { raw, expand } = load(env, userHome);
    const rows = Object.entries(raw.projects ?? {}).map(([id, p]) => ({
      id,
      name: p?.name ?? id,
      tracker: p?.tracker?.type ?? "none",
      dir: projectDirs(p, expand)[0] ?? null,
      repos: [p?.repos ?? (p?.repo ? [p.repo] : [])].flat().map((r) => ({ path: expand(String(r?.path ?? r)), role: r?.role ?? null })),
    }));
    if (json) log(JSON.stringify(rows, null, 2));
    else if (!rows.length) log("Sin proyectos. Agrega uno con overhaul init en su carpeta.");
    else for (const r of rows) log(`${r.id.padEnd(16)} ${r.tracker.padEnd(10)} ${r.dir ?? "-"}${r.name !== r.id ? `  (${r.name})` : ""}`);
    return 0;
  } catch (err) {
    if (!(err instanceof WizardError)) throw err;
    console.error(err.message);
    return 1;
  }
}

export function resolveProject(raw, id, cwd, expand) {
  if (id) {
    if (!raw.projects?.[id]) throw new WizardError(`No hay un proyecto ${id} (overhaul project list)`);
    return id;
  }
  const here = projectAt(raw, cwd, expand);
  if (!here) throw new WizardError(`${cwd} no es la carpeta de ningún proyecto; di cuál (overhaul project list)`, 2);
  return here;
}

// Reopens the wizard with the project's current values, from its folder.
export async function editProject(id, opts = {}) {
  const env = opts.env ?? process.env;
  try {
    const { raw, expand } = load(env, opts.userHome);
    const pid = resolveProject(raw, id, opts.cwd ?? process.cwd(), expand);
    const dir = projectDirs(raw.projects[pid], expand)[0] ?? opts.cwd ?? process.cwd();
    if (!fs.existsSync(dir)) throw new WizardError(`La carpeta del proyecto (${dir}) no existe`);
    return await runInit({ ...opts, cwd: dir, editId: pid, flags: { ...opts.flags, project: pid } });
  } catch (err) {
    if (!(err instanceof WizardError)) throw err;
    console.error(err.message);
    return err.code;
  }
}

export async function removeProject(id, { force = false, nonInteractive = false, restart = true, self, env = process.env, userHome, io } = {}) {
  io ??= nonInteractive || force ? quietIo() : prompter();
  try {
    const { P, doc, raw } = load(env, userHome);
    if (!raw.projects?.[id]) throw new WizardError(`No hay un proyecto ${id} (overhaul project list)`);
    if (!force) {
      if (nonInteractive) throw new WizardError("Sin --force no quito nada en modo no interactivo", 2);
      if (!(await io.yes(`¿Quito el proyecto ${id} de config.yaml? (sus tickets, preguntas y notas en la base no se borran)`, false))) { io.say("No cambié nada."); return 1; }
    }
    doc.deleteIn(["projects", id]);
    saveConfig(P.config, doc);
    const t = raw.projects[id]?.tracker ?? {};
    const vars = [t.token_env, t.email_env].filter(Boolean);
    io.say(`Quité ${id} de ${P.config} (respaldo: config.yaml.bak).${vars.length ? ` Sus credenciales siguen en env (${vars.join(", ")}); bórralas a mano si ya no las usas.` : ""}`);
    await restartServices({ io, env, userHome: userHome ?? env.HOME ?? os.homedir(), self: self ?? (await import("./self.mjs")).selfCommand(), enabled: restart });
    return 0;
  } catch (err) {
    if (!(err instanceof WizardError)) throw err;
    io.say(`Error: ${err.message}`);
    return err.code;
  } finally {
    io.close?.();
  }
}

export async function openProject(id, { cwd = process.cwd(), env = process.env, userHome } = {}) {
  try {
    const { raw, expand } = load(env, userHome);
    const url = projectUrl(raw, resolveProject(raw, id, cwd, expand));
    console.log(url);
    openUrl(url, { env });
    return 0;
  } catch (err) {
    if (!(err instanceof WizardError)) throw err;
    console.error(err.message);
    return err.code;
  }
}
