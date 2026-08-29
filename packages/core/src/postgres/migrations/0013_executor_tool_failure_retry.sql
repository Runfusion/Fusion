-- FNXC:ExecutorToolFailureRetry 2026-07-16-12:00: durable bounded retry state is project-task scoped in the PostgreSQL production backend.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS consecutive_tool_failure_retry_count integer DEFAULT 0;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS tool_failure_detector_log_cursor integer;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS tool_failure_retry_exhausted_audit_emitted integer DEFAULT 0;
