import { getJson, secret } from "./index.mjs";

const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

// Jira Cloud: email + API token (Basic), API v3. Jira Server/Data Center (no email_env): a personal
// access token (Bearer), API v2.
const authHeader = (t) => (t.emailEnv ? `Basic ${Buffer.from(`${secret(t, "emailEnv")}:${secret(t, "tokenEnv")}`).toString("base64")}` : `Bearer ${secret(t, "tokenEnv")}`);

export async function listJira(t) {
  const base = t.baseUrl.replace(/\/$/, "");
  const auth = authHeader(t);
  const url = new URL(t.emailEnv ? `${base}/rest/api/3/search/jql` : `${base}/rest/api/2/search`);
  url.searchParams.set("jql", t.jql ?? DEFAULT_JQL);
  url.searchParams.set("fields", "summary,status");
  url.searchParams.set("maxResults", "50");
  const data = await getJson(url, { authorization: auth });
  return (data.issues ?? []).map((i) => ({
    key: i.key,
    title: i.fields?.summary ?? "",
    status: i.fields?.status?.name ?? "",
    group: i.key.split("-")[0],
    url: `${base}/browse/${i.key}`,
  }));
}

// Description and comments in Atlassian Document Format (JSON, not HTML): the page renders
// them node by node, so nothing from Jira is ever inserted as markup.
export async function jiraDetails(t, key) {
  const base = t.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/rest/api/3/issue/${encodeURIComponent(key)}`);
  url.searchParams.set("fields", "description,comment,issuetype,priority,reporter,assignee,created,updated");
  const { fields: f = {} } = await getJson(url, { authorization: authHeader(t) });
  return {
    description: f.description ?? null,
    type: f.issuetype?.name ?? "",
    priority: f.priority?.name ?? "",
    reporter: f.reporter?.displayName ?? "",
    assignee: f.assignee?.displayName ?? "",
    created: f.created ?? null,
    updated: f.updated ?? null,
    comments: (f.comment?.comments ?? []).map((c) => ({ author: c.author?.displayName ?? "", created: c.created, body: c.body })),
  };
}
