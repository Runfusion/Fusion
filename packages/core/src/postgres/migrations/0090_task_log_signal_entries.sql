-- FNXC:TaskLogSignalEntries 2026-10-18-18:00:
-- Slim board lists read a task's log only to derive timedExecutionMs, stalledReview and
-- inReviewStalled, yet shipped and parsed the whole log (over 90% of row bytes) on every poll.
-- log_signal_entries is the in-order subset of log those derivations can read:
--   * entries whose action or outcome contains '[timing]' (timedExecutionMs);
--   * re-enqueue and invalid-transition entries (stalled-review-detector.ts);
--   * entries whose action starts with the in-review stall prefix (in-review-stalled.ts);
--   * the newest canonical toISOString() timestamp, plus every entry whose timestamp is
--     missing or not in that exact form, so the latest-activity maximum is unchanged.
-- The patterns mirror TypeScript constants; task-log-signal-entries.pg.test.ts pins them.
-- A trigger keeps the column current only when log changes. It is declared UPDATE OF log,
-- log_signal_entries so updates that do not name those columns (most task updates) skip it entirely.

CREATE OR REPLACE FUNCTION project.task_log_signal_entries(task_log jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT COALESCE(jsonb_agg(k.entry ORDER BY k.ord), '[]'::jsonb)
  FROM (
    SELECT a.entry, a.ord,
      max(CASE WHEN jsonb_typeof(a.entry->'timestamp') = 'string'
                AND a.entry->>'timestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
               THEN a.entry->>'timestamp' END) OVER () AS newest
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(task_log) = 'array' THEN task_log ELSE '[]'::jsonb END)
      WITH ORDINALITY AS a(entry, ord)
  ) k
  WHERE jsonb_typeof(k.entry->'timestamp') IS DISTINCT FROM 'string'
     OR k.entry->>'timestamp' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     OR k.entry->>'timestamp' = k.newest
     OR (jsonb_typeof(k.entry->'action') = 'string' AND (
          strpos(k.entry->>'action', '[timing]') > 0
       OR strpos(k.entry->>'action', 'Auto-recovered: eligible in-review task re-enqueued for merge') > 0
       OR strpos(k.entry->>'action', 'Invalid transition: ''') > 0
       OR starts_with(k.entry->>'action', 'In-review stall surfaced [')))
     OR (jsonb_typeof(k.entry->'outcome') = 'string' AND (
          strpos(k.entry->>'outcome', '[timing]') > 0
       OR strpos(k.entry->>'outcome', 'Invalid transition: ''') > 0))
$fn$;

CREATE OR REPLACE FUNCTION project.tasks_set_log_signal_entries()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.log IS DISTINCT FROM OLD.log
     OR NEW.log_signal_entries IS DISTINCT FROM OLD.log_signal_entries THEN
    NEW.log_signal_entries := project.task_log_signal_entries(NEW.log);
  END IF;
  RETURN NEW;
END
$fn$;

-- Column, trigger and backfill only where project.tasks exists and carries a log column
-- (repair paths and legacy upgrade fixtures may lack either).
DO $do$
BEGIN
  -- Repair and upgrade paths can run with project.tasks absent; there is nothing to maintain then.
  IF to_regclass('project.tasks') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS log_signal_entries jsonb;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'log') THEN
    DROP TRIGGER IF EXISTS tasks_log_signal_entries ON project.tasks;
    CREATE TRIGGER tasks_log_signal_entries
      BEFORE INSERT OR UPDATE OF log, log_signal_entries ON project.tasks
      FOR EACH ROW EXECUTE FUNCTION project.tasks_set_log_signal_entries();
    UPDATE project.tasks
    SET log_signal_entries = project.task_log_signal_entries(log)
    WHERE log_signal_entries IS NULL;
  END IF;
END
$do$;
