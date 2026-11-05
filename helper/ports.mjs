// Dev servers the agents start on their hosts (Next on host-a:4500, Vite on host-b:5173…)
// answer only on that host's localhost, so the links they print (http://localhost:4500) lead
// nowhere on this desktop. The helper watches each host's listening ports and keeps an SSH forward
// for each dev server, so the same localhost URL works here: in Orca, Chrome or the hub.
import net from "node:net";
import { execFile, spawn } from "node:child_process";

const SKIP = new Set([22, 53, 7420, 7421, 7437]); // ssh, dns, hub, this helper, engram
const forwards = new Map(); // local port -> { host, child }
let found = []; // last scan: { host, port, cwd, comm, state, error? }

// Listening TCP ports on a host with the owning process, one "port\tpid\tcwd\tcomm" per line.
// Linux has ss and /proc; macOS has lsof.
const SCRIPT = String.raw`
printf 'HOME\t%s\n' "$HOME"
if command -v ss >/dev/null 2>&1; then
  ss -ltnpH 2>/dev/null | while read -r _ _ _ local _ proc; do
    pid=$(printf %s "$proc" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
    [ -n "$pid" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$(printf %s "$local" | sed 's/.*://')" "$pid" "$(readlink /proc/$pid/cwd)" "$(cat /proc/$pid/comm)"
  done
else
  /usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null |
    awk '/^p/{p=substr($0,2)} /^c/{c=substr($0,2)} /^n/{n=substr($0,2); sub(/.*:/,"",n); print n, p, c}' |
    sort -u | while read -r port pid comm; do
      cwd=$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
      printf '%s\t%s\t%s\t%s\n' "$port" "$pid" "$cwd" "$comm"
    done
fi`;

// A dev server: run from a folder in the home (not a dotfolder like ~/.orca-remote), or Docker.
async function devPorts(host) {
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "sh -s"],
      { timeout: 30_000 }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin.end(SCRIPT);
  });
  const lines = stdout.trim().split("\n").map((l) => l.split("\t"));
  const home = lines.find(([k]) => k === "HOME")?.[1];
  const ports = new Map();
  for (const [port, , cwd = "", comm = ""] of lines) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n >= 49152 || SKIP.has(n) || ports.has(n)) continue; // 49152+: ephemeral
    const docker = /docker/i.test(comm);
    const inHome = home && cwd.startsWith(`${home}/`) && !cwd.slice(home.length + 1).startsWith(".");
    if (docker || inHome) ports.set(n, { host, port: n, cwd: docker ? "Docker" : `~/${cwd.slice(home.length + 1)}`, comm });
  }
  return [...ports.values()];
}

// Scans every host and forwards what is new; drops forwards whose server stopped. A host that
// does not answer keeps its forwards as they are. Same port on two hosts: the first host wins.
export async function syncForwards(hosts) {
  const next = [];
  const answered = new Set();
  for (const host of hosts) {
    try {
      next.push(...(await devPorts(host)));
      answered.add(host);
    } catch {
      next.push(...found.filter((f) => f.host === host));
    }
  }
  for (const f of next) {
    const owner = forwards.get(f.port)?.host;
    if (owner === f.host) f.state = "forwarded";
    else if (owner || next.some((g) => g.port === f.port && g.host !== f.host && hosts.indexOf(g.host) < hosts.indexOf(f.host))) f.state = "conflict";
    else if (await listening(f.port)) f.state = "busy";
    else {
      try {
        await ensureForward(f.port, f.host);
        f.state = "forwarded";
      } catch (err) {
        f.state = "error";
        f.error = err.message;
      }
    }
  }
  for (const [port, { host, child }] of forwards) {
    if (answered.has(host) && !next.some((f) => f.host === host && f.port === port)) {
      forwards.delete(port);
      child.kill();
      console.log(`stopped forwarding localhost:${port} from ${host}`);
    }
  }
  found = next;
  return found;
}

export const devServers = () => found;

// Forwards localhost:port here to localhost:port on host, unless something already listens.
export async function ensureForward(port, host) {
  if (await listening(port)) return;
  forwards.get(port)?.child.kill();
  // No bind address: ssh listens on both 127.0.0.1 and ::1, as browsers try either for localhost.
  const child = spawn("/usr/bin/ssh", [
    "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "BatchMode=yes",
    "-L", `${port}:localhost:${port}`, host,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.on("exit", () => forwards.get(port)?.child === child && forwards.delete(port));
  forwards.set(port, { host, child });
  console.log(`forwarding localhost:${port} from ${host}`);
  for (let i = 0; i < 40; i++) {
    if (await listening(port)) return;
    if (child.exitCode !== null) throw new Error(`ssh ${host} -L ${port}: ${stderr.trim().split("\n").pop() || "exited"}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${port} from ${host} did not come up`);
}

export function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}
