// Shared by the contract tests: run OVERHAUL_BIN (default node bin/overhaul.mjs) black box.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT = JSON.parse(fs.readFileSync(path.join(root, "contract/contract.json"), "utf8"));
export const BIN = process.env.OVERHAUL_BIN ? [path.resolve(process.env.OVERHAUL_BIN)] : [process.execPath, path.join(root, "bin/overhaul.mjs")];
export const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

export const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
export const AGENT_TOKEN = "an-agent-token-of-24-chars-or-more";
export const PASSWORD = "a-long-ui-password";

// A clean environment: a temporary HOME, nothing of this machine's Overhaul.
export function cleanEnv(home, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TMUX_PANE: "", XDG_CONFIG_HOME: path.join(home, ".config") };
  return { ...env, ...extra };
}

export function overhaul(args, { env, input, timeout = 20_000 } = {}) {
  return spawnSync(BIN[0], [...BIN.slice(1), ...args], { env, input, encoding: "utf8", timeout });
}

export const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// `overhaul serve` on a temporary home; resolves once it answers HTTP.
export async function serve(env) {
  const child = spawn(BIN[0], [...BIN.slice(1), "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 15_000;
  while (!/on http:\/\//.test(out)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      throw new Error(`overhaul serve did not start:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { log: () => out, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.on("exit", r); child.kill(); }) };
}

// A home with config.yaml and env (no password prompt), written where the contract says.
export function hubHome(port, extraConfig = "") {
  const home = tmp("overhaul-contract-");
  const oh = path.join(home, ".overhaul");
  fs.mkdirSync(oh, { mode: 0o700 });
  fs.writeFileSync(path.join(oh, "config.yaml"), `version: 2\nport: ${port}\nbind: [127.0.0.1]\nprojects:\n  alpha: {}\n${extraConfig}`);
  fs.writeFileSync(path.join(oh, "env"), `HUB_TOKEN=${PASSWORD}\nHUB_AGENT_TOKEN=${AGENT_TOKEN}\n`, { mode: 0o600 });
  return { home, oh };
}

