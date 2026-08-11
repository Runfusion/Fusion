-- FNXC:SpecLock 2026-08-09-17:37: current-plan source revisions use Date.now(), which exceeds PostgreSQL integer range; preserve append-only evidence by widening existing 0048 deployments.
ALTER TABLE project.current_plan_evidence
  ALTER COLUMN source_revision TYPE bigint;
