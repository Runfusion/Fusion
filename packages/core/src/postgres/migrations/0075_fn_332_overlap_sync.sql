/*
FNXC:OverlapWaitSynchronization 2026-09-09-23:53:
A file-scope wait remains durable after its display marker clears. The owner task has a composite foreign key, while blocker identity is a snapshot so deletion or archival of the delivered predecessor cannot erase synchronization evidence.
*/
CREATE TABLE IF NOT EXISTS project.task_overlap_waits (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  task_id text NOT NULL,
  episode_id text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  blocker_task_id text NOT NULL,
  task_lineage_id text,
  blocker_lineage_id text,
  observed_at text NOT NULL,
  plan_fingerprint text,
  phase text NOT NULL DEFAULT 'observed',
  revision integer NOT NULL DEFAULT 1,
  owner text,
  attempt integer NOT NULL DEFAULT 0,
  checkout_epoch text,
  observation jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt jsonb,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, task_id, episode_id),
  CONSTRAINT fk_task_overlap_wait_owner FOREIGN KEY (project_id, task_id)
    REFERENCES project.tasks(project_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_task_overlap_wait_phase CHECK (phase IN ('observed','analyzing','freshness-pending','revalidation-pending','ready','delivered','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_overlap_wait_open_blocker
  ON project.task_overlap_waits(project_id, task_id, blocker_task_id)
  WHERE phase NOT IN ('delivered', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_task_overlap_wait_unconsumed
  ON project.task_overlap_waits(project_id, task_id, observed_at)
  WHERE phase NOT IN ('delivered', 'cancelled');

ALTER TABLE project.task_overlap_waits ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_overlap_waits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_overlap_waits;
CREATE POLICY fusion_project_isolation ON project.task_overlap_waits
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_overlap_waits;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.task_overlap_waits
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

GRANT SELECT, INSERT, UPDATE, DELETE ON project.task_overlap_waits TO fusion_runtime;
