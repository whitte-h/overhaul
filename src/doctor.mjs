// `overhaul doctor`: checks that this installation works on its own (hub, bridge, config, Orca)
// and says what is wrong in plain words. --fix repairs what is safe to repair here; --prompt prints
// a prompt to paste into an agent (Claude Code, pi...) with this machine's state, no secrets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { resolvePaths } from "./paths.mjs";
import { configPort, hubAnswers } from "./init.mjs";

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
const hostName = () => os.hostname().replace(/\.local$/, "");

// KEY=value lines of an env file (values are only used here, never printed).
function envLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}
const envVars = (lines) => Object.fromEntries(lines.map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter((m) => m && !m[0].trimStart().startsWith("#")).map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")]));

// HUB_URL / OVERHAUL_URL naming hubs on other machines: the bridge and the agents here would talk
// to them instead of this machine's hub.
export function remoteHubUrls(vars) {
  const out = [];
  for (const k of ["HUB_URL", "OVERHAUL_URL"]) {
    if (!vars[k]) continue;
    const remote = vars[k].split(",").map((u) => u.trim()).filter((u) => u && !LOOPBACK.test(u));
    if (remote.length) out.push({ key: k, value: vars[k], remote });
  }
  return out;
}

// Comments out HUB_URL / OVERHAUL_URL lines that point at another machine, saying why. Returns the
// keys it turned off. The value stays in the file, commented, to bring back by hand.
export function disableRemoteHubUrls(file, stamp = new Date().toISOString()) {
  const lines = envLines(file);
  const off = new Set(remoteHubUrls(envVars(lines)).map((r) => r.key));
  if (!off.size) return [];
  const out = lines.map((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=/);
    return m && off.has(m[1]) ? `# ${stamp} overhaul: apagado, apuntaba a un hub de otra máquina; este nodo usa su propio hub\n# ${l}` : l;
  });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out.join("\n"), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return [...off];
}

function readConfig(file) {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch (err) {
    return { __error: err.message };
  }
}

function which(cmd, env) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8", env });
  return r.status === 0 ? r.stdout.trim() : null;
}
const orcaBin = (env) => env.ORCA_BIN || which("orca", env) || (fs.existsSync("/Applications/Orca.app/Contents/Resources/bin/orca") ? "/Applications/Orca.app/Contents/Resources/bin/orca" : null);

// Every check: { ok, title, detail?, fix? (what to do), fixable? (--fix does it) }.
export async function diagnose({ env = process.env, userHome = env.HOME || os.homedir(), serviceLines = null, bridgeWait = 0 } = {}) {
  const P = resolvePaths(env, userHome);
  const checks = [];
  const add = (c) => checks.push(c);

  add(P.mode === "home"
    ? { ok: true, title: `Carpeta de Overhaul: ${P.home}` }
    : { ok: false, title: `Overhaul usa una ubicación anterior (${P.configDir})`, fix: "overhaul service install (migra a ~/.overhaul con respaldo)" });

  const raw = fs.existsSync(P.config) ? readConfig(P.config) : null;
  const projects = Object.entries(raw?.projects ?? {});
  if (!raw) add({ ok: false, title: `No hay config (${P.config})`, fix: "overhaul setup, y después overhaul init en la carpeta de cada proyecto" });
  else if (raw.__error) add({ ok: false, title: `config.yaml no se puede leer: ${raw.__error}`, fix: `corrige ${P.config} (respaldo en config.yaml.bak si lo editó init)` });
  else if (!projects.length) add({ ok: false, title: "La config no tiene proyectos", fix: "overhaul init en la carpeta del proyecto" });
  else add({ ok: true, title: `Proyectos: ${projects.map(([id]) => id).join(", ")}` });

  const fileVars = envVars(envLines(P.env));
  const vars = { ...fileVars, ...Object.fromEntries(Object.entries(env).filter(([k]) => /^(HUB|OVERHAUL)_/.test(k))) };
  if (!fileVars.HUB_TOKEN && !env.HUB_TOKEN && !raw?.auth?.password_env) add({ ok: false, title: "Sin contraseña del hub: no arranca", fix: "overhaul set-password" });
  for (const r of remoteHubUrls(vars)) {
    const inFile = fileVars[r.key] === r.value;
    add({
      ok: false,
      title: `${r.key} apunta a otro hub (${r.remote.join(", ")})`,
      detail: "El puente y los agentes de esta máquina le reportan a ese hub, no al de aquí: el hub local muestra «el puente está desconectado» y los clics no abren agentes.",
      fix: inFile ? `overhaul doctor --fix (lo comenta en ${P.env}) y overhaul service restart` : `quita ${r.key} del entorno de tu shell`,
      fixable: inFile,
    });
  }
  const host = vars.HUB_HOST || hostName();
  const hosts = new Set(projects.map(([, p]) => p?.host ?? host));
  for (const h of hosts) {
    if (h !== host) add({ ok: false, title: `Hay proyectos con host «${h}», pero esta máquina se llama «${host}»`, detail: "Esos proyectos se tratan como de otra máquina: su puente nunca aparece aquí.", fix: `quita host: ${h} de esos proyectos en config.yaml (sin host corren aquí)` });
  }

  if (serviceLines) {
    const bad = serviceLines.filter((l) => !/corriendo/.test(l));
    add(bad.length ? { ok: false, title: "Servicios", detail: serviceLines.join("\n"), fix: "overhaul service install" } : { ok: true, title: "Servicios: hub y puente corriendo" });
  }

  const port = configPort(P.config);
  const up = await hubAnswers(port);
  add(up ? { ok: true, title: `Hub respondiendo en http://127.0.0.1:${port}` } : { ok: false, title: `El hub no responde en el puerto ${port}`, fix: `overhaul service status; logs en ${P.logs}` });

  if (up && fileVars.HUB_AGENT_TOKEN) {
    const seen = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/agent/bridge/seen`, { headers: { authorization: `Bearer ${fileVars.HUB_AGENT_TOKEN}` }, signal: AbortSignal.timeout(2000) });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    };
    let s = await seen();
    for (let waited = 0; s && !(s.hosts?.[s.host] < 30_000) && waited < bridgeWait; waited += 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      s = await seen();
    }
    if (s) {
      const others = Object.keys(s.hosts ?? {}).filter((h) => h !== s.host && s.hosts[h] < 30_000);
      add(s.hosts?.[s.host] < 30_000
        ? { ok: true, title: `Puente de ${s.host} conectado a este hub` }
        : { ok: false, title: `El puente de ${s.host} no le habla a este hub`, detail: others.length ? `Sí llega un puente que se llama ${others.join(", ")}: el hub y el puente no usan el mismo nombre (HUB_HOST).` : "Ningún puente le reporta a este hub.", fix: "revisa los puntos de arriba (HUB_URL, host); después overhaul service restart" });
    }
  }

  const orcaProjects = projects.filter(([, p]) => (p?.runtime?.terminal ?? raw?.terminal) === "orca");
  if (orcaProjects.length) {
    const bin = orcaBin(env);
    add(bin ? { ok: true, title: `Orca: ${bin}` } : { ok: false, title: `Proyectos con terminal orca (${orcaProjects.map(([id]) => id).join(", ")}) pero no encuentro el CLI de Orca`, fix: "instala Orca, o pon ORCA_BIN en ~/.overhaul/env" });
  }
  return { checks, paths: P, port, host };
}

export function report({ checks }, log = console.log) {
  for (const c of checks) {
    log(`${c.ok ? "ok " : "MAL"} ${c.title}`);
    if (!c.ok && c.detail) for (const l of c.detail.split("\n")) log(`    ${l}`);
    if (!c.ok && c.fix) log(`    → ${c.fix}`);
  }
  return checks.every((c) => c.ok);
}

// What to paste into an agent: what Overhaul is, the goal, and this machine's state. Values from
// env never go in, only their names.
export function agentPrompt(result, { version, userHome = os.homedir() } = {}) {
  const P = result.paths;
  const tilde = (s) => String(s).split(userHome).join("~");
  const lines = [];
  report(result, (l) => lines.push(l));
  let config = "";
  try {
    config = fs.readFileSync(P.config, "utf8");
  } catch {}
  const envNames = Object.keys(envVars(envLines(P.env)));
  const logs = [];
  for (const f of ["hub.log", "bridge.log"]) {
    const file = path.join(P.logs, f);
    if (!fs.existsSync(file)) continue;
    logs.push(`--- ${f} (últimas 30 líneas)\n${fs.readFileSync(file, "utf8").split("\n").slice(-31).join("\n")}`);
  }
  return tilde(`Ayúdame a dejar Overhaul ${version} funcionando en esta máquina (${result.host}, ${os.platform()}), sola: sin depender de otro hub ni de otro computador.

Qué es Overhaul: un hub web local (http://127.0.0.1:${result.port}) que muestra los tickets y las preguntas de mis proyectos, más un puente (bridge) que abre un agente por ticket en tmux o en Orca. Los dos corren como servicios de usuario (\`overhaul service install|status|restart\`). Todo vive en ~/.overhaul: config.yaml (proyectos, sin secretos), env (secretos, permisos 600), logs/ y backups/.
Comandos útiles: \`overhaul doctor\` (revisa), \`overhaul doctor --fix\`, \`overhaul service status\`, \`overhaul init\` en la carpeta de un proyecto, \`overhaul terminal\`, \`overhaul help\`.

Reglas: no me pidas conectarme a otras máquinas; no muestres ni copies valores de ~/.overhaul/env (solo nombres); antes de editar config.yaml o env, haz una copia al lado; explícame cada cambio en una línea.

Diagnóstico de \`overhaul doctor\`:
${lines.join("\n")}

config.yaml:
\`\`\`yaml
${config.trim() || "(no existe)"}
\`\`\`

Variables en env (solo nombres): ${envNames.join(", ") || "(ninguna)"}

${logs.join("\n\n") || "Sin logs todavía."}

Empieza corriendo \`overhaul doctor\` y arregla lo que marque MAL, de arriba hacia abajo. Al final, abre http://127.0.0.1:${result.port} y confirma conmigo que el banner «el puente está desconectado» ya no sale.`);
}
