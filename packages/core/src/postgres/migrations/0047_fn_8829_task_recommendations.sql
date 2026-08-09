-- FNXC:TaskRecommendations 2026-08-08-05:56: persist bounded completion suggestions without changing legacy task rows.
-- Schema-only settings stores have no task relation; remain a no-op there while materializing the column for every task-owning project.
ALTER TABLE IF EXISTS project.tasks ADD COLUMN IF NOT EXISTS recommendations jsonb;
