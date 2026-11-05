// Files you attach to a message (screenshots, PDFs, docs). The hub keeps the bytes; whoever
// delivers the message (the hub itself, a host bridge or `hub inbox`) first writes them on
// the agent's machine and adds their paths, since Claude reads images and PDFs by path.
// Dependency-free: copied to agent hosts with the CLI.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./env.mjs";

const DIR = path.join(CONFIG_DIR, "uploads");
const ID_RE = /^[0-9a-f-]{36}$/;

// Keeps letters, digits, dots, dashes and underscores; never a path.
export const safeName = (name) => String(name ?? "").normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(-120) || "archivo";

export const localPath = (a) => path.join(DIR, a.id, safeName(a.name));

// Writes each attachment once (fetchBytes(id) -> Buffer) and returns their local paths.
export async function materialize(attachments, fetchBytes) {
  const paths = [];
  for (const a of attachments ?? []) {
    if (!ID_RE.test(a.id)) continue;
    const file = localPath(a);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, await fetchBytes(a.id), { mode: 0o600 });
    }
    paths.push(file);
  }
  return paths;
}

export const withFiles = (text, paths) =>
  paths.length ? `${text}${text ? "\n" : ""}Adjuntos (léelos con Read):\n${paths.map((p) => `- ${p}`).join("\n")}` : text;
