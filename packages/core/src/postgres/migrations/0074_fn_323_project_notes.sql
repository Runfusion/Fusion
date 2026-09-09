/* FNXC:ProjectNotes 2026-09-09-17:08: Upgraded databases need the same project-scoped, revision-fenced note storage as fresh installs. */
CREATE TABLE IF NOT EXISTS project.notes (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  id text NOT NULL,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  CONSTRAINT notes_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT notes_content_length CHECK (octet_length(content) <= 1048576),
  CONSTRAINT notes_revision_positive CHECK (revision >= 1)
);
CREATE INDEX IF NOT EXISTS "idxNotesProjectUpdatedAt" ON project.notes (project_id, updated_at DESC);
ALTER TABLE project.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.notes;
CREATE POLICY fusion_project_isolation ON project.notes
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.notes;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.notes
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
