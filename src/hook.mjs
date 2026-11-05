// Claude Code hook (`overhaul hook <Event>`): tells the hub what happens in this tmux window so
// you can follow and drive the agent from the page. Events: UserPromptSubmit (what it was asked),
// Stop (its final reply), PermissionRequest / Notification (it needs you).
// pi sends the same events through its extension (pi/overhaul.ts), with "agent": "pi".
// Outside tmux (Orca terminals) the window is HUB_WINDOW ("session:title"), set by the bridge.
// Never blocks or fails the agent: silent, short timeout, always exits 0.
import fs from "node:fs";
import { hubUrls, loadEnvFile, localHost } from "./env.mjs";
import { paneWindow, rememberSession } from "./restart.mjs";

export const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "PermissionRequest", "Notification"];

// event: the one named on the command line; the JSON on stdin says it too and wins.
export async function runHook(event) {
  try {
    await main(event);
  } catch {}
  process.exit(0);
}

async function main(event) {
  loadEnvFile();
  const token = process.env.HUB_AGENT_TOKEN;
  const where = await windowOf();
  if (!where || !token) return; // only agents in tmux or bridge-opened Orca terminals are tracked
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  input.hook_event_name ??= event;
  const [session, window] = where;
  // pi keeps its session id on the window (restart.mjs); this file is Claude's.
  if (input.agent !== "pi") try { rememberSession(`${session}:${window}`, input.session_id, input.cwd); } catch {}
  const text = describe(input);
  if (!text) return;
  const payload = {
    host: localHost(),
    session,
    window,
    event: input.hook_event_name,
    text: text.slice(0, 20_000),
    cwd: input.cwd ?? "",
  };
  for (const url of hubUrls()) {
    try {
      const res = await fetch(`${url}/agent/hook`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
    } catch {}
  }
}

async function windowOf() {
  const pane = process.env.TMUX_PANE;
  if (pane) {
    const win = await paneWindow(pane); // not the hub-* view it is being watched through
    const i = win.indexOf(":");
    return [win.slice(0, i), win.slice(i + 1)];
  }
  const m = /^([^:]+):(.+)$/.exec(process.env.HUB_WINDOW ?? "");
  return m ? [m[1], m[2]] : null;
}

function describe(input) {
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      return input.prompt ?? "";
    case "Stop":
      return input.last_assistant_message ?? lastAssistantText(input.transcript_path);
    case "PermissionRequest":
      return `Pide permiso para ${input.tool_name ?? "una herramienta"}: ${summarize(input.tool_input)}`;
    case "Notification":
      return input.message ?? "";
    default:
      return "";
  }
}

function summarize(toolInput) {
  if (!toolInput) return "";
  if (toolInput.command) return toolInput.command;
  if (toolInput.file_path) return toolInput.file_path;
  return JSON.stringify(toolInput).slice(0, 500);
}

// Last assistant message with text in the session transcript (JSONL); reads only the tail.
function lastAssistantText(file) {
  if (!file || !fs.existsSync(file)) return "";
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  const len = Math.min(size, 1024 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "assistant" || entry.isSidechain) continue;
      const parts = (entry.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
      if (parts.length) return parts.join("\n").trim();
    } catch {}
  }
  return "";
}
