-- 0011_owner_project_id.sql
--
-- FNXC:MultiProjectIsolation 2026-07-15-23:40:
-- Separate the DOMAIN "project" field from the PostgreSQL isolation partition.
-- Migration 0006 made `project_id` the RLS partition column on every project-schema
-- table (owned by the fusion_assign_project_id BEFORE INSERT trigger + the
-- fusion.project_id session GUC, with composite PK/unique/FK keys). A handful of
-- tables ALSO carried a caller-supplied domain "projectId" on their TS types and
-- wrote that domain value into the same physical `project_id` column. When the
-- domain value differed from the session GUC, the parent row landed in the domain
-- partition while child rows (research_run_events, experiment_session_records,
-- eval_task_results, ...) landed in the session partition, violating the composite
-- FKs with SQLSTATE 23503.
--
-- This migration adds a separate nullable `owner_project_id` domain column to the
-- conflated tables. `project_id` remains the isolation partition and stays owned by
-- the trigger/GUC; stores stop writing it and read/write the domain field through
-- `owner_project_id` instead.
--
-- Backfill: in production the domain value and the partition were written with the
-- same id, so `owner_project_id = project_id` is correct. `'__legacy_unscoped__'`
-- is the trigger's "no session project bound" sentinel and never a real domain
-- project, and the domain field was nullable, so the sentinel backfills to NULL.
--
-- Idempotent and re-runnable: to_regclass-guarded (a failed early baseline can
-- leave a migration marker before every baseline table exists — absent tables
-- receive the column when the idempotent baseline is materialized on the next
-- recovery pass, matching the 0007 pattern), ADD COLUMN IF NOT EXISTS, and a
-- backfill scoped to owner_project_id IS NULL.

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'research_runs',
    'experiment_sessions',
    'todo_lists',
    'eval_runs',
    'chat_sessions',
    'chat_rooms',
    'ai_sessions',
    'chat_token_usage',
    'project_insights',
    'project_insight_runs',
    'cli_sessions'
  ] LOOP
    IF to_regclass(format('project.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE project.%I ADD COLUMN IF NOT EXISTS owner_project_id text', tbl);
      EXECUTE format(
        'UPDATE project.%I SET owner_project_id = NULLIF(project_id, %L) WHERE owner_project_id IS NULL',
        tbl,
        '__legacy_unscoped__'
      );
      -- Domain-filter index (stores list/filter by the domain project id).
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON project.%I (owner_project_id)',
        'idx_' || tbl || '_owner_project_id',
        tbl
      );
    END IF;
  END LOOP;
END
$$;
