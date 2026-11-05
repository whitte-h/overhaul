import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "../config.mjs";

const DEFAULT_STATUSES = ["todo", "in-progress", "review"];

// Reads the board's task files directly; only the flat frontmatter keys are needed.
export async function listKanbanMd(t) {
  const dir = path.join(expandHome(t.dir), t.tasksDir ?? "tasks");
  const wanted = new Set(t.statuses ?? DEFAULT_STATUSES);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  const tickets = [];
  for (const file of files) {
    const meta = frontmatter(await fs.readFile(path.join(dir, file), "utf8"));
    if (!wanted.has(meta.status)) continue;
    tickets.push({
      key: `${t.prefix ?? "K"}-${meta.id}`,
      title: meta.title ?? file,
      status: meta.status,
      url: null,
    });
  }
  return tickets.sort((a, b) => Number(b.key.split("-")[1]) - Number(a.key.split("-")[1]));
}

export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  if (!m) return meta;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv && kv[2] !== "") meta[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return meta;
}
