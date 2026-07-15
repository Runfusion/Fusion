/**
 * Drizzle schema for plugin-owned tables.
 *
 * FNXC:PostgresSchema 2026-06-24-03:15:
 * Plugin-owned tables are materialized via a schema-init hook rather than the
 * core migration baseline (VAL-SCHEMA-007). The roadmap plugin owns three
 * tables (roadmaps, roadmap_milestones, roadmap_features) that live in the
 * project schema alongside core tables. This module defines their Drizzle
 * shape so the migration applier's plugin hook can create them against
 * PostgreSQL, mirroring plugins/fusion-plugin-roadmap/src/roadmap-schema.ts.
 *
 * The hook contract: plugins register a schema-init function that receives
 * an executor (anything that can run DDL). The applier calls each registered
 * hook after the core baseline migration lands. This keeps plugin tables out
 * of the core migration file (so they evolve independently with the plugin)
 * while still materializing on a fresh database.
 */

import { text, integer, bigint, boolean, foreignKey, index, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { projectSchema } from "./project.js";

/**
 * Roadmap plugin tables. These live in the project schema because the roadmap
 * plugin instantiates core's Database against the project connection.
 */
export const roadmaps = projectSchema.table("roadmaps", {
  id: text("id").primaryKey(),
  /** FNXC:RoadmapPostgresUpgrade 2026-07-13-23:40: Runtime Roadmap rows always carry the project partition enforced by the plugin upgrade hook. */
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const roadmapMilestones = projectSchema.table("roadmap_milestones", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  roadmapId: text("roadmap_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  orderIndex: integer("order_index").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.roadmapId], foreignColumns: [roadmaps.id] }).onDelete("cascade"),
  index("idxRoadmapMilestonesRoadmapOrder").on(t.roadmapId, t.orderIndex, t.createdAt, t.id),
]);

export const roadmapFeatures = projectSchema.table("roadmap_features", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  milestoneId: text("milestone_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  orderIndex: integer("order_index").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.milestoneId], foreignColumns: [roadmapMilestones.id] }).onDelete("cascade"),
  index("idxRoadmapFeaturesMilestoneOrder").on(t.milestoneId, t.orderIndex, t.createdAt, t.id),
]);

/**
 * Registry of plugin-owned table names (per plugin), used by the schema-init
 * hook to verify plugin tables materialized after the hook runs.
 */
export const roadmapPluginTableNames = [
  "roadmaps",
  "roadmap_milestones",
  "roadmap_features",
] as const;

// ── Even Realities plugin tables ───────────────────────────────────
/**
 * FNXC:EvenRealitiesPostgres 2026-07-14-17:25:
 * Notification dedupe state is durable, project-private plugin data. The PostgreSQL runtime stores one snapshot row per project/task so identical task IDs in separate projects never suppress each other's glasses notifications.
 */
export const evenRealitiesSeenTasks = projectSchema.table("even_realities_seen_tasks", {
  projectId: text("project_id").notNull(),
  taskId: text("task_id").notNull(),
  lastColumn: text("last_column").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.taskId] }),
  index("idxEvenRealitiesSeenTasksProjectUpdated").on(t.projectId, t.updatedAt, t.taskId),
]);

export const evenRealitiesPluginTableNames = ["even_realities_seen_tasks"] as const;

// ── Compound Engineering plugin tables ──────────────────────────────
// FNXC:PostgresSchema 2026-07-04-00:00:
// Mirror of plugins/fusion-plugin-compound-engineering/src/schema.ts
// (ensureCeSchema). These four tables back the CE plugin's session and
// pipeline state machines (U5/U7/U8). They live in the project schema
// alongside core tables and are materialized by cePluginSchemaInit (see
// postgres/plugin-schema-hook.ts). Kept here so async store queries are
// type-safe via schema.plugin.ce*; the hook still issues raw DDL.

/** ce_sessions — interactive CE stage sessions (U5 no-silent-loss core). */
export const ceSessions = projectSchema.table("ce_sessions", {
  id: text("id").primaryKey(),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  currentQuestion: text("current_question"),
  conversationHistory: text("conversation_history").notNull().default("[]"),
  projectId: text("project_id"),
  artifactPath: text("artifact_path"),
  error: text("error"),
  turnIntervalMs: integer("turn_interval_ms").notNull().default(120000),
  /*
  FNXC:PostgresSchema 2026-07-13-19:35:
  last_activity_at stores epoch milliseconds (Date.now()), which overflows PG
  integer (max ~2.1e9) — epoch-ms values are ~1.78e12. Must be bigint like the
  other epoch-ms columns (see project.ts pr_* tables). An integer column here
  broke the SQLite → PostgreSQL first-boot auto-migration and blocked startup.
  */
  lastActivityAt: bigint("last_activity_at", { mode: "number" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idxCeSessionsStatusUpdated").on(t.status, t.updatedAt, t.id),
  index("idxCeSessionsStageCreated").on(t.stage, t.createdAt, t.id),
  index("idxCeSessionsProject").on(t.projectId, t.updatedAt, t.id),
]);

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

/**
 * Registry of CE-plugin-owned table names, used by the schema-init hook to
 * verify plugin tables materialized after the hook runs.
 */
export const cePluginTableNames = [
  "ce_sessions",
  "ce_pipeline_links",
  "ce_pipeline_state",
  "ce_pipeline_sync_queue",
] as const;

// ── Reports plugin tables ───────────────────────────────────────────
// FNXC:PostgresSchema 2026-07-04-00:00:
// Mirror of plugins/fusion-plugin-reports/src/report-schema.ts
// (ensureReportSchema). The reports table backs the Reports plugin's
// ReportStore. It lives in the project schema alongside core tables and is
// materialized by reportsPluginSchemaInit (see postgres/plugin-schema-hook.ts).
// Kept here so async store queries are type-safe via schema.plugin.reports;
// the hook still issues raw DDL.
//
// PG column names are normalized to snake_case (the SQLite schema uses mixed
// case, e.g. periodStart / approval_state). The Drizzle shape maps them to the
// camelCase JS keys the Report interface uses.

/** reports — generated activity reports with multi-agent review + approval. */
export const reports = projectSchema.table("reports", {
  id: text("id").primaryKey(),
  cadence: text("cadence").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  generationStartedAt: text("generation_started_at").notNull(),
  generationCompletedAt: text("generation_completed_at"),
  reviewStartedAt: text("review_started_at"),
  reviewCompletedAt: text("review_completed_at"),
  approvedAt: text("approved_at"),
  approvedBy: text("approved_by"),
  publishedAt: text("published_at"),
  archivedAt: text("archived_at"),
  failureReason: text("failure_reason"),
  approvalState: text("approval_state").notNull().default("not_required"),
  approvalHistory: text("approval_history").notNull().default("[]"),
  draftMarkdown: text("draft_markdown"),
  renderedHtmlPath: text("rendered_html_path"),
  renderedHtml: text("rendered_html"),
  renderedHtmlGeneratedAt: text("rendered_html_generated_at"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  combinedReviewJson: text("combined_review_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idxReportsCadenceCreated").on(t.cadence, t.createdAt, t.id),
  index("idxReportsStatusUpdated").on(t.status, t.updatedAt, t.id),
  index("idxReportsPeriod").on(t.periodStart, t.periodEnd, t.id),
]);

/**
 * Registry of Reports-plugin-owned table names, used by the schema-init hook
 * to verify plugin tables materialized after the hook runs.
 */
export const reportsPluginTableNames = [
  "reports",
] as const;
// ── CLI Printing Press plugin tables ────────────────────────────────
// FNXC:PostgresSchema 2026-07-04-00:00:
// Mirror of plugins/fusion-plugin-cli-printing-press/src/store/cli-press-store.ts
// (ensureCliPressSchema). These five tables back the CLI Printing Press
// plugin's CliPressStore. They live in the project schema alongside core
// tables and are materialized by cliPressPluginSchemaInit (see
// postgres/plugin-schema-hook.ts). Kept here so async store queries are
// type-safe via schema.plugin.cliPress*; the hook still issues raw DDL.
//
// PG column names are normalized to snake_case (the SQLite schema uses
// camelCase, e.g. displayName / baseUrl / createdAt). The Drizzle shape maps
// them to the camelCase JS keys the Service/CliSpec/CliArtifact/Credential/
// ServiceSetting interfaces use. `executable` is a native PG boolean.

/** cli_press_services — registered external-service CLI definitions. */
export const cliPressServices = projectSchema.table("cli_press_services", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  baseUrl: text("base_url").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceRef: text("source_ref"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** cli_press_cli_specs — generated CLI specs scoped to a service. */
export const cliPressSpecs = projectSchema.table("cli_press_cli_specs", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  generatorVersion: text("generator_version").notNull(),
  specJson: text("spec_json").notNull(),
  generatedAt: text("generated_at"),
  status: text("status").notNull(),
  lastGenerationError: text("last_generation_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.serviceId], foreignColumns: [cliPressServices.id] }).onDelete("cascade"),
  uniqueIndex("uq_cli_press_specs_service_name").on(t.serviceId, t.name),
  index("idx_cli_press_specs_service").on(t.serviceId, t.createdAt, t.id),
]);

/** cli_press_artifacts — built CLI artifacts (binaries/scripts/packages). */
export const cliPressArtifacts = projectSchema.table("cli_press_artifacts", {
  id: text("id").primaryKey(),
  cliSpecId: text("cli_spec_id").notNull(),
  kind: text("kind").notNull(),
  path: text("path").notNull(),
  executable: boolean("executable").notNull(),
  checksum: text("checksum"),
  sizeBytes: integer("size_bytes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.cliSpecId], foreignColumns: [cliPressSpecs.id] }).onDelete("cascade"),
  index("idx_cli_press_artifacts_spec").on(t.cliSpecId, t.createdAt, t.id),
]);

/** cli_press_credentials — auth credentials scoped to a service. */
export const cliPressCredentials = projectSchema.table("cli_press_credentials", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  placement: text("placement").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.serviceId], foreignColumns: [cliPressServices.id] }).onDelete("cascade"),
  uniqueIndex("uq_cli_press_credentials_service_name").on(t.serviceId, t.name),
  index("idx_cli_press_credentials_service").on(t.serviceId, t.createdAt, t.id),
]);

/** cli_press_service_settings — key/value settings scoped to a service. */
export const cliPressSettings = projectSchema.table("cli_press_service_settings", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  scope: text("scope").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  foreignKey({ columns: [t.serviceId], foreignColumns: [cliPressServices.id] }).onDelete("cascade"),
  uniqueIndex("uq_cli_press_settings_service_key_scope").on(t.serviceId, t.key, t.scope),
  index("idx_cli_press_settings_service").on(t.serviceId, t.createdAt, t.id),
]);

/**
 * Registry of CLI Printing Press plugin-owned table names, used by the
 * schema-init hook to verify plugin tables materialized after the hook runs.
 */
export const cliPressPluginTableNames = [
  "cli_press_services",
  "cli_press_cli_specs",
  "cli_press_artifacts",
  "cli_press_credentials",
  "cli_press_service_settings",
] as const;
