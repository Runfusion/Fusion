-- FNXC:SymbolLock 2026-07-30-14:10:
-- Durable mission-lineage admission locks require an upgraded-install table and
-- the complete project ownership contract. The baseline intentionally omits
-- this block because 0006 creates the trigger function and policy machinery.
CREATE TABLE IF NOT EXISTS project.symbol_locks (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  symbol_key text NOT NULL,
  owner_task_id text NOT NULL,
  mission_id text,
  feature_id text,
  lineage_id text,
  node_id text,
  agent_id text,
  status text NOT NULL,
  acquired_at text NOT NULL,
  renewed_at text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, symbol_key),
  CONSTRAINT symbol_locks_status_check CHECK (status IN ('held', 'released', 'expired'))
);
CREATE INDEX IF NOT EXISTS "idxSymbolLocksOwner"
  ON project.symbol_locks(project_id, owner_task_id);
CREATE INDEX IF NOT EXISTS "idxSymbolLocksExpiry"
  ON project.symbol_locks(status, expires_at);

ALTER TABLE project.symbol_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.symbol_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.symbol_locks;
CREATE POLICY fusion_project_isolation ON project.symbol_locks
  USING (
    current_setting('fusion.project_bypass', true) = 'on'
    OR project_id = current_setting('fusion.project_id', true)
  )
  WITH CHECK (
    current_setting('fusion.project_bypass', true) = 'on'
    OR project_id = current_setting('fusion.project_id', true)
  );
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.symbol_locks;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.symbol_locks
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

-- FNXC:TaskVerificationRequest 2026-07-30-14:30: 0024 was already a
-- published migration when its post-0006 ownership omission was discovered;
-- repair existing 0024 installations here instead of mutating its identity.
ALTER TABLE project.task_verification_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.task_verification_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.task_verification_requests;
CREATE POLICY fusion_project_isolation ON project.task_verification_requests
  USING (
    current_setting('fusion.project_bypass', true) = 'on'
    OR project_id = current_setting('fusion.project_id', true)
  )
  WITH CHECK (
    current_setting('fusion.project_bypass', true) = 'on'
    OR project_id = current_setting('fusion.project_id', true)
  );
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.task_verification_requests;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.task_verification_requests
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
