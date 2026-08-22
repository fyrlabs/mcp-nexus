export const BUILT_IN_ALIASES: Record<string, string> = {
  pr: "pull request",
  prs: "pull requests",
  mr: "merge request",
  mrs: "merge requests",
  ticket: "issue",
  tickets: "issues",
  repo: "repository",
  repos: "repositories",
  msg: "message",
  msgs: "messages",
  db: "database",
  cfg: "configuration",
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "my",
  "me",
  "is",
  "are",
  "be",
  "it",
  "this",
  "that",
]);

export function contentTokens(text: string): string[] {
  return tokenize(text).filter((token) => !STOPWORDS.has(token));
}

export function expandAliases(query: string, extraAliases: Record<string, string> = {}): string {
  const aliases = { ...BUILT_IN_ALIASES, ...normalizeAliasKeys(extraAliases) };
  let expanded = query;
  for (const [from, to] of Object.entries(aliases)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(from.toLowerCase())}([^a-z0-9]|$)`, "gi");
    expanded = expanded.replace(pattern, (_match, before: string, after: string) => `${before}${to}${after}`);
  }
  return expanded;
}

function normalizeAliasKeys(aliases: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliases)) {
    if (typeof value === "string" && key.length > 0) {
      output[key.toLowerCase()] = value;
    }
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}
