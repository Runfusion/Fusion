-- FNXC:OverlapWaitSynchronization 2026-09-13-05:10:
-- `repair-required` is a declared OverlapWaitPhase and the phase the delta revalidation node writes on a
-- REVISE verdict, but 0075 shipped a CHECK constraint that omitted it. Every REVISE therefore raised a
-- constraint violation inside the node, surfaced as a bare "exception" failure value with no message
-- persisted anywhere, and the episode stayed `revalidation-pending` — so the next dispatch re-ran the same
-- paid AI review and hit the same wall until the overseer's retry budget parked the card failed.
-- Measured 2026-09-13 on FN-372.

DO $$
BEGIN
  IF to_regclass('project.task_overlap_waits') IS NOT NULL THEN
    ALTER TABLE project.task_overlap_waits DROP CONSTRAINT IF EXISTS ck_task_overlap_wait_phase;
    ALTER TABLE project.task_overlap_waits
      ADD CONSTRAINT ck_task_overlap_wait_phase
      CHECK (phase IN ('observed','analyzing','freshness-pending','revalidation-pending','repair-required','ready','delivered','cancelled'));
  END IF;
END $$;
