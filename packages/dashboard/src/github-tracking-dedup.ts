import type { Task } from "@fusion/core";

const FILE_SCOPE_HEADER = /^##\s+File\s+Scope\s*$/im;
const FILE_SCOPE_BULLET = /^-\s+`?([^`\n]+?)`?\s*$/;
const BACKTICK_IDENTIFIER_RE = /`([A-Za-z0-9_./-]{3,})`/g;
const ERROR_NAME_RE = /\b([A-Z][A-Za-z0-9]*(?:Error|Exception))\b/g;
const SYMBOL_TOKEN_RE = /\b([A-Za-z_][A-Za-z0-9_]{5,}|[a-z]+(?:[A-Z][A-Za-z0-9]+){2,})\b/g;

const STOPWORDS = new Set([
  "fusion",
  "task",
  "tasks",
  "issue",
  "github",
  "tracking",
  "bug",
  "fix",
  "error",
  "failed",
  "failure",
  "create",
  "update",
  "description",
  "scope",
]);

export const DEDUP_MATCH_THRESHOLD = 3;

function stripTrailingGlob(path: string): string {
  return path.replace(/\/+$/, "").replace(/\/(\*\*?|[^/]*[?*][^/]*)$/, "");
}

function quoteIfNeeded(value: string): string {
  return /[/.\-]/.test(value) ? `"${value}"` : value;
}

function toSearchText(candidate: { title: string; body: string | null }): string {
  return `${candidate.title}\n${candidate.body ?? ""}`.toLowerCase();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractFileScopePaths(task: Pick<Task, "description"> & { prompt?: string }): string[] {
  const source = task.prompt ?? task.description ?? "";
  const headerMatch = source.match(FILE_SCOPE_HEADER);
  if (!headerMatch || headerMatch.index == null) {
    return [];
  }

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const afterStart = source.slice(sectionStart);
  const nextHeaderMatch = afterStart.match(/\n##\s+/);
  const section = nextHeaderMatch ? afterStart.slice(0, nextHeaderMatch.index) : afterStart;

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    const match = line.match(FILE_SCOPE_BULLET);
    if (!match) continue;
    const normalized = stripTrailingGlob(match[1].trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
    if (paths.length >= 8) break;
  }

  return paths;
}

export function extractSymptomKeywords(task: Pick<Task, "title" | "description">, opts?: { max?: number }): string[] {
  const max = Math.max(1, opts?.max ?? 6);
  const source = `${task.title ?? ""}\n${task.description ?? ""}`;
  const values: string[] = [];
  const seen = new Set<string>();

  for (const regex of [BACKTICK_IDENTIFIER_RE, ERROR_NAME_RE, SYMBOL_TOKEN_RE]) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) && values.length < max) {
      const token = match[1].trim();
      const normalized = token.toLowerCase();
      if (token.length < 6) continue;
      if (STOPWORDS.has(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(token);
    }
    if (values.length >= max) break;
  }

  return values;
}

export function buildIssueSearchQueries(paths: string[], keywords: string[]): string[] {
  const queries: string[] = [];
  const topKeywords = keywords.slice(0, 3);
  if (topKeywords.length > 0) {
    queries.push(topKeywords.map((keyword) => quoteIfNeeded(keyword)).join(" "));
  }

  for (const path of paths.slice(0, 2)) {
    queries.push(quoteIfNeeded(path));
  }

  return queries.slice(0, 3);
}

export function scoreCandidateIssue(
  candidate: { title: string; body: string | null },
  paths: string[],
  keywords: string[],
): { score: number; matchedPaths: string[]; matchedKeywords: string[] } {
  const text = toSearchText(candidate);
  const matchedPaths = paths.filter((path) => text.includes(path.toLowerCase()));
  const matchedKeywords = keywords.filter((keyword) => {
    const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i");
    return pattern.test(`${candidate.title}\n${candidate.body ?? ""}`);
  });

  return {
    score: (matchedPaths.length * 2) + matchedKeywords.length,
    matchedPaths,
    matchedKeywords,
  };
}
