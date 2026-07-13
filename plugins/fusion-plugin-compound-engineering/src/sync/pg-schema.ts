/*
FNXC:PostgresCutover 2026-07-13:
Plugin-local Drizzle shapes for the CE pipeline tables (U7/U8). These used to
be imported from @fusion/core's postgresSchema.plugin.*, but FN-7936 aliases
bare `@fusion/core` imports in bundled plugin output to a tiny runtime shim —
which cannot carry the real schema objects — so the published bundled.js
failed to build ("No matching export ... for import 'postgresSchema'"). The
tables are plugin-OWNED (created by ensureCeSchema's raw DDL / the
plugin-schema-hook); defining their typed shapes here keeps the bundle
self-contained. Must stay column-identical to ensureCeSchema
(../schema.ts) and core's mirror in postgres/schema/plugin.ts.
*/
import { text, index, uniqueIndex } from "drizzle-orm/pg-core";
import { pgSchema } from "drizzle-orm/pg-core";

// Same fixed schema name core uses (postgres/schema/_shared.ts PROJECT_SCHEMA).
const projectSchema = pgSchema("project");

/** ce_pipeline_links (U7) — board-task ↔ CE-pipeline/stage/artifact back-ref. */
export const cePipelineLinks = projectSchema.table("ce_pipeline_links", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  cePipelineId: text("ce_pipeline_id").notNull(),
  ceStageId: text("ce_stage_id").notNull(),
  ceArtifactPath: text("ce_artifact_path"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idxCePipelineLinksPipeline").on(t.cePipelineId, t.createdAt, t.id),
  uniqueIndex("idxCePipelineLinksTask").on(t.taskId),
]);

/** ce_pipeline_state (U8) — CE pipeline's OWN state machine (vs board columns). */
export const cePipelineState = projectSchema.table("ce_pipeline_state", {
  cePipelineId: text("ce_pipeline_id").primaryKey(),
  currentStage: text("current_stage").notNull(),
  status: text("status").notNull(),
  lastArtifactPath: text("last_artifact_path"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idxCePipelineStateStatus").on(t.status, t.updatedAt, t.cePipelineId),
]);

/** ce_pipeline_sync_queue (U8 / FN-5719) — board→pipeline sync signal queue. */
export const cePipelineSyncQueue = projectSchema.table("ce_pipeline_sync_queue", {
  id: text("id").primaryKey(),
  cePipelineId: text("ce_pipeline_id").notNull(),
  taskId: text("task_id").notNull(),
  reason: text("reason").notNull(),
  fromColumn: text("from_column"),
  toColumn: text("to_column"),
  enqueuedAt: text("enqueued_at").notNull(),
  processedAt: text("processed_at"),
}, (t) => [
  index("idxCePipelineSyncQueuePending").on(t.processedAt, t.enqueuedAt, t.id),
  index("idxCePipelineSyncQueuePipeline").on(t.cePipelineId, t.enqueuedAt, t.id),
]);
