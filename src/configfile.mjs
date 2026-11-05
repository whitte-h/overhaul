// Edits config.yaml in place with the yaml Document API so your comments survive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_DIR } from "./env.mjs";

export const CONFIG_YAML = path.join(CONFIG_DIR, "config.yaml");

export function editConfig(mutate, file = CONFIG_YAML) {
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  mutate(doc);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Map a repo for a tracker group and list it for the daily's commits.
export function addRepoMapping(doc, projectId, group, repoPath) {
  const shown = tilde(repoPath);
  // `auto_work: false` shorthand has to become a map before it can hold the mapping.
  const aw = doc.getIn(["projects", projectId, "auto_work"], true);
  if (aw !== undefined && !YAML.isMap(aw)) doc.setIn(["projects", projectId, "auto_work"], doc.createNode({ enabled: Boolean(YAML.isScalar(aw) ? aw.value : aw) }));
  doc.setIn(["projects", projectId, "auto_work", "repos_by_group", group], shown);
  const repos = doc.getIn(["projects", projectId, "repos"]);
  const list = repos ? repos.toJSON() : [];
  if (!list.map((r) => String(r?.path ?? r)).includes(shown)) doc.setIn(["projects", projectId, "repos"], doc.createNode([...list, shown], { flow: true }));
}

export const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? `~/${p.slice(os.homedir().length + 1)}` : p);
