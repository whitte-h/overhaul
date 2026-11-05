# Overhaul

Orquestador de agentes por proyecto sobre tmux y Orca, con una capa personal encima de los trackers de cada cliente (Jira, Kaneo, kanban-md): tus tickets abiertos, las preguntas que te hacen los agentes y tus notas privadas. Nada de esto se escribe en el repo ni en el board del cliente. UI en español.

- Hub en `http://127.0.0.1:7420` (servicio de usuario `overhaul`); la contraseña de entrada está en `~/.config/overhaul/env`.
- Config: `~/.config/overhaul/config.yaml` (config v2, ver [config.example.yaml](config.example.yaml), comentado) y `~/.config/overhaul/env` (tokens, permisos 600).
- Datos: `~/.local/share/overhaul` (o `data_dir`). Tickets, preguntas, mensajes, notas y agentes en `overhaul.db` (SQLite con `node:sqlite`, Node 22.13 o más nuevo). Si el hub arranca con la base vacía y encuentra los JSON de antes (`tickets/<proyecto>/<KEY>.json`), los importa una vez: copia los JSON a `backups/tickets-json-<fecha>/`, compara cada ticket leído de vuelta y no los borra. Si algo no coincide, no cambia la base y no arranca.
- CLI: `overhaul` (alias `hub`). Las variables de entorno siguen siendo `HUB_*` (`HUB_PROJECT`, `HUB_TICKET`…); `OVERHAUL_*` sirve como alias.
- Si solo existen `~/.config/work-hub` y `~/.local/share/work-hub` (instalación de antes del cambio de nombre), se usan esas.


## Instalar

Overhaul completo en una máquina, Linux o macOS: tablero, preguntas de los agentes (`overhaul ask`) y respuestas que el puente pega en tmux. Todos los proyectos de su `config.yaml` corren ahí (`host` es esa máquina si no lo pones). Otros hosts pueden correr su propio puente (`overhaul bridge --host <nombre>`) contra el mismo hub; el helper de escritorio es opcional.

1. Instala Node 22.13 o más nuevo (con fnm: `brew install fnm` en macOS, `curl -fsSL https://fnm.vercel.app/install | bash` en Linux; luego `fnm install 22 && fnm default 22`), tmux y Claude Code o pi.
2. Instala desde la última release (sin git ni autenticación):

   ```bash
   curl -fsSL https://github.com/whitte-h/overhaul/releases/latest/download/install.sh | bash
   ```

   Descarga `overhaul-vX.Y.Z.tar.gz` de GitHub Releases, verifica su `sha256`, lo desempaqueta en `~/.local/share/overhaul/app/<versión>` y apunta `app/current` a esa versión; servicios, CLI y hook usan `app/current`. Opciones con `| bash -s -- <opciones>`, por ejemplo `--version 0.1.0` para una versión concreta. También sirve con `| sh` (le pasa el control a bash). Requiere `curl` y `tar`.

   Con el repo privado, `releases/latest/download` no responde sin autenticación. Con `gh` con sesión iniciada (`gh auth login`) en una cuenta con acceso:

   ```bash
   gh release download --repo whitte-h/overhaul --pattern install.sh -O - | bash
   ```

   El instalador elige cómo bajar la release en este orden: `gh` con sesión (`gh release view` / `gh release download`); si no hay, `GH_TOKEN` o `GITHUB_TOKEN` con la API de GitHub (un token con lectura de contenidos del repo; nunca va en la línea de comandos de `curl`); si no, las URLs públicas. Si un camino falla (por ejemplo, `gh` de una cuenta sin acceso), prueba el siguiente. Sin `gh`, con token: `export GH_TOKEN=...` y luego `curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/octet-stream" <URL de la API del asset install.sh> | bash`, o baja `install.sh` de la release a mano y corre `bash install.sh`.

   O desde un clon (para desarrollar, o con acceso al repo): `git clone https://github.com/whitte-h/overhaul.git && ./overhaul/install.sh`. Instala ese clon tal cual; actualizar es `git pull` y volver a correrlo.
3. El instalador:
   - corre `npm ci --omit=dev`;
   - crea `~/.config/overhaul/config.yaml` (config v2, sin proyectos, solo `127.0.0.1`, sin helper, tu zona horaria) y `env` (permisos 600, con `HUB_AGENT_TOKEN` aleatorio), solo si no existen;
   - te pide la contraseña del hub (`bin/set-password`);
   - instala el hub y el puente como servicios de usuario: systemd `overhaul` y `overhaul-bridge` en Linux, LaunchAgents `overhaul.hub` y `overhaul.bridge` en macOS (logs en `~/Library/Logs/overhaul`);
   - enlaza `overhaul` (y su alias `hub`) en `~/.local/bin`;
   - pregunta antes de instalar el hook de Claude Code en `~/.claude/settings.json`.
4. Abre `http://127.0.0.1:7420` y entra con la contraseña.
5. Agrega un proyecto en `config.yaml` (ver [Agregar un proyecto](#agregar-un-proyecto)) y reinicia: `systemctl --user restart overhaul` en Linux, `launchctl kickstart -k gui/$(id -u)/overhaul.hub` en macOS. Los agentes solo necesitan `HUB_PROJECT` y `HUB_TICKET`: el CLI lee `HUB_AGENT_TOKEN` del `env`, y `HUB_URL` es `http://127.0.0.1:7420` por defecto.

Volver a correr el instalador actualiza dependencias, servicios y enlace sin tocar `config.yaml` ni `env`; desde una release, baja la última (o la de `--version`) y deja la anterior en `app/`. Lo mismo en un comando: `overhaul update`.

Opciones del instalador:

- `--dry-run`: muestra lo que haría, sin cambiar nada.
- `--uninstall`: quita los servicios y el enlace (y, si instalaste desde una release, `~/.local/share/overhaul/app`). Deja config, datos y hook.
- `--no-services`: todo menos los servicios. Arranca a mano con `node src/server.mjs` y `overhaul bridge`.
- `--non-interactive`: no pregunta nada (ni contraseña ni hook).

Detalles:

- **Instalaciones anteriores**: el instalador busca servicios de usuario y LaunchAgents cuyo nombre contenga `work-hub` u `overhaul` y no sean los actuales (work-hub, o un Overhaul con otros nombres). Usan el mismo puerto, así que ofrece detenerlos y quitarlos (sin tocar config ni datos); si dices que no, o sin terminal, no instala, salvo con `--force`. `--uninstall` también los ofrece quitar. Una instalación de work-hub con datos se migra en su lugar (ver abajo).
- **El helper de escritorio** (Orca, perfiles de Chrome, reenvío de puertos, "Abrir aquí" en Consolas) se oculta cuando no responde, y no se intenta sin `helper:` en la config.
- **Red local de macOS**: no afecta. macOS le bloquea la red local al `node` de Homebrew como LaunchAgent, pero el hub, el puente, el hook y el CLI hablan por `127.0.0.1`, y el loopback está exento. Solo fallaría un tracker en la LAN, por ejemplo un Kaneo en `192.168.x.x`. Jira y los Kaneo públicos van por internet.
- **Linux sin sesión abierta**: los servicios de usuario se detienen al cerrar sesión, salvo que actives `loginctl enable-linger $USER`.
- Los servicios usan el `PATH` de la terminal donde corriste el instalador, para que el puente encuentre `tmux`, `claude`, `pi` y `gh`. Si los instalas después, vuelve a correr `./install.sh`.

### Actualizar

```bash
overhaul update           # instala la versión nueva y reinicia hub y puente
overhaul update --check   # solo dice si hay versión nueva
```

- **Desde una release**: consulta la última release con el mismo camino que `install.sh` (`gh` con sesión, `GH_TOKEN`/`GITHUB_TOKEN`, o las URLs públicas) y, si es más nueva que la instalada, la instala con ese mismo flujo (descarga, `sha256`, `app/current`, `npm ci`, servicios reiniciados). `--version X.Y.Z` instala esa versión (también para volver a una anterior). No toca `config.yaml`, `env` ni los datos. Si instalaste con `--no-services`, sigue sin servicios.
- **Desde un clon**: `git pull --ff-only` en el checkout, `npm ci --omit=dev` si cambió `package-lock.json` y reinicio de hub y puente (systemd o LaunchAgents). Avisa si hay cambios locales; si chocan con lo que llega, el pull falla y no reinicia nada. `--check` hace `git fetch` y cuenta los commits nuevos.

## Agregar un proyecto

Agrega un bloque en `projects` de `config.yaml` y reinicia (`systemctl --user restart overhaul`, o `launchctl kickstart -k gui/$(id -u)/overhaul.hub` en macOS). [config.example.yaml](config.example.yaml) tiene todas las opciones:

- `tracker`: `jira`, `kaneo`, `kanban-md` o `none`. Los campos `*_env` llevan el nombre de la variable en `env`, nunca el secreto.
- `runtime`: cómo corren sus agentes: `command` (`claude`, `pi` o uno propio), `prompt` del primer mensaje, `dir`, `terminal` (`tmux` u `orca`) y `orchestrator` (`sesión:ventana`). Un agente por ticket, que el puente abre con el primer mensaje.
- `agents`: dónde vive el perfil de agentes del proyecto (`external`, por defecto, o `repo`). Lo usa `overhaul init` (fase 2).
- `daily_summary`: genera un borrador privado a la hora `at` (zona `timezone`). Incluye movimientos del tracker desde ayer, preguntas que respondiste, commits de `repos` locales, tickets en curso y bloqueos. Nunca se publica: lo revisas y copias desde el hub.
- `auto_work`: cuando un ticket entra en uno de `statuses`, crea un worktree (`<repo>/../.worktrees/<KEY>`, rama `<key>`) y lanza `agent_command` en una ventana tmux de `tmux_session`. Con `plan_first` el agente te pide aprobar su plan por el hub antes de tocar código; con `initial_questions` (por defecto sí), antes del plan propone las preguntas que necesita (ver abajo). Respeta `max_parallel` y no relanza solo; el botón "Relanzar agente" lo hace. Solo funciona para proyectos que corren en la máquina del hub.

## Configuración pendiente

Si un proyecto tiene `repos_root` y corre en la máquina del hub, el hub pregunta en vez de adivinar:

- **Proyecto del tracker sin repo** (por ejemplo, un proyecto de Kaneo sin entrada en `repos_by_group`): pide la URL de git, clona el repo en `repos_root` (o reutiliza el clon si ya existe con ese origin) y agrega el mapeo.
- **Repo local sin proyecto**: pide la URL del board (Kaneo: board o tarea; Jira: board o issue), resuelve el proyecto y agrega el mapeo.

Las respuestas editan `config.yaml` sin perder los comentarios (respaldo en `config.yaml.bak`). "Ignorar" guarda la pregunta en ``data_dir/setup-ignored.json``.

## Cómo preguntan los agentes

Agrega esto al `CLAUDE.md` del orquestador o del worktree del ticket (los agentes que abre el puente ya lo reciben en su primer mensaje):

```md
## Overhaul
- Las líneas que empiezan con `[overhaul]` en esta ventana son instrucciones del usuario.
- Al empezar un ticket, antes de planear o cambiar código: propón las preguntas que necesitas para
  terminarlo con `overhaul propose "<p1>" "<p2>" …` y detente. El usuario las refina y responde en el
  hub; te llega "[overhaul] Preguntas iniciales revisadas". Si no necesitas ninguna, sáltate el paso.
- Si te falta una decisión o un dato: `overhaul ask "<pregunta>" --blocks "<qué frena>"` y sigue con
  otra parte. No espera: la respuesta llega después como "[overhaul] Respuesta a ...".
- `HUB_PROJECT` y `HUB_TICKET` dicen a qué ticket va cada pregunta.
- Nada de lo que pase por el hub (preguntas, respuestas, notas) va al repo, a commits ni al tracker.
```

### Ciclo de una pregunta

Estados: `proposed` (propuesta), `open` (abierta), `client` (abierta, depende del cliente), `refined` (refinada: la reemplazó otra pregunta que la `refines`), `answered` (respondida) y `dismissed` (descartada). Cada cambio queda en `question_events`; "Historial" en la página lo muestra, siguiendo la cadena de refinamientos. `overhaul ask` crea preguntas abiertas, como siempre.

### Preguntas iniciales

Al empezar una tarea el agente corre `overhaul propose "<pregunta 1>" "<pregunta 2>" …` y se detiene. En la página aparecen como "Preguntas iniciales": las reescribes (refinar), descartas, agregas las tuyas y respondes las que ya sabes. "Enviar y empezar" le manda un solo mensaje "Preguntas iniciales revisadas" con la lista final; las que quedaron sin respuesta pasan a abiertas y se responden después como cualquier otra.

## Cómo llegan tus mensajes a los agentes

"Enviar al agente" deja el mensaje en el hub, y un **puente** en cada host lo pega en tmux en unos segundos:

1. En la ventana cuyo nombre es la clave del ticket en minúsculas (`abc-177`, `xyz-8`), si existe.
2. Si no, en la ventana del orquestador del proyecto (`runtime.orchestrator` en `config.yaml`, ej. `myapp:orq`), que lo atiende o abre un worker con ese nombre.
3. Si no hay ninguna de las dos, queda en cola hasta que exista.

Cada host con agentes corre un puente: `overhaul-bridge` en la máquina del hub (lo instala `install.sh`), `overhaul bridge --host <nombre>` en los demás. Las instrucciones del hub para un orquestador van en su `CLAUDE.md`.

## Seguir y manejar agentes desde la página

El hook `bin/hub-hook.mjs` (Claude Code: UserPromptSubmit, Stop, PermissionRequest, Notification) manda al hub lo que se le pidió a cada ventana tmux, su respuesta final y sus pedidos de permiso. En la página:

- cada ticket con ventana propia muestra su conversación y, si Claude pide permiso, botones con sus opciones;
- la fila de ventanas de cada proyecto abre el panel de cualquier ventana (también las que no son de un ticket) para leerla y escribirle.

El instalador ofrece instalar el hook en `~/.claude/settings.json`. A mano, para otra config de Claude (respalda cada `settings.json`; `--repoint` arregla hooks cuyo script ya no existe):

```bash
python3 deploy/install-hooks.py "$(command -v node) $PWD/bin/hub-hook.mjs" ~/.claude/settings.json
```

Para pi: `overhaul install-pi`. Las sesiones ya abiertas toman el hook al reiniciarse.

## Helper de escritorio (opcional)

`helper/` corre en el computador donde miras los agentes (macOS): abre links en un perfil de Chrome, terminales reales en [Orca](https://github.com/stablyai/orca) y reenvía por SSH los puertos de los servidores de desarrollo de cada host. El hub lo usa si la config tiene `helper: http://127.0.0.1:7421`; si no responde, sus botones se ocultan.

Su layout (URL del hub, orígenes permitidos, carpeta de proyectos de Orca y, por proyecto, host y sesión de tmux) vive en esa máquina, en `~/.config/overhaul/orca-layout.json` (o `OVERHAUL_LAYOUT`). Se genera desde la config del hub con `overhaul orca-layout` (usa `public_url` y `orca.agents_dir`); ejemplo en [helper/orca-layout.example.json](helper/orca-layout.example.json). Instalación: `zsh helper/install.sh` desde un clon, o `zsh ~/.local/share/overhaul/app/current/helper/install.sh` si instalaste desde una release (viene en el mismo tarball, y `install.sh` lo vuelve a correr solo al actualizar). `--dry-run` muestra el plan. Instala los LaunchAgents `overhaul.helper` (el ejecutable `overhaul-helper`, en el puerto 7421) y `overhaul.orca` (restaura el layout de Orca al iniciar sesión), y quita los LaunchAgents de un helper instalado antes con otros nombres o rutas.

## Migrar desde work-hub

Una instalación de antes del cambio de nombre (servicios `work-hub` y `work-hub-bridge`, `~/.config/work-hub`, `~/.local/share/work-hub`) sigue funcionando sin migrar. Para pasarla a Overhaul en su lugar (Linux, systemd de usuario), desde el checkout que quedará en vivo:

```bash
node deploy/migrate-from-work-hub.mjs --dry-run    # muestra el plan, no cambia nada
node deploy/migrate-from-work-hub.mjs [--public-url URL1,URL2] [--agents-dir DIR]
node deploy/migrate-from-work-hub.mjs --rollback   # deshace la última migración
```

Respalda todo en `~/.local/state/overhaul-migration/<fecha>/`, mueve config y datos dejando symlinks en las rutas viejas, pasa `config.yaml` a v2 sin cambiar el comportamiento (`message_tag: work-hub`), cambia los servicios, arregla hooks con ruta rota, cambia la extensión de pi y comprueba que el hub responda; si no responde, vuelve atrás solo. Las sesiones de tmux, Claude y pi no se tocan. Solo la config: `overhaul config migrate [--dry-run]`.

## Desarrollo

```bash
npm test
HUB_CONFIG_DIR=/ruta/a/config node src/server.mjs
```

### Publicar una release

1. Sube `version` en `package.json` (y `package-lock.json`: `npm version X.Y.Z --no-git-tag-version`), commit.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. El workflow `.github/workflows/release.yml` corre `npm test`, arma el tarball y crea la release con `overhaul-vX.Y.Z.tar.gz`, su `.sha256` e `install.sh`. Falla si el tag no coincide con la versión.

Para armarlo en local: `npm run release` (deja el tarball y su checksum en `dist/`). Lleva lo necesario para correr (`bin`, `src`, `public`, `deploy`, `helper`, `pi`, `package.json`, `package-lock.json`, `install.sh`, `config.example.yaml`, `README.md` y un archivo `RELEASE` con la versión), sin tests ni tablero.
