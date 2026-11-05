# Service names of this version, and the ones earlier installations left behind.
# Sourced by install.sh and bin/set-password (bash 3.2) and helper/install.sh (zsh): keep it POSIX.
#
# Earlier versions used other launchd labels and systemd units. They are found by pattern, never
# by name: a LaunchAgent or unit whose name contains "work-hub" or "overhaul" and is not one of
# the current ones belongs to a previous installation. Two copies would fight over the same port,
# so the installers offer to remove them.

OVERHAUL_HUB_LABEL=overhaul.hub
OVERHAUL_BRIDGE_LABEL=overhaul.bridge
OVERHAUL_HELPER_LABEL=overhaul.helper
OVERHAUL_ORCA_LABEL=overhaul.orca
OVERHAUL_UNITS="overhaul overhaul-bridge"

# Which side a LaunchAgent belongs to: helper (the desktop helper and its Orca restore) or hub.
overhaul_plist_side() { # plist
  if grep -qE 'chrome-helper|orca-restore|overhaul-helper' "$1" 2>/dev/null; then echo helper; else echo hub; fi
}

# previous_launch_agents <LaunchAgents dir> <hub|helper>: labels (one per line) of earlier
# installations on that side, from the plist file names.
previous_launch_agents() {
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 1 -type f -name '*.plist' \( -name '*work-hub*' -o -name '*overhaul*' \) 2>/dev/null | sort |
    while IFS= read -r f; do
      l=$(basename "$f" .plist)
      case "$l" in
        "$OVERHAUL_HUB_LABEL"|"$OVERHAUL_BRIDGE_LABEL"|"$OVERHAUL_HELPER_LABEL"|"$OVERHAUL_ORCA_LABEL") continue ;;
      esac
      [ "$(overhaul_plist_side "$f")" = "$2" ] && printf '%s\n' "$l"
    done
  return 0
}

# previous_units <systemd user dir>: units (without .service) of earlier installations.
previous_units() {
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 1 -name '*.service' \( -name '*work-hub*' -o -name '*overhaul*' \) 2>/dev/null | sort |
    while IFS= read -r f; do
      u=$(basename "$f" .service)
      case " $OVERHAUL_UNITS " in *" $u "*) continue ;; esac
      printf '%s\n' "$u"
    done
  return 0
}
