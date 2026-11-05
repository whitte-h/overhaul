#!/bin/zsh
# Installs Overhaul's desktop helper on this Mac: node-pty for the Orca terminals and the
# LaunchAgents overhaul.helper (overhaul-helper: Chrome profiles, consoles, Orca terminals) and
# overhaul.orca (Orca layout restore at login), with this machine's node and paths.
# Run again after moving the folder or changing node versions; it replaces what it installed.
# LaunchAgents of an earlier helper installation (other names, other paths) are stopped and
# removed, so the helper never runs twice on port 7421.
# From an installed release use ~/.local/share/overhaul/app/current/helper/install.sh: the
# LaunchAgents keep that path (no symlinks resolved), so a new release only needs a rerun, which
# the main install.sh does by itself when it updates the release.
#   zsh helper/install.sh [--dry-run]
set -euo pipefail
dir=${0:a:h}
dry=0
[[ ${1:-} == --dry-run ]] && dry=1
run() { if (( dry )); then print -r -- "+ $*"; else "$@"; fi }
source "$dir/../deploy/labels.sh"
agents=${OVERHAUL_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}

node=$(command -v node) || { echo "Falta Node: instálalo (por ejemplo con fnm) y vuelve a correr esto."; exit 1; }

# The layout (hub URL, origins, hosts) lives on this machine, outside the repo; the helper
# does not start without it.
layout=${OVERHAUL_LAYOUT:-$HOME/.config/overhaul/orca-layout.json}
if [[ ! -f $layout && ! -f $dir/orca-layout.json ]]; then
  echo "Falta $layout: genéralo en el host del hub con \`overhaul orca-layout\` y cópialo aquí (ejemplo: $dir/orca-layout.example.json)"
  exit 1
fi

# Earlier installations: their plists point at paths that may no longer exist.
for label in ${(f)"$(previous_launch_agents "$agents" helper)"}; do
  run launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  run rm -f "$agents/$label.plist"
  echo "LaunchAgent $label quitado (instalación anterior)"
done

if (( dry )); then echo "+ npm install (en $dir)"; else (cd "$dir" && npm install --no-audit --no-fund); fi

run mkdir -p "$agents"
for name label in helper "$OVERHAUL_HELPER_LABEL" orca "$OVERHAUL_ORCA_LABEL"; do
  target=$agents/$label.plist
  if (( dry )); then
    echo "+ escribir $target"
  else
    sed -e "s|__NODE__|$node|g" -e "s|__DIR__|$dir|g" -e "s|__LABEL__|$label|g" "$dir/$name.plist" > "$target"
    plutil -lint -s "$target"
  fi
  run launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  run launchctl bootstrap "gui/$(id -u)" "$target"
  echo "LaunchAgent $label instalado"
done

[[ -x /Applications/Orca.app/Contents/Resources/bin/orca ]] ||
  echo "Orca no está instalado: brew install --cask stablyai/orca/orca (luego: node $dir/orca-restore.mjs)"
