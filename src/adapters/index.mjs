// Each adapter returns the caller's open tickets as
// { key, title, status, url, group? } so the hub never depends on a tracker's shape.
import { jiraDetails, listJira } from "./jira.mjs";
import { listKaneo } from "./kaneo.mjs";
import { listKanbanMd } from "./kanban-md.mjs";
import { ENV_FILE } from "../env.mjs";

const ADAPTERS = { jira: listJira, kaneo: listKaneo, "kanban-md": listKanbanMd };

export async function listTickets(tracker) {
  const list = ADAPTERS[tracker?.type];
  if (!list) throw new Error(`Unknown tracker type: ${tracker?.type}`);
  return list(tracker);
}

// Description and comments of one ticket, for trackers that offer them (Jira Cloud for now: its
// documents are ADF; Server's are wiki text).
const DETAILS = { jira: jiraDetails };
export const hasDetails = (tracker) => !!DETAILS[tracker?.type] && (tracker.type !== "jira" || !!tracker.emailEnv);
export async function ticketDetails(tracker, key) {
  return DETAILS[tracker.type](tracker, key);
}

export function secret(tracker, field) {
  const name = tracker[field];
  const value = name && process.env[name];
  if (!value) throw new Error(`Set ${name ?? field} in ${ENV_FILE}`);
  return value;
}

export async function getJson(url, headers) {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.json();
}
