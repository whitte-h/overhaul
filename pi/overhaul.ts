// Overhaul for pi: tells the hub what this agent was asked and its final reply, like the
// Claude Code hook does (bin/hub-hook.mjs: UserPromptSubmit, Stop). pi asks no permissions,
// so there is no PermissionRequest. Installed by `hub install-pi` into ~/.pi/agent/extensions,
// which fills in the two paths below.
//
// Each event runs the hook in its own detached process and is never awaited: a slow or
// down hub cannot hold up pi's turn. The hook finds the window (tmux pane, or HUB_WINDOW in
// an Orca terminal) and the token, and does nothing outside an agent the hub tracks.
import { spawn } from "node:child_process";

const NODE = "__NODE__";
const HOOK = "__HOOK__";

function send(event: string, text: string, ctx: any): void {
  if (!text || (!process.env.TMUX_PANE && !process.env.HUB_WINDOW)) return;
  let sessionId: unknown;
  try {
    sessionId = ctx?.sessionManager?.getSessionId?.();
  } catch {}
  const input = JSON.stringify({
    agent: "pi",
    hook_event_name: event,
    session_id: typeof sessionId === "string" ? sessionId : undefined,
    cwd: typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(),
    ...(event === "Stop" ? { last_assistant_message: text } : { prompt: text }),
  });
  try {
    const child = spawn(NODE, [HOOK], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.unref();
  } catch {}
}

// Subagents run their own sessions in this process; only the main agent's turns are the window's.
function isSubagent(ctx: any): boolean {
  try {
    return ctx?.agentKind === "sub" || typeof ctx?.sessionManager?.getHeader?.()?.parentSession === "string";
  } catch {
    return false;
  }
}

function assistantText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("");
}

export default function (pi: any): void {
  // What was typed or pasted, as written: before_agent_start only sees it after pi expands
  // it (a "/skill:x" line becomes the whole skill). Runs started without input (an
  // extension's message) are reported from before_agent_start.
  let fromInput = false;
  pi.on("input", (event: any, ctx: any) => {
    if (isSubagent(ctx) || event?.source === "extension") return { action: "continue" };
    fromInput = true;
    send("UserPromptSubmit", String(event?.text ?? ""), ctx);
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    if (isSubagent(ctx) || event?.messageType === "custom") return;
    if (fromInput) {
      fromInput = false;
      return;
    }
    send("UserPromptSubmit", String(event?.prompt ?? ""), ctx);
  });

  // The last assistant text of the run is its final reply; a run that continues (retry,
  // compaction) has not ended yet.
  pi.on("agent_end", (event: any, ctx: any) => {
    if (event?.willContinue === true || isSubagent(ctx)) return;
    fromInput = false;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "assistant") continue;
      const text = assistantText(messages[i]).trim();
      if (text) return send("Stop", text, ctx);
    }
  });
}
