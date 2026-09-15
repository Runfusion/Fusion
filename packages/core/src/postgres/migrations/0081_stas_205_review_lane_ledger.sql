-- STAS-205: make the review lane's durable dispatch evidence enforceable.
--
-- (1) task_reviewer_runs existed with zero writers, so nothing could answer "has reviewer
--     work already begun for this card?" and a verdict could be surfaced with no attributable
--     attempt behind it. The dispatch sweep records one OPEN attempt per (project, task,
--     reviewer agent); this partial unique index is what makes a concurrent or restarted
--     second dispatch a no-op instead of a duplicate reviewer session. Rows are invalidated
--     (history kept) when a newer commit lands, so the index constrains live attempts only.
-- (2) task_lifecycle_events was CHECKed to 'task:deleted' alone, so a review-lane entry could
--     not be recorded as a lifecycle fact at all. Add 'task:entered-review' for the store
--     chokepoint that every entry path (engine, scheduler, graph, handoff, CLI) funnels through.
--
-- Data decision: NO backfill. Before this widening 'task:deleted' was the only type the CHECK
-- allowed and the only type ever written, so any historical 'task:entered-review' row could only
-- be fabricated -- and the sweep would then read a made-up timestamp as a real lane entry. (The
-- live install agreed: 4 rows DB-wide, all 'task:deleted', none in the project under repair.) An
-- absent historical event stays honest: it means no record was written, not that nothing happened.
--
-- CHECK scope decision: widened to exactly the two types that have writers. A lifecycle row per
-- column change would duplicate 'task:move' in run_audit_events, which commits from, to and
-- moveSource for every move call in this same transaction -- same-column retries included, which
-- is why a no-op move needs no event of its own -- and a row per dispatch or verdict would
-- duplicate task_reviewer_runs. Lane crossings are this table's fact to own.

CREATE UNIQUE INDEX IF NOT EXISTS task_reviewer_runs_live_unique
  ON project.task_reviewer_runs (project_id, task_id, reviewer_agent_id)
  WHERE invalidated_at IS NULL;

ALTER TABLE project.task_lifecycle_events
  DROP CONSTRAINT IF EXISTS task_lifecycle_events_type_check;

ALTER TABLE project.task_lifecycle_events
  ADD CONSTRAINT task_lifecycle_events_type_check
  CHECK (event_type IN ('task:deleted', 'task:entered-review'));
