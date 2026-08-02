-- FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
-- FN-8685 adds the durable read half of the PostgreSQL task:deleted outbox. These rows
-- are partitioned by project and consumer identity so each independently observing runtime
-- has its own ordered at-least-once stream, fenced lease, receipts, and poison evidence.
CREATE TABLE IF NOT EXISTS project.task_lifecycle_consumer_registrations (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  consumer_id text NOT NULL,
  registered_at text NOT NULL,
  last_seen_at text NOT NULL,
  active integer NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS project.task_lifecycle_consumer_cursors (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  consumer_id text NOT NULL,
  last_acked_seq bigint NOT NULL DEFAULT 0,
  retry_attempts integer NOT NULL DEFAULT 0,
  retry_backoff_until text,
  lease_token text,
  fencing_token bigint NOT NULL DEFAULT 0,
  lease_expires_at text,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS project.task_lifecycle_consumer_receipts (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  consumer_id text NOT NULL,
  event_id text NOT NULL,
  seq bigint NOT NULL,
  processed_at text NOT NULL,
  PRIMARY KEY (project_id, consumer_id, event_id)
);
CREATE INDEX IF NOT EXISTS "idxTaskLifecycleConsumerReceiptsSequence" ON project.task_lifecycle_consumer_receipts(project_id, consumer_id, seq);

CREATE TABLE IF NOT EXISTS project.task_lifecycle_consumer_dead_letters (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  consumer_id text NOT NULL,
  event_id text NOT NULL,
  seq bigint NOT NULL,
  attempts integer NOT NULL,
  failure_class text NOT NULL,
  parked_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, consumer_id, event_id)
);

-- All new state has the same forced RLS and project-id trigger as the outbox writer.
ALTER TABLE project.task_lifecycle_consumer_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_lifecycle_consumer_registrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_lifecycle_consumer_registrations;
CREATE POLICY fusion_project_isolation ON project.task_lifecycle_consumer_registrations
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_lifecycle_consumer_registrations;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_lifecycle_consumer_registrations
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.task_lifecycle_consumer_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_lifecycle_consumer_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_lifecycle_consumer_cursors;
CREATE POLICY fusion_project_isolation ON project.task_lifecycle_consumer_cursors
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_lifecycle_consumer_cursors;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_lifecycle_consumer_cursors
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.task_lifecycle_consumer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_lifecycle_consumer_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_lifecycle_consumer_receipts;
CREATE POLICY fusion_project_isolation ON project.task_lifecycle_consumer_receipts
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_lifecycle_consumer_receipts;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_lifecycle_consumer_receipts
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.task_lifecycle_consumer_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_lifecycle_consumer_dead_letters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_lifecycle_consumer_dead_letters;
CREATE POLICY fusion_project_isolation ON project.task_lifecycle_consumer_dead_letters
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_lifecycle_consumer_dead_letters;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_lifecycle_consumer_dead_letters
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
