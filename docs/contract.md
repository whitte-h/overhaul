# Contrato de Overhaul (v0.2)

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
| Instalación | `init [--non-interactive]` | Crea `config.yaml` y `env` (con `HUB_AGENT_TOKEN`) si faltan. Nunca los reemplaza. |
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
6. Si `~/.overhaul` ya tiene config y una ruta vieja también (dos instalaciones), no junta nada: avisa.

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
2. Lo deja en la primera carpeta escribible de: `--bin-dir`/`OVERHAUL_BIN_DIR`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.overhaul/bin` (y en este último caso imprime la línea para el `PATH`). Reemplazo atómico (archivo temporal en la misma carpeta + `mv`).
3. `overhaul init`, la contraseña si falta (interactivo), `overhaul service install` (salvo `--no-services`), y el hook de Claude Code si dices que sí.
4. Corriendo desde una release v0.1 (`app/<versión>` con `RELEASE`, que es como `overhaul update` de v0.1 instala la nueva), hace lo mismo con esa versión y además: repunta los hooks y la extensión de pi, cambia los enlaces `~/.local/bin/overhaul` y `~/.local/bin/hub` al binario, reinstala el helper si estaba, y borra `app/`.

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
