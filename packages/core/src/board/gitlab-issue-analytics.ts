import { sql } from "drizzle-orm";
import type { Database } from "../db/db.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";

/**
 * FNXC:CommandCenterGitLab 2026-07-02-00:00:
 * GitLab analytics must be provider-isolated while sharing the generic sourceIssue storage columns with GitHub. Filed counts read only `gitlabTracking.item`; fixed counts read only `sourceIssueProvider = "gitlab"`, using exact `sourceIssueClosedAt` when present and `updatedAt` only as an approximation fallback.
 */
export interface GitlabIssueAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

export interface GitlabIssueDailyPoint {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** Fusion-created GitLab items filed on this date. */
  filed: number;
  /** Imported GitLab issue/MR tasks completed on this date. */
  fixed: number;
}

export interface GitlabIssueProjectBreakdown {
  /** GitLab project/group key; `(unknown)` when historical data lacks it. */
  project: string;
  filed: number;
  fixed: number;
}

export interface GitlabResolvedIssue {
  /** Fusion task that resolved the imported GitLab source item. */
  taskId: string;
  /** Fusion task title at aggregation time. */
  taskTitle: string;
  /** GitLab project/group key; `(unknown)` when historical data lacks it. */
  project: string;
  /** GitLab issue or merge request IID when stored. */
  issueNumber: number | null;
  /** Source GitLab item URL when available. */
  url: string | null;
  /** ISO timestamp used for range filtering and ordering. */
  resolvedAt: string;
  /** True when `sourceIssueClosedAt` supplied `resolvedAt`; false when `updatedAt` was used. */
  resolvedAtExact: boolean;
}

export interface GitlabIssueAnalytics {
  from: string | null;
  to: string | null;
  /** Fusion-created GitLab tracked items in range. Undated tracked items are included because no date can be honestly inferred. */
  filed: number;
  /** Imported GitLab source tasks currently in `done`, filtered by exact `sourceIssueClosedAt` when present with `updatedAt` fallback. */
  fixed: number;
  /** Filed minus fixed. */
  net: number;
  /** Filed/fixed counts grouped by UTC day, ascending. */
  daily: GitlabIssueDailyPoint[];
  /** Filed/fixed counts grouped by GitLab project/group, descending by total activity. */
  byProject: GitlabIssueProjectBreakdown[];
  /** Imported GitLab source items completed in range, most-recently resolved first. */
  resolved: GitlabResolvedIssue[];
}

interface GitlabTrackingRow {
  gitlabTracking: string | null;
}

interface FixedIssueRow {
  id: string;
  title: string | null;
  sourceIssueRepository: string | null;
  sourceIssueNumber: number | null;
  sourceIssueUrl: string | null;
  sourceIssueClosedAt: string | null;
  updatedAt: string | null;
}

interface GitlabTrackedItemLike {
  iid?: unknown;
  projectPath?: unknown;
  groupPath?: unknown;
  projectId?: unknown;
  createdAt?: unknown;
}

interface GitlabTrackingLike {
  item?: GitlabTrackedItemLike;
}

function isInRange(iso: string, query: GitlabIssueAnalyticsQuery): boolean {
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

function projectFromItem(item: GitlabTrackedItemLike): string {
  const projectPath = typeof item.projectPath === "string" ? item.projectPath.trim() : "";
  if (projectPath) return projectPath;
  const groupPath = typeof item.groupPath === "string" ? item.groupPath.trim() : "";
  if (groupPath) return groupPath;
  if (typeof item.projectId === "number" && Number.isFinite(item.projectId)) return String(item.projectId);
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

function addProject(
  byProject: Map<string, { filed: number; fixed: number }>,
  project: string,
  kind: "filed" | "fixed",
): void {
  const current = byProject.get(project) ?? { filed: 0, fixed: 0 };
  current[kind] += 1;
  byProject.set(project, current);
}

/**
 * Aggregate locally persisted GitLab issue and merge-request analytics for the Command Center.
 * Empty ranges return zeroed structures, never null collections. Bounds are
 * inclusive. Malformed historical `gitlabTracking` JSON is ignored rather than
 * failing the entire analytics request.
 *
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Now accepts a `Database | AsyncDataLayer` and is async. In backend
 * (PostgreSQL) mode it branches on `"ping" in dbOrLayer` and reads the real
 * `project.tasks` rows (gitlab_tracking is jsonb — already parsed — and the
 * source_issue_* columns are snake_case); the sync SQLite branch is unchanged.
 * Mirrors aggregateGithubIssueAnalytics.
 */
export async function aggregateGitlabIssueAnalytics(
  dbOrLayer: Database | AsyncDataLayer,
  query: GitlabIssueAnalyticsQuery = {},
): Promise<GitlabIssueAnalytics> {
  if ("ping" in dbOrLayer) {
    return aggregateGitlabIssueAnalyticsAsync(dbOrLayer, query);
  }
  const db = dbOrLayer as Database;

  const filedRows = db
    .prepare(
      "SELECT gitlabTracking FROM tasks WHERE gitlabTracking IS NOT NULL AND gitlabTracking NOT IN ('', '{}')",
    )
    .all() as GitlabTrackingRow[];

  // Sync rows store gitlabTracking as a JSON string; parse (skip malformed).
  const filedTrackings: GitlabTrackingLike[] = [];
  for (const row of filedRows) {
    if (!row.gitlabTracking) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.gitlabTracking);
    } catch {
      continue;
    }
    filedTrackings.push(parsed as GitlabTrackingLike);
  }

  const fixedRows = db
    .prepare(
      `SELECT id, title, sourceIssueRepository, sourceIssueNumber, sourceIssueUrl, sourceIssueClosedAt, updatedAt FROM tasks WHERE sourceIssueProvider = 'gitlab' AND "column" = 'done'`,
    )
    .all() as FixedIssueRow[];

  return buildGitlabIssueAnalytics(filedTrackings, fixedRows, query);
}

/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * PostgreSQL fetch path for {@link aggregateGitlabIssueAnalytics}. gitlab_tracking
 * is jsonb (postgres-js returns it already parsed, so no JSON.parse), and the
 * `gitlab_tracking::text <> '{}'` predicate mirrors the sync `NOT IN ('', '{}')`
 * empty-object skip. Fixed-issue columns are aliased back to their camelCase
 * row shape; source_issue_number coerces to number|null.
 */
async function aggregateGitlabIssueAnalyticsAsync(
  layer: AsyncDataLayer,
  query: GitlabIssueAnalyticsQuery,
): Promise<GitlabIssueAnalytics> {
  const filedRaw = (await layer.db.execute(
    sql`SELECT gitlab_tracking AS "gitlabTracking" FROM project.tasks
        WHERE gitlab_tracking IS NOT NULL AND gitlab_tracking::text <> '{}'`,
  )) as Array<{ gitlabTracking: unknown }>;
  const filedTrackings: GitlabTrackingLike[] = [];
  for (const row of filedRaw) {
    if (row.gitlabTracking == null) continue;
    filedTrackings.push(row.gitlabTracking as GitlabTrackingLike);
  }

  const fixedRaw = (await layer.db.execute(
    sql`SELECT
          id,
          title,
          source_issue_repository AS "sourceIssueRepository",
          source_issue_number     AS "sourceIssueNumber",
          source_issue_url        AS "sourceIssueUrl",
          source_issue_closed_at  AS "sourceIssueClosedAt",
          updated_at              AS "updatedAt"
        FROM project.tasks
        WHERE source_issue_provider = 'gitlab' AND "column" = 'done'`,
  )) as Array<Record<string, unknown>>;
  const fixedRows: FixedIssueRow[] = fixedRaw.map((r) => ({
    id: String(r.id),
    title: (r.title as string | null) ?? null,
    sourceIssueRepository: (r.sourceIssueRepository as string | null) ?? null,
    sourceIssueNumber: r.sourceIssueNumber == null ? null : Number(r.sourceIssueNumber),
    sourceIssueUrl: (r.sourceIssueUrl as string | null) ?? null,
    sourceIssueClosedAt: (r.sourceIssueClosedAt as string | null) ?? null,
    updatedAt: (r.updatedAt as string | null) ?? null,
  }));

  return buildGitlabIssueAnalytics(filedTrackings, fixedRows, query);
}

/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Pure GitLab-issue aggregation shared by the sync (SQLite) and async
 * (PostgreSQL) fetch paths. Takes already-parsed `gitlabTracking` objects and
 * the fixed-issue rows so both backends produce identical filed/fixed/daily/
 * byProject/resolved shapes.
 */
function buildGitlabIssueAnalytics(
  filedTrackings: GitlabTrackingLike[],
  fixedRows: FixedIssueRow[],
  query: GitlabIssueAnalyticsQuery,
): GitlabIssueAnalytics {
  const daily = new Map<string, { filed: number; fixed: number }>();
  const byProject = new Map<string, { filed: number; fixed: number }>();

  let filed = 0;
  for (const tracking of filedTrackings) {
    const item = tracking.item;
    if (!item || typeof item.iid !== "number" || !Number.isFinite(item.iid)) continue;

    const createdAt = typeof item.createdAt === "string" ? item.createdAt : undefined;
    const hasUsableDate = createdAt !== undefined && dayKey(createdAt) !== null;
    if (hasUsableDate && !isInRange(createdAt, query)) continue;

    filed += 1;
    const project = projectFromItem(item);
    addProject(byProject, project, "filed");
    if (hasUsableDate && createdAt !== undefined) {
      const day = dayKey(createdAt);
      if (day !== null) addDaily(daily, day, "filed");
    }
  }

  let fixed = 0;
  const resolved: GitlabResolvedIssue[] = [];
  for (const row of fixedRows) {
    const hasExactResolvedAt = row.sourceIssueClosedAt !== null;
    const fixedDate = row.sourceIssueClosedAt ?? row.updatedAt;
    if (fixedDate === null || !isInRange(fixedDate, query)) continue;

    fixed += 1;
    const project = row.sourceIssueRepository?.trim() || "(unknown)";
    addProject(byProject, project, "fixed");
    const day = dayKey(fixedDate);
    if (day !== null) addDaily(daily, day, "fixed");
    resolved.push({
      taskId: row.id,
      taskTitle: row.title ?? "",
      project,
      issueNumber: typeof row.sourceIssueNumber === "number" ? row.sourceIssueNumber : null,
      url: row.sourceIssueUrl?.trim() || null,
      resolvedAt: fixedDate,
      resolvedAtExact: hasExactResolvedAt,
    });
  }

  resolved.sort((a, b) => {
    const byDate = Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt);
    return byDate !== 0 ? byDate : a.taskId.localeCompare(b.taskId);
  });

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    filed,
    fixed,
    net: filed - fixed,
    daily: [...daily.entries()]
      .map(([date, counts]) => ({ date, filed: counts.filed, fixed: counts.fixed }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byProject: [...byProject.entries()]
      .map(([project, counts]) => ({ project, filed: counts.filed, fixed: counts.fixed }))
      .sort((a, b) => {
        const total = b.filed + b.fixed - (a.filed + a.fixed);
        return total !== 0 ? total : a.project.localeCompare(b.project);
      }),
    resolved,
  };
}
