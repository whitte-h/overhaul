#!/usr/bin/env bash
# Installs Overhaul standalone on this machine (Linux or macOS): the hub and its bridge as user
# services on 127.0.0.1:7420, the `overhaul` CLI (and its `hub` alias) in the PATH and, if you say yes, the Claude Code hook.
# Every project in config.yaml runs here; nothing talks to other hosts.
#
#   ./install.sh                  install or update (never overwrites config.yaml or env)
#   ./install.sh --uninstall      remove the services and the CLI links; keeps config and data
#   ./install.sh --dry-run        print what it would do, change nothing
#   ./install.sh --no-services    everything but the services (containers, CI)
#   ./install.sh --non-interactive  no questions: no password prompt, no hook
#   ./install.sh --force          install even if services of an earlier installation (work-hub or an
#                                 older Overhaul) stay on this machine (migrate work-hub: deploy/migrate-from-work-hub.mjs)
#   ./install.sh --version X.Y.Z  release mode only: that release instead of the latest
#   ./install.sh --check          release mode only: print the latest release's version, install nothing
#
# Without a clone (release mode): curl -fsSL <releases>/latest/download/install.sh | bash
#   downloads the release tarball (no git, no auth), checks its sha256, unpacks it in
#   ~/.local/share/overhaul/app/<version>, points app/current at it and installs from there.
#   Run it again to update; --uninstall also removes app/. From a clone it installs that clone.
#   Private repo: with a logged-in gh it uses gh release download; else GH_TOKEN or GITHUB_TOKEN
#   with the GitHub API; else the public download URLs.
# Env: OVERHAUL_CONFIG_DIR or HUB_CONFIG_DIR (default ~/.config/overhaul, or ~/.config/work-hub
#      when only that one exists), OVERHAUL_BIN_DIR (default ~/.local/bin).
# Bash 3.2 compatible (macOS /bin/bash).

# Started by sh (curl ... | sh): hand over to bash, from the file or by fetching the script again.
# POSIX only up to here: sh reads one command at a time, so it never parses the bash below.
if [ -z "${BASH_VERSION:-}" ]; then
  command -v bash >/dev/null 2>&1 || { echo "Error: Overhaul necesita bash" >&2; exit 1; }
  case "$0" in *install.sh) [ -f "$0" ] && exec bash "$0" "$@" ;; esac
  curl -fsSL "${OVERHAUL_RELEASES_URL:-https://github.com/${OVERHAUL_REPO:-whitte-h/overhaul}/releases}/latest/download/install.sh" | bash -s -- "$@"
  exit $?
fi
set -euo pipefail

# Where releases come from. OVERHAUL_RELEASES_URL, OVERHAUL_API_URL and OVERHAUL_GH: tests only
# (a local server that mimics GitHub, a fake gh).
REPO="${OVERHAUL_REPO:-whitte-h/overhaul}"
RELEASES_URL="${OVERHAUL_RELEASES_URL:-https://github.com/$REPO/releases}"
API_URL="${OVERHAUL_API_URL:-https://api.github.com}"
GH="${OVERHAUL_GH:-gh}"
APP_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/overhaul/app"
PORT=7420

dry=0 uninstall=0 services=1 interactive=1 force=0 check=0 version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --uninstall) uninstall=1 ;;
    --no-services) services=0 ;;
    --non-interactive) interactive=0 ;;
    --force) force=1 ;;
    --check) check=1 ;;
    --version) [ $# -ge 2 ] || { echo "Error: --version necesita X.Y.Z" >&2; exit 2; }; version=${2#v}; shift ;;
    --version=*) version=${1#--version=}; version=${version#v} ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $1 (ver --help)" >&2; exit 2 ;;
  esac
  shift
done
# What the installed release's install.sh gets: the same options, without --version.
pass=()
[ "$dry" = 0 ] || pass+=(--dry-run)
[ "$uninstall" = 0 ] || pass+=(--uninstall)
[ "$services" = 1 ] || pass+=(--no-services)
[ "$interactive" = 1 ] || pass+=(--non-interactive)
[ "$force" = 0 ] || pass+=(--force)

say() { printf '%s\n' "$*"; }
warn() { printf 'Aviso: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# Commands that change the machine go through run: printed, not run, with --dry-run.
run() { if [ "$dry" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
# Questions read the terminal even when the script came through a pipe (curl | bash).
ask_yes() {
  [ "$interactive" = 1 ] && [ "$dry" = 0 ] || return 1
  local reply
  { printf '%s [s/N] ' "$1" >/dev/tty; read -r reply </dev/tty; } 2>/dev/null || return 1
  case "$reply" in s|S|si|sí|y|Y|yes) return 0 ;; *) return 1 ;; esac
}
# Runs an install.sh with the terminal as stdin when there is one (questions after curl | bash).
# ${pass[@]+...}: bash 3.2 with set -u fails on an empty array.
exec_installer() {
  if { : </dev/tty; } 2>/dev/null; then exec bash "$1" ${pass[@]+"${pass[@]}"} </dev/tty; else exec bash "$1" ${pass[@]+"${pass[@]}"}; fi
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# --- Release mode: download, verify and unpack a release, then run its install.sh ---------------
# Three sources, each with latest_<src> (prints X.Y.Z) and download_<src> <version> <file> <dir>:
#   gh      gh release view/download (gh's own session; private repo)
#   api     GitHub API with GH_TOKEN or GITHUB_TOKEN (private repo, no gh)
#   public  github.com/<repo>/releases URLs (public repo, no auth)
source_label() {
  case "$1" in gh) printf 'gh (%s)' "$REPO" ;; api) printf 'la API de GitHub con token (%s)' "$REPO" ;; *) printf '%s' "$RELEASES_URL" ;; esac
}
latest_gh() { "$GH" release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null | sed 's/^v//'; }
download_gh() { "$GH" release download "v$1" --repo "$REPO" --pattern "$2" --dir "$3" --clobber >/dev/null 2>&1; }

# The token goes to curl through a config on stdin, never in its arguments (ps shows those).
api_curl() { # url [curl options...]
  local url=$1; shift
  printf 'header = "Authorization: Bearer %s"\n' "${GH_TOKEN:-${GITHUB_TOKEN:-}}" |
    curl -fsSL -K - -H 'X-GitHub-Api-Version: 2022-11-28' "$@" "$url"
}
latest_api() {
  api_curl "$API_URL/repos/$REPO/releases/latest" -H 'Accept: application/vnd.github+json' |
    sed -n 's/^.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*$/\1/p' | head -n 1
}
# Assets by id from the release JSON: one {"url":".../releases/assets/<id>",...,"name":"<file>"} each.
download_api() {
  local json id
  json=$(api_curl "$API_URL/repos/$REPO/releases/tags/v$1" -H 'Accept: application/vnd.github+json') || return 1
  id=$(printf '%s' "$json" | tr -d '\n' | tr '{}' '\n\n' |
    sed -n "s/.*\"url\"[[:space:]]*:[[:space:]]*\"[^\"]*\/releases\/assets\/\([0-9]*\)\".*\"name\"[[:space:]]*:[[:space:]]*\"$(printf '%s' "$2" | sed 's/[.]/\\./g')\".*/\1/p" | head -n 1)
  [ -n "$id" ] || return 1
  # GitHub answers with a redirect to storage; curl drops the Authorization header on the new host.
  api_curl "$API_URL/repos/$REPO/releases/assets/$id" -H 'Accept: application/octet-stream' -o "$3/$2"
}

latest_public() {
  # GitHub redirects releases/latest to releases/tag/vX.Y.Z; no API, no token.
  local url
  url=$(curl -fsSIL -o /dev/null -w '%{url_effective}' "$RELEASES_URL/latest") || return 1
  url=${url%/}; url=${url##*/}; printf '%s\n' "${url#v}"
}
download_public() { curl -fsSL -o "$3/$2" "$RELEASES_URL/download/v$1/$2"; }

release_install() {
  if [ "$uninstall" = 1 ]; then
    [ -f "$APP_ROOT/current/install.sh" ] || die "no hay una release instalada en $APP_ROOT (desde un clon: ./install.sh --uninstall)"
    exec_installer "$APP_ROOT/current/install.sh"
  fi
  command -v tar >/dev/null || die "falta tar para desempaquetar la release"
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}" sources="" src v name tmp=""
  if command -v "$GH" >/dev/null && "$GH" auth status >/dev/null 2>&1; then sources="gh"; fi
  if [ -n "$token" ]; then command -v curl >/dev/null && sources="$sources api"; fi
  command -v curl >/dev/null && sources="$sources public"
  [ -n "$sources" ] || die "falta curl (o gh con sesión) para descargar la release"
  # The first source that answers wins; a gh without access to the repo falls through to the next.
  for src in $sources; do
    v="$version"
    if [ -z "$v" ]; then
      v=$(latest_$src) && [ -n "$v" ] || { warn "$(source_label "$src"): no encontré la última release"; continue; }
    fi
    case "$v" in [0-9]*.[0-9]*.[0-9]*) ;; *) die "versión inválida: '$v' (usa --version X.Y.Z)" ;; esac
    if [ "$check" = 1 ]; then printf '%s\n' "$v"; exit 0; fi
    name="overhaul-v$v.tar.gz"
    say "Overhaul v$v desde $(source_label "$src")"
    if [ "$dry" = 1 ]; then
      say "+ descargar $name y $name.sha256 ($(source_label "$src")), verificar sha256"
      say "+ desempaquetar en $APP_ROOT/$v y enlazar $APP_ROOT/current"
      say "(dry-run) seguiría con $APP_ROOT/$v/install.sh ${pass[*]+"${pass[*]}"}"
      exit 0
    fi
    if [ -z "$tmp" ]; then
      mkdir -p "$APP_ROOT"
      tmp=$(mktemp -d "$APP_ROOT/.download.XXXXXX")
      # shellcheck disable=SC2064
      trap "rm -rf '$tmp'" EXIT
    fi
    rm -f "$tmp/$name" "$tmp/$name.sha256"
    if download_$src "$v" "$name" "$tmp" && download_$src "$v" "$name.sha256" "$tmp"; then break; fi
    warn "$(source_label "$src"): no pude descargar $name de v$v"
    name=""
  done
  [ -n "${name:-}" ] && [ -f "$tmp/$name" ] || die "no pude descargar la release (ver avisos arriba)"
  local expected actual
  expected=$(cut -d' ' -f1 <"$tmp/$name.sha256")
  actual=$(sha256 "$tmp/$name")
  [ "${#expected}" = 64 ] && [ "$actual" = "$expected" ] || die "el sha256 de $name no coincide con $name.sha256: no instalo nada"
  say "sha256 verificado: $actual"
  mkdir "$tmp/x"
  tar -xzf "$tmp/$name" -C "$tmp/x"
  [ -f "$tmp/x/overhaul-v$v/src/server.mjs" ] && [ -f "$tmp/x/overhaul-v$v/RELEASE" ] || die "$name no es una release de Overhaul"
  # Same version again: replace it (the running services restart from the new copy).
  [ ! -e "$APP_ROOT/$v" ] || mv "$APP_ROOT/$v" "$tmp/previous"
  mv "$tmp/x/overhaul-v$v" "$APP_ROOT/$v"
  rm -rf "$tmp"
  trap - EXIT
  exec_installer "$APP_ROOT/$v/install.sh"
}

# --- Where the code is: this script's folder (a clone or an installed release), else release mode --
src="${BASH_SOURCE[0]:-}"
DIR=""
if [ -n "$src" ] && [ -f "$src" ]; then DIR=$(cd "$(dirname "$src")" && pwd -P); fi
if [ -z "$DIR" ] || [ ! -f "$DIR/src/server.mjs" ]; then release_install; fi

# An installed release (app/<version>, with RELEASE): links and services go through app/current,
# which this run points at this version once its dependencies are in.
RELEASE_DIR=""
if [ -f "$DIR/RELEASE" ] && [ "$(basename "$(dirname "$DIR")")" = app ]; then
  RELEASE_DIR=$DIR
  APP_ROOT=$(dirname "$DIR")
  [ "$uninstall" = 0 ] || DIR="$APP_ROOT/current"
elif [ -n "$version" ]; then
  die "--version es solo para instalar desde una release; desde un clon usa git checkout v$version"
fi
[ "$check" = 0 ] || die "--check es solo para releases; desde un clon: overhaul update --check"

# shellcheck source=deploy/labels.sh
. "$DIR/deploy/labels.sh"
HUB_LABEL=$OVERHAUL_HUB_LABEL
BRIDGE_LABEL=$OVERHAUL_BRIDGE_LABEL

OS=$(uname -s)
case "$OS" in
  Linux|Darwin) ;;
  *) die "Sistema no soportado: $OS (solo Linux y macOS)" ;;
esac

CONFIG_DIR="${OVERHAUL_CONFIG_DIR:-${HUB_CONFIG_DIR:-}}"
if [ -z "$CONFIG_DIR" ]; then
  CONFIG_DIR="$HOME/.config/overhaul"
  [ ! -e "$CONFIG_DIR" ] && [ -d "$HOME/.config/work-hub" ] && CONFIG_DIR="$HOME/.config/work-hub"
fi
case "$CONFIG_DIR" in "~/"*) CONFIG_DIR="$HOME/${CONFIG_DIR#\~/}" ;; esac
BIN_DIR="${OVERHAUL_BIN_DIR:-$HOME/.local/bin}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/overhaul"

# --- Services -------------------------------------------------------------------------------------
remove_services() {
  if [ "$OS" = Linux ]; then
    local removed=0
    for unit in overhaul-bridge overhaul; do
      [ -f "$SYSTEMD_DIR/$unit.service" ] || continue
      run systemctl --user disable --now "$unit.service" || true
      run rm -f "$SYSTEMD_DIR/$unit.service"
      say "Servicio $unit quitado"
      removed=1
    done
    [ "$removed" = 0 ] || run systemctl --user daemon-reload || true
  else
    for label in "$BRIDGE_LABEL" "$HUB_LABEL"; do
      [ -f "$AGENTS_DIR/$label.plist" ] || continue
      run launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      run rm -f "$AGENTS_DIR/$label.plist"
      say "LaunchAgent $label quitado"
    done
  fi
}

# Services of earlier installations (work-hub, or Overhaul with other names), found by pattern.
previous_services() {
  if [ "$OS" = Linux ]; then previous_units "$SYSTEMD_DIR"; else previous_launch_agents "$AGENTS_DIR" hub; fi
}
remove_previous() { # names...
  local name
  for name in "$@"; do
    if [ "$OS" = Linux ]; then
      run systemctl --user disable --now "$name.service" || true
      run rm -f "$SYSTEMD_DIR/$name.service"
    else
      run launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
      run rm -f "$AGENTS_DIR/$name.plist"
    fi
    say "Quité $name (instalación anterior)"
  done
  if [ "$OS" = Linux ]; then run systemctl --user daemon-reload || true; fi
}
# Lists them and asks; returns 1 if they stay.
offer_remove_previous() {
  local previous
  previous=$(previous_services)
  [ -n "$previous" ] || return 0
  say "Servicios de una instalación anterior en esta máquina:"
  printf '  %s\n' $previous
  if ask_yes "¿Los detengo y quito? (no toca config ni datos; si es work-hub, migra antes con deploy/migrate-from-work-hub.mjs)"; then
    # shellcheck disable=SC2086
    remove_previous $previous
    return 0
  fi
  return 1
}

remove_link() {
  local link
  for link in "$BIN_DIR/overhaul" "$BIN_DIR/hub"; do
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$DIR/bin/hub.mjs" ]; then
      run rm -f "$link"
      say "Enlace $link quitado"
    fi
  done
}

if [ "$uninstall" = 1 ]; then
  remove_services
  remove_link
  offer_remove_previous || say "Esos servicios siguen ahí; para quitarlos corre ./install.sh --uninstall en una terminal y responde que sí."
  if [ -n "$RELEASE_DIR" ]; then
    if [ "$OS" = Darwin ] && [ -f "$AGENTS_DIR/$OVERHAUL_HELPER_LABEL.plist" ]; then
      say "El helper de escritorio ($OVERHAUL_HELPER_LABEL) corre desde $APP_ROOT: no lo borro."
    else
      run rm -rf "$APP_ROOT"
      say "Release quitada: $APP_ROOT"
    fi
  fi
  say "Listo. No toqué $CONFIG_DIR ni los datos (data_dir de config.yaml)."
  say "El hook de Claude, si lo instalaste, sigue en ~/.claude/settings.json: sin hub no hace nada."
  exit 0
fi

# --- Services of an earlier installation (they would take the same port) -----------------------
if ! offer_remove_previous; then
  [ "$force" = 1 ] || die "esos servicios son de una instalación anterior y usan el puerto $PORT. Quítalos (corre ./install.sh en una terminal y responde que sí), migra work-hub con deploy/migrate-from-work-hub.mjs, o usa --force para instalar igual."
  warn "sigo por --force: dos hubs en el puerto $PORT no corren a la vez"
fi

# --- Node >= 22.13 --------------------------------------------------------------------------------
node_help() {
  say "Instala Node 22.13 o más nuevo con fnm y vuelve a correr ./install.sh:"
  if [ "$OS" = Darwin ]; then say "  brew install fnm"; else say "  curl -fsSL https://fnm.vercel.app/install | bash"; fi
  say "  fnm install 22 && fnm default 22"
  say "  (abre una terminal nueva para que node quede en el PATH)"
  exit 1
}
command -v node >/dev/null || { say "No encontré node."; node_help; }
# node:sqlite works without a flag from 22.13.
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' ||
  { say "Tienes Node $(node -v); Overhaul necesita 22.13 o más."; node_help; }

# The node services run with: fnm's per-shell path dies with the shell, so use its default alias.
NODE=$(command -v node)
case "$NODE" in
  *fnm_multishells*)
    for alias in "${FNM_DIR:-}/aliases/default/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/Library/Application Support/fnm/aliases/default/bin/node"; do
      [ -x "$alias" ] && { NODE="$alias"; break; }
    done
    case "$NODE" in *fnm_multishells*) NODE=$(node -p 'require("fs").realpathSync(process.execPath)') ;; esac
    ;;
esac
say "Node $(node -v) ($NODE), $OS"

# --- Dependencies ---------------------------------------------------------------------------------
if [ "${OVERHAUL_SKIP_NPM:-0}" = 1 ]; then
  say "Dependencias: omitidas (OVERHAUL_SKIP_NPM=1)"
else
  (cd "$DIR" && run npm ci --omit=dev --no-audit --no-fund)
fi

# --- Installed release: app/current points at this version from here on ---------------------------
if [ -n "$RELEASE_DIR" ]; then
  previous=""
  [ -L "$APP_ROOT/current" ] && previous=$(cd "$APP_ROOT/current" 2>/dev/null && pwd -P) || true
  run ln -sfn "$(basename "$RELEASE_DIR")" "$APP_ROOT/current"
  DIR="$APP_ROOT/current"
  say "Release $(cat "$RELEASE_DIR/RELEASE") en $RELEASE_DIR ($DIR)"
  # Keep this version and the one before (rollback: ln -sfn <versión> app/current and run its install.sh).
  for old in "$APP_ROOT"/*; do
    [ -d "$old" ] && [ ! -L "$old" ] && [ -f "$old/RELEASE" ] || continue
    [ "$old" = "$RELEASE_DIR" ] || [ "$old" = "$previous" ] || run rm -rf "$old"
  done
fi

# --- Config and env (only created when missing) --------------------------------------------------
run mkdir -p "$CONFIG_DIR"
run chmod 700 "$CONFIG_DIR"
if [ -f "$CONFIG_DIR/config.yaml" ]; then
  say "Config: $CONFIG_DIR/config.yaml ya existe, no la toco"
elif [ "$dry" = 1 ]; then
  say "+ node $DIR/deploy/standalone/config.mjs > $CONFIG_DIR/config.yaml"
else
  node "$DIR/deploy/standalone/config.mjs" "$DIR/config.example.yaml" > "$CONFIG_DIR/config.yaml"
  say "Config: creé $CONFIG_DIR/config.yaml (sin proyectos todavía)"
fi

ENV_FILE="$CONFIG_DIR/env"
if [ "$dry" = 1 ]; then
  [ -f "$ENV_FILE" ] || say "+ crear $ENV_FILE (600) con HUB_AGENT_TOKEN aleatorio"
else
  if [ ! -f "$ENV_FILE" ]; then
    (umask 077 && printf '# Overhaul secrets (600). Tracker tokens go here too, named by *_env in config.yaml.\n' > "$ENV_FILE")
    say "Env: creé $ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  if ! grep -q '^HUB_AGENT_TOKEN=.\{24,\}' "$ENV_FILE"; then
    printf 'HUB_AGENT_TOKEN=%s\n' "$(node -p 'require("crypto").randomBytes(32).toString("hex")')" >> "$ENV_FILE"
    say "Env: agregué HUB_AGENT_TOKEN"
  fi
fi

# --- Password (HUB_TOKEN) ---------------------------------------------------------------------------
has_password() { [ -f "$ENV_FILE" ] && grep -q '^HUB_TOKEN=.\{12,\}' "$ENV_FILE"; }
if has_password; then
  say "Contraseña: ya hay una (cámbiala con $DIR/bin/set-password)"
elif [ "$dry" = 1 ]; then
  say "+ $DIR/bin/set-password --no-restart"
elif [ "$interactive" = 1 ] && { : </dev/tty; } 2>/dev/null; then
  say "Elige la contraseña para entrar al hub:"
  until HUB_CONFIG_DIR="$CONFIG_DIR" bash "$DIR/bin/set-password" --no-restart </dev/tty; do say "Otra vez:"; done
else
  warn "sin contraseña todavía: el hub no arranca hasta que corras $DIR/bin/set-password"
fi

# --- `overhaul` (and its alias `hub`) in the PATH ---------------------------------------------------
run mkdir -p "$BIN_DIR"
run chmod +x "$DIR/bin/hub.mjs" "$DIR/bin/set-password"
for name in overhaul hub; do
  if [ -e "$BIN_DIR/$name" ] && [ ! -L "$BIN_DIR/$name" ]; then
    warn "$BIN_DIR/$name ya existe y no es un enlace; no lo reemplazo"
  else
    run ln -sfn "$DIR/bin/hub.mjs" "$BIN_DIR/$name"
    say "CLI: $BIN_DIR/$name"
  fi
done
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR no está en tu PATH; agrégalo en tu ~/.zshrc o ~/.bashrc" ;; esac

# --- Services ---------------------------------------------------------------------------------------
# The services get this shell's PATH, so the bridge finds tmux, claude, pi and gh like you do.
esc() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; } # safe as a sed replacement
render() { # template target
  sed -e "s|__NODE__|$(esc "$NODE")|g" -e "s|__DIR__|$(esc "$DIR")|g" -e "s|__PATH__|$(esc "$PATH")|g" \
      -e "s|__CONFIG_DIR__|$(esc "$CONFIG_DIR")|g" -e "s|__LOGS__|$(esc "$LOG_DIR")|g" -e "s|__LABEL__|$(esc "${3:-}")|g" "$1" > "$2"
}

install_services() {
  command -v tmux >/dev/null || warn "no encontré tmux: el puente no puede entregar mensajes a los agentes sin él"
  if [ "$OS" = Linux ]; then
    command -v systemctl >/dev/null || die "no hay systemctl; usa --no-services y arranca el hub a mano (README)"
    run mkdir -p "$SYSTEMD_DIR"
    for unit in overhaul overhaul-bridge; do
      if [ "$dry" = 1 ]; then say "+ escribir $SYSTEMD_DIR/$unit.service"; else render "$DIR/deploy/standalone/$unit.service" "$SYSTEMD_DIR/$unit.service"; fi
    done
    run systemctl --user daemon-reload
    run systemctl --user enable overhaul.service overhaul-bridge.service
    run systemctl --user restart overhaul.service overhaul-bridge.service
    say "Servicios: systemctl --user status overhaul overhaul-bridge (logs: journalctl --user -u overhaul)"
    if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
      say "Para que sigan corriendo sin sesión abierta: loginctl enable-linger $USER"
    fi
  else
    run mkdir -p "$AGENTS_DIR" "$LOG_DIR"
    for label in "$HUB_LABEL" "$BRIDGE_LABEL"; do
      local target="$AGENTS_DIR/$label.plist"
      if [ "$dry" = 1 ]; then say "+ escribir $target"; else render "$DIR/deploy/standalone/${label#overhaul.}.plist" "$target" "$label"; plutil -lint -s "$target"; fi
      run launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      run launchctl bootstrap "gui/$(id -u)" "$target"
    done
    say "Servicios: LaunchAgents $HUB_LABEL y $BRIDGE_LABEL (logs en $LOG_DIR)"
  fi
}
if [ "$services" = 1 ]; then install_services; else say "Servicios: omitidos (--no-services). Arranca a mano: node $DIR/src/server.mjs y overhaul bridge"; fi

# --- Desktop helper (macOS): already installed from a release, it follows the update ------------
if [ -n "$RELEASE_DIR" ] && [ "$OS" = Darwin ] && [ -f "$AGENTS_DIR/$OVERHAUL_HELPER_LABEL.plist" ]; then
  say "Helper de escritorio: actualizándolo desde $DIR/helper"
  if [ "$dry" = 1 ]; then zsh "$DIR/helper/install.sh" --dry-run || true; else zsh "$DIR/helper/install.sh" || warn "el helper no se actualizó; corre zsh $DIR/helper/install.sh"; fi
fi

# --- Claude Code hook (asks first) -----------------------------------------------------------------
SETTINGS="$HOME/.claude/settings.json"
HOOK_CMD="$NODE $DIR/bin/hub-hook.mjs"
if [ -f "$SETTINGS" ] && grep -q 'hub-hook.mjs' "$SETTINGS"; then
  say "Hook de Claude: ya está en $SETTINGS"
elif [ "$dry" = 1 ]; then
  say "+ (si respondes que sí) python3 $DIR/deploy/install-hooks.py \"$HOOK_CMD\" $SETTINGS"
elif ask_yes "¿Instalo el hook de Claude Code en $SETTINGS (la página sigue lo que hacen los agentes; respalda el archivo)?"; then
  if command -v python3 >/dev/null; then
    mkdir -p "$(dirname "$SETTINGS")"
    [ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"
    python3 "$DIR/deploy/install-hooks.py" "$HOOK_CMD" "$SETTINGS"
  else
    warn "falta python3 para instalar el hook; córrelo después: python3 $DIR/deploy/install-hooks.py \"$HOOK_CMD\" $SETTINGS"
  fi
else
  say "Hook de Claude: no instalado (después: python3 $DIR/deploy/install-hooks.py \"$HOOK_CMD\" $SETTINGS)"
fi

# --- Done ---------------------------------------------------------------------------------------------
if [ "$services" = 1 ] && [ "$dry" = 0 ] && has_password; then
  up=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "http://127.0.0.1:$PORT/login.html"; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || warn "el hub no responde todavía en 127.0.0.1:$PORT; revisa los logs de arriba"
fi
say ""
say "Overhaul: http://127.0.0.1:$PORT"
say "Siguiente paso: agrega un proyecto en $CONFIG_DIR/config.yaml (config.example.yaml tiene todas las opciones)"
if [ "$OS" = Linux ]; then say "y reinicia: systemctl --user restart overhaul"; else say "y reinicia: launchctl kickstart -k gui/$(id -u)/$HUB_LABEL"; fi
