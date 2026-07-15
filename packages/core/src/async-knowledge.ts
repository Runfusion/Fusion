/**
 * PostgreSQL persistence for the dashboard knowledge index.
 *
 * FNXC:KnowledgeIndex 2026-07-14-16:42:
 * Task and PR history must remain incrementally searchable after PostgreSQL cutover. Keep Drizzle and project-partition enforcement in core so dashboard does not acquire a database-driver dependency, and reject unbound layers because this index contains sensitive repository history.
 */
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import * as schema from "./postgres/schema/index.js";

export interface AsyncKnowledgePageInput {
  sourceKind: "task" | "pr";
  sourceId: string;
  title: string;
  summary?: string | null;
  content: string;
  tags?: string[];
  now?: string;
}

export interface AsyncKnowledgePage {
  id: number;
  sourceKind: "task" | "pr";
  sourceId: string;
  sourceKey: string;
  title: string;
  summary: string | null;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AsyncKnowledgeQueryOptions {
  terms: string[];
  sourceKind?: "task" | "pr";
  limit: number;
}

function projectIdFor(layer: AsyncDataLayer): string {
  const projectId = layer.projectId?.trim();
  if (!projectId) throw new Error("PostgreSQL knowledge index access requires asyncLayer.projectId");
  return projectId;
}

function toPage(row: typeof schema.project.knowledgePages.$inferSelect): AsyncKnowledgePage {
  return {
    id: row.id,
    sourceKind: row.sourceKind as "task" | "pr",
    sourceId: row.sourceId,
    sourceKey: row.sourceKey,
    title: row.title,
    summary: row.summary,
    content: row.content,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertKnowledgePageInPostgres(
  layer: AsyncDataLayer,
  input: AsyncKnowledgePageInput,
  searchText: string,
): Promise<{ page: AsyncKnowledgePage; created: boolean }> {
  const projectId = projectIdFor(layer);
  const now = input.now ?? new Date().toISOString();
  const sourceKey = `${input.sourceKind}:${input.sourceId}`;
  const values = {
    projectId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceKey,
    title: input.title,
    summary: input.summary ?? null,
    content: input.content,
    tags: input.tags ?? [],
    searchText,
    createdAt: now,
    updatedAt: now,
  };
  const result = await layer.transactionImmediate(async (tx) => {
    /*
    FNXC:KnowledgeIndex 2026-07-14-18:10:
    Creation reporting must be determined by the atomic insert result so concurrent first writers cannot both report that they created the same project-scoped page.
    */
    const [inserted] = await tx
      .insert(schema.project.knowledgePages)
      .values(values)
      .onConflictDoNothing({
        target: [schema.project.knowledgePages.projectId, schema.project.knowledgePages.sourceKey],
      })
      .returning();
    if (inserted) return { row: inserted, created: true };

    const [updated] = await tx
      .update(schema.project.knowledgePages)
      .set({
        title: input.title,
        summary: input.summary ?? null,
        content: input.content,
        tags: input.tags ?? [],
        searchText,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.knowledgePages.projectId, projectId),
        eq(schema.project.knowledgePages.sourceKey, sourceKey),
      ))
      .returning();
    return { row: updated, created: false };
  });
  if (!result.row) throw new Error(`knowledge page ${sourceKey} was not returned after upsert`);
  return { page: toPage(result.row), created: result.created };
}

export async function queryKnowledgePagesInPostgres(
  layer: AsyncDataLayer,
  options: AsyncKnowledgeQueryOptions,
): Promise<AsyncKnowledgePage[]> {
  const projectId = projectIdFor(layer);
  const predicates = [eq(schema.project.knowledgePages.projectId, projectId)];
  for (const term of options.terms) {
    /*
    FNXC:KnowledgeIndex 2026-07-14-21:55:
    Knowledge search preserves the case-insensitive substring behavior of the legacy index while treating user-provided percent, underscore, and backslash characters literally instead of as PostgreSQL wildcard syntax.
    */
    const escaped = term.replace(/[\\%_]/g, "\\$&");
    predicates.push(ilike(schema.project.knowledgePages.searchText, `%${escaped}%`));
  }
  if (options.sourceKind) predicates.push(eq(schema.project.knowledgePages.sourceKind, options.sourceKind));
  const rows = await layer.db
    .select()
    .from(schema.project.knowledgePages)
    .where(and(...predicates))
    .orderBy(desc(schema.project.knowledgePages.updatedAt), desc(schema.project.knowledgePages.id))
    .limit(options.limit);
  return rows.map(toPage);
}

export async function countKnowledgePagesInPostgres(layer: AsyncDataLayer): Promise<number> {
  const projectId = projectIdFor(layer);
  const [row] = await layer.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.knowledgePages)
    .where(eq(schema.project.knowledgePages.projectId, projectId));
  return row?.count ?? 0;
}
