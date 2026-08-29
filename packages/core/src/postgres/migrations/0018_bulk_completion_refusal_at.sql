-- FNXC:Lifecycle 2026-07-16-22:35: FN-8141 skip-bypass taint marker (nullable ISO timestamp).
-- PR #2260 added project.tasks.bulk_completion_refusal_at to the Drizzle model
-- and the 0000 baseline but shipped NO forward migration, so every database
-- created before #2260 (already carrying the 0000 marker) never received the
-- column and crashed on the first TaskStore SELECT ("column
-- bulk_completion_refusal_at does not exist"). This forward migration lands the
-- column on existing clusters. Idempotent via IF NOT EXISTS.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS bulk_completion_refusal_at text;
