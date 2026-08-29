-- FNXC:LifecycleOutbox 2026-08-01-10:33:
-- PostgreSQL needs a durable, cross-process observation record for task:deleted after
-- FN-8683 removed the unreachable SQLite polling replica. The event and delete state
-- must commit together; the transactional counter avoids MAX(seq)+1 collisions and,
-- unlike a SEQUENCE, rolls back with a failed delete. Schema-applier versions run once,
-- while the policy/trigger guards keep repaired manual re-runs executable.
CREATE TABLE IF NOT EXISTS project.task_lifecycle_events (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  seq bigint NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  task_id text NOT NULL,
  occurred_at text NOT NULL,
  created_at text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (project_id, seq),
  UNIQUE (project_id, event_id),
  CONSTRAINT task_lifecycle_events_type_check CHECK (event_type IN ('task:deleted'))
);
CREATE INDEX IF NOT EXISTS "idxTaskLifecycleEventsTask" ON project.task_lifecycle_events(project_id, task_id);
ALTER TABLE project.task_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_lifecycle_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_lifecycle_events;
CREATE POLICY fusion_project_isolation ON project.task_lifecycle_events
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_lifecycle_events;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

CREATE TABLE IF NOT EXISTS project.task_lifecycle_event_seq (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  last_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id)
);
ALTER TABLE project.task_lifecycle_event_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_lifecycle_event_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_lifecycle_event_seq;
CREATE POLICY fusion_project_isolation ON project.task_lifecycle_event_seq
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_lifecycle_event_seq;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_lifecycle_event_seq
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
