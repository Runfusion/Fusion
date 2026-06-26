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
 * The default set of plugin schema-init hooks. The schema applier runs each
 * registered hook after the core baseline migration lands.
 */
export const DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS: readonly PluginSchemaInitHook[] = [
  roadmapPluginSchemaInit,
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
