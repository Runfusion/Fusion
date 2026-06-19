import type { Database } from "./db.js";

/**
 * FNXC:CommandCenterGithub 2026-06-18-00:00:
 * Command Center GitHub issue analytics must derive filed/fixed counts only from the project-scoped local task store. "Filed" means a task has `githubTracking.issue`; "fixed" means an imported GitHub source issue task is currently in the `done` column. Fixed trends use the exact persisted `sourceIssueClosedAt` when available, fall back to the `updatedAt` completion approximation only when it is absent, and never fabricate a close date.
 */

export interface GithubIssueAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

export interface GithubIssueDailyPoint {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** Fusion-created GitHub issues filed on this date. */
  filed: number;
  /** Imported GitHub issue tasks completed on this date. */
  fixed: number;
}

export interface GithubIssueRepoBreakdown {
  /** Repository key, usually `owner/repo`; `(unknown)` when historical data lacks it. */
  repo: string;
  filed: number;
  fixed: number;
}

export interface GithubIssueAnalytics {
  from: string | null;
  to: string | null;
  /** Fusion-created GitHub issues in range. Undated tracked issues are included because no date can be honestly inferred. */
  filed: number;
  /** Imported GitHub issue tasks currently in `done`, filtered by exact `sourceIssueClosedAt` when present with `updatedAt` fallback. */
  fixed: number;
  /** Filed minus fixed. */
  net: number;
  /** Filed/fixed counts grouped by UTC day, ascending. */
  daily: GithubIssueDailyPoint[];
  /** Filed/fixed counts grouped by repository, descending by total activity. */
  byRepo: GithubIssueRepoBreakdown[];
}

interface GithubTrackingRow {
  githubTracking: string | null;
}

interface FixedIssueRow {
  sourceIssueRepository: string | null;
  sourceIssueClosedAt: string | null;
  updatedAt: string | null;
}

interface TrackedIssueLike {
  number?: unknown;
  owner?: unknown;
  repo?: unknown;
  createdAt?: unknown;
}

interface GithubTrackingLike {
  issue?: TrackedIssueLike;
}

function isInRange(iso: string, query: GithubIssueAnalyticsQuery): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  if (query.from !== undefined && t < Date.parse(query.from)) return false;
  if (query.to !== undefined && t > Date.parse(query.to)) return false;
  return true;
}

function dayKey(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function repoFromIssue(issue: TrackedIssueLike): string {
  const owner = typeof issue.owner === "string" ? issue.owner.trim() : "";
  const repo = typeof issue.repo === "string" ? issue.repo.trim() : "";
  if (owner && repo) return `${owner}/${repo}`;
  if (repo) return repo;
  return "(unknown)";
}

function addDaily(
  daily: Map<string, { filed: number; fixed: number }>,
  date: string,
  kind: "filed" | "fixed",
): void {
  const current = daily.get(date) ?? { filed: 0, fixed: 0 };
  current[kind] += 1;
  daily.set(date, current);
}

function addRepo(
  byRepo: Map<string, { filed: number; fixed: number }>,
  repo: string,
  kind: "filed" | "fixed",
): void {
  const current = byRepo.get(repo) ?? { filed: 0, fixed: 0 };
  current[kind] += 1;
  byRepo.set(repo, current);
}

/**
 * Aggregate locally persisted GitHub issue analytics for the Command Center.
 * Empty ranges return zeroed structures, never null collections. Bounds are
 * inclusive. Malformed historical `githubTracking` JSON is ignored rather than
 * failing the entire analytics request.
 */
export function aggregateGithubIssueAnalytics(
  db: Database,
  query: GithubIssueAnalyticsQuery = {},
): GithubIssueAnalytics {
  const daily = new Map<string, { filed: number; fixed: number }>();
  const byRepo = new Map<string, { filed: number; fixed: number }>();

  const filedRows = db
    .prepare(
      "SELECT githubTracking FROM tasks WHERE githubTracking IS NOT NULL AND githubTracking NOT IN ('', '{}')",
    )
    .all() as GithubTrackingRow[];

  let filed = 0;
  for (const row of filedRows) {
    if (!row.githubTracking) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.githubTracking);
    } catch {
      continue;
    }
    const tracking = parsed as GithubTrackingLike;
    const issue = tracking.issue;
    if (!issue || typeof issue.number !== "number" || !Number.isFinite(issue.number)) continue;

    const createdAt = typeof issue.createdAt === "string" ? issue.createdAt : undefined;
    const hasUsableDate = createdAt !== undefined && dayKey(createdAt) !== null;
    if (hasUsableDate && !isInRange(createdAt, query)) continue;

    filed += 1;
    const repo = repoFromIssue(issue);
    addRepo(byRepo, repo, "filed");
    if (hasUsableDate && createdAt !== undefined) {
      const day = dayKey(createdAt);
      if (day !== null) addDaily(daily, day, "filed");
    }
  }

  const fixedRows = db
    .prepare(
      `SELECT sourceIssueRepository, sourceIssueClosedAt, updatedAt FROM tasks WHERE sourceIssueProvider = 'github' AND "column" = 'done'`,
    )
    .all() as FixedIssueRow[];

  let fixed = 0;
  for (const row of fixedRows) {
    const fixedDate = row.sourceIssueClosedAt ?? row.updatedAt;
    if (fixedDate === null || !isInRange(fixedDate, query)) continue;

    fixed += 1;
    const repo = row.sourceIssueRepository?.trim() || "(unknown)";
    addRepo(byRepo, repo, "fixed");
    const day = dayKey(fixedDate);
    if (day !== null) addDaily(daily, day, "fixed");
  }

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    filed,
    fixed,
    net: filed - fixed,
    daily: [...daily.entries()]
      .map(([date, counts]) => ({ date, filed: counts.filed, fixed: counts.fixed }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byRepo: [...byRepo.entries()]
      .map(([repo, counts]) => ({ repo, filed: counts.filed, fixed: counts.fixed }))
      .sort((a, b) => {
        const total = b.filed + b.fixed - (a.filed + a.fixed);
        return total !== 0 ? total : a.repo.localeCompare(b.repo);
      }),
  };
}
