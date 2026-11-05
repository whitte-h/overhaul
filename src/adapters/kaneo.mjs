import { getJson, secret } from "./index.mjs";

// GET /api/task/assigned returns the caller's open tasks across the workspace. Several hub
// projects can share one workspace: `projects` keeps only those Kaneo projects (slug or name),
// `exclude_projects` drops some.
export async function listKaneo(t) {
  const base = t.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/api/task/assigned`);
  url.searchParams.set("workspaceId", t.workspaceId);
  const data = await getJson(url, { authorization: `Bearer ${secret(t, "tokenEnv")}` });
  const ids = (task) => [task.projectSlug, task.projectName].filter(Boolean).map((s) => String(s).toLowerCase());
  const tasks = (data.tasks ?? []).filter((task) =>
    (!t.projects || ids(task).some((s) => t.projects.includes(s))) &&
    !(t.excludeProjects ?? []).some((s) => ids(task).includes(s)));
  return tasks.map((task) => {
    const key = task.number == null ? task.id : `${task.projectSlug.toUpperCase()}-${task.number}`;
    return {
      key,
      title: task.title,
      status: task.statusName ?? task.status,
      group: task.projectName,
      url: fill(t.taskUrl, { key, id: task.id, projectId: task.projectId, workspaceId: t.workspaceId }),
    };
  });
}

function fill(template, vars) {
  if (!template) return null;
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
}
