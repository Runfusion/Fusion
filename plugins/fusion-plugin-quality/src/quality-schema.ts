import type { Database } from "@fusion/core";

/*
FNXC:Quality 2026-07-14-21:45:
Plugin-owned Quality tables via onSchemaInit. projectId on every row for multi-project isolation.
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
