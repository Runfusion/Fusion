-- FNXC:TaskTiming 2026-08-01-10:00: durable planning AI session accounting.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS cumulative_planning_ms bigint;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS planning_started_at text;
