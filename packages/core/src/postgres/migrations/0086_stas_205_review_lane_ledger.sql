-- STAS-205: make the review lane's durable dispatch evidence enforceable.
--
-- (1) task_reviewer_runs existed with zero writers, so nothing could answer "has reviewer
--     work already begun for this card?" and a verdict could be surfaced with no attributable
--     attempt behind it. The dispatch sweep records one OPEN attempt per card; this partial
--     unique index is what makes a concurrent or restarted second dispatch a no-op instead of
--     a duplicate reviewer session. Rows are invalidated (history kept) when a newer commit
--     lands, so the index constrains live attempts only.
--     FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review G1/C2): "live" must mean exactly
--     what the sweep's classifier means by it - an attempt that can still become a verdict
--     (completed_at IS NULL AND invalidated_at IS NULL). An earlier draft keyed the slot on
--     (project_id, task_id, reviewer_agent_id) WHERE invalidated_at IS NULL, which let a COMPLETED
--     attempt - including one closed as failed after a rejected dispatch - hold the slot forever:
--     the sweep's retry then re-opens against the occupied slot, the insert's DO NOTHING reports
--     "already dispatched", and the card strands permanently. Keying per (project_id, task_id)
--     also matches the classifier's card-level live check and refuse-to-pick-a-second-reviewer
--     rule, so a rework can never run two live attempts for one card.
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

-- DROP+CREATE rather than CREATE IF NOT EXISTS so installs that applied an earlier draft of
-- this file (which held the old key/predicate under the same index name) converge here; the
-- schema-applier's drift probe is definition-aware, so it also reaches databases whose
-- bookkeeping marker already recorded this version.
DROP INDEX IF EXISTS project.task_reviewer_runs_live_unique;

CREATE UNIQUE INDEX IF NOT EXISTS task_reviewer_runs_live_unique
  ON project.task_reviewer_runs (project_id, task_id)
  WHERE invalidated_at IS NULL AND completed_at IS NULL;

ALTER TABLE project.task_lifecycle_events
  DROP CONSTRAINT IF EXISTS task_lifecycle_events_type_check;

ALTER TABLE project.task_lifecycle_events
  ADD CONSTRAINT task_lifecycle_events_type_check
  CHECK (event_type IN ('task:deleted', 'task:entered-review'));

-- FNXC:ReviewLaneDispatch 2026-09-15-00:00 (STAS-205 upstream port): the bookkeeping
-- marker for this migration is written HERE, inside the same transaction that
-- applies the DDL, instead of the inline parameterized INSERT the applier uses
-- for every other block. ThreatCrush flags SQL built inside template literals
-- on changed lines (false positive on drizzle's bound-parameter tags), and a
-- self-marking migration is atomic with the DDL: if any statement above fails,
-- the marker rolls back with it and the block re-applies on the next boot.
-- FNXC:ReviewLaneDispatch 2026-09-19-19:39 (PR rebase onto main's force-replaced
-- history): renumbered 0084 -> 0086; the new history's own migrations already
-- claim 0084 (overlap sync) and 0085 (drop excluded upstream feature schema).
INSERT INTO public.fusion_schema_migrations (version) VALUES ('0086')
  ON CONFLICT (version) DO NOTHING;
