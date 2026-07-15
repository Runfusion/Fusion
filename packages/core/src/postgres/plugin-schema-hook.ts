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
import type { PluginPostgresSchemaDefinition } from "../plugin-types.js";

export interface LoadedPluginSchemaContract {
  pluginId: string;
  /** @deprecated compatibility alias for legacyHook. */
  hook?: unknown;
  legacyHook?: unknown;
  postgresSchema?: PluginPostgresSchemaDefinition;
}

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
        project_id text,
        title text NOT NULL,
        description text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project.roadmap_milestones (
        id text PRIMARY KEY,
        project_id text,
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
        ON project.roadmap_milestones(project_id, roadmap_id, order_index, created_at, id);

      CREATE TABLE IF NOT EXISTS project.roadmap_features (
        id text PRIMARY KEY,
        project_id text,
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
        ON project.roadmap_features(project_id, milestone_id, order_index, created_at, id);

      /*
       * FNXC:PluginPostgresIsolation 2026-07-13-22:37:
       * Bundled plugin rows share one embedded PostgreSQL schema, so every roadmap hierarchy row must carry the bound project ID. The upgrade below derives or rejects legacy ownership before enforcing non-null, while runtime stores reject unbound layers and always filter these columns.
       */
      ALTER TABLE project.roadmaps ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.roadmap_milestones ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.roadmap_features ADD COLUMN IF NOT EXISTS project_id text;

      /*
       * FNXC:RoadmapPostgresUpgrade 2026-07-14-22:45:
       * Existing databases may already have composite hierarchy foreign keys from universal project isolation. Remove both relationships before repairing sentinel ownership so parent and child partitions can move together, then rebuild project-local keys and relationships only after the hierarchy is validated.
       */
      ALTER TABLE project.roadmap_features DROP CONSTRAINT IF EXISTS roadmap_features_milestone_id_fkey;
      ALTER TABLE project.roadmap_milestones DROP CONSTRAINT IF EXISTS roadmap_milestones_roadmap_id_fkey;

      /*
       * FNXC:RoadmapPostgresUpgrade 2026-07-13-23:40:
       * Project-bound Roadmap readers must never silently hide pre-partition PostgreSQL rows. Derive child ownership from an owned parent first, use the sole registered project only when that mapping is unambiguous, and abort schema startup when multiple/no projects leave ownership unknowable. Validate the complete hierarchy before making ownership mandatory.
       *
       * FNXC:PluginLegacyOwnership 2026-07-14-22:40:
       * The core schema's non-null compatibility default marks pre-partition rows as __legacy_unscoped__. Treat that sentinel exactly like NULL/empty ownership in every bundled-plugin upgrade so a sole registered project can recover preserved data and ambiguous databases still fail closed.
       */
      UPDATE project.roadmap_milestones milestone
      SET project_id = roadmap.project_id
      FROM project.roadmaps roadmap
      WHERE milestone.roadmap_id = roadmap.id
        AND (milestone.project_id IS NULL OR milestone.project_id IN ('', '__legacy_unscoped__'))
        AND roadmap.project_id IS NOT NULL
        AND roadmap.project_id <> '';
      UPDATE project.roadmap_features feature
      SET project_id = milestone.project_id
      FROM project.roadmap_milestones milestone
      WHERE feature.milestone_id = milestone.id
        AND (feature.project_id IS NULL OR feature.project_id IN ('', '__legacy_unscoped__'))
        AND milestone.project_id IS NOT NULL
        AND milestone.project_id <> '';

      DO $roadmap_upgrade$
      DECLARE
        unowned_count bigint;
        registered_project_count bigint;
        singleton_project_id text;
        ownership_conflicts bigint;
      BEGIN
        SELECT
          (SELECT count(*) FROM project.roadmaps WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.roadmap_milestones WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.roadmap_features WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
        INTO unowned_count;

        IF unowned_count > 0 THEN
          SELECT count(*), min(id) INTO registered_project_count, singleton_project_id
          FROM central.projects;
          IF registered_project_count <> 1 THEN
            RAISE EXCEPTION 'Roadmap PostgreSQL upgrade cannot assign % pre-project row(s) across % registered projects',
              unowned_count, registered_project_count;
          END IF;
          UPDATE project.roadmaps SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.roadmap_milestones SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.roadmap_features SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
        END IF;

        SELECT
          (SELECT count(*) FROM project.roadmap_milestones milestone
            JOIN project.roadmaps roadmap ON roadmap.id = milestone.roadmap_id
            WHERE milestone.project_id IS DISTINCT FROM roadmap.project_id)
          + (SELECT count(*) FROM project.roadmap_features feature
            JOIN project.roadmap_milestones milestone ON milestone.id = feature.milestone_id
            WHERE feature.project_id IS DISTINCT FROM milestone.project_id)
        INTO ownership_conflicts;
        IF ownership_conflicts > 0 THEN
          RAISE EXCEPTION 'Roadmap PostgreSQL upgrade found % cross-project hierarchy relationship(s)', ownership_conflicts;
        END IF;
      END
      $roadmap_upgrade$;

      ALTER TABLE project.roadmaps ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.roadmap_milestones ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.roadmap_features ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.roadmap_features DROP CONSTRAINT IF EXISTS roadmap_features_pkey;
      ALTER TABLE project.roadmap_milestones DROP CONSTRAINT IF EXISTS roadmap_milestones_pkey;
      ALTER TABLE project.roadmaps DROP CONSTRAINT IF EXISTS roadmaps_pkey;
      ALTER TABLE project.roadmaps ADD CONSTRAINT roadmaps_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.roadmap_milestones ADD CONSTRAINT roadmap_milestones_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.roadmap_features ADD CONSTRAINT roadmap_features_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.roadmap_milestones ADD CONSTRAINT roadmap_milestones_roadmap_id_fkey
        FOREIGN KEY (project_id, roadmap_id) REFERENCES project.roadmaps(project_id, id) ON DELETE CASCADE;
      ALTER TABLE project.roadmap_features ADD CONSTRAINT roadmap_features_milestone_id_fkey
        FOREIGN KEY (project_id, milestone_id) REFERENCES project.roadmap_milestones(project_id, id) ON DELETE CASCADE;
      DROP INDEX IF EXISTS project."idxRoadmapMilestonesRoadmapOrder";
      CREATE INDEX "idxRoadmapMilestonesRoadmapOrder"
        ON project.roadmap_milestones(project_id, roadmap_id, order_index, created_at, id);
      DROP INDEX IF EXISTS project."idxRoadmapFeaturesMilestoneOrder";
      CREATE INDEX "idxRoadmapFeaturesMilestoneOrder"
        ON project.roadmap_features(project_id, milestone_id, order_index, created_at, id);
      CREATE INDEX IF NOT EXISTS "idxRoadmapsProject" ON project.roadmaps(project_id, created_at, id);
      CREATE INDEX IF NOT EXISTS "idxRoadmapMilestonesProject" ON project.roadmap_milestones(project_id, roadmap_id, order_index, id);
      CREATE INDEX IF NOT EXISTS "idxRoadmapFeaturesProject" ON project.roadmap_features(project_id, milestone_id, order_index, id);
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
        last_activity_at bigint NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      -- FNXC:PostgresSchema 2026-07-13-19:35:
      -- last_activity_at holds epoch milliseconds (Date.now()), which overflows
      -- PG integer. Datadirs created before this fix materialized the column as
      -- integer via the CREATE TABLE IF NOT EXISTS above, so widen it in place.
      -- Idempotent: ALTER ... TYPE bigint on an already-bigint column is a no-op.
      ALTER TABLE project.ce_sessions ALTER COLUMN last_activity_at TYPE bigint;
      CREATE INDEX IF NOT EXISTS "idxCeSessionsStatusUpdated"
        ON project.ce_sessions(status, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS "idxCeSessionsStageCreated"
        ON project.ce_sessions(stage, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS "idxCeSessionsProject"
        ON project.ce_sessions(project_id, updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS project.ce_plan_handoff_claims (
        project_id text NOT NULL,
        artifact_path text NOT NULL,
        session_id text NOT NULL,
        created_at text NOT NULL,
        PRIMARY KEY (project_id, artifact_path),
        CONSTRAINT ce_plan_handoff_claims_session_id_fkey
          FOREIGN KEY (session_id) REFERENCES project.ce_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project.ce_pipeline_links (
        project_id text NOT NULL,
        id text NOT NULL,
        task_id text NOT NULL,
        ce_pipeline_id text NOT NULL,
        ce_stage_id text NOT NULL,
        ce_artifact_path text,
        created_at text NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS "idxCePipelineLinksPipeline"
        ON project.ce_pipeline_links(ce_pipeline_id, created_at DESC, id);
      CREATE UNIQUE INDEX IF NOT EXISTS "idxCePipelineLinksTask"
        ON project.ce_pipeline_links(task_id);

      CREATE TABLE IF NOT EXISTS project.ce_pipeline_state (
        project_id text NOT NULL,
        ce_pipeline_id text NOT NULL,
        current_stage text NOT NULL,
        status text NOT NULL CHECK (status IN (
          'running','advancing','awaiting_board','completed'
        )),
        last_artifact_path text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, ce_pipeline_id)
      );
      CREATE INDEX IF NOT EXISTS "idxCePipelineStateStatus"
        ON project.ce_pipeline_state(status, updated_at DESC, ce_pipeline_id);

      CREATE TABLE IF NOT EXISTS project.ce_pipeline_sync_queue (
        project_id text NOT NULL,
        id text NOT NULL,
        ce_pipeline_id text NOT NULL,
        task_id text NOT NULL,
        reason text NOT NULL,
        from_column text,
        to_column text,
        enqueued_at text NOT NULL,
        processed_at text,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS "idxCePipelineSyncQueuePending"
        ON project.ce_pipeline_sync_queue(processed_at, enqueued_at, id);
      CREATE INDEX IF NOT EXISTS "idxCePipelineSyncQueuePipeline"
        ON project.ce_pipeline_sync_queue(ce_pipeline_id, enqueued_at, id);

      /*
       * FNXC:CePipelineProjectIsolation 2026-07-14-21:41:
       * Idempotently upgrade pre-partition plugin tables before runtime stores begin applying project predicates. Legacy rows may be assigned only when central.projects proves a single owner; a sentinel would make preserved pipeline state invisible to every project-scoped reader.
       */
      ALTER TABLE project.ce_pipeline_links ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.ce_pipeline_state ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.ce_pipeline_sync_queue ADD COLUMN IF NOT EXISTS project_id text;
      DO $ce_pipeline_upgrade$
      DECLARE
        unowned_count bigint;
        registered_project_count bigint;
        singleton_project_id text;
      BEGIN
        SELECT
          (SELECT count(*) FROM project.ce_pipeline_links WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.ce_pipeline_state WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.ce_pipeline_sync_queue WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
        INTO unowned_count;

        IF unowned_count > 0 THEN
          SELECT count(*), min(id) INTO registered_project_count, singleton_project_id
          FROM central.projects;
          IF registered_project_count <> 1 THEN
            RAISE EXCEPTION 'Compound Engineering PostgreSQL upgrade cannot assign % pre-project pipeline row(s) across % registered projects',
              unowned_count, registered_project_count;
          END IF;
          UPDATE project.ce_pipeline_links SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.ce_pipeline_state SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.ce_pipeline_sync_queue SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
        END IF;
      END
      $ce_pipeline_upgrade$;
      ALTER TABLE project.ce_pipeline_links ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.ce_pipeline_state ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.ce_pipeline_sync_queue ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.ce_pipeline_links DROP CONSTRAINT IF EXISTS ce_pipeline_links_pkey;
      ALTER TABLE project.ce_pipeline_links ADD CONSTRAINT ce_pipeline_links_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.ce_pipeline_state DROP CONSTRAINT IF EXISTS ce_pipeline_state_pkey;
      ALTER TABLE project.ce_pipeline_state ADD CONSTRAINT ce_pipeline_state_pkey PRIMARY KEY (project_id, ce_pipeline_id);
      ALTER TABLE project.ce_pipeline_sync_queue DROP CONSTRAINT IF EXISTS ce_pipeline_sync_queue_pkey;
      ALTER TABLE project.ce_pipeline_sync_queue ADD CONSTRAINT ce_pipeline_sync_queue_pkey PRIMARY KEY (project_id, id);
      DROP INDEX IF EXISTS project."idxCePipelineLinksTask";
      CREATE UNIQUE INDEX "idxCePipelineLinksTask" ON project.ce_pipeline_links(project_id, task_id);
    `));
  },
};

/**
 * FNXC:WhatsAppPostgresPersistence 2026-07-13-22:37:
 * WhatsApp credentials, Signal keys, replay protection, and conversation history are durable plugin data. Store them in PostgreSQL and include project_id in every key so two projects using the bundled plugin cannot share auth state or suppress each other's inbound messages.
 */
export const whatsappPluginSchemaInit: PluginSchemaInitHook = {
  pluginId: "fusion-plugin-whatsapp-chat",
  async init(db) {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS project.whatsapp_chat_sessions (
        project_id text NOT NULL,
        sender text NOT NULL,
        history text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, sender)
      );
      CREATE TABLE IF NOT EXISTS project.whatsapp_chat_dedupe (
        project_id text NOT NULL,
        message_id text NOT NULL,
        sender text NOT NULL,
        received_at text NOT NULL,
        PRIMARY KEY (project_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS "idxWhatsAppDedupeRetention"
        ON project.whatsapp_chat_dedupe(project_id, received_at);
      CREATE TABLE IF NOT EXISTS project.whatsapp_auth_creds (
        project_id text NOT NULL,
        id text NOT NULL,
        value text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE TABLE IF NOT EXISTS project.whatsapp_auth_keys (
        project_id text NOT NULL,
        category text NOT NULL,
        key_id text NOT NULL,
        value text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, category, key_id)
      );
    `));
  },
};

/**
 * FNXC:EvenRealitiesPostgres 2026-07-14-17:25:
 * The bundled glasses notifier previously registered only SQLite DDL, so backend startup skipped its table and onLoad later reached a removed synchronous database. Materialize the project-owned PostgreSQL snapshot table explicitly; arbitrary SQLite hook SQL is never translated or executed as PostgreSQL.
 */
export const evenRealitiesPluginSchemaInit: PluginSchemaInitHook = {
  pluginId: "fusion-plugin-even-realities-glasses",
  async init(db) {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS project.even_realities_seen_tasks (
        project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
        task_id text NOT NULL,
        last_column text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS "idxEvenRealitiesSeenTasksProjectUpdated"
        ON project.even_realities_seen_tasks(project_id, updated_at, task_id);
      ALTER TABLE project.even_realities_seen_tasks ENABLE ROW LEVEL SECURITY;
      ALTER TABLE project.even_realities_seen_tasks FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS fusion_project_isolation ON project.even_realities_seen_tasks;
      CREATE POLICY fusion_project_isolation ON project.even_realities_seen_tasks
        USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
        WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
      DO $even_realities_runtime$
      BEGIN
        IF to_regprocedure('project.fusion_assign_project_id()') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.even_realities_seen_tasks;
          CREATE TRIGGER fusion_assign_project_id
            BEFORE INSERT OR UPDATE OF project_id ON project.even_realities_seen_tasks
            FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON project.even_realities_seen_tasks TO fusion_runtime;
        END IF;
      END
      $even_realities_runtime$;
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
        project_id text NOT NULL,
        id text NOT NULL,
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
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, id)
      );

      CREATE INDEX IF NOT EXISTS "idxReportsCadenceCreated"
        ON project.reports(cadence, created_at DESC, id);

      CREATE INDEX IF NOT EXISTS "idxReportsStatusUpdated"
        ON project.reports(status, updated_at DESC, id);

      CREATE INDEX IF NOT EXISTS "idxReportsPeriod"
        ON project.reports(period_start, period_end, id);

      /*
       * FNXC:ReportsProjectIsolation 2026-07-14-21:41:
       * Upgrade existing report rows without hiding preserved reports behind an unqueryable sentinel. Only a single central.projects registration establishes unambiguous ownership; otherwise schema startup fails before the composite identity is enforced.
       */
      ALTER TABLE project.reports ADD COLUMN IF NOT EXISTS project_id text;
      DO $reports_upgrade$
      DECLARE
        unowned_count bigint;
        registered_project_count bigint;
        singleton_project_id text;
      BEGIN
        SELECT count(*) INTO unowned_count
        FROM project.reports
        WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');

        IF unowned_count > 0 THEN
          SELECT count(*), min(id) INTO registered_project_count, singleton_project_id
          FROM central.projects;
          IF registered_project_count <> 1 THEN
            RAISE EXCEPTION 'Reports PostgreSQL upgrade cannot assign % pre-project report row(s) across % registered projects',
              unowned_count, registered_project_count;
          END IF;
          UPDATE project.reports SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
        END IF;
      END
      $reports_upgrade$;
      ALTER TABLE project.reports ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.reports DROP CONSTRAINT IF EXISTS reports_pkey;
      ALTER TABLE project.reports ADD CONSTRAINT reports_pkey PRIMARY KEY (project_id, id);
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
        project_id text NOT NULL,
        id text NOT NULL,
        slug text NOT NULL,
        display_name text NOT NULL,
        description text,
        base_url text NOT NULL,
        source_kind text NOT NULL,
        source_ref text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, id),
        CONSTRAINT uq_cli_press_services_project_slug UNIQUE (project_id, slug)
      );

      CREATE TABLE IF NOT EXISTS project.cli_press_cli_specs (
        project_id text NOT NULL,
        id text NOT NULL,
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
        PRIMARY KEY (project_id, id),
        CONSTRAINT cli_press_cli_specs_service_id_fkey
          FOREIGN KEY (project_id, service_id) REFERENCES project.cli_press_services(project_id, id) ON DELETE CASCADE,
        CONSTRAINT uq_cli_press_specs_service_name UNIQUE (project_id, service_id, name)
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_specs_service"
        ON project.cli_press_cli_specs(service_id, created_at, id);

      CREATE TABLE IF NOT EXISTS project.cli_press_artifacts (
        project_id text NOT NULL,
        id text NOT NULL,
        cli_spec_id text NOT NULL,
        kind text NOT NULL,
        path text NOT NULL,
        executable boolean NOT NULL,
        checksum text,
        size_bytes integer,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, id),
        CONSTRAINT cli_press_artifacts_cli_spec_id_fkey
          FOREIGN KEY (project_id, cli_spec_id) REFERENCES project.cli_press_cli_specs(project_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_artifacts_spec"
        ON project.cli_press_artifacts(cli_spec_id, created_at, id);

      CREATE TABLE IF NOT EXISTS project.cli_press_credentials (
        project_id text NOT NULL,
        id text NOT NULL,
        service_id text NOT NULL,
        name text NOT NULL,
        kind text NOT NULL,
        value text NOT NULL,
        placement text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, id),
        CONSTRAINT cli_press_credentials_service_id_fkey
          FOREIGN KEY (project_id, service_id) REFERENCES project.cli_press_services(project_id, id) ON DELETE CASCADE,
        CONSTRAINT uq_cli_press_credentials_service_name UNIQUE (project_id, service_id, name)
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_credentials_service"
        ON project.cli_press_credentials(service_id, created_at, id);

      CREATE TABLE IF NOT EXISTS project.cli_press_service_settings (
        project_id text NOT NULL,
        id text NOT NULL,
        service_id text NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        scope text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project_id, id),
        CONSTRAINT cli_press_service_settings_service_id_fkey
          FOREIGN KEY (project_id, service_id) REFERENCES project.cli_press_services(project_id, id) ON DELETE CASCADE,
        CONSTRAINT uq_cli_press_settings_service_key_scope UNIQUE (project_id, service_id, key, scope)
      );
      CREATE INDEX IF NOT EXISTS "idx_cli_press_settings_service"
        ON project.cli_press_service_settings(service_id, created_at, id);

      /*
       * FNXC:CliPressProjectIsolation 2026-07-14-21:41:
       * Upgrade every legacy table together so composite ownership keys and child foreign keys remain valid across repeated schema application. Pre-project definitions may be claimed only by the sole registered project; ambiguous ownership fails closed instead of assigning rows to an invisible sentinel.
       */
      ALTER TABLE project.cli_press_services ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.cli_press_cli_specs ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.cli_press_artifacts ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.cli_press_credentials ADD COLUMN IF NOT EXISTS project_id text;
      ALTER TABLE project.cli_press_service_settings ADD COLUMN IF NOT EXISTS project_id text;
      /*
       * FNXC:CliPressProjectIsolation 2026-07-14-22:48:
       * A repeated upgrade can encounter composite child foreign keys installed by an earlier boot. Drop them before moving sentinel-owned parents and children to the recovered project together; the same transaction rebuilds every relationship after ownership validation.
       */
      ALTER TABLE project.cli_press_artifacts DROP CONSTRAINT IF EXISTS cli_press_artifacts_cli_spec_id_fkey;
      ALTER TABLE project.cli_press_cli_specs DROP CONSTRAINT IF EXISTS cli_press_cli_specs_service_id_fkey;
      ALTER TABLE project.cli_press_credentials DROP CONSTRAINT IF EXISTS cli_press_credentials_service_id_fkey;
      ALTER TABLE project.cli_press_service_settings DROP CONSTRAINT IF EXISTS cli_press_service_settings_service_id_fkey;
      DO $cli_press_upgrade$
      DECLARE
        unowned_count bigint;
        registered_project_count bigint;
        singleton_project_id text;
      BEGIN
        SELECT
          (SELECT count(*) FROM project.cli_press_services WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.cli_press_cli_specs WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.cli_press_artifacts WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.cli_press_credentials WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
          + (SELECT count(*) FROM project.cli_press_service_settings WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__'))
        INTO unowned_count;

        IF unowned_count > 0 THEN
          SELECT count(*), min(id) INTO registered_project_count, singleton_project_id
          FROM central.projects;
          IF registered_project_count <> 1 THEN
            RAISE EXCEPTION 'CLI Printing Press PostgreSQL upgrade cannot assign % pre-project row(s) across % registered projects',
              unowned_count, registered_project_count;
          END IF;
          UPDATE project.cli_press_services SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.cli_press_cli_specs SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.cli_press_artifacts SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.cli_press_credentials SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
          UPDATE project.cli_press_service_settings SET project_id = singleton_project_id
            WHERE project_id IS NULL OR project_id IN ('', '__legacy_unscoped__');
        END IF;
      END
      $cli_press_upgrade$;
      ALTER TABLE project.cli_press_services ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.cli_press_cli_specs ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.cli_press_artifacts ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.cli_press_credentials ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.cli_press_service_settings ALTER COLUMN project_id SET NOT NULL;
      ALTER TABLE project.cli_press_artifacts DROP CONSTRAINT IF EXISTS cli_press_artifacts_pkey;
      ALTER TABLE project.cli_press_cli_specs DROP CONSTRAINT IF EXISTS cli_press_cli_specs_pkey;
      ALTER TABLE project.cli_press_credentials DROP CONSTRAINT IF EXISTS cli_press_credentials_pkey;
      ALTER TABLE project.cli_press_service_settings DROP CONSTRAINT IF EXISTS cli_press_service_settings_pkey;
      ALTER TABLE project.cli_press_services DROP CONSTRAINT IF EXISTS cli_press_services_pkey;
      ALTER TABLE project.cli_press_services DROP CONSTRAINT IF EXISTS cli_press_services_slug_key;
      ALTER TABLE project.cli_press_services DROP CONSTRAINT IF EXISTS uq_cli_press_services_project_slug;
      ALTER TABLE project.cli_press_cli_specs DROP CONSTRAINT IF EXISTS uq_cli_press_specs_service_name;
      ALTER TABLE project.cli_press_credentials DROP CONSTRAINT IF EXISTS uq_cli_press_credentials_service_name;
      ALTER TABLE project.cli_press_service_settings DROP CONSTRAINT IF EXISTS uq_cli_press_settings_service_key_scope;
      ALTER TABLE project.cli_press_services ADD CONSTRAINT cli_press_services_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.cli_press_services ADD CONSTRAINT uq_cli_press_services_project_slug UNIQUE (project_id, slug);
      ALTER TABLE project.cli_press_cli_specs ADD CONSTRAINT cli_press_cli_specs_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.cli_press_cli_specs ADD CONSTRAINT uq_cli_press_specs_service_name UNIQUE (project_id, service_id, name);
      ALTER TABLE project.cli_press_artifacts ADD CONSTRAINT cli_press_artifacts_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.cli_press_credentials ADD CONSTRAINT cli_press_credentials_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.cli_press_credentials ADD CONSTRAINT uq_cli_press_credentials_service_name UNIQUE (project_id, service_id, name);
      ALTER TABLE project.cli_press_service_settings ADD CONSTRAINT cli_press_service_settings_pkey PRIMARY KEY (project_id, id);
      ALTER TABLE project.cli_press_service_settings ADD CONSTRAINT uq_cli_press_settings_service_key_scope UNIQUE (project_id, service_id, key, scope);
      ALTER TABLE project.cli_press_cli_specs ADD CONSTRAINT cli_press_cli_specs_service_id_fkey FOREIGN KEY (project_id, service_id) REFERENCES project.cli_press_services(project_id, id) ON DELETE CASCADE;
      ALTER TABLE project.cli_press_artifacts ADD CONSTRAINT cli_press_artifacts_cli_spec_id_fkey FOREIGN KEY (project_id, cli_spec_id) REFERENCES project.cli_press_cli_specs(project_id, id) ON DELETE CASCADE;
      ALTER TABLE project.cli_press_credentials ADD CONSTRAINT cli_press_credentials_service_id_fkey FOREIGN KEY (project_id, service_id) REFERENCES project.cli_press_services(project_id, id) ON DELETE CASCADE;
      ALTER TABLE project.cli_press_service_settings ADD CONSTRAINT cli_press_service_settings_service_id_fkey FOREIGN KEY (project_id, service_id) REFERENCES project.cli_press_services(project_id, id) ON DELETE CASCADE;
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
  whatsappPluginSchemaInit,
  evenRealitiesPluginSchemaInit,
  reportsPluginSchemaInit,
  cliPressPluginSchemaInit,
];

const POSTGRES_PLUGIN_SCHEMA_HOOKS = new Map(
  DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS.map((hook) => [hook.pluginId, hook] as const),
);

const SAFE_POSTGRES_PLUGIN_CREATE_STATEMENT = /^(?:CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+project\.[a-z][a-z0-9_]*\s*\(|CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(?:"[^"]+"|[a-z][a-z0-9_]*)\s+ON\s+project\.[a-z][a-z0-9_]*\s*\()/i;
const CREATE_PLUGIN_TABLE = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+project\.([a-z][a-z0-9_]*)\s*\(/i;
const CREATE_PLUGIN_INDEX = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(?:"[^"]+"|[a-z][a-z0-9_]*)\s+ON\s+project\.([a-z][a-z0-9_]*)\s*\(/i;
const ALTER_PLUGIN_TABLE = /^ALTER\s+TABLE\s+project\.([a-z][a-z0-9_]*)\s+(.+)$/is;
const SAFE_PLUGIN_COLUMN_TYPE = "(?:text|integer|bigint|boolean|jsonb|timestamp(?:\\s+(?:with|without)\\s+time\\s+zone)?)";
const SAFE_PLUGIN_DEFAULT = "(?:NULL|TRUE|FALSE|-?[0-9]+(?:\\.[0-9]+)?|'(?:''|[^'])*'|[a-z][a-z0-9_]*(?:\\(\\))?)";
const SAFE_PLUGIN_ALTER_ACTION = new RegExp(
  `^(?:ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+("?[a-z][a-z0-9_]*"?)\\s+${SAFE_PLUGIN_COLUMN_TYPE}(?:\\s+NOT\\s+NULL)?(?:\\s+DEFAULT\\s+${SAFE_PLUGIN_DEFAULT})?|ALTER\\s+COLUMN\\s+("?[a-z][a-z0-9_]*"?)\\s+SET\\s+(?:NOT\\s+NULL|DEFAULT\\s+${SAFE_PLUGIN_DEFAULT}))$`,
  "i",
);

function pluginStatementTable(normalized: string): string | undefined {
  return normalized.match(CREATE_PLUGIN_TABLE)?.[1]
    ?? normalized.match(CREATE_PLUGIN_INDEX)?.[1]
    ?? normalized.match(ALTER_PLUGIN_TABLE)?.[1];
}

/**
 * Validate a third-party schema plan before plugin lifecycle side effects run.
 * This is a capability boundary, not a SQL sandbox: installed plugins already
 * execute JavaScript, but ordinary hooks never receive migration credentials.
 */
export function validatePluginPostgresSchema(
  pluginId: string,
  definition: PluginPostgresSchemaDefinition,
): void {
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new Error(`Plugin "${pluginId}" PostgreSQL schema version must be a positive integer`);
  }
  if (!/^[a-z][a-z0-9_]*_$/.test(definition.tablePrefix)) {
    throw new Error(`Plugin "${pluginId}" PostgreSQL tablePrefix must be lowercase snake_case ending in underscore`);
  }
  if (!Array.isArray(definition.statements) || definition.statements.length === 0) {
    throw new Error(`Plugin "${pluginId}" PostgreSQL schema must declare at least one statement`);
  }
  for (const statement of definition.statements) {
    const normalized = statement.trim().replace(/;\s*$/, "");
    if (!normalized || normalized.includes(";") || /--|\/\*/.test(normalized)) {
      throw new Error(`Plugin "${pluginId}" PostgreSQL schema requires exactly one statement per item`);
    }
    const alter = normalized.match(ALTER_PLUGIN_TABLE);
    if (alter) {
      const action = alter[2].trim();
      const safeAction = action.match(SAFE_PLUGIN_ALTER_ACTION);
      const column = (safeAction?.[1] ?? safeAction?.[2])?.replaceAll('"', "").toLowerCase();
      /*
      FNXC:PluginPostgresContract 2026-07-14-22:42:
      Third-party migrations may evolve their own ordinary columns, but the privileged schema executor must retain sole ownership of project_id, keys, policies, triggers, grants, and table identity. A narrow additive ALTER grammar prevents a declarative hook from using migration credentials to weaken the host-installed isolation envelope.
      */
      if (!safeAction || column === "project_id") {
        throw new Error(
          `Plugin "${pluginId}" PostgreSQL ALTER TABLE may only add or set defaults/nullability on non-project_id data columns`,
        );
      }
    } else if (!SAFE_POSTGRES_PLUGIN_CREATE_STATEMENT.test(normalized)) {
      throw new Error(
        `Plugin "${pluginId}" PostgreSQL schema may only use idempotent CREATE TABLE/INDEX or ALTER TABLE statements in the project schema`,
      );
    }
    for (const [, table] of normalized.matchAll(/\bproject\.([a-z][a-z0-9_]*)\b/gi)) {
      if (!table.toLowerCase().startsWith(definition.tablePrefix)) {
        throw new Error(`Plugin "${pluginId}" PostgreSQL schema may only reference tables beginning with ${definition.tablePrefix}`);
      }
    }
    if (CREATE_PLUGIN_TABLE.test(normalized)) {
      if (!/\bproject_id\s+text\s+NOT\s+NULL\b/i.test(normalized)) {
        throw new Error(`Plugin "${pluginId}" PostgreSQL tables must declare project_id text NOT NULL`);
      }
      if (!/\bPRIMARY\s+KEY\s*\(\s*project_id\s*,/i.test(normalized)) {
        throw new Error(`Plugin "${pluginId}" PostgreSQL tables must use a project_id-leading composite primary key`);
      }
    }
  }
}

/**
 * Validate runtime-loaded legacy hooks against the PostgreSQL registry.
 * Runtime AsyncDataLayer connections intentionally have DML-only privileges;
 * DDL is executed by applySchemaBaseline's migration connection on every boot.
 */
export function assertLoadedPluginSchemaInitHooksSupported(
  hooks: ReadonlyArray<LoadedPluginSchemaContract>,
): void {
  for (const loaded of hooks) {
    if (loaded.postgresSchema) {
      validatePluginPostgresSchema(loaded.pluginId, loaded.postgresSchema);
      continue;
    }
    if ((loaded.legacyHook ?? loaded.hook) && !POSTGRES_PLUGIN_SCHEMA_HOOKS.has(loaded.pluginId)) {
      throw new Error(
        `Plugin "${loaded.pluginId}" declares legacy SQLite onSchemaInit but has no registered PostgreSQL schema hook`,
      );
    }
  }
}

/**
 * Run the explicit PostgreSQL schema contract for plugins loaded at runtime.
 * A legacy `onSchemaInit(Database)` callback is evidence that schema is needed,
 * but its SQLite SQL is not portable. Only registered PostgreSQL equivalents
 * may run; unknown hooks fail loudly with an actionable contract error.
 */
export async function runLoadedPluginSchemaInitHooks(
  db: PostgresJsDatabase<Record<string, never>>,
  hooks: ReadonlyArray<LoadedPluginSchemaContract>,
): Promise<void> {
  assertLoadedPluginSchemaInitHooksSupported(hooks);
  for (const loaded of hooks) {
    /*
    FNXC:PluginPostgresContract 2026-07-14-22:42:
    Runtime load and hot reload share the schema-applier advisory lock. Each contract and its complete isolation envelope commit atomically, so concurrent Fusion processes serialize DDL and a rejected reload cannot leave partially-created or temporarily unprotected tables behind.
    */
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fusion:schema-applier'))`);
      if (loaded.postgresSchema) {
        const tables = new Set<string>();
        for (const statement of loaded.postgresSchema.statements) {
          const normalized = statement.trim().replace(/;\s*$/, "");
          const table = pluginStatementTable(normalized);
          if (table) tables.add(table);
          await tx.execute(sql.raw(normalized));
        }
        for (const table of tables) {
          /*
          FNXC:PluginPostgresContract 2026-07-14-18:32:
          Fusion owns the isolation envelope for third-party tables. Plugins
          declare project-local keys; the privileged executor installs forced
          RLS, ownership stamping, runtime grants, and a single scoped policy.
          */
          await tx.execute(sql.raw(`
          ALTER TABLE project."${table}" ALTER COLUMN project_id
            SET DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__');
          ALTER TABLE project."${table}" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE project."${table}" FORCE ROW LEVEL SECURITY;
          DROP POLICY IF EXISTS fusion_project_isolation ON project."${table}";
          CREATE POLICY fusion_project_isolation ON project."${table}"
            USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
            WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
          DROP TRIGGER IF EXISTS fusion_assign_project_id ON project."${table}";
          CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id
            ON project."${table}" FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
          GRANT SELECT, INSERT, UPDATE, DELETE ON project."${table}" TO fusion_runtime;
        `));
        }
        return;
      }
      const postgresHook = POSTGRES_PLUGIN_SCHEMA_HOOKS.get(loaded.pluginId);
      if (postgresHook) await postgresHook.init(tx);
    });
  }
}

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
