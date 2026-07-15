/**
 * Barrel export for the PostgreSQL schema layer.
 *
 * FNXC:PostgresSchema 2026-06-24-03:20:
 * Aggregates the three application schemas (project/central/archive) and the
 * plugin-owned tables. This is the single import surface for the data-layer
 * features (U4+) that need Drizzle table references for type-safe queries.
 *
 * The fresh migration baseline (postgres/migrations/0000_initial.sql) is the
 * materialized snapshot of these definitions; applying it to an empty database
 * yields the schema these Drizzle objects describe (VAL-SCHEMA-001).
 */

export {
  PROJECT_SCHEMA,
  CENTRAL_SCHEMA,
  ARCHIVE_SCHEMA,
  DRIZZLE_MIGRATION_SCHEMA,
  APPLICATION_SCHEMAS,
} from "./_shared.js";

export * as project from "./project.js";
export * as central from "./central.js";
export * as archive from "./archive.js";
export * as plugin from "./plugin.js";

export { projectTableNames } from "./project.js";
export { centralTableNames } from "./central.js";
export { archiveTableNames } from "./archive.js";
export { roadmapPluginTableNames, cePluginTableNames, evenRealitiesPluginTableNames, reportsPluginTableNames, cliPressPluginTableNames } from "./plugin.js";
