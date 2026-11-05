// Config gaps the hub asks you about instead of guessing:
//   repo_for_group  a tracker project (ticket group) has no repo  -> answer with the repo's git URL
//   board_for_repo  a local repo has no tracker project           -> answer with the board URL
// Only for projects whose repos live on this machine (repos_root set, host = here).
import fs from "node:fs";
import { localHost } from "./env.mjs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getJson, secret } from "./adapters/index.mjs";
import { editConfig, addRepoMapping } from "./configfile.mjs";
import { httpError } from "./store.mjs";

const run = promisify(execFile);
const GIT_URL_RE = /^(git@[\w.-]+:[\w./-]+?|https:\/\/[\w.-]+\/[\w./-]+?)(\.git)?$/;

export class Setup {
  constructor(cfg, ticketsFor, reload) {
    this.cfg = cfg;
    this.ticketsFor = ticketsFor;
    this.reload = reload; // re-reads config.yaml after an edit
    this.ignoredFile = path.join(cfg.dataDir, "setup-ignored.json");
  }

  ignored() {
    return new Set(fs.existsSync(this.ignoredFile) ? JSON.parse(fs.readFileSync(this.ignoredFile, "utf8")) : []);
  }

  ignore(id) {
    const set = this.ignored();
    set.add(id);
    fs.mkdirSync(path.dirname(this.ignoredFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.ignoredFile, JSON.stringify([...set]), { mode: 0o600 });
  }

  async questions() {
    const ignored = this.ignored();
    const out = [];
    for (const p of this.cfg.projects) {
      if (!p.reposRoot || p.host !== localHost()) continue;
      const mapped = new Map(Object.entries(p.autoWork.repoByGroup)); // lower group -> repo
      let tickets = [];
      try { tickets = await this.ticketsFor(p, false); } catch { continue; }

      const groups = [...new Set(tickets.map((t) => t.group).filter(Boolean))];
      for (const group of groups) {
        const id = `repo_for_group:${p.id}:${group}`;
        if (!mapped.has(group.toLowerCase()) && !ignored.has(id)) {
          out.push({ id, kind: "repo_for_group", project: p.id, projectName: p.name, group, text: `${p.name}: el proyecto ${group} no tiene repo. ¿Cuál es la URL del repo?` });
        }
      }

      const used = new Set([...mapped.values(), p.autoWork.repo].filter(Boolean));
      for (const repo of localRepos(p.reposRoot)) {
        const id = `board_for_repo:${p.id}:${path.basename(repo)}`;
        if (!used.has(repo) && !ignored.has(id)) {
          out.push({ id, kind: "board_for_repo", project: p.id, projectName: p.name, repo: path.basename(repo), text: `${p.name}: el repo ${path.basename(repo)} no tiene proyecto asociado. ¿Cuál es la URL de su board?` });
        }
      }
    }
    return out;
  }

  async answer(id, answer) {
    const q = (await this.questions()).find((x) => x.id === id);
    if (!q) throw httpError(404, "Esa pregunta ya no está pendiente");
    const p = this.cfg.projects.find((x) => x.id === q.project);
    const value = String(answer ?? "").trim();
    if (q.kind === "repo_for_group") {
      const repo = await this.cloneOrReuse(p, value);
      editConfig((doc) => addRepoMapping(doc, p.id, q.group, repo));
      this.reload();
      return { message: `${q.group} → ${path.basename(repo)}` };
    }
    const group = await this.groupFromBoardUrl(p, value);
    editConfig((doc) => addRepoMapping(doc, p.id, group, path.join(p.reposRoot, q.repo)));
    this.reload();
    return { message: `${q.repo} → ${group}` };
  }

  async cloneOrReuse(p, url) {
    if (!GIT_URL_RE.test(url)) throw httpError(400, "Usa una URL de git, como git@github.com:Org/repo.git o https://github.com/Org/repo");
    const name = url.replace(/\.git$/, "").split(/[/:]/).pop();
    const dest = path.join(p.reposRoot, name);
    if (fs.existsSync(dest)) {
      const origin = await run("git", ["-C", dest, "remote", "get-url", "origin"]).then((r) => r.stdout.trim(), () => "");
      if (sameRepo(origin, url)) return dest;
      throw httpError(409, `${dest} ya existe con otro origin (${origin || "sin origin"})`);
    }
    try {
      await run("git", ["clone", "--quiet", url, dest], { timeout: 10 * 60_000 });
    } catch (err) {
      throw httpError(502, `git clone falló: ${String(err.stderr || err.message).trim().split("\n").pop()}`);
    }
    return dest;
  }

  // Kaneo: .../project/<id>/... or .../task/<SLUG>-<n>. Jira: .../projects/<KEY>... or /browse/<KEY>-<n>.
  async groupFromBoardUrl(p, value) {
    let url;
    try { url = new URL(value); } catch { throw httpError(400, "Pega la URL completa del board"); }
    const t = p.tracker;
    if (!t?.baseUrl || new URL(t.baseUrl).host !== url.host) throw httpError(400, `Ese board no es de ${t?.baseUrl ?? "el tracker de este proyecto"}`);
    if (t.type === "jira") {
      const key = url.pathname.match(/\/projects\/([A-Z][A-Z0-9_]+)/)?.[1] ?? url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+)-\d+/)?.[1];
      if (!key) throw httpError(400, "No encontré la clave del proyecto en esa URL de Jira");
      return key;
    }
    if (t.type === "kaneo") {
      const projectId = url.pathname.match(/\/project\/([\w-]+)/)?.[1];
      const slug = url.pathname.match(/\/task\/([^/]+)-\d+/)?.[1];
      if (!projectId && !slug) throw httpError(400, "Usa la URL del board (…/project/<id>/…) o de una tarea del proyecto");
      const base = t.baseUrl.replace(/\/$/, "");
      const list = await getJson(`${base}/api/project?workspaceId=${encodeURIComponent(t.workspaceId)}`, { authorization: `Bearer ${secret(t, "tokenEnv")}` });
      const projects = Array.isArray(list) ? list : list.projects ?? [];
      const hit = projects.find((x) => (projectId && x.id === projectId) || (slug && String(x.slug).toLowerCase() === slug.toLowerCase()));
      if (!hit) throw httpError(404, "Ese proyecto no está en el workspace configurado");
      return hit.name;
    }
    throw httpError(400, `${t.type} no tiene boards por URL`);
  }
}

function localRepos(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && fs.existsSync(path.join(root, d.name, ".git")))
    .map((d) => path.join(root, d.name));
}

export function sameRepo(a, b) {
  const norm = (u) => u.replace(/\.git$/, "").replace(/^git@([^:]+):/, "https://$1/").toLowerCase();
  return norm(a) === norm(b);
}
