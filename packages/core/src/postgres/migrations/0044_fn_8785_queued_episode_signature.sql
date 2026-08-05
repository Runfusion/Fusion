-- FNXC:QueuedTaskLogging 2026-08-04-18:03: retain one durable full blocker signature per live task queue episode.
ALTER TABLE project.tasks
  ADD COLUMN IF NOT EXISTS queued_log_episode_signature text;
