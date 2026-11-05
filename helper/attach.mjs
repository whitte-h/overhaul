#!/usr/bin/env node
// Runs on the desktop machine inside an Orca terminal: a real terminal on an agent's tmux window.
//   node attach.mjs <ssh-host> <session:window>
// - Opens its own view of the agent's tmux session (a grouped session), so several terminals
//   of one project don't fight over which window they show; tmux removes it on detach.
// - Reconnects by itself when the Mac sleeps or the network drops; ends when the window is gone.
// - Files you paste or drop by path (e.g. /Users/…/captura.png) are uploaded to the agent's
//   host and the path is rewritten, since Claude there can only read its own disk.
// - Ctrl+V with an image on the clipboard (a screenshot) does the same: the image is saved,
//   uploaded, and its remote path typed in. Without an image, Ctrl+V passes through.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import pty from "node-pty";

const [host, target] = process.argv.slice(2);
if (!/^[\w.-]+$/.test(host ?? "") || !/^[\w.-]+:[\w.-]+$/.test(target ?? "")) {
  console.error("Uso: attach.mjs <host> <session:window>");
  process.exit(2);
}
const [session, window] = target.split(":");
const GONE = 3; // remote exit code when the window no longer exists
const MAX_UPLOAD = 100 * 1024 * 1024;

const view = `hub-${randomUUID().slice(0, 8)}`;
const remote = [
  "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH;",
  `tmux list-windows -t '=${session}' -F '#W' 2>/dev/null | grep -qx '${window}' || exit ${GONE};`,
  `exec tmux new-session -t '=${session}' -s '${view}'`,
  `\\; set-option destroy-unattached on \\; set-option mouse on \\; select-window -t ':${window}'`,
].join(" ");

// Local file paths in what you typed or pasted: quoted, backslash-escaped spaces, or plain.
const PATH_RE = /'(\/(?:Users|private|var|tmp|Volumes)\/[^']+)'|"(\/(?:Users|private|var|tmp|Volumes)\/[^"]+)"|(\/(?:Users|private|var|tmp|Volumes)\/(?:\\ |[^\s'"])+)/g;

const run = promisify(execFile);
let term = null;
let input = Promise.resolve(); // keystrokes stay in order while a paste uploads

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  const next = text === "\x16" ? pasteClipboardImage : rewritePaths;
  input = input.then(() => next(text)).then((out) => term?.write(out), () => term?.write(text));
});
process.stdout.on("resize", () => term?.resize(process.stdout.columns, process.stdout.rows));

// node-pty 1.1.0 on macOS never closes a session's /dev/ptmx, so a pty per reconnect piles up
// (sleep/wake cycles overnight reached the system limit of 511 and no app could open a
// terminal). This process opens one pty for its whole life; the reconnect loop runs inside it
// as a small shell script: probe the host while it is down (backing off up to 30 s), attach,
// clean up tmux's terminal modes after a drop, stop when the window is gone or you detach.
const RESET = "\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1005l\\033[?1006l\\033[?1015l\\033[?1004l\\033[?2004l\\033[?1049l\\033[?25h";
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const loop = `
w=3
while true; do
  if ! /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8 ${host} true 2>/dev/null; then
    printf '\\r\\n[work-hub] ${host} no responde; reintento en %s s… (Ctrl+C para salir)\\r\\n' $w
    sleep $w; w=$(( w * 2 > 30 ? 30 : w * 2 )); continue
  fi
  w=3
  /usr/bin/ssh -t -o ServerAliveInterval=15 -o ServerAliveCountMax=4 ${host} ${q(remote)}
  code=$?
  printf '${RESET}'
  if [ $code -eq ${GONE} ]; then printf '\\r\\n[work-hub] La ventana ${target} ya no existe en ${host}.\\r\\n'; exit 0; fi
  if [ $code -eq 0 ]; then exit 0; fi
  printf '\\r\\n[work-hub] Conexión con ${host} perdida; reconectando… (Ctrl+C para salir)\\r\\n'
  sleep 3
done`;

term = pty.spawn("/bin/zsh", ["-f", "-c", loop], {
  name: process.env.TERM || "xterm-256color",
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 40,
  env: process.env,
});
term.onData((d) => process.stdout.write(d));
term.onExit(() => {
  process.stdout.write(RESET.replace(/\\033/g, "\x1b"));
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
});

// Ctrl+V: the clipboard's image (PNG), if any, saved to a temp file and uploaded.
async function pasteClipboardImage(key) {
  const { stdout } = await run("osascript", ["-e", "clipboard info"]).catch(() => ({ stdout: "" }));
  if (!/PNGf|TIFF/.test(stdout)) return key;
  const file = path.join(os.tmpdir(), `captura-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`);
  const script = `set f to open for access POSIX file "${file}" with write permission\nwrite (the clipboard as «class PNGf») to f\nclose access f`;
  await run("osascript", ["-e", script]);
  try { return await upload(file); } finally { fs.rmSync(file, { force: true }); }
}

async function rewritePaths(text) {
  if (!text.includes("/")) return text;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const local = (m[1] ?? m[2] ?? m[3]).replace(/\\ /g, " ");
    let stat;
    try { stat = fs.statSync(local); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_UPLOAD) continue;
    out += text.slice(last, m.index) + (await upload(local));
    last = m.index + m[0].length;
  }
  return last ? out + text.slice(last) : text;
}

// Streams the file over ssh to ~/.config/work-hub/uploads/term/<id>/<name> and returns that path.
function upload(local) {
  const name = path.basename(local).normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "archivo";
  const dest = `uploads/term/${randomUUID()}/${name}`;
  const cmd = `f="$HOME/.config/work-hub/${dest}"; mkdir -p "\${f%/*}" && cat > "$f" && printf %s "$f"`;
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/ssh", ["-o", "BatchMode=yes", host, cmd], { stdio: ["pipe", "pipe", "ignore"] });
    let remotePath = "";
    child.stdout.on("data", (d) => (remotePath += d));
    child.on("close", (code) => (code === 0 && remotePath ? resolve(remotePath) : reject(new Error(`upload ${code}`))));
    fs.createReadStream(local).pipe(child.stdin);
  });
}
