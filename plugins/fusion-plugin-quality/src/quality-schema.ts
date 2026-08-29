import type { Database, PluginPostgresSchemaDefinition } from "@fusion/core";

/*
FNXC:Quality 2026-07-14-21:45:
Plugin-owned Quality tables via onSchemaInit. projectId on every row for multi-project isolation.

FNXC:QualityPostgres 2026-07-16-09:03:
ensureQualitySchema is SQLite/unit-test only. Production QA routes use
qualityPostgresSchema + AsyncQualityStore; they never open TaskStore.db.
*/

export function ensureQualitySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_test_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      plan_id TEXT,
      source TEXT NOT NULL,
      preset_id TEXT,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      cwd_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      error_message TEXT,
      timeout_ms INTEGER NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      triggered_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quality_test_runs_project_created
      ON quality_test_runs(project_id, created_at DESC, id);

    CREATE INDEX IF NOT EXISTS idx_quality_test_runs_task_created
      ON quality_test_runs(project_id, task_id, created_at DESC, id);

    CREATE TABLE IF NOT EXISTS quality_test_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quality_test_plans_project
      ON quality_test_plans(project_id, status, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS quality_suggested_cases (
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      cases_json TEXT NOT NULL DEFAULT '[]',
      generated_at TEXT NOT NULL,
      method TEXT NOT NULL,
      PRIMARY KEY (project_id, task_id)
    );
  `);
}

/**
 * FNXC:QualityPostgres 2026-07-15-14:55:
 * Quality remains available when Fusion uses the PostgreSQL-backed task store.
 * The legacy SQLite hook above serves local DatabaseSync tests, while this
 * declarative contract lets the host create the same project-scoped tables
 * through its privileged PostgreSQL schema executor before plugin routes run.
 */
export const qualityPostgresSchema: PluginPostgresSchemaDefinition = {
  version: 1,
  tablePrefix: "quality_",
  statements: [
    `CREATE TABLE IF NOT EXISTS project.quality_test_runs (
      project_id text NOT NULL,
      id text NOT NULL,
      task_id text,
      plan_id text,
      source text NOT NULL,
      preset_id text,
      command text NOT NULL,
      cwd text NOT NULL,
      cwd_kind text NOT NULL,
      status text NOT NULL,
      exit_code integer,
      error_message text,
      timeout_ms integer NOT NULL,
      started_at text,
      finished_at text,
      duration_ms integer,
      stdout text NOT NULL DEFAULT '',
      stderr text NOT NULL DEFAULT '',
      triggered_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (project_id, id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_quality_test_runs_project_created ON project.quality_test_runs(project_id, created_at DESC, id)",
    "CREATE INDEX IF NOT EXISTS idx_quality_test_runs_task_created ON project.quality_test_runs(project_id, task_id, created_at DESC, id)",
    `CREATE TABLE IF NOT EXISTS project.quality_test_plans (
      project_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      status text NOT NULL,
      steps_json text NOT NULL DEFAULT '[]',
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (project_id, id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_quality_test_plans_project ON project.quality_test_plans(project_id, status, updated_at DESC, id)",
    `CREATE TABLE IF NOT EXISTS project.quality_suggested_cases (
      project_id text NOT NULL,
      task_id text NOT NULL,
      cases_json text NOT NULL DEFAULT '[]',
      generated_at text NOT NULL,
      method text NOT NULL,
      PRIMARY KEY (project_id, task_id)
    )`,
  ],
};
