-- FNXC:TaskWedgeNotifications 2026-07-22-14:00:
-- Persist the active/resolved terminal-wedge episode on the task row. The opaque
-- episode id is used by push and mailbox idempotency; human-readable error output
-- never enters this durable dedupe state.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS wedge_notification text;
