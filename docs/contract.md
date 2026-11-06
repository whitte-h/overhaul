# Contrato de Overhaul (v0.2.1)

Lo que una instalación de Overhaul promete hacia afuera: el comando, dónde guarda todo, cómo corre como servicio, qué publica una release y cómo hablan el hub, los agentes y el puente. La versión en Go (v0.3) lo respeta para que cambiar de ejecutable no se note: mismo comando, mismos archivos, misma base y misma API.

- La parte que se puede verificar a máquina está en [`contract/contract.json`](../contract/contract.json).
- Los tests de [`test/contract.test.mjs`](../test/contract.test.mjs) y [`test/contract-install.test.mjs`](../test/contract-install.test.mjs) son de caja negra: solo usan la línea de comandos, archivos, HTTP y el archivo SQLite. Corren contra cualquier ejecutable:

  ```bash
  npm test                                                    # node bin/overhaul.mjs (clon)
  OVERHAUL_BIN=dist/overhaul-linux-x64 node --test test/contract*.test.mjs   # el binario
  OVERHAUL_BIN=/ruta/al/overhaul-go node --test test/contract*.test.mjs      # el port a Go
  ```

Cambiar algo de este documento es un cambio de contrato: se cambia junto con `contract.json`, los tests y una nota en la release.

## Comando

Un solo ejecutable, `overhaul`, en el `PATH`. Sin Node instalado (excepto el helper de escritorio, ver abajo). Salida: `0` bien, `1` falló, `2` uso incorrecto (comando desconocido, faltan argumentos o variables). `overhaul hook` siempre sale con `0`.

| Grupo | Subcomando | Qué hace |
|---|---|---|
| Agentes | `ask "pregunta" [--blocks X]` | Pregunta al usuario. No espera: la respuesta llega como mensaje en la ventana del agente. |
| | `propose "p1" ["p2" …] [--blocks X]` | Preguntas iniciales de un ticket. |
| | `inbox [--once] [--timeout s]` | Espera mensajes y los imprime. |
| | `restart` | Reinicia el agente de esta ventana (tmux u Orca) retomando su conversación. |
| Hook | `hook [Evento]` | Hook de Claude Code y de la extensión de pi. Lee el JSON del evento en stdin. |
| Hub | `serve` | Corre el hub (lo que corre el servicio). |
| | `bridge [--host H] [--interval s]` | Entrega en tmux/Orca los mensajes de este host (lo que corre el servicio del puente). |
| Servicios | `service install\|start\|stop\|restart\|status\|uninstall [--dry-run]` | Servicios de usuario del hub y el puente. |
| Proyectos | `init [--non-interactive …]` | Asistente de proyecto en su carpeta (ver Proyectos). Sin flags de proyecto y con `--non-interactive` o sin terminal, es `setup`. |
| | `project list [--json]` | Proyectos de config.yaml (`--json`: claves en `contract.json` → `init.project_list_json_keys`). |
| | `project edit [id]` | Reabre el asistente con lo actual; sin id, el proyecto del cwd. |
| | `project remove <id> [--force]` | Quita el bloque de config.yaml (pregunta; `--force` sin preguntar). Las credenciales en `env` y los datos de la base quedan. |
| | `open [id]` | Imprime y abre `http://localhost:<port>/p/<id>`; sin id, el proyecto del cwd. |
| | `terminal [id] [--terminal tmux\|orca]` | Abre o enfoca la terminal del orquestador del proyecto (ver Terminal); sin id, el proyecto del cwd. |
| Instalación | `setup` | Crea `config.yaml` y `env` (con `HUB_AGENT_TOKEN`) si faltan. Nunca los reemplaza. Lo corren install.sh, `service install`, `update` y Homebrew. Antes de v0.2.1 se llamaba `init`. |
| Diagnóstico | `doctor [--fix]`, `doctor prompt` | Revisa que la instalación funcione sola: carpeta, config, contraseña, `HUB_URL` hacia otro hub, `host` de los proyectos, servicios, hub, puente conectado a este hub y CLI de Orca. Sale con `1` si algo está mal y dice qué hacer. `--fix` comenta en `env` los `HUB_URL` que apuntan a otra máquina y reinicia los servicios. `prompt` imprime un texto para pegar en un agente de esa máquina, con la config y los nombres (nunca los valores) de `env`. `service install` lo corre al terminar. |
| | `set-password [--no-restart]` | Contraseña de la página (`HUB_TOKEN`, o lo que diga `auth.password_env`). Lee de la terminal sin eco. |
| | `migrate [--dry-run]` | Adopta una instalación anterior en `~/.overhaul` (ver Migración). |
| | `paths [--json]` | Dónde está todo (claves en `contract.json` → `paths_json_keys`). |
| | `install-hooks [--settings F]… [--repoint-only]` | Hook de Claude Code en `~/.claude/settings.json`. |
| | `install-pi [--dir D]` | Extensión de pi en `~/.pi/agent/extensions/overhaul.ts`. |
| | `helper install [--dry-run]` | Helper de escritorio (necesita Node). |
| | `update [--check] [--version X.Y.Z]` | Actualiza esta instalación y reinicia los servicios. |
| | `version` (también `--version`) | Imprime `X.Y.Z`. |
| Config | `config migrate […]` | config.yaml v1 (work-hub) → v2. |
| | `orca-layout` | Layout de Orca del helper, en JSON. |

`hub` era el alias de v0.1. El binario funciona con cualquier nombre (un enlace `hub` → `overhaul` sirve), pero el instalador no lo crea en carpetas del sistema: `hub` es también el nombre de otra herramienta de GitHub.

## Proyectos

`overhaul init` corre en la carpeta del proyecto. Pregunta en español, con el valor por defecto entre corchetes (Enter lo acepta), en este orden (`contract.json` → `init`):

1. **Tracker**: `jira`, `kaneo`, `kanban-md` o ninguno. Sin tracker recomienda kanban-md.
2. **Nombre e id** (`[a-z0-9-]+`, por defecto el nombre de la carpeta).
3. **Credenciales**, guardadas en `env` (0600) con nombre del proyecto: `<ID>_JIRA_EMAIL` y `<ID>_JIRA_TOKEN` (Jira Cloud; Server/Data Center solo token, `Bearer`), `<ID>_KANEO_TOKEN`. Los tokens se leen sin eco. Se validan contra la API antes de seguir (rutas en `contract.json` → `init.validation`); si fallan, pregunta de nuevo o termina sin cambiar nada.
   - Jira: lista los proyectos visibles, arma `project = <KEY> AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` y prueba el JQL.
   - Kaneo: lista los workspaces (o pide el id), los proyectos del elegido y, si es compartido, escribe `projects` o `exclude_projects`.
   - kanban-md: carpeta del board (por defecto `<cwd>/kanban`) y prefijo; si no hay board corre `kanban-md init --dir <dir> --name <nombre>`; si kanban-md no está instalado, dice cómo instalarlo y deja el tracker configurado.
4. **Repos**: si el cwd es un repo, ese; si no, sus carpetas hijas con `.git` (se eligen). Por cada uno propone `role` y `description` (package.json, go.mod, README, nombre) y el usuario los confirma o edita.
5. **Agentes**: `runtime.command` (`claude`, `pi` o un comando propio), `runtime.prompt`, `runtime.terminal` (`tmux` u `orca`; `orca` por defecto si esta máquina tiene Orca) y `runtime.orchestrator`; con `orca`, si el hub se mira también desde otro computador con el helper (escribe `helper: http://127.0.0.1:7421` si falta); `agents.location` (`external` por defecto, o `repo`) y `agents.profile: default` (el perfil por defecto; el agente de preguntas llega en #29). Un repo con lane propio (`ORCA.md`, `.pi/`) se respeta: `pi` por defecto si tiene `.pi/`, `agents.location: repo`, sin `profile`.
6. Muestra el bloque, pide confirmación y lo escribe en `config.yaml` clave por clave (comentarios y demás claves intactos, respaldo `config.yaml.bak`, validado antes de reemplazar).
7. **Hooks**: si faltan, ofrece el de Claude Code (`~/.claude/settings.json`) y, con `pi` en el `PATH`, su extensión.
8. Reinicia hub y puente si los servicios están instalados.
9. **Orca** (`runtime.terminal: orca`): arma el proyecto en el Orca de esta máquina, como `overhaul terminal`. Sin Orca, guarda la config y dice que corras `overhaul terminal` cuando esté. Muestra (y abre, si hay navegador) `http://localhost:<port>/p/<id>`.

El cwd queda como `runtime.dir`; con varios repos, también como `repos_root` y sin `repo`. Con un solo repo, `repo` es ese. Si ya hay un proyecto en esa carpeta (`runtime.dir`, `repos_root`, `repo` o el primer repo) o con ese id, ofrece editarlo: nunca lo duplica.

`--non-interactive` toma lo mismo de flags: `--project`, `--name`, `--tracker`, `--base-url`, `--email-env`, `--token-env`, `--jql`, `--workspace-id`, `--kaneo-projects a,b`, `--exclude-projects a,b`, `--kanban-dir`, `--prefix`, `--repo path:role:description` (repetible; vacíos = propuestos; sin `--repo`, los detectados), `--runtime claude|pi|<comando>`, `--prompt`, `--orchestrator`, `--terminal tmux|orca`, `--helper`, `--agents-location`, `--hooks`, `--no-validate`, `--no-restart`. Los secretos nunca van en flags: se leen de la variable nombrada por `--*-env` (del entorno, que se copia a `env`, o de `env`). Sale con `2` si falta un flag necesario o uno es inválido, `1` si la validación falla.

### Terminal

`overhaul terminal [id]` corre en la carpeta del proyecto (o con su id). Si el proyecto no dice dónde corren sus agentes (`runtime.terminal`; en v1, `terminals`), pregunta `tmux` u `orca` (`--terminal` en `--non-interactive`, que sin él sale con `2`) y lo escribe en `config.yaml` sin tocar comentarios (respaldo `config.yaml.bak`). Solo usa esta máquina: el hub nunca se conecta a otro nodo.

- **tmux**: crea la ventana del orquestador (`runtime.orchestrator`, por defecto `<id>:orq`) si falta, con `runtime.command` en `runtime.dir` y `HUB_PROJECT`/`HUB_AGENT_NAME` (pi con id de sesión fijo, marcado para `overhaul restart`); luego `switch-client` dentro de tmux o `attach` fuera.
- **orca**: con el CLI de Orca (`ORCA_BIN`, `orca` en el `PATH` o `/Applications/Orca.app/Contents/Resources/bin/orca`), abre Orca si no corre y arma el proyecto, idempotente:
  - Varios repos: un **grupo** de Orca en su carpeta común (`repos_root`, si no `runtime.dir`) con exactamente esos repos (`projectGroup.importNested`; un repo suelto o en otro grupo se mueve con `projectGroup.moveProject`) y un **espacio de carpeta** (`folderWorkspace.create`) donde van el orquestador y la pestaña del hub. Un repo fuera de esa carpeta es un error: pon `repos_root`.
  - Un repo: ese repo (`orca repo add`) con el orquestador y la pestaña.
  - Pestaña del hub en `<public_url>/p/<id>`.
  - Orquestador: terminal titulada con la parte de ventana de `runtime.orchestrator` (`orq`), que corre `runtime.command` en `runtime.dir` con sesión fija (`overhaul restart` la retoma). Si sigue viva en tmux, la terminal se engancha a esa ventana en vez de abrir otro agente.
  - Agentes: los que abrió el hub y Orca perdió se reabren retomando su sesión; las ventanas de agentes vivas en la sesión de tmux del proyecto se muestran enganchadas (vista agrupada `hub-*`).
  - Al final, `orca terminal switch` al orquestador. En un servidor (`orca serve`, sin ventana) lo dice: se sigue desde el Orca del escritorio.

Los grupos y espacios de carpeta no tienen comando en el CLI de Orca: se piden al runtime por su socket unix (`orca-runtime.json` en la carpeta de datos de Orca, `ORCA_USER_DATA_PATH` u `ORCA_RUNTIME_FILE`: una línea JSON `{ id, authToken, method, params }`, una de respuesta).

**Seguir en Orca** (proyectos con `runtime.terminal: orca`): al elegir un ticket (o el orquestador), la página pide `POST /api/orca/<id>/focus` `{ key }` (`key: null` = orquestador). El hub busca esa terminal en su propio Orca y, si falta, la crea: arma el proyecto primero si hace falta, y abre el agente del ticket en su repo, retomando su sesión si ya existía. Luego hace `orca terminal switch` y responde `{ runtimeId, handle, state, navigated }`. Con Orca de escritorio en la misma máquina (standalone), `navigated` es `true` y no hace falta el helper. Un `orca serve` no tiene ventana (`navigated: false`): entonces la página le pasa `{ runtimeId, handle }` al helper del escritorio (ver Helper). Solo proyectos de esta máquina (`host`): el hub nunca llama a otro nodo.

Y al revés: con "Seguir en Orca" activo y Orca en la máquina del hub, la página consulta `GET /api/orca/focus` cada 1,5 s. Responde `{ focus: { project, key } | null }`, con `key: null` cuando es el orquestador. Cuando cambia, la página selecciona ese ticket (o el chat del proyecto) sin volver a mover Orca. Orca no tiene una llamada para la terminal enfocada; su app de escritorio la guarda en el estado del perfil (`workspaceSession.activeTabId` en `profiles/<perfil>/profile-state.db`), que el hub lee en solo lectura y cruza con `terminal list`. Un `orca serve` no tiene ventana y ahí siempre es `null`.

Las terminales de ticket que abre el puente van en el repo del ticket (el de su grupo de tracker en `auto_work.repos_by_group`) o, si corre en la carpeta del proyecto, en el espacio de carpeta del grupo.

### `repos`

Una lista de rutas (como antes) o de `{ path, role, description }`, mezclables. La primera es el repo principal si no hay `repo`. Los agentes de ticket reciben en su primer mensaje los repos del proyecto con su rol cuando hay más de uno o tienen rol: un ticket puede tocar varios.

## Variables de entorno

- `OVERHAUL_HOME`: carpeta de la instalación (por defecto `~/.overhaul`).
- `OVERHAUL_X` vale como `HUB_X` en todas partes; si están las dos, gana `HUB_X`.
- Agentes: `HUB_PROJECT`, `HUB_TICKET`, `HUB_AGENT_NAME`, `HUB_AGENT_TOKEN`, `HUB_URL` (varias separadas por coma, se prueban en orden; por defecto `http://127.0.0.1:7420`), `HUB_HOST` (nombre de esta máquina; por defecto el hostname sin `.local`), `HUB_WINDOW` (`sesión:ventana` en terminales de Orca).
- De v0.1, solo compatibilidad: `HUB_CONFIG_DIR` / `OVERHAUL_CONFIG_DIR` fijan la carpeta de config (y `data_dir` sigue en `~/.local/share/overhaul` salvo que config.yaml diga otra cosa). `OVERHAUL_HOME` les gana.
- Instalador: `OVERHAUL_REPO` (`whitte-h/overhaul`), `OVERHAUL_BIN_DIR` (dónde dejar el binario), `GH_TOKEN`/`GITHUB_TOKEN` (repo privado). Solo tests: `OVERHAUL_RELEASES_URL`, `OVERHAUL_API_URL`, `OVERHAUL_GH`.

## `~/.overhaul`

Todo en una carpeta (`0700`):

```
~/.overhaul/
  config.yaml          config v2 (config.example.yaml)
  env                  secretos, 0600: HUB_TOKEN, HUB_AGENT_TOKEN, tokens de trackers
  overhaul.db          SQLite (+ -wal, -shm), 0600
  session.key          clave de las cookies de sesión
  logs/                hub.log y bridge.log (macOS; en Linux, journalctl)
  bin/overhaul         el ejecutable, cuando no hay carpeta del sistema escribible
  backups/             respaldos de migraciones, de la importación de JSON, etc.
  panes/               sesión de Claude de cada ventana (para restart)
  uploads/             adjuntos
  orca-terminals/      terminales de Orca abiertas por el puente
  activity/  daily/    actividad por ventana, resúmenes diarios
  helper/              el helper de escritorio instalado (overhaul helper install)
  setup-ignored.json  ssh-config  orca-layout.json
```

`data_dir` en config.yaml sigue funcionando y mueve los datos (base, uploads del hub, activity, daily, backups) a otra carpeta. Sin `data_dir`, los datos están en `~/.overhaul`.

### Resolución

Una sola función ([`src/paths.mjs`](../src/paths.mjs)) para CLI, hook, servicios, `update` e instalador:

1. `OVERHAUL_HOME` → esa carpeta, siempre.
2. `HUB_CONFIG_DIR` / `OVERHAUL_CONFIG_DIR` (v0.1) → esa carpeta de config.
3. `~/.overhaul` si tiene `config.yaml`, `config.json` o `env`.
4. Si no, la primera instalación anterior que tenga config (`~/.config/overhaul`, luego `~/.config/work-hub`), con sus datos en `~/.local/share/overhaul` (o `work-hub`): se usa tal cual hasta migrarla.
5. Si no hay nada, `~/.overhaul` (instalación nueva).

### Migración

`overhaul migrate` (y, antes de arrancar los servicios, `overhaul service install` y `overhaul update`) mueve a `~/.overhaul` sin perder datos:

- **v0.1** (`~/.config/overhaul` + `~/.local/share/overhaul`, o el `data_dir` de config.yaml si es una de esas) y **work-hub** (`~/.config/work-hub`, `~/.local/share/work-hub`, carpetas o enlaces).
- **Un `~/.overhaul` armado a mano**: busca `config.yaml`, `env` y `overhaul.db` hasta 3 niveles adentro y los sube a la raíz junto con lo que hay en sus carpetas. Si encuentra dos de algo, no adivina: no toca nada y dice cuáles.

Siempre:

1. Respalda todo lo que va a mover en `~/.overhaul/backups/migrate-<fecha>/` antes de mover.
2. Mueve (mismo disco: `rename`) y junta carpetas. Si un archivo existe en los dos lados, queda el de la config y el otro sigue en el respaldo (lo dice).
3. Deja enlaces en las rutas viejas (`~/.config/overhaul` → `~/.overhaul`, etc.): hooks, scripts y hosts que todavía usan esas rutas siguen funcionando.
4. Quita `data_dir` de config.yaml si apuntaba a una ruta vieja (comentarios intactos, respaldo `config.yaml.bak-migrate-<fecha>`). Un `data_dir` propio (otra ruta) se respeta y no se mueve.
5. No migra con el hub corriendo: `overhaul migrate` se niega si el puerto del hub responde (`--force` para hacerlo igual); `service install` y `update` paran los servicios antes.
6. Un `HUB_URL` del `env` migrado que apunta a otra máquina queda comentado (el nodo usa su propio hub).
7. Si `~/.overhaul` ya tiene config y una ruta vieja también (dos instalaciones), no junta nada: avisa con cuántos proyectos tiene cada una. Excepción: si `~/.overhaul` solo tiene lo que crea `overhaul setup` (config sin proyectos y/o `env`, sin `overhaul.db` ni nada debajo), lo aparta a `backups/migrate-<stamp>/setup/` y migra la instalación vieja.

Volver atrás a mano: parar servicios, quitar los enlaces y restaurar las carpetas de `backups/migrate-<fecha>/` (`config/`, `data/` o `home/`).

## Servicios

`overhaul service install` escribe y arranca dos servicios de usuario que corren el ejecutable (no Node ni rutas a `.mjs`):

| | Linux (systemd de usuario, `~/.config/systemd/user`) | macOS (LaunchAgents, `~/Library/LaunchAgents`) |
|---|---|---|
| Hub | `overhaul.service`: `<overhaul> serve` | `overhaul.hub`: `<overhaul> serve`, log `~/.overhaul/logs/hub.log` |
| Puente | `overhaul-bridge.service`: `<overhaul> bridge` | `overhaul.bridge`: `<overhaul> bridge`, log `~/.overhaul/logs/bridge.log` |

- `<overhaul>` es la ruta del ejecutable; con Homebrew, `$(brew --prefix)/bin/overhaul` (sobrevive a `brew upgrade`).
- Entorno: `OVERHAUL_HOME` y el `PATH` de quien instaló (el puente necesita encontrar `tmux`, `claude`, `pi`, `gh`).
- `install` también quita los servicios de instalaciones anteriores (nombres con `work-hub` u `overhaul` que no son estos) y reemplaza los de v0.1 con los mismos nombres. Es idempotente.
- `uninstall` quita los servicios; nunca toca `~/.overhaul`.
- Helper de escritorio (macOS): `overhaul.helper` y `overhaul.orca`, instalados por `overhaul helper install`.

## Hook

- Claude Code: `~/.claude/settings.json`, eventos `UserPromptSubmit`, `Stop`, `PermissionRequest`, `Notification`, cada uno con el comando `<overhaul> hook <Evento>` (timeout 5 s). `overhaul install-hooks` agrega los que faltan y reescribe los existentes (v0.1: `node …/hub-hook.mjs`) con respaldo `settings.json.bak-overhaul-<fecha>`.
- pi: `~/.pi/agent/extensions/overhaul.ts` corre `<overhaul> hook <Evento>` en un proceso aparte, sin esperar.
- Entrada: el JSON del evento de Claude Code en stdin (`hook_event_name`, `prompt`, `last_assistant_message`, `transcript_path`, `tool_name`, `tool_input`, `message`, `session_id`, `cwd`; pi agrega `"agent": "pi"`). Si el JSON no trae `hook_event_name`, vale el del argumento.
- Salida: `POST /agent/hook` con `Authorization: Bearer $HUB_AGENT_TOKEN` y `{host, session, window, event, text, cwd}`. Solo dentro de tmux (`TMUX_PANE`) o con `HUB_WINDOW`. Nunca falla ni bloquea al agente.

## Release

- Repo `whitte-h/overhaul`, tag `vX.Y.Z` (igual a `package.json`).
- Instalar: `curl -fsSL https://github.com/whitte-h/overhaul/releases/latest/download/install.sh | bash`.
- Assets de cada release:

  | Archivo | Qué es |
  |---|---|
  | `overhaul-darwin-arm64`, `overhaul-darwin-x64`, `overhaul-linux-arm64`, `overhaul-linux-x64` | El ejecutable de cada plataforma (Node SEA; firmado ad-hoc en macOS). |
  | `overhaul-<os>-<arch>.sha256` | `<sha256 hex>  <archivo>\n` (formato `sha256sum`). |
  | `install.sh` | El instalador. |
  | `overhaul-vX.Y.Z.tar.gz` (+ `.sha256`) | El código, como en v0.1: lo usa `overhaul update` de una instalación v0.1 para llegar al binario. |
  | `overhaul.rb` | La fórmula de Homebrew de esa versión. |

- `os` es `darwin` o `linux` (`uname -s` en minúsculas); `arch` es `arm64` o `x64` (`uname -m`: `arm64`/`aarch64` → `arm64`, `x86_64`/`amd64` → `x64`).

### install.sh

```
install.sh [--version X.Y.Z] [--check] [--bin-dir D] [--binary FILE] [--no-services]
           [--non-interactive] [--dry-run] [--uninstall]
```

1. Baja `overhaul-<os>-<arch>` y su `.sha256` de la release (gh con sesión, `GH_TOKEN`/`GITHUB_TOKEN` con la API, o las URLs públicas) y verifica el sha256. Con `--binary FILE` usa ese archivo.
2. Lo deja en la primera carpeta escribible de: `--bin-dir`/`OVERHAUL_BIN_DIR`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.overhaul/bin`. Reemplazo atómico (archivo temporal en la misma carpeta + `mv`). Si esa carpeta no está en el `PATH` y ningún enlace `overhaul` en una carpeta del `PATH` lleva al ejecutable, imprime la línea para el `PATH`.
3. `overhaul setup` (`init` si el ejecutable es anterior a v0.2.1), la contraseña si falta (interactivo), `overhaul service install` (salvo `--no-services`), y el hook de Claude Code si dices que sí.
4. Corriendo desde una release v0.1 (`app/<versión>` con `RELEASE`, que es como `overhaul update` de v0.1 instala la nueva), hace lo mismo con esa versión y además: repunta los hooks y la extensión de pi, cambia los enlaces `~/.local/bin/overhaul` y `~/.local/bin/hub` al binario, reinstala el helper si estaba, y borra `app/`.
5. Los enlaces de v0.1 (`~/.local/bin/overhaul`, `~/.local/bin/hub` → un `.mjs`) se repuntan al binario siempre, salvo el que es la ruta misma del binario (`--bin-dir ~/.local/bin`): ese ya quedó reemplazado por el ejecutable.

`--check` imprime la última versión. `--uninstall` quita servicios y el binario; nunca `~/.overhaul`.

### update

- Binario: `overhaul update` consulta la última release (mismas fuentes que install.sh), baja el binario de la plataforma, verifica sha256, lo reemplaza en su lugar (atómico) y corre `overhaul service install` con el nuevo (migra si hace falta y reinicia hub y puente). `--check` solo dice si hay versión nueva; `--version X.Y.Z` instala esa.
- Homebrew: `overhaul update` dice `brew upgrade overhaul`.
- Clon (`.git`): `git pull --ff-only`, `npm ci` si cambió el lockfile, reinicia servicios.
- v0.1 (`app/current`): `overhaul update` de v0.1 baja el tarball de la versión nueva y corre su install.sh, que instala el binario (ver install.sh, paso 4).

## HTTP

- Puerto `7420`, `bind` `127.0.0.1` por defecto (config.yaml `port`, `bind`, `allow_from`).
- Públicos: `/login.html`, `/style.css`, `POST /login` (form `token=<contraseña>` → cookie de sesión). Cualquier otra página sin sesión devuelve la de login.
- `/api/*`: sesión de la página; los métodos que no son GET piden además `X-Hub: 1`. Sin sesión: `401`.
- `/agent/*`: `Authorization: Bearer $HUB_AGENT_TOKEN`. Sin token: `401`.
- Rutas, método y autenticación: `contract.json` → `http.routes`. Respuestas JSON; errores `{ "error": "…" }` con el código HTTP.
- Agentes:
  - `POST /agent/{project}/{key}/ask` `{text, blocks, from, host, tmuxPane}` → `{id, …}`.
  - `POST /agent/{project}/{key}/propose` `{questions: [{text, blocks}], from, host, tmuxPane}` → `{questions: […]}`.
  - `GET /agent/{project}/{key}/inbox?wait=s&from&host&pane` → `{messages: [{kind, question?, text, attachments?}]}`.

## SQLite

`overhaul.db` en la carpeta de datos, `0600`, WAL. Tablas, columnas e índices exactos en `contract.json` → `sqlite`; versión de esquema en `schema_migrations` (`MAX(version)`). Cada fila tiene `id` (uuid), `created_at` y `updated_at` (ISO 8601). Un ejecutable que encuentra una base de un esquema más nuevo que el suyo no arranca.

## Helper de escritorio

En v0.2 sigue en Node (node-pty): `overhaul helper install` copia el helper que trae el ejecutable a `~/.overhaul/helper`, corre `npm install` con el Node del sistema y, en macOS, instala `overhaul.helper` y `overhaul.orca`. Sin Node, avisa cómo instalarlo y no hace nada. Su layout: `OVERHAUL_LAYOUT`, `~/.overhaul/orca-layout.json` o `~/.config/overhaul/orca-layout.json`. En Go irá dentro del binario.
