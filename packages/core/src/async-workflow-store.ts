/**
 * Async Drizzle workflow-definition reads (PostgreSQL backend).
 *
 * FNXC:WorkflowDefinitions 2026-06-27-06:00:
 * The custom workflow-definition read path (readAllWorkflowDefinitionsImpl /
 * getWorkflowDefinitionImpl) was the only remaining sync `store.db` SELECT on
 * the workflows surface — every caller already awaits listWorkflowDefinitions /
 * getWorkflowDefinition, so wiring these two reads to the AsyncDataLayer makes
 * /api/workflows work in PG backend mode with no consumer changes. Builtin
 * workflows still come from code constants (BUILTIN_WORKFLOWS) and are merged by
 * the callers; these helpers return only the custom rows from project.workflows.
 *
 * `ir`/`layout` are jsonb in PostgreSQL (Drizzle returns parsed objects) but the
 * shared `toWorkflowDefinition` mapper expects JSON strings (it parseWorkflowIr's
 * them), so we re-stringify here to keep the mapper backend-agnostic.
 */
import { asc, eq } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";

/** SQLite-shaped workflow row (ir/layout as JSON strings) consumed by toWorkflowDefinition. */
export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  ir: string;
  layout: string;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToWorkflowRow(r: typeof schema.project.workflows.$inferSelect): WorkflowRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    ir: typeof r.ir === "string" ? r.ir : JSON.stringify(r.ir ?? {}),
    layout: typeof r.layout === "string" ? r.layout : JSON.stringify(r.layout ?? {}),
    kind: r.kind ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** All custom workflow definitions ordered by createdAt ASC (mirrors the sync SELECT). */
export async function listWorkflowRows(layer: AsyncDataLayer): Promise<WorkflowRow[]> {
  const rows = await layer.db
    .select()
    .from(schema.project.workflows)
    .orderBy(asc(schema.project.workflows.createdAt));
  return rows.map(rowToWorkflowRow);
}

/** Single custom workflow definition by id, or undefined. */
export async function getWorkflowRow(layer: AsyncDataLayer, id: string): Promise<WorkflowRow | undefined> {
  const rows = await layer.db
    .select()
    .from(schema.project.workflows)
    .where(eq(schema.project.workflows.id, id))
    .limit(1);
  return rows[0] ? rowToWorkflowRow(rows[0]) : undefined;
}
