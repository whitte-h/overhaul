// Push fallback for agents that are not long-polling: paste into their tmux pane,
// the same load-buffer + paste-buffer -p + Enter sequence used by the orchestrators.
import { localHost, tool } from "./env.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TMUX = tool("tmux", process.env.TMUX_BIN);

export async function pasteToTmux(agent, text) {
  if (!agent?.tmuxPane || agent.host !== localHost()) return false;
  const pane = agent.tmuxPane;
  if (!/^%\d+$/.test(pane)) return false;
  try {
    await run(TMUX, ["display-message", "-p", "-t", pane, "#{pane_id}"]);
    const buffer = `overhaul-${process.pid}`;
    const child = execFile(TMUX, ["load-buffer", "-b", buffer, "-"]);
    child.stdin.end(text);
    await new Promise((resolve, reject) => child.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`tmux ${c}`)))));
    await run(TMUX, ["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane]);
    await run(TMUX, ["send-keys", "-t", pane, "Enter"]);
    return true;
  } catch {
    return false;
  }
}

export function formatForAgent(msgs, tag = "overhaul") {
  return msgs
    .map((m) => (m.kind === "answer" ? `[${tag}] Respuesta a "${m.question}": ${m.text}` : `[${tag}] ${m.text}`))
    .join("\n");
}
