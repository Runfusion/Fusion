/*
FNXC:PatchnodeLedger 2026-08-28-12:16:
Patchnode intentionally has no REFERENCES clause. Archive cleanup hard-deletes task rows to activate sibling cascades, while this permanent, denormalized delivery history must survive that deletion.
*/
CREATE TABLE IF NOT EXISTS project.patchnode_entries (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  entry_id text NOT NULL,
  task_id text NOT NULL,
  kind text NOT NULL,
  occurrence_key text NOT NULL,
  day text NOT NULL,
  occurred_at text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  reverts_entry_id text,
  reverted_at text,
  reverted_commit_sha text,
  created_at text NOT NULL,
  PRIMARY KEY (project_id, entry_id),
  CONSTRAINT patchnode_entries_kind_check CHECK (kind IN ('completed', 'reverted'))
);
CREATE INDEX IF NOT EXISTS "idxPatchnodeEntriesFeed" ON project.patchnode_entries(project_id, day DESC, occurred_at DESC);
CREATE INDEX IF NOT EXISTS "idxPatchnodeEntriesTaskKind" ON project.patchnode_entries(project_id, task_id, kind, occurred_at DESC);
ALTER TABLE project.patchnode_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.patchnode_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.patchnode_entries;
CREATE POLICY fusion_project_isolation ON project.patchnode_entries
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.patchnode_entries;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.patchnode_entries
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
