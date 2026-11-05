#!/usr/bin/env node
// Runs on the desktop machine only. The hub page calls it to open a URL in a given Chrome profile, or a
// Terminal window with ssh to an agent host, which a web page cannot do on its own.
// Listens on localhost and only answers the hub origin.
// For localhost URLs of a project on another host it first makes sure an SSH port forward
// to that host exists, so dev servers on the agent hosts open here with no manual tunnels.
import http from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { attachCommand, layout, orca, orcaTerminal, restoreProject, worktreeOf } from "./orca.mjs";
import { devServers, ensureForward, syncForwards } from "./ports.mjs";

const PORT = Number(process.env.CHROME_HELPER_PORT ?? 7421);
// The hub's origins and the hosts to forward from come from the Orca layout (`origins`, and the
// projects' hosts); HUB_ORIGINS and FORWARD_HOSTS (comma-separated) override them.
const ORIGINS = process.env.HUB_ORIGINS ? process.env.HUB_ORIGINS.split(",") : layout().origins;
const PROFILE_RE = /^(Default|Profile \d{1,3})$/;
const SSH_HOSTS = process.env.FORWARD_HOSTS ? process.env.FORWARD_HOSTS.split(",") : [...new Set(layout().projects.map((p) => p.host))]; // ssh aliases allowed to forward from
const run = promisify(execFile);

// Dev servers on the agent hosts, forwarded here as they appear (see ports.mjs).
const DEV_HOSTS = [...new Set(layout().projects.map((p) => p.host))];
let scanning = false; // a scan with new forwards can outlast the interval
const scan = () => {
  if (scanning) return;
  scanning = true;
  syncForwards(DEV_HOSTS).catch((err) => console.error(`ports: ${err.message}`)).finally(() => (scanning = false));
};
scan();
setInterval(scan, 15_000);


http
  .createServer(async (req, res) => {
    const origin = req.headers.origin ?? "";
    if (!ORIGINS.includes(origin)) {
      res.writeHead(403).end();
      return;
    }
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
      // Chrome's Private Network Access preflight for tailnet page -> localhost.
      "access-control-allow-private-network": "true",
      vary: "origin",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    // Dev servers found on the agent hosts and whether localhost:<port> reaches them here.
    if (req.method === "GET" && url.pathname === "/ports") {
      res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(devServers()));
      return;
    }
    // A URL in a browser tab of the project's Orca (the embedded hub's links open there).
    if (req.method === "POST" && url.pathname === "/browse") {
      const target = url.searchParams.get("url") ?? "";
      if (!/^https?:\/\//.test(target)) {
        res.writeHead(400, cors).end("bad url");
        return;
      }
      try {
        await forwardLocal(target, url.searchParams.get("host") ?? "");
        await orca("tab", "create", "--url", target, "--worktree", worktreeOf(url.searchParams.get("project") ?? ""));
        res.writeHead(204, cors).end();
      } catch (err) {
        res.writeHead(502, cors).end(err.message);
      }
      return;
    }
    // A plain shell on an agent host (the ssh alias may jump through another host, per ~/.ssh/config):
    // a tab in Orca under the project, or a Terminal.app window if Orca is not running.
    if (req.method === "POST" && url.pathname === "/console") {
      const host = url.searchParams.get("host") ?? "";
      const project = url.searchParams.get("project") ?? "";
      if (!SSH_HOSTS.includes(host)) {
        res.writeHead(400, cors).end("unknown host");
        return;
      }
      try {
        await orcaTerminal(project, `consola ${host}`, `ssh ${host}`);
      } catch {
        const script = `tell application "Terminal"\n  activate\n  do script "ssh ${host}"\nend tell`;
        await run("osascript", ["-e", script]).catch(() => {});
      }
      res.writeHead(204, cors).end();
      return;
    }
    // The agent's own terminal in Orca: brings its tab forward, or opens one attached to tmux.
    if (req.method === "POST" && url.pathname === "/terminal") {
      const project = url.searchParams.get("project") ?? "";
      const host = url.searchParams.get("host") ?? "";
      const win = url.searchParams.get("win") ?? "";
      if (!SSH_HOSTS.includes(host) || !/^[\w.-]+:[\w.-]+$/.test(win)) {
        res.writeHead(400, cors).end("bad host or window");
        return;
      }
      try {
        const title = win.split(":")[1];
        await orcaTerminal(project, title, attachCommand(host, win), { agent: { host, win } });
        res.writeHead(204, cors).end();
      } catch (err) {
        res.writeHead(502, cors).end(err.message);
      }
      return;
    }
    // Rebuilds a project's Orca layout (hub tab + every agent terminal) from the Orca layout.
    if (req.method === "POST" && url.pathname === "/orca/restore") {
      const p = layout().projects.find((x) => x.id === url.searchParams.get("project"));
      if (!p) {
        res.writeHead(400, cors).end("unknown project");
        return;
      }
      try {
        await restoreProject(p);
        res.writeHead(204, cors).end();
      } catch (err) {
        res.writeHead(502, cors).end(err.message);
      }
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/open") {
      res.writeHead(404, cors).end();
      return;
    }
    const profile = url.searchParams.get("profile") ?? "";
    const target = url.searchParams.get("url") ?? "";
    const host = url.searchParams.get("host") ?? "";
    if (!PROFILE_RE.test(profile) || !/^https?:\/\//.test(target)) {
      res.writeHead(400, cors).end("bad profile or url");
      return;
    }
    try {
      await forwardLocal(target, host);
    } catch (err) {
      res.writeHead(502, cors).end(err.message);
      return;
    }
    execFile("open", ["-na", "Google Chrome", "--args", `--profile-directory=${profile}`, target], (err) => {
      res.writeHead(err ? 500 : 204, cors).end();
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`overhaul-helper on 127.0.0.1:${PORT}`));

// localhost:PORT of a remote project: forward that port from the project's host first.
async function forwardLocal(target, host) {
  const u = new URL(target);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || !SSH_HOSTS.includes(host)) return;
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (port >= 1024 && port <= 65535) await ensureForward(port, host);
}
