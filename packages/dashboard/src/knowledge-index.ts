/**
 * Persistent knowledge index (U14).
 *
 * A persistent, incrementally-refreshed knowledge layer that downstream agents
 * can query. Each "page" captures the durable, queryable summary of one source
 * (currently one page per completed task; PR-history pages share the same row
 * shape). Pages are stored in the project-owned `knowledge_pages` table; the
 * runtime uses the project-scoped PostgreSQL persistence API.
 *
 * ## Delta over `insights` / `memoryView`
 *
 * This is intentionally NOT a second copy of the existing surfaces:
 *
 * - `InsightStore` / `insights-routes.ts` / `InsightsView` store **LLM-extracted
 *   durable project learnings** ("patterns/principles/pitfalls" mined from
 *   working memory by an agent run). `memoryView` renders the freeform working/
 *   insights **markdown memory files**. Both are *interpretation* layers and both
 *   require a model run to populate.
 * - The knowledge index is a **deterministic, model-free, keyword-searchable
 *   index of concrete task/PR history** (title, description, modified files,
 *   commits, PR links). It is refreshed **incrementally on task completion** —
 *   one upsert per affected page, never a full re-index — and exposes a plain
 *   keyword **query API** an agent can call to recall "what work touched X".
 *
 * So the genuinely new capability is: (1) a persistent per-task/PR page store,
 * (2) an incremental refresh hook on task completion, and (3) a keyword query
 * API — none of which the insights/memory surfaces provide.
 *
 * ## Search
 *
 * Matching is portable keyword `LIKE` over a denormalized lowercased
 * `searchText` column (AND-of-terms), deliberately avoiding backend-specific
 * full-text extensions and external embedding APIs.
 *
 * ## Security
 *
 * The query API is registered as an {@link ApiRouteRegistrar} (see
 * `routes/register-knowledge-routes.ts`) so it inherits the dashboard's standard
 * session/auth middleware AND resolves the database through `getScopedStore(req)`
 * before reading — exactly like U9. The index holds sensitive repo/commit/PR
 * content, so it is an information-disclosure surface, never an open endpoint.
 */

import {
  countKnowledgePagesInPostgres,
  queryKnowledgePagesInPostgres,
  upsertKnowledgePageInPostgres,
  type AsyncDataLayer,
  type TaskStore,
} from "@fusion/core";

/** The kind of source a knowledge page was indexed from. */
export type KnowledgeSourceKind = "task" | "pr";

/** A knowledge page row as stored/read from `knowledge_pages`. */
export interface KnowledgePage {
  id: number;
  sourceKind: KnowledgeSourceKind;
  sourceId: string;
  /** Stable dedupe key (`<sourceKind>:<sourceId>`); upserts target this. */
  sourceKey: string;
  title: string;
  summary: string | null;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Input for {@link upsertKnowledgePageAsync}. */
export interface KnowledgePageInput {
  sourceKind: KnowledgeSourceKind;
  sourceId: string;
  title: string;
  summary?: string | null;
  content: string;
  tags?: string[];
  /** Injectable clock for deterministic tests. Defaults to now. */
  now?: string;
}

/** Maximum number of pages a single keyword query returns. */
export const KNOWLEDGE_QUERY_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_QUERY_MAX_LIMIT = 100;

/**
 * Build the denormalized, lowercased search blob a page is matched against.
 * Pure so it can be unit-tested independently of the DB.
 */
export function buildSearchText(input: {
  title: string;
  summary?: string | null;
  content: string;
  tags?: string[];
}): string {
  return [
    input.title,
    input.summary ?? "",
    input.content,
    (input.tags ?? []).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Tokenize a free-text query into lowercased keyword terms. Empty / whitespace
 * input yields no terms (callers treat that as "match nothing", not "match all",
 * to avoid returning the whole sensitive index for a blank query).
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** PostgreSQL implementation of the incremental knowledge-page upsert. */
export async function upsertKnowledgePageAsync(
  layer: AsyncDataLayer,
  input: KnowledgePageInput,
): Promise<{ page: KnowledgePage; created: boolean }> {
  return upsertKnowledgePageInPostgres(layer, input, buildSearchText(input));
}

/** Options for {@link queryKnowledgePagesAsync}. */
export interface KnowledgeQueryOptions {
  query: string;
  sourceKind?: KnowledgeSourceKind;
  limit?: number;
}

/**
 * Keyword search the index. Returns pages whose `searchText` contains **all**
 * query terms (AND), most-recently-updated first. A blank/termless query returns
 * an empty list rather than the whole index.
 */
/** Project-scoped PostgreSQL keyword search with the same AND-of-terms semantics. */
export async function queryKnowledgePagesAsync(
  layer: AsyncDataLayer,
  options: KnowledgeQueryOptions,
): Promise<KnowledgePage[]> {
  const terms = tokenizeQuery(options.query);
  if (terms.length === 0) return [];
  const limit = Math.min(
    Math.max(1, options.limit ?? KNOWLEDGE_QUERY_DEFAULT_LIMIT),
    KNOWLEDGE_QUERY_MAX_LIMIT,
  );
  return queryKnowledgePagesInPostgres(layer, {
    terms: terms.map(escapeLike),
    sourceKind: options.sourceKind,
    limit,
  });
}

/** Escape SQL `LIKE` wildcards in a term so user input cannot inject them. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Total number of knowledge pages in the bound PostgreSQL project. */
export async function countKnowledgePagesAsync(layer: AsyncDataLayer): Promise<number> {
  return countKnowledgePagesInPostgres(layer);
}

/**
 * Render a completed task into a deterministic knowledge page body. Pure so the
 * refresh hook is testable without a real store. Concatenates the durable,
 * non-sensitive facts: title, description, modified files, associated commit
 * subjects, and PR link if present.
 */
export function renderTaskPage(task: {
  id: string;
  title?: string;
  description?: string;
  modifiedFiles?: string[];
  commitSubjects?: string[];
  prUrl?: string | null;
  column?: string;
}): KnowledgePageInput {
  const title = (task.title ?? "").trim() || `Task ${task.id}`;
  const lines: string[] = [];
  if (task.description?.trim()) {
    lines.push(task.description.trim());
  }
  if (task.modifiedFiles && task.modifiedFiles.length > 0) {
    lines.push(`Files: ${task.modifiedFiles.join(", ")}`);
  }
  if (task.commitSubjects && task.commitSubjects.length > 0) {
    lines.push(`Commits:\n${task.commitSubjects.map((s) => `- ${s}`).join("\n")}`);
  }
  if (task.prUrl) {
    lines.push(`PR: ${task.prUrl}`);
  }
  const tags = (task.modifiedFiles ?? [])
    .map((f) => f.split("/").pop() ?? f)
    .filter((t) => t.length > 0);
  return {
    sourceKind: "task",
    sourceId: task.id,
    title,
    summary: task.description?.trim().slice(0, 280) || null,
    content: lines.join("\n\n") || title,
    tags,
  };
}

/**
 * Incremental refresh hook: index (or re-index) a single task as a knowledge
 * page. Intended to be invoked from the task-completion path (or by code that
 * observes a task reaching `done`). It reads only the one task and upserts only
 * its page, so unaffected pages are never touched.
 *
 * **Fail-soft:** any read/write error is logged and swallowed so a knowledge
 * refresh can never break the task-completion flow that called it.
 *
 * @returns the upserted page, or `null` if the task could not be loaded/indexed.
 */
export async function refreshKnowledgeForTask(
  store: TaskStore,
  taskId: string,
  options?: { now?: string },
): Promise<KnowledgePage | null> {
  try {
    const detail = await store.getTask(taskId);
    if (!detail) return null;

    let commitSubjects: string[] = [];
    try {
      const lineageId = (detail as { lineageId?: string }).lineageId ?? detail.id;
      const rows = await store.getTaskCommitAssociationsByLineageId(lineageId);
      commitSubjects = [...rows]
        .sort((a, b) => a.authoredAt.localeCompare(b.authoredAt))
        .map((row) => row.commitSubject);
    } catch {
      commitSubjects = [];
    }

    const prUrl = extractPrUrl(detail);
    const input = renderTaskPage({
      id: detail.id,
      title: detail.title,
      description: detail.description,
      modifiedFiles: (detail as { modifiedFiles?: string[] }).modifiedFiles,
      commitSubjects,
      prUrl,
      column: detail.column,
    });
    if (options?.now) input.now = options.now;

    /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Completed-task knowledge is PostgreSQL-only; missing layer wiring fails this best-effort refresh instead of writing a hidden SQLite index. */
    const layer = store.getAsyncLayer();
    if (!layer) throw new Error("Knowledge refresh requires the project PostgreSQL AsyncDataLayer");
    return (await upsertKnowledgePageAsync(layer, input)).page;
  } catch (err) {
    console.warn(`[knowledge-index] refresh skipped for task ${taskId}:`, err);
    return null;
  }
}

/** Best-effort extraction of a PR URL from a task detail, tolerant of shape. */
function extractPrUrl(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.prUrl === "string" && d.prUrl) return d.prUrl;
  const pr = d.pullRequest as Record<string, unknown> | undefined;
  if (pr && typeof pr.url === "string" && pr.url) return pr.url;
  if (pr && typeof pr.htmlUrl === "string" && pr.htmlUrl) return pr.htmlUrl;
  return null;
}
