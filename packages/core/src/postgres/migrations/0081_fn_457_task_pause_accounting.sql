-- FNXC:TaskPauseAccounting 2026-09-16-06:16: FN-457 durable paused-time accounting so the task
-- card's clock chip can subtract pause from worked time. Additive and nullable, exactly like
-- 0029_planning_active_timing.sql; no existing column changes meaning.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS cumulative_paused_ms bigint;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS paused_started_at text;
