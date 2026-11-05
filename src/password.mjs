// `overhaul set-password`: the page's password, in env under the variable config.yaml names
// (auth.password_env, default HUB_TOKEN). Read twice without echo; only that line is rewritten.
import fs from "node:fs";
import YAML from "yaml";
import { resolvePaths } from "./paths.mjs";

export function passwordVar({ env = process.env, userHome } = {}) {
  try {
    const raw = YAML.parse(fs.readFileSync(resolvePaths(env, userHome).config, "utf8")) ?? {};
    return String(raw.auth?.password_env ?? "HUB_TOKEN");
  } catch {
    return "HUB_TOKEN";
  }
}

export function hasPassword({ env = process.env, userHome } = {}) {
  const P = resolvePaths(env, userHome);
  const name = passwordVar({ env, userHome });
  try {
    return new RegExp(`^${name}=.{12,}$`, "m").test(fs.readFileSync(P.env, "utf8"));
  } catch {
    return false;
  }
}

export function validPassword(p) {
  if (p.length < 12) return `Muy corta (${p.length}); mínimo 12.`;
  if (/[\r\n]/.test(p) || p !== p.trim()) return "Sin saltos de línea ni espacios al inicio o final.";
  return null;
}

export function writePassword(file, name, value) {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  let text = fs.readFileSync(file, "utf8");
  text = re.test(text) ? text.replace(re, () => line) : `${line}\n${text}`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// One line from the terminal without echo, or from stdin when it is not a terminal (tests, pipes).
let piped = null;
export async function readSecret(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY) {
    if (!piped) {
      const chunks = [];
      for await (const c of input) chunks.push(c);
      piped = Buffer.concat(chunks).toString("utf8").split("\n");
    }
    output.write(`${prompt}\n`);
    return piped.shift() ?? "";
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (buf) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(null);
        if (ch === "\u0003") return done(new Error("cancelado"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = (err) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    input.on("data", onData);
  });
}
