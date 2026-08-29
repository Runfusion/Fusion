-- FNXC:TaskVerificationRequest 2026-07-30-00:00: durable, project-scoped chat-to-executor verification queue.
CREATE TABLE IF NOT EXISTS project.task_verification_requests (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  task_id text NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL,
  profile text NOT NULL,
  command text NOT NULL,
  scope text NOT NULL,
  requested_by text NOT NULL,
  requested_at text NOT NULL,
  started_at text,
  completed_at text,
  result jsonb,
  rejection_reason text,
  PRIMARY KEY (project_id, task_id),
  UNIQUE (project_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_task_verification_requests_status
  ON project.task_verification_requests(project_id, status, requested_at);
