-- FNXC:TaskQueueOrder 2026-09-17-12:07: FN-509 replaces task priority levels with one chronological
-- queue plus an explicit operator Boost. Two additive, nullable pieces of state:
--
--   * `project.tasks.queue_boost` — the durable per-stay Boost record (jsonb). Absent means the card
--     is in ordinary arrival order. Nullable and additive exactly like 0080/0081; no existing column
--     changes meaning, and the retired `priority` column is deliberately NOT dropped or backfilled:
--     it stays as inert historical data that nothing reads.
--
--   * `project.task_queue_boost_seq` — the monotonic ordering authority for CONCURRENT boosts. A
--     browser clock (or `now()`) cannot order two clicks that land in the same millisecond, and a
--     read-modify-write counter would serialize behind the task row. A sequence is assigned
--     server-side, is never reused, and survives rollback (a burned value only leaves a gap, which
--     the comparator does not care about).
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS queue_boost jsonb;

CREATE SEQUENCE IF NOT EXISTS project.task_queue_boost_seq AS bigint START WITH 1 INCREMENT BY 1;

-- The runtime role writes boosts through the ordinary task mutation path, so it needs USAGE on the
-- sequence as well as the table grants the baseline already gives it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE project.task_queue_boost_seq TO fusion_runtime';
  END IF;
END
$$;

-- Boosted cards are a small minority; a partial index keeps the queue-head lookup cheap without
-- paying for the whole table.
CREATE INDEX IF NOT EXISTS idx_tasks_queue_boost
  ON project.tasks (project_id, "column")
  WHERE queue_boost IS NOT NULL;
