/* FNXC:WhiteboardAlpha 2026-09-10-05:42: Upgraded projects receive revision-fenced structured Whiteboards and immutable snapshots under the same project RLS identity. */
/* FNXC:OverlapWaitSynchronization 2026-09-10-05:42: The next forward migration corrects 0075's owner FK to permit the established atomic project-partition rekey path without rewriting the already-released migration. */
ALTER TABLE IF EXISTS project.task_overlap_waits DROP CONSTRAINT IF EXISTS fk_task_overlap_wait_owner;
ALTER TABLE IF EXISTS project.task_overlap_waits ADD CONSTRAINT fk_task_overlap_wait_owner FOREIGN KEY (project_id, task_id) REFERENCES project.tasks(project_id, id) ON UPDATE CASCADE ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS project.whiteboards (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), id text NOT NULL,
  title text NOT NULL, document jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
  created_at text NOT NULL, updated_at text NOT NULL,
  PRIMARY KEY (project_id, id),
  CONSTRAINT whiteboards_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT whiteboards_document_length CHECK (octet_length(document::text) <= 5242880),
  CONSTRAINT whiteboards_revision_positive CHECK (revision >= 1)
);
CREATE INDEX IF NOT EXISTS "idxWhiteboardsProjectUpdatedAt" ON project.whiteboards (project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS "idxWhiteboardsProjectTitle" ON project.whiteboards (project_id, title);
CREATE TABLE IF NOT EXISTS project.whiteboard_revisions (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true), whiteboard_id text NOT NULL,
  revision integer NOT NULL, title text NOT NULL, document jsonb NOT NULL, created_at text NOT NULL,
  PRIMARY KEY (project_id, whiteboard_id, revision),
  FOREIGN KEY (project_id, whiteboard_id) REFERENCES project.whiteboards(project_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT whiteboard_revisions_document_length CHECK (octet_length(document::text) <= 5242880),
  CONSTRAINT whiteboard_revisions_revision_positive CHECK (revision >= 1)
);
CREATE INDEX IF NOT EXISTS "idxWhiteboardRevisionsRecent" ON project.whiteboard_revisions (project_id, whiteboard_id, revision DESC);

ALTER TABLE project.whiteboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.whiteboards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.whiteboards;
CREATE POLICY fusion_project_isolation ON project.whiteboards
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.whiteboards;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.whiteboards FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
ALTER TABLE project.whiteboard_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.whiteboard_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.whiteboard_revisions;
CREATE POLICY fusion_project_isolation ON project.whiteboard_revisions
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.whiteboard_revisions;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.whiteboard_revisions FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
