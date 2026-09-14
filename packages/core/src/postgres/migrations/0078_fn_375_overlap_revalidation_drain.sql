/*
FNXC:OverlapWaitSynchronization 2026-09-13-04:01:
The model-owned overlap revalidation gate was removed. Historical pending/repair episodes become deterministic ready briefings without deleting delivery evidence, and the phase constraint prevents the removed state machine from returning.
*/
ALTER TABLE project.task_overlap_waits
  DROP CONSTRAINT IF EXISTS ck_task_overlap_wait_phase;

UPDATE project.task_overlap_waits
SET
  phase = 'ready',
  receipt = CASE
    WHEN receipt IS NULL THEN NULL
    ELSE (receipt
      - 'revalidationVerdict'
      - 'invalidatedPromise'
      - 'revalidationFeedback')
      || jsonb_build_object(
        'decision',
        CASE
          WHEN NULLIF(BTRIM(receipt->>'briefing'), '') IS NOT NULL THEN 'briefing'
          ELSE 'resume'
        END
      )
  END
WHERE phase IN ('revalidation-pending', 'repair-required');

ALTER TABLE project.task_overlap_waits
  ADD CONSTRAINT ck_task_overlap_wait_phase
  CHECK (phase IN ('observed','analyzing','freshness-pending','ready','delivered','cancelled'));
