/*
FNXC:PostgresMigrationColumnCoverage 2026-07-14-13:17:
Late SQLite migrations added task lifecycle state, workflow icons, and mission assertion scope after the PostgreSQL baseline was captured. Add explicit typed destinations so first-boot migration preserves every value instead of correctly failing closed on unmapped source columns.
*/

DO $$
BEGIN
  /*
  FNXC:PostgresMigrationColumnCoverage 2026-07-14-13:43:
  A failed early baseline can leave a migration marker before every baseline table exists. Schema-parity repair must remain retryable in that state; absent tables will receive these columns when the idempotent baseline is materialized on the next recovery pass.
  */
  IF to_regclass('project.tasks') IS NOT NULL THEN
    ALTER TABLE project.tasks
      ADD COLUMN IF NOT EXISTS board_id text,
      ADD COLUMN IF NOT EXISTS task_question_interrupt text,
      ADD COLUMN IF NOT EXISTS column_dwell_ms jsonb,
      ADD COLUMN IF NOT EXISTS workflow_transition_notification jsonb,
      ADD COLUMN IF NOT EXISTS planner_oversight_level text,
      ADD COLUMN IF NOT EXISTS awaiting_approval_reason text,
      ADD COLUMN IF NOT EXISTS approved_plan_fingerprint text;
  END IF;

  IF to_regclass('project.workflows') IS NOT NULL THEN
    ALTER TABLE project.workflows ADD COLUMN IF NOT EXISTS icon text;
  END IF;

  IF to_regclass('project.mission_contract_assertions') IS NOT NULL THEN
    ALTER TABLE project.mission_contract_assertions
      ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'feature';
  END IF;
END
$$;
