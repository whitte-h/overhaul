# Overhaul

Orquestador de agentes por proyecto sobre tmux y Orca, con una capa personal encima de los trackers de cada cliente (Jira, Kaneo, kanban-md): tus tickets abiertos, las preguntas que te hacen los agentes y tus notas privadas. Nada de esto se escribe en el repo ni en el board del cliente. UI en español.

- Un solo ejecutable, `overhaul`, sin Node ni dependencias. Hub en `http://127.0.0.1:7420` (servicio de usuario); todo lo demás en `~/.overhaul` (o `OVERHAUL_HOME`).
- `~/.overhaul/config.yaml` (config v2, ver [config.example.yaml](config.example.yaml), comentado), `~/.overhaul/env` (contraseña y tokens, permisos 600) y `~/.overhaul/overhaul.db` (SQLite: tickets, preguntas, mensajes, notas y agentes). `data_dir` en config.yaml mueve los datos a otra carpeta. Si el hub arranca con la base vacía y encuentra los JSON de antes (`tickets/<proyecto>/<KEY>.json`), los importa una vez: copia los JSON a `backups/tickets-json-<fecha>/`, compara cada ticket leído de vuelta y no los borra. Si algo no coincide, no cambia la base y no arranca.
- Las variables de entorno siguen siendo `HUB_*` (`HUB_PROJECT`, `HUB_TICKET`…); `OVERHAUL_*` sirve como alias.
- Lo que una instalación promete (comando, archivos, servicios, assets de release, API, esquema) está en [docs/contract.md](docs/contract.md). `overhaul paths` dice dónde está todo.

## Instalar

Overhaul completo en una máquina, Linux o macOS (arm64 o x64): tablero, preguntas de los agentes (`overhaul ask`) y respuestas que el puente pega en tmux. Todos los proyectos de su `config.yaml` corren ahí (`host` es esa máquina si no lo pones). Otros hosts pueden correr su propio puente (`overhaul bridge --host <nombre>`) contra el mismo hub; el helper de escritorio es opcional.

1. Instala tmux y Claude Code o pi. Node no hace falta (solo para el helper de escritorio).
2. Instala desde la última release:

   ```bash
   curl -fsSL https://github.com/whitte-h/overhaul/releases/latest/download/install.sh | bash
   ```

   Baja `overhaul-<os>-<arch>` de GitHub Releases, verifica su `sha256` y lo deja en `/opt/homebrew/bin` o `/usr/local/bin` si puede escribir ahí; si no, en `~/.overhaul/bin`, y te muestra la línea para agregarlo al `PATH`. Opciones con `| bash -s -- <opciones>`, por ejemplo `--version 0.2.0` o `--bin-dir ~/bin`. También sirve con `| sh`. Requiere `curl`.

   Con el repo privado, `releases/latest/download` no responde sin autenticación. Con `gh` con sesión iniciada (`gh auth login`) en una cuenta con acceso:

   ```bash
   gh release download --repo whitte-h/overhaul --pattern install.sh -O - | bash
   ```

   El instalador elige cómo bajar en este orden: `gh` con sesión; si no hay, `GH_TOKEN` o `GITHUB_TOKEN` con la API de GitHub (un token con lectura de contenidos del repo; nunca va en la línea de comandos de `curl`); si no, las URLs públicas. Si un camino falla (por ejemplo, `gh` de una cuenta sin acceso), prueba el siguiente.

   Con Homebrew (macOS o Linux), cuando exista el tap `whitte-h/homebrew-tap`:

   ```bash
   brew install whitte-h/tap/overhaul
   overhaul setup && overhaul set-password && overhaul service install
   ```

   La fórmula está en [packaging/homebrew/overhaul.rb](packaging/homebrew/overhaul.rb) y cada release adjunta la suya (`overhaul.rb`). `brew services start overhaul` corre solo el hub; `overhaul service install` corre hub y puente (usa uno de los dos).

3. El instalador:
   - crea `~/.overhaul/config.yaml` (config v2, sin proyectos, solo `127.0.0.1`, sin helper, tu zona horaria) y `env` (permisos 600, con `HUB_AGENT_TOKEN` aleatorio), solo si no existen (`overhaul setup`);
   - te pide la contraseña del hub (`overhaul set-password`);
   - instala el hub y el puente como servicios de usuario (`overhaul service install`): systemd `overhaul` y `overhaul-bridge` en Linux, LaunchAgents `overhaul.hub` y `overhaul.bridge` en macOS (logs en `~/.overhaul/logs`). Corren el ejecutable: `overhaul serve` y `overhaul bridge`;
   - pregunta antes de instalar el hook de Claude Code en `~/.claude/settings.json` (`overhaul install-hooks`).
4. Abre `http://127.0.0.1:7420` y entra con la contraseña.
5. Agrega un proyecto: en su carpeta (un repo, o una carpeta con varios) corre `overhaul init` (ver [Agregar un proyecto](#agregar-un-proyecto)). Los agentes solo necesitan `HUB_PROJECT` y `HUB_TICKET`: el CLI lee `HUB_AGENT_TOKEN` del `env`, y `HUB_URL` es `http://127.0.0.1:7420` por defecto.

Opciones del instalador:

- `--dry-run`: muestra lo que haría, sin cambiar nada.
- `--uninstall`: quita los servicios y el ejecutable. Deja `~/.overhaul` y el hook.
- `--no-services`: todo menos los servicios. Arranca a mano con `overhaul serve` y `overhaul bridge`.
- `--non-interactive`: no pregunta nada (ni contraseña ni hook).
- `--bin-dir D` (o `OVERHAUL_BIN_DIR`): dónde dejar `overhaul`. `--binary FILE`: instala ese ejecutable en vez de bajarlo.

Servicios a mano: `overhaul service status|start|stop|restart|uninstall`. `overhaul service install` es idempotente: reescribe los servicios para que corran este ejecutable.

Detalles:

- **Instalaciones anteriores**: `overhaul service install` para los servicios que corren, quita los de instalaciones anteriores (servicios de usuario y LaunchAgents cuyo nombre contenga `work-hub` u `overhaul` y no sean los actuales; los del helper no) y reemplaza los de v0.1, que tienen los mismos nombres.
- **El helper de escritorio** (Orca, perfiles de Chrome, reenvío de puertos, "Abrir aquí" en Consolas) se oculta cuando no responde, y no se intenta sin `helper:` en la config.
- **Red local de macOS**: el hub, el puente, el hook y el CLI hablan por `127.0.0.1`, que está exento. Solo fallaría un tracker en la LAN, por ejemplo un Kaneo en `192.168.x.x`. Jira y los Kaneo públicos van por internet.
- **Linux sin sesión abierta**: los servicios de usuario se detienen al cerrar sesión, salvo que actives `loginctl enable-linger $USER`.
- Los servicios usan el `PATH` de la terminal donde corriste `overhaul service install`, para que el puente encuentre `tmux`, `claude`, `pi` y `gh`. Si los instalas después, vuelve a correrlo.

### Actualizar

```bash
overhaul update           # baja la versión nueva, reemplaza el ejecutable y reinicia hub y puente
overhaul update --check   # solo dice si hay versión nueva
```

Consulta la última release con el mismo camino que `install.sh`, baja el ejecutable de tu plataforma, verifica su `sha256`, lo reemplaza en su lugar (un `mv` atómico) y corre `overhaul service install` con el nuevo. `--version X.Y.Z` instala esa versión (también para volver a una anterior). No toca `config.yaml`, `env` ni los datos. Si instalaste con `--no-services`, sigue sin servicios. Instalado con Homebrew: `brew upgrade overhaul`.

### Desde v0.1

v0.1 necesitaba Node y repartía todo entre `~/.config/overhaul`, `~/.local/share/overhaul` y `~/.local/bin`. Para pasar al ejecutable:

- **Instalada desde una release** (`~/.local/share/overhaul/app`): `overhaul update`. Baja la release nueva y su `install.sh` instala el ejecutable, mueve config y datos a `~/.overhaul` (con respaldo), cambia los servicios, el hook, la extensión de pi y los enlaces de `~/.local/bin`, y borra `app/`.
- **Desde un clon**: corre el instalador (arriba). `overhaul service install` hace la migración.
- **work-hub** (`~/.config/work-hub`, `~/.local/share/work-hub`, servicios `work-hub*`): igual que un clon. La config v1 sigue funcionando; `overhaul config migrate` la pasa a v2.

La migración (`overhaul migrate`, que `service install` corre sola con los servicios detenidos) respalda todo en `~/.overhaul/backups/migrate-<fecha>/`, mueve las carpetas a `~/.overhaul`, deja enlaces en las rutas viejas (hooks, scripts y otros hosts que las usen siguen funcionando) y quita `data_dir` de config.yaml si apuntaba a una de ellas. Un `~/.overhaul` armado a mano (config, env o base en subcarpetas) se ordena igual. Si encuentra dos instalaciones o dos archivos del mismo tipo, no adivina: avisa y no toca nada. `overhaul migrate --dry-run` muestra el plan. Detalles en [docs/contract.md](docs/contract.md#migración).

## Agregar un proyecto

En la carpeta del proyecto:

```bash
cd ~/code/acme        # un repo, o una carpeta con varios (api/, web/...)
overhaul init
```

El asistente pregunta primero el tracker (jira, kaneo o kanban-md; sin tracker recomienda kanban-md y lo inicializa), pide URL y token sin mostrarlo, los valida contra la API y los guarda en `~/.overhaul/env` con nombre del proyecto (`ACME_JIRA_TOKEN`...). Después lista los proyectos o boards que ves para elegir (en Jira arma el JQL: asignados a ti, sin terminar, del proyecto elegido), detecta los repos y propone el rol y la descripción de cada uno, pregunta cómo corren los agentes (`claude`, `pi` o un comando propio; respeta el lane propio de un repo con `ORCA.md` o `.pi/`) y dónde (tmux u Orca; con Orca arma el proyecto en el Orca de esta máquina), ofrece instalar los hooks que falten, escribe el bloque en `config.yaml` (con tus comentarios), reinicia los servicios y te da `http://localhost:7420/p/<proyecto>`. Correrlo de nuevo en la misma carpeta edita el proyecto.

- `overhaul project list`, `overhaul project edit [id]`, `overhaul project remove <id>`, `overhaul open [id]`.
- `overhaul terminal [id]`: abre o enfoca la terminal del orquestador. La primera vez pregunta si los agentes corren en tmux u Orca y lo guarda. Con Orca arma el proyecto en el Orca de esta máquina: con varios repos, un grupo de Orca con sus repos y un espacio de carpeta donde corre el orquestador junto a la pestaña del hub; con uno, ese repo. Se puede repetir: lo que ya existe queda igual.
- Para scripts: `overhaul init --non-interactive --tracker jira --base-url https://acme.atlassian.net --email-env ACME_JIRA_EMAIL --token-env ACME_JIRA_TOKEN --repo api:backend:"API y modelo de datos" --repo web:frontend:Tienda` (los secretos se leen de esas variables, nunca de flags). Todos los flags en [docs/contract.md](docs/contract.md#proyectos).

A mano: agrega un bloque en `projects` de `config.yaml` y reinicia (`systemctl --user restart overhaul`, o `launchctl kickstart -k gui/$(id -u)/overhaul.hub` en macOS). [config.example.yaml](config.example.yaml) tiene todas las opciones:

- `tracker`: `jira`, `kaneo`, `kanban-md` o `none`. Los campos `*_env` llevan el nombre de la variable en `env`, nunca el secreto.
- `runtime`: cómo corren sus agentes: `command` (`claude`, `pi` o uno propio), `prompt` del primer mensaje, `dir`, `terminal` (`tmux` u `orca`) y `orchestrator` (`sesión:ventana`). Un agente por ticket, que el puente abre con el primer mensaje.
- `repos`: rutas, o `{ path, role, description }` por repo (ej. `role: backend`, `description: API y modelo de datos`). Los agentes de ticket reciben el rol de cada repo: un ticket puede tocar varios.
- `agents`: dónde vive el perfil de agentes del proyecto (`external`, por defecto, o `repo`) y cuál (`profile: default`).
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

Cada host con agentes corre un puente: `overhaul-bridge` en la máquina del hub (lo instala `overhaul service install`), `overhaul bridge --host <nombre>` en los demás. Las instrucciones del hub para un orquestador van en su `CLAUDE.md`.

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

Su layout (URL del hub, orígenes permitidos, carpeta de proyectos de Orca y, por proyecto, host y sesión de tmux) vive en esa máquina, en `~/.overhaul/orca-layout.json` (o `OVERHAUL_LAYOUT`; `~/.config/overhaul/orca-layout.json` también se lee). Se genera desde la config del hub con `overhaul orca-layout > orca-layout.json` (usa `public_url` y `orca.agents_dir`); ejemplo en [helper/orca-layout.example.json](helper/orca-layout.example.json).

En v0.2 el helper todavía corre en Node (usa node-pty), así que necesita Node 18 o más en esa máquina. `overhaul helper install` copia el helper que trae el ejecutable a `~/.overhaul/helper`, corre `npm install` ahí e instala los LaunchAgents `overhaul.helper` (el helper, en el puerto 7421) y `overhaul.orca` (restaura el layout de Orca al iniciar sesión) con ese Node; quita los LaunchAgents de un helper instalado antes con otros nombres o rutas. Sin Node, dice cómo instalarlo y no hace nada. `--dry-run` muestra el plan. Después de `overhaul update`, vuelve a correrlo para tener el helper de esa versión.

## Desarrollo

```bash
npm ci
npm test
OVERHAUL_HOME=/tmp/oh node bin/overhaul.mjs setup    # una instalación de prueba aparte
OVERHAUL_HOME=/tmp/oh node bin/overhaul.mjs serve
npm run build                                        # dist/overhaul-<os>-<arch> para esta máquina
OVERHAUL_BIN=dist/overhaul-linux-x64 node --test test/contract*.test.mjs
```

`bin/overhaul.mjs` es el mismo CLI que el ejecutable. El ejecutable es Node SEA: [scripts/build.mjs](scripts/build.mjs) arma un solo archivo con esbuild y lo inyecta, con `public/`, el helper, `install.sh` y la extensión de pi como assets, en una copia del Node que lo corre (firmado ad-hoc en macOS). Los tests de contrato son de caja negra: los usará también la versión en Go.

### Publicar una release

1. Sube `version` en `package.json` (y `package-lock.json`: `npm version X.Y.Z --no-git-tag-version`), commit.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. El workflow `.github/workflows/release.yml` corre `npm test`, construye el ejecutable en un runner de cada plataforma (darwin-arm64, darwin-x64, linux-x64, linux-arm64), le corre los tests de contrato y crea la release con `overhaul-<os>-<arch>` y su `.sha256`, `install.sh` y el tarball `overhaul-vX.Y.Z.tar.gz` (lo que baja `overhaul update` de v0.1). Falla si el tag no coincide con la versión.
