-- FNXC:MigrationCollisionRepair 2026-08-23-07:07:
-- The deploy line (RUFU-068) and origin/main (FN-149) independently shipped migration
-- 0065: chat_sessions.memory_focus vs the tasks review-convergence columns. The
-- integrated binary keeps 0065 = FN-149 (origin/main is canonical and shipped it in
-- v0.77.0-beta.7) and renumbers RUFU-068's migration to 0066. A database that already
-- recorded 0065 with the OTHER line's content skips that version on upgrade, leaving
-- the other line's columns missing. Every statement below is idempotent (ADD COLUMN
-- IF NOT EXISTS), so re-running both migrations repairs mixed databases; on databases
-- where both migrations already applied, every statement is a no-op.
ALTER TABLE IF EXISTS project.chat_sessions ADD COLUMN IF NOT EXISTS memory_focus text;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS review_convergence_stage integer DEFAULT 0;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS review_convergence_escalation_count integer DEFAULT 0;
