#!/usr/bin/env python3
"""Add Overhaul's hook to Claude Code settings files, idempotently, with a backup.

usage: install-hooks.py [--repoint] [--repoint-only] <hook command> <settings.json> [<settings.json> ...]

--repoint: a hub-hook.mjs hook whose script no longer exists (the repo moved, e.g. from
work-hub to overhaul) is pointed at <hook command> instead of being left as it is.
--repoint-only: like --repoint, and adds no hook for events that have none.
"""
import json
import os
import shlex
import shutil
import sys
import time

EVENTS = ["UserPromptSubmit", "Stop", "PermissionRequest", "Notification"]

args = sys.argv[1:]
only = "--repoint-only" in args
repoint = only or "--repoint" in args
args = [a for a in args if a not in ("--repoint", "--repoint-only")]
command, files = args[0], args[1:]


def broken(cmd):
    """The hook's hub-hook.mjs path, when that file does not exist."""
    try:
        parts = shlex.split(cmd)
    except ValueError:
        return False
    return any(p.endswith("hub-hook.mjs") and not os.path.exists(os.path.expanduser(p)) for p in parts)


for path in files:
    with open(path) as f:
        settings = json.load(f)
    hooks = settings.get("hooks", {})
    changed = []
    for event in EVENTS:
        groups = hooks.get(event, [])
        ours = [h for g in groups for h in g.get("hooks", []) if "hub-hook.mjs" in h.get("command", "")]
        if ours:
            for h in ours:
                if repoint and h["command"] != command and broken(h["command"]):
                    h["command"] = command
                    changed.append(f"{event} (repointed)")
            continue
        if only:
            continue
        settings["hooks"] = hooks
        hooks[event] = groups
        groups.append({"hooks": [{"type": "command", "command": command, "timeout": 5}]})
        changed.append(event)
    if changed:
        shutil.copy2(path, f"{path}.bak-overhaul-{time.strftime('%Y%m%d-%H%M%S')}")
        with open(path, "w") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
    print(f"{path}: {'changed ' + ', '.join(changed) if changed else 'already installed'}")
