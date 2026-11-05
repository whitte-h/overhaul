// PRs that mention the ticket: its key in the title, or among the keys the bridge
// extracted from title and body. Whole word only, so ABC-17 does not match ABC-177.
export function matchPrs(prs, key) {
  const k = key.toUpperCase();
  const re = new RegExp(`(^|[^A-Za-z0-9-])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i");
  return prs
    .filter((pr) => re.test(pr.title) || (pr.keys ?? []).includes(k))
    .map(({ number, title, url, state, isDraft, repo }) => ({ number, title, url, state, isDraft, repo }));
}
