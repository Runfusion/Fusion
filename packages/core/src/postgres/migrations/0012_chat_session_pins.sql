/*
FNXC:ChatPinned 2026-07-16-12:30:
Persist a nullable pin timestamp for Direct conversations. This additive,
idempotent upgrade runs independently so databases that already recorded the
initial schema gain the field before chat-session reads and writes use it.
*/
ALTER TABLE IF EXISTS project.chat_sessions
  ADD COLUMN IF NOT EXISTS pinned_at text;
