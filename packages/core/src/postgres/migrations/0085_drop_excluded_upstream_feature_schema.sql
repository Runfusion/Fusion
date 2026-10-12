/*
FNXC:ForkedProductLine 2026-09-18-19:40:
This binary is a permanently feature-reduced fork that never implements some upstream
migration slots (0074, 0076, 0079-0083): project notes, whiteboards, workflow-identity
archive tables, and task-level human-approval/pause/queue-boost columns. A database that
ever ran a full-featured build carries that schema forever, inert but present.

Rather than leave those tables/columns sitting in the active `project` schema where any
future code (a stray migration, a debugging query, a schema-drift check) could stumble on
them, move them somewhere clearly out of the way. Nothing is deleted: standalone tables are
relocated wholesale (SET SCHEMA preserves every row, index, and constraint), and the five
task columns' non-null values are copied into a durable backup table before the columns are
dropped from project.tasks (a column, unlike a table, cannot be "moved" — only copied then
removed). Everything here is recoverable by a human with psql access; nothing needs Fusion's
code to read it back.
*/

CREATE SCHEMA IF NOT EXISTS deprecated_excluded_features;

DO $$
BEGIN
  IF to_regclass('project.notes') IS NOT NULL THEN
    ALTER TABLE project.notes SET SCHEMA deprecated_excluded_features;
  END IF;
  IF to_regclass('project.whiteboards') IS NOT NULL THEN
    ALTER TABLE project.whiteboards SET SCHEMA deprecated_excluded_features;
  END IF;
  IF to_regclass('project.whiteboard_revisions') IS NOT NULL THEN
    ALTER TABLE project.whiteboard_revisions SET SCHEMA deprecated_excluded_features;
  END IF;
  IF to_regclass('project.archived_workflow_settings') IS NOT NULL THEN
    ALTER TABLE project.archived_workflow_settings SET SCHEMA deprecated_excluded_features;
  END IF;
  IF to_regclass('project.workflow_prompt_overrides_archive') IS NOT NULL THEN
    ALTER TABLE project.workflow_prompt_overrides_archive SET SCHEMA deprecated_excluded_features;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS deprecated_excluded_features.task_columns_backup (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  task_id text NOT NULL,
  column_name text NOT NULL,
  value jsonb,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['human_plan_approval', 'human_merge_approval', 'queue_boost', 'cumulative_paused_ms', 'paused_started_at']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = col
    ) THEN
      EXECUTE format(
        'INSERT INTO deprecated_excluded_features.task_columns_backup (project_id, task_id, column_name, value) '
        || 'SELECT project_id, id, %L, to_jsonb(%I) FROM project.tasks WHERE %I IS NOT NULL',
        col, col, col
      );
      EXECUTE format('ALTER TABLE project.tasks DROP COLUMN %I', col);
    END IF;
  END LOOP;
END $$;

/*
FNXC:ForkedProductLine 2026-09-19-20:10:
Migration 0084 first shipped its task_overlap_waits owner FK without ON UPDATE CASCADE / DEFERRABLE, unlike every task-owned FK 0006 rebuilds.
Project-partition promotion refuses such an FK (unsafe-fk-update-graph), so repair databases that already applied the original 0084.
*/
DO $$
BEGIN
  IF to_regclass('project.task_overlap_waits') IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_task_overlap_wait_owner'
      AND conrelid = 'project.task_overlap_waits'::regclass
      AND (confupdtype <> 'c' OR NOT condeferrable)
  ) THEN
    ALTER TABLE project.task_overlap_waits DROP CONSTRAINT fk_task_overlap_wait_owner;
    ALTER TABLE project.task_overlap_waits ADD CONSTRAINT fk_task_overlap_wait_owner
      FOREIGN KEY (project_id, task_id) REFERENCES project.tasks(project_id, id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
