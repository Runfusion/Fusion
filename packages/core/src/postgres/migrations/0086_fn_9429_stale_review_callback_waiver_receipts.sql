-- FN-9429: authoritative receipt for automatic stale code-review callback waivers.
CREATE TABLE IF NOT EXISTS project.stale_review_callback_waiver_receipts (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  id text NOT NULL,
  task_id text NOT NULL,
  workflow_step_id text NOT NULL,
  attempt_id text NOT NULL,
  policy_version text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  issued_at text NOT NULL,
  state text NOT NULL DEFAULT 'issued',
  PRIMARY KEY (project_id, id),
  CONSTRAINT stale_review_callback_waiver_receipts_task_fk
    FOREIGN KEY (project_id, task_id) REFERENCES project.tasks(project_id, id)
      ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT stale_review_callback_waiver_receipts_attempt_unique
    UNIQUE (project_id, task_id, workflow_step_id, attempt_id),
  CONSTRAINT stale_review_callback_waiver_receipts_state_check CHECK (state IN ('issued', 'revoked')),
  CONSTRAINT stale_review_callback_waiver_receipts_policy_check CHECK (policy_version = 'fn-9429-v1'),
  CONSTRAINT stale_review_callback_waiver_receipts_actor_check CHECK (actor = 'system:stale-review-callback-waiver'),
  CONSTRAINT stale_review_callback_waiver_receipts_reason_check CHECK (reason = 'proven-stale-code-review-callback')
);
/*
FNXC:StaleReviewCallbackWaiver 2026-10-03-23:08:
Fallback partition promotion updates a task's composite identity. The receipt is a task satellite, so
its composite FK must cascade that update rather than rejecting a populated project rekey.
*/
ALTER TABLE project.stale_review_callback_waiver_receipts
  DROP CONSTRAINT IF EXISTS stale_review_callback_waiver_receipts_task_fk;
ALTER TABLE project.stale_review_callback_waiver_receipts
  ADD CONSTRAINT stale_review_callback_waiver_receipts_task_fk
    FOREIGN KEY (project_id, task_id) REFERENCES project.tasks(project_id, id)
      ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_stale_review_callback_waiver_receipts_task
  ON project.stale_review_callback_waiver_receipts (project_id, task_id);

ALTER TABLE project.stale_review_callback_waiver_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.stale_review_callback_waiver_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.stale_review_callback_waiver_receipts;
CREATE POLICY fusion_project_isolation ON project.stale_review_callback_waiver_receipts
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.stale_review_callback_waiver_receipts;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.stale_review_callback_waiver_receipts
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

GRANT SELECT, INSERT, UPDATE, DELETE ON project.stale_review_callback_waiver_receipts TO fusion_runtime;
