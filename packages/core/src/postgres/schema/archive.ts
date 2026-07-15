/**
 * Drizzle schema for the archive (cold-storage) database.
 *
 * FNXC:PostgresSchema 2026-06-24-03:10:
 * Snapshotted from BASE_SCHEMA_SQL in packages/core/src/archive-db.ts.
 * The archive stores append-only snapshots of archived tasks, queryable by
 * archivedAt/createdAt and (later) by tsvector full-text search.
 *
 * The FTS5 virtual table (archived_tasks_fts) is replaced by a tsvector/GIN
 * generated column (search_vector) on the archived_tasks table — see below
 * (fts-replacement feature, U7).
 */

import { pgSchema, text, jsonb, index, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ARCHIVE_SCHEMA, tsvector } from "./_shared.js";

/**
 * FNXC:PostgresSchema 2026-06-24-03:10:
 * Dedicated PostgreSQL schema for the archive database (VAL-SCHEMA-008).
 */
export const archiveSchema = pgSchema(ARCHIVE_SCHEMA);

export const archivedTasks = archiveSchema.table("archived_tasks", {
  id: text("id").notNull(),
  /*
  FNXC:MultiProjectIsolation 2026-07-12:
  Per-project partition key (see project.tasks.projectId). The cold-storage
  archive is one shared table across every project on the embedded cluster,
  so archived-board listings, counts, and searches must be scoped to the
  owning project — otherwise project A's archived list shows project B's
  rows. Legacy/unbound rows use the explicit __legacy_unscoped__ quarantine.
  */
  projectId: text("project_id").notNull().default(sql`current_setting('fusion.project_id', true)`),
  taskJson: text("task_json").notNull(),
  prompt: text("prompt"),
  archivedAt: text("archived_at").notNull(),
  title: text("title"),
  description: text("description").notNull(),
  comments: jsonb("comments").default([]),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  columnMovedAt: text("column_moved_at"),
  /*
  FNXC:TaskStoreSearch 2026-06-24-12:20:
  Full-text search vector for archived tasks, replacing the SQLite FTS5
  external-content table (archived_tasks_fts). GENERATED ALWAYS column kept in
  sync automatically on write (VAL-SEARCH-005 archive search parity). Uses the
  'simple' text-search config for code-like tokenization parity with FTS5.
  Indexes id, title, description, and comments (cast to text) — the same
  columns the FTS5 archive table indexed.
  */
  searchVector: tsvector("search_vector").generatedAlwaysAs(
    sql`to_tsvector('simple', coalesce(id, '') || ' ' || coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(comments::text, ''))`,
  ),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxArchivedTasksArchivedAt").on(t.archivedAt),
  // FNXC:MultiProjectIsolation 2026-07-12: per-project archived-board scans.
  index("idxArchiveArchivedTasksProjectId").on(t.projectId),
  index("idxArchivedTasksCreatedAt").on(t.createdAt),
  /*
  FNXC:TaskStoreSearch 2026-06-24-12:25:
  GIN index on the archive search_vector for full-text search
  (VAL-SEARCH-005). The PostgreSQL replacement for the FTS5 archive index.
  */
  index("idxArchivedTasksSearchVector").using("gin", t.searchVector),
]);

/**
 * FNXC:PostgresSchema 2026-06-24-03:10:
 * Registry of all archive-schema table names.
 */
export const archiveTableNames = ["archived_tasks"] as const;
