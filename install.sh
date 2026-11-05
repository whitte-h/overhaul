#!/usr/bin/env bash
# Installs Overhaul on this machine (Linux or macOS) as one executable, `overhaul`, with no Node:
# the hub and its bridge as user services on 127.0.0.1:7420, everything else in ~/.overhaul.
#
#   curl -fsSL https://github.com/whitte-h/overhaul/releases/latest/download/install.sh | bash
#   ... | bash -s -- [options]
#
#   --version X.Y.Z     that release instead of the latest
#   --check             print the latest release's version, install nothing
#   --bin-dir D         where to put `overhaul` (default: /opt/homebrew/bin or /usr/local/bin when
#                       writable, else ~/.overhaul/bin; OVERHAUL_BIN_DIR does the same)
#   --binary FILE       install this executable instead of downloading one
#   --no-services       no user services (containers, CI): only the executable, config and data
#   --non-interactive   no questions: no password prompt, no Claude Code hook
#   --dry-run           print what it would do, change nothing
#   --uninstall         remove the services and the executable; keeps ~/.overhaul
#
# What it does: downloads overhaul-<os>-<arch> and its .sha256 from the release (gh with a
# session, GH_TOKEN/GITHUB_TOKEN with the GitHub API, or the public URLs), checks the sha256,
# puts it in place atomically, then `overhaul setup`, the password, `overhaul service install`
# (which moves an earlier installation into ~/.overhaul) and, if you say yes, the Claude Code hook.
# Run again to update; `overhaul update` does the same from the executable.
# Run from a v0.1 release (app/<version>, which is how v0.1's `overhaul update` installs a new
# one) it installs that version's executable and leaves v0.1 behind: links, hooks, app/.
# docs/contract.md, "install.sh". Bash 3.2 compatible (macOS /bin/bash).

# Started by sh (curl ... | sh): hand over to bash, from the file or by fetching the script again.
# POSIX only up to here: sh reads one command at a time, so it never parses the bash below.
if [ -z "${BASH_VERSION:-}" ]; then
  command -v bash >/dev/null 2>&1 || { echo "Error: el instalador de Overhaul necesita bash" >&2; exit 1; }
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
OH_HOME="${OVERHAUL_HOME:-$HOME/.overhaul}"
PORT=7420

dry=0 uninstall=0 services=1 interactive=1 check=0 version="" bin_dir="${OVERHAUL_BIN_DIR:-}" binary=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --uninstall) uninstall=1 ;;
    --no-services) services=0 ;;
    --non-interactive) interactive=0 ;;
    --check) check=1 ;;
    --force) ;; # v0.1's option: earlier services are now always replaced
    --version) [ $# -ge 2 ] || { echo "Error: --version necesita X.Y.Z" >&2; exit 2; }; version=${2#v}; shift ;;
    --version=*) version=${1#--version=}; version=${version#v} ;;
    --bin-dir) [ $# -ge 2 ] || { echo "Error: --bin-dir necesita una carpeta" >&2; exit 2; }; bin_dir=$2; shift ;;
    --bin-dir=*) bin_dir=${1#--bin-dir=} ;;
    --binary) [ $# -ge 2 ] || { echo "Error: --binary necesita un archivo" >&2; exit 2; }; binary=$2; shift ;;
    --binary=*) binary=${1#--binary=} ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $1 (ver --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
warn() { printf 'Aviso: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# Commands that change the machine go through run: printed, not run, with --dry-run.
run() { if [ "$dry" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
# Questions read the terminal even when the script came through a pipe (curl | bash).
has_tty() { [ "$interactive" = 1 ] && [ "$dry" = 0 ] && { : </dev/tty; } 2>/dev/null; }
ask_yes() {
  has_tty || return 1
  local reply
  { printf '%s [s/N] ' "$1" >/dev/tty; read -r reply </dev/tty; } 2>/dev/null || return 1
  case "$reply" in s|S|si|sí|y|Y|yes) return 0 ;; *) return 1 ;; esac
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
abspath() { case "$1" in /*) printf '%s' "$1" ;; "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s/%s' "$(pwd -P)" "$1" ;; esac; }

# --- Platform -------------------------------------------------------------------------------------
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "sistema no soportado: $(uname -s) (solo Linux y macOS)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) die "arquitectura no soportada: $(uname -m)" ;;
esac
# A Terminal under Rosetta says x86_64 on an Apple Silicon Mac: the native build is better.
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi
ASSET="overhaul-$OS-$ARCH"

# --- Release sources: latest_<src> prints X.Y.Z, download_<src> <version> <file> <dir> ------------
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

sources() {
  local s=""
  if command -v "$GH" >/dev/null && "$GH" auth status >/dev/null 2>&1; then s="gh"; fi
  if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] && command -v curl >/dev/null; then s="$s api"; fi
  command -v curl >/dev/null && s="$s public"
  [ -n "$s" ] || die "falta curl (o gh con sesión) para descargar Overhaul"
  printf '%s' "$s"
}

# --- Where this script runs from: a v0.1 release (app/<version>/install.sh) or anywhere ------------
LEGACY_APP=""
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then
  here=$(cd "$(dirname "$src")" && pwd -P)
  if [ -f "$here/RELEASE" ] && [ "$(basename "$(dirname "$here")")" = app ]; then
    LEGACY_APP=$(dirname "$here")
    [ -n "$version" ] || version=$(tr -d '[:space:]' <"$here/RELEASE")
  fi
fi

# --- Where the executable goes ---------------------------------------------------------------------
writable_dir() { [ -d "$1" ] && [ -w "$1" ]; }
pick_bin_dir() {
  if [ -n "$bin_dir" ]; then abspath "$bin_dir"; return; fi
  # An overhaul executable already in the PATH (not v0.1's link to a .mjs) is updated where it is.
  local cur
  cur=$(command -v overhaul 2>/dev/null || true)
  if [ -n "$cur" ] && [ -f "$cur" ] && [ ! -L "$cur" ] && ! head -c 2 "$cur" | grep -q '#!' && writable_dir "$(dirname "$cur")"; then
    dirname "$cur"; return
  fi
  local d
  for d in /opt/homebrew/bin /usr/local/bin; do
    if writable_dir "$d"; then printf '%s' "$d"; return; fi
  done
  printf '%s' "$OH_HOME/bin"
}
BIN_DIR=$(pick_bin_dir)
BIN="$BIN_DIR/overhaul"

# --- Uninstall ---------------------------------------------------------------------------------------
if [ "$uninstall" = 1 ]; then
  installed="$BIN"
  [ -x "$installed" ] || installed=$(command -v overhaul 2>/dev/null || true)
  if [ -n "$installed" ] && [ -x "$installed" ]; then
    run "$installed" service uninstall || warn "no pude quitar los servicios con $installed service uninstall"
    if [ -f "$installed" ] && [ ! -L "$installed" ]; then
      run rm -f "$installed"
      say "Quité $installed"
    fi
  else
    warn "no encontré el ejecutable overhaul"
  fi
  for link in "$HOME/.local/bin/overhaul" "$HOME/.local/bin/hub"; do
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$installed" ]; then run rm -f "$link"; fi
  done
  say "Listo. No toqué $OH_HOME (config, datos y respaldos)."
  say "El hook de Claude, si lo instalaste, sigue en ~/.claude/settings.json: sin overhaul no hace nada."
  exit 0
fi

# --- Version -----------------------------------------------------------------------------------------
SOURCES=""
if [ -z "$binary" ] || [ "$check" = 1 ]; then SOURCES=$(sources); fi
if [ "$check" = 1 ]; then
  for s in $SOURCES; do
    v=$(latest_$s) && [ -n "$v" ] && { printf '%s\n' "$v"; exit 0; }
    warn "$(source_label "$s"): no encontré la última release"
  done
  die "no pude consultar la última release"
fi

# --- Get the executable ------------------------------------------------------------------------------
say "Overhaul para $OS-$ARCH en $BIN"
tmp=""
cleanup() { [ -z "$tmp" ] || rm -rf "$tmp"; }
trap cleanup EXIT
if [ "$dry" = 0 ]; then
  mkdir -p "$BIN_DIR" 2>/dev/null || die "no puedo crear $BIN_DIR (usa --bin-dir con una carpeta tuya)"
  [ -w "$BIN_DIR" ] || die "no puedo escribir en $BIN_DIR (usa --bin-dir, o sudo)"
  # Next to the target, so the final mv is a rename on the same disk: atomic.
  tmp=$(mktemp -d "$BIN_DIR/.overhaul-download.XXXXXX")
fi

if [ -n "$binary" ]; then
  [ -f "$binary" ] || die "no existe $binary"
  run cp "$binary" "${tmp:-.}/overhaul"
else
  got=""
  for s in $SOURCES; do
    v="$version"
    if [ -z "$v" ]; then
      v=$(latest_$s) && [ -n "$v" ] || { warn "$(source_label "$s"): no encontré la última release"; continue; }
    fi
    case "$v" in [0-9]*.[0-9]*.[0-9]*) ;; *) die "versión inválida: '$v' (usa --version X.Y.Z)" ;; esac
    say "Overhaul v$v desde $(source_label "$s")"
    if [ "$dry" = 1 ]; then
      say "+ descargar $ASSET y $ASSET.sha256, verificar sha256, dejarlo en $BIN"
      got=$v
      break
    fi
    rm -f "$tmp/$ASSET" "$tmp/$ASSET.sha256"
    if download_$s "$v" "$ASSET" "$tmp" && download_$s "$v" "$ASSET.sha256" "$tmp"; then got=$v; break; fi
    warn "$(source_label "$s"): no pude descargar $ASSET de v$v"
  done
  [ -n "$got" ] || die "no pude descargar Overhaul (ver avisos arriba)"
  version=$got
  if [ "$dry" = 0 ]; then
    expected=$(cut -d' ' -f1 <"$tmp/$ASSET.sha256")
    actual=$(sha256 "$tmp/$ASSET")
    [ "${#expected}" = 64 ] && [ "$actual" = "$expected" ] || die "el sha256 de $ASSET no coincide con $ASSET.sha256: no instalo nada"
    say "sha256 verificado: $actual"
    mv "$tmp/$ASSET" "$tmp/overhaul"
  fi
fi

if [ "$dry" = 0 ]; then
  chmod 755 "$tmp/overhaul"
  # Downloaded by a browser it would carry quarantine; curl does not, but a copied file might.
  [ "$OS" != darwin ] || xattr -d com.apple.quarantine "$tmp/overhaul" 2>/dev/null || true
  got_version=$("$tmp/overhaul" version 2>/dev/null) || die "el ejecutable descargado no corre en esta máquina ($OS-$ARCH)"
  if [ -z "$binary" ] && [ "$got_version" != "$version" ]; then die "el ejecutable dice v$got_version, esperaba v$version"; fi
  mv -f "$tmp/overhaul" "$BIN"
  say "Instalado: $BIN (v$got_version)"
else
  say "+ mv <descarga> $BIN"
fi

# v0.1 left `overhaul` and `hub` in ~/.local/bin as links to a .mjs: they would shadow this one.
# With --bin-dir ~/.local/bin the executable itself is ~/.local/bin/overhaul: no link to itself.
linked_dirs=":"
for link in "$HOME/.local/bin/overhaul" "$HOME/.local/bin/hub"; do
  [ "$link" != "$BIN" ] || continue
  [ -L "$link" ] || continue
  to=$(readlink "$link")
  case "$to" in
    *.mjs) run ln -sfn "$BIN" "$link"; say "$link -> $BIN (antes apuntaba a v0.1)"; to=$BIN ;;
  esac
  if [ "$to" = "$BIN" ] && [ "$(basename "$link")" = overhaul ]; then linked_dirs="$linked_dirs$(dirname "$link"):"; fi
done

# --- PATH -------------------------------------------------------------------------------------------
# Fine when BIN_DIR is in the PATH, or a link named overhaul in a PATH folder leads to $BIN.
in_path=0
case ":$PATH:" in *":$BIN_DIR:"*) in_path=1 ;; esac
if [ "$in_path" = 0 ]; then
  old_ifs=$IFS; IFS=:
  for d in $PATH; do
    case "$linked_dirs" in *":$d:"*) in_path=1 ;; esac
  done
  IFS=$old_ifs
fi
if [ "$in_path" = 0 ]; then
  rc="$HOME/.bashrc"
  case "${SHELL:-}" in */zsh) rc="$HOME/.zshrc" ;; esac
  say ""
  say "$BIN_DIR no está en tu PATH. Agrega esta línea a $rc y abre una terminal nueva:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
  say ""
fi

if [ "$dry" = 1 ]; then
  say "+ $BIN setup"
  [ "$services" = 0 ] || say "+ $BIN service install"
  say "(dry-run) no cambié nada"
  exit 0
fi

# --- Config, env, password ----------------------------------------------------------------------------
# `setup` since v0.2.1; an older executable (--version 0.2.0) only knows `init`.
if "$BIN" help 2>/dev/null | grep -q '^  setup '; then "$BIN" setup; else "$BIN" init; fi
if ! "$BIN" set-password --check >/dev/null 2>&1; then
  if has_tty; then
    say "Elige la contraseña para entrar al hub:"
    until "$BIN" set-password --no-restart </dev/tty; do say "Otra vez:"; done
  else
    warn "sin contraseña todavía: el hub no arranca hasta que corras overhaul set-password"
  fi
fi

# --- Services (they also move an earlier installation into ~/.overhaul) ------------------------------
if [ "$services" = 1 ]; then
  command -v tmux >/dev/null || warn "no encontré tmux: el puente no puede entregar mensajes a los agentes sin él"
  "$BIN" service install || die "overhaul service install falló (ver arriba)"
else
  # Without services nothing stops a running hub, and migrate refuses while one answers.
  "$BIN" migrate || warn "no migré la instalación anterior; córrelo cuando el hub esté detenido: overhaul migrate"
  say "Servicios: omitidos (--no-services). Arranca a mano: overhaul serve y overhaul bridge"
fi

# --- Claude Code hook and pi extension ------------------------------------------------------------
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && grep -Eq 'hub-hook\.mjs|overhaul[^"]* hook ' "$SETTINGS"; then
  "$BIN" install-hooks --repoint-only
elif ask_yes "¿Instalo el hook de Claude Code en $SETTINGS (la página sigue lo que hacen los agentes; respalda el archivo)?"; then
  "$BIN" install-hooks
else
  say "Hook de Claude: no instalado (después: overhaul install-hooks)"
fi
[ ! -f "$HOME/.pi/agent/extensions/overhaul.ts" ] || "$BIN" install-pi

# --- Leaving v0.1 behind (when v0.1's `overhaul update` brought us here) ----------------------------
if [ -n "$LEGACY_APP" ]; then
  helper_plist="$HOME/Library/LaunchAgents/overhaul.helper.plist"
  keep_app=0
  if [ "$OS" = darwin ] && [ -f "$helper_plist" ] && grep -q "$LEGACY_APP" "$helper_plist"; then
    say "Helper de escritorio: reinstalándolo desde el ejecutable"
    "$BIN" helper install || { keep_app=1; warn "el helper sigue corriendo desde $LEGACY_APP; reinstálalo con overhaul helper install y borra esa carpeta"; }
  fi
  if [ "$keep_app" = 0 ]; then
    rm -rf "$LEGACY_APP"
    say "Quité la instalación v0.1 ($LEGACY_APP)"
  fi
fi

# --- Done -----------------------------------------------------------------------------------------------
if [ "$services" = 1 ] && "$BIN" set-password --check >/dev/null 2>&1 && command -v curl >/dev/null; then
  up=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login.html" 2>/dev/null; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || warn "el hub no responde todavía en 127.0.0.1:$PORT; mira overhaul service status"
fi
say ""
say "Overhaul: http://127.0.0.1:$PORT"
say "Siguiente paso: en la carpeta de tu proyecto (un repo, o una carpeta con varios) corre: overhaul init"
