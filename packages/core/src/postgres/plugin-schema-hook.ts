/**
 * Plugin schema-init hook executor.
 *
 * FNXC:PostgresSchema 2026-06-24-03:45:
 * Plugin-owned tables (e.g. roadmap milestones/features) materialize via a
 * schema-init hook rather than the core migration baseline (VAL-SCHEMA-007).
 * This keeps plugin table definitions owned by the plugin so they evolve
 * independently, while still materializing on a fresh database before the
 * plugin's store layer is used.
 *
 * A plugin schema-init hook is an async function receiving the Drizzle
 * connection. It is expected to run idempotent DDL (CREATE TABLE IF NOT
 * EXISTS). The default roadmap hook mirrors
 * plugins/fusion-plugin-roadmap/src/roadmap-schema.ts but targets PostgreSQL
 * in the project schema.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

/**
 * A plugin schema-init hook. Receives the Drizzle connection and is expected
 * to run idempotent DDL that creates the plugin's tables.
 */
export type PluginSchemaInitHook = {
  /** Stable plugin identifier, used for logging/verification. */
  pluginId: string;
  /** Async function that runs the plugin's idempotent schema DDL. */
  init(db: PostgresJsDatabase<Record<string, never>>): Promise<void>;
};

/**
 * FNXC:PostgresSchema 2026-06-24-03:45:
 * Default roadmap plugin schema-init hook. Creates roadmaps, roadmap_milestones,
 * and roadmap_features in the project schema with the same foreign-key cascade
 * rules and indexes as the plugin's SQLite schema. Idempotent.
 */
export const roadmapPluginSchemaInit: PluginSchemaInitHook = {
  pluginId: "fusion-plugin-roadmap",
  async init(db) {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS project.roadmaps (
        id text PRIMARY KEY,
        title text NOT NULL,
        description text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project.roadmap_milestones (
        id text PRIMARY KEY,
        roadmap_id text NOT NULL,
        title text NOT NULL,
        description text,
        order_index integer NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        CONSTRAINT roadmap_milestones_roadmap_id_fkey
          FOREIGN KEY (roadmap_id) REFERENCES project.roadmaps(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idxRoadmapMilestonesRoadmapOrder"
        ON project.roadmap_milestones(roadmap_id, order_index, created_at, id);

      CREATE TABLE IF NOT EXISTS project.roadmap_features (
        id text PRIMARY KEY,
        milestone_id text NOT NULL,
        title text NOT NULL,
        description text,
        order_index integer NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        CONSTRAINT roadmap_features_milestone_id_fkey
          FOREIGN KEY (milestone_id) REFERENCES project.roadmap_milestones(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idxRoadmapFeaturesMilestoneOrder"
        ON project.roadmap_features(milestone_id, order_index, created_at, id);
    `));
  },
};

/**
 * FNXC:PostgresSchema 2026-07-04-00:00:
 * Compound Engineering plugin schema-init hook. Mirrors
 * plugins/fusion-plugin-compound-engineering/src/schema.ts (ensureCeSchema)
 * but targets PostgreSQL in the project schema. Idempotent
 * (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS), so re-running
 * against an already-migrated database is a no-op.
 *
 * These four tables back the CE plugin's session and pipeline state machines
 * (U5 no-silent-loss core; U7 back-ref links; U8 pipeline-state + sync queue).
 * The async CePipelineStore queries the ce_pipeline_* tables via the Drizzle
 * shapes exported from postgres/schema/plugin.ts.
 */
export const cePluginSchemaInit: PluginSchemaInitHook = {
  pluginId: "fusion-plugin-compound-engineering",
  async init(db) {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS project.ce_sessions (
        id text PRIMARY KEY,
        stage text NOT NULL,
        status text NOT NULL CHECK (status IN (
          'launching','active','awaiting_input','completed','error','interrupted'
        )),
        current_question text,
        conversation_history text NOT NULL DEFAULT '[]',
        project_id text,
        artifact_path text,
        error text,
        turn_interval_ms integer NOT NULL DEFAULT 120000,
        last_activity_at integer NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idxCeSessionsStatusUpdated"
        ON project.ce_sessions(status, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS "idxCeSessionsStageCreated"
        ON project.ce_sessions(stage, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS "idxCeSessionsProject"
        ON project.ce_sessions(project_id, updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS project.ce_pipeline_links (
        id text PRIMARY KEY,
        task_id text NOT NULL,
        ce_pipeline_id text NOT NULL,
        ce_stage_id text NOT NULL,
        ce_artifact_path text,
        created_at text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idxCePipelineLinksPipeline"
        ON project.ce_pipeline_links(ce_pipeline_id, created_at DESC, id);
      CREATE UNIQUE INDEX IF NOT EXISTS "idxCePipelineLinksTask"
        ON project.ce_pipeline_links(task_id);

      CREATE TABLE IF NOT EXISTS project.ce_pipeline_state (
        ce_pipeline_id text PRIMARY KEY,
        current_stage text NOT NULL,
        status text NOT NULL CHECK (status IN (
          'running','advancing','awaiting_board','completed'
        )),
        last_artifact_path text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idxCePipelineStateStatus"
        ON project.ce_pipeline_state(status, updated_at DESC, ce_pipeline_id);

      CREATE TABLE IF NOT EXISTS project.ce_pipeline_sync_queue (
        id text PRIMARY KEY,
        ce_pipeline_id text NOT NULL,
        task_id text NOT NULL,
        reason text NOT NULL,
        from_column text,
        to_column text,
        enqueued_at text NOT NULL,
        processed_at text
      );
      CREATE INDEX IF NOT EXISTS "idxCePipelineSyncQueuePending"
        ON project.ce_pipeline_sync_queue(processed_at, enqueued_at, id);
      CREATE INDEX IF NOT EXISTS "idxCePipelineSyncQueuePipeline"
        ON project.ce_pipeline_sync_queue(ce_pipeline_id, enqueued_at, id);
    `));
  },
};

/**
 * FNXC:PostgresSchema 2026-07-04-00:00:
 * Reports plugin schema-init hook. Creates the reports table in the project
 * schema with the same columns and indexes as the plugin's SQLite schema
 * (plugins/fusion-plugin-reports/src/report-schema.ts). PG column names are
 * normalized to snake_case; the Drizzle shape (schema/plugin.ts) maps them to
 * the camelCase JS keys the Report interface uses. Idempotent.
 */
export const reportsPluginSchemaInit: PluginSchemaInitHook = {
  pluginId: "fusion-plugin-reports",
  async init(db) {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS project.reports (
        id text PRIMARY KEY,
        cadence text NOT NULL CHECK (cadence IN ('daily','weekly','monthly','quarterly','manual')),
        period_start text NOT NULL,
        period_end text NOT NULL,
        title text NOT NULL,
        status text NOT NULL CHECK (status IN ('generating','review_pending','review_in_progress','review_complete','approved','published','archived','failed')),
        generation_started_at text NOT NULL,
        generation_completed_at text,
        review_started_at text,
        review_completed_at text,
        approved_at text,
        approved_by text,
        published_at text,
        archived_at text,
        failure_reason text,
        approval_state text NOT NULL DEFAULT 'not_required',
        approval_history text NOT NULL DEFAULT '[]',
        draft_markdown text,
        rendered_html_path text,
        rendered_html text,
        rendered_html_generated_at text,
        metadata_json text NOT NULL DEFAULT '{}',
        combined_review_json text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );

      CREATE INDEX IF NOT EXISTS "idxReportsCadenceCreated"
        ON project.reports(cadence, created_at DESC, id);

      CREATE INDEX IF NOT EXISTS "idxReportsStatusUpdated"
        ON project.reports(status, updated_at DESC, id);

      CREATE INDEX IF NOT EXISTS "idxReportsPeriod"
        ON project.reports(period_start, period_end, id);
    `));
  },
};

/**
 * FNXC:PostgresSchema 2026-07-04-00:00:
 * CLI Printing Press plugin schema-init hook. Creates the five cli_press_*
 * tables in the project schema with the same foreign-key cascade rules,
 * unique constraints, and indexes as the plugin's SQLite schema
 * (ensureCliPressSchema in plugins/fusion-plugin-cli-printing-press/src/store/
 * cli-press-store.ts). Idempotent. PG column names are snake_case; `executable`
 * is a native PG boolean (SQLite used INTEGER 0/1). The async CliPressStore
 * queries these via the Drizzle shapes in postgres/schema/plugin.ts.
 */
export const cliPressPluginSchemaInit: PluginSchemaInitHook = {
  pluginId: "fusion-plugin-cli-printing-press",
  async init(db) {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS project.cli_press_services (
        id text PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        display_name text NOT NULL,
        description text,
        base_url text NOT NULL,
        source_kind text NOT NULL,
        source_ref text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project.cli_press_cli_specs (
        id text PRIMARY KEY,
        service_id text NOT NULL,
        name text NOT NULL,
        version text NOT NULL,
        generator_version text NOT NULL,
        spec_json text NOT NULL,
        generated_at text,
        status text NOT NULL,
        last_generation_error text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        CONSTRAINT cli_press_cli_specs_service_id_fkey
          FOREIGN KEY (service_id) REFERENCES project.cli_press_services(id) ON DELETE CASCADE,
        CONSTRAINT uq_cli_press_specs_service_name UNIQUE (service_id, name)
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_specs_service"
        ON project.cli_press_cli_specs(service_id, created_at, id);

      CREATE TABLE IF NOT EXISTS project.cli_press_artifacts (
        id text PRIMARY KEY,
        cli_spec_id text NOT NULL,
        kind text NOT NULL,
        path text NOT NULL,
        executable boolean NOT NULL,
        checksum text,
        size_bytes integer,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        CONSTRAINT cli_press_artifacts_cli_spec_id_fkey
          FOREIGN KEY (cli_spec_id) REFERENCES project.cli_press_cli_specs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_artifacts_spec"
        ON project.cli_press_artifacts(cli_spec_id, created_at, id);

      CREATE TABLE IF NOT EXISTS project.cli_press_credentials (
        id text PRIMARY KEY,
        service_id text NOT NULL,
        name text NOT NULL,
        kind text NOT NULL,
        value text NOT NULL,
        placement text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        CONSTRAINT cli_press_credentials_service_id_fkey
          FOREIGN KEY (service_id) REFERENCES project.cli_press_services(id) ON DELETE CASCADE,
        CONSTRAINT uq_cli_press_credentials_service_name UNIQUE (service_id, name)
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_credentials_service"
        ON project.cli_press_credentials(service_id, created_at, id);

      CREATE TABLE IF NOT EXISTS project.cli_press_service_settings (
        id text PRIMARY KEY,
        service_id text NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        scope text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        CONSTRAINT cli_press_service_settings_service_id_fkey
          FOREIGN KEY (service_id) REFERENCES project.cli_press_services(id) ON DELETE CASCADE,
        CONSTRAINT uq_cli_press_settings_service_key_scope UNIQUE (service_id, key, scope)
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_settings_service"
        ON project.cli_press_service_settings(service_id, created_at, id);
    `));
  },
};

/**
 * The default set of plugin schema-init hooks. The schema applier runs each
 * registered hook after the core baseline migration lands.
 */
export const DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS: readonly PluginSchemaInitHook[] = [
  roadmapPluginSchemaInit,
  cePluginSchemaInit,
  reportsPluginSchemaInit,
  cliPressPluginSchemaInit,
];

/**
 * Run the given plugin schema-init hooks in registration order. Each hook is
 * expected to be idempotent; this function does not swallow hook errors.
 */
export async function runPluginSchemaInitHooks(
  db: PostgresJsDatabase<Record<string, never>>,
  hooks: readonly PluginSchemaInitHook[],
): Promise<void> {
  for (const hook of hooks) {
    await hook.init(db);
  }
}
