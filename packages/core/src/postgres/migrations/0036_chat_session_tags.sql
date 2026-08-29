-- FNXC:ChatTags 2026-08-05-10:55:
-- Direct conversation tags have an explicit project scope and normalized name so
-- whitespace/case variants cannot split one reusable category. Assignment rows
-- cascade with either parent; store transactions additionally prove a tag and
-- session share the same scope before writing.
CREATE TABLE IF NOT EXISTS project.chat_tags (
  id text NOT NULL,
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  owner_project_id text NOT NULL DEFAULT '__default__',
  name text NOT NULL,
  normalized_name text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT chat_tags_normalized_name_nonempty CHECK (length(normalized_name) > 0),
  PRIMARY KEY (project_id, id),
  CONSTRAINT uq_chat_tags_scope_name UNIQUE (project_id, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_chat_tags_scope_name ON project.chat_tags(project_id, normalized_name);

-- Some upgrade-recovery fixtures materialize only a partial historical schema.
-- Do not stamp a broken assignment table before its session parent exists; a normal
-- 0000 upgrade always has chat_sessions and receives both cascading constraints.
DO $$
BEGIN
  IF to_regclass('project.chat_sessions') IS NOT NULL THEN
    -- FNXC:ChatTags 2026-08-05-12:15: legacy sessions use `id` as their primary
    -- key, so establish the project/id candidate key before scoped assignments
    -- reference it. The global ID primary key keeps this addition safe for rows
    -- already present on upgraded clusters.
    ALTER TABLE project.chat_sessions
      ADD CONSTRAINT chat_sessions_project_id_id_key UNIQUE (project_id, id);

    CREATE TABLE IF NOT EXISTS project.chat_session_tags (
      session_id text NOT NULL,
      tag_id text NOT NULL,
      project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
      assigned_at text NOT NULL,
      PRIMARY KEY (project_id, session_id, tag_id),
      CONSTRAINT chat_session_tags_session_fk FOREIGN KEY (project_id, session_id)
        REFERENCES project.chat_sessions(project_id, id) ON DELETE CASCADE,
      CONSTRAINT chat_session_tags_tag_fk FOREIGN KEY (project_id, tag_id)
        REFERENCES project.chat_tags(project_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session_tags_tag ON project.chat_session_tags(project_id, tag_id, session_id);
  END IF;
END $$;

ALTER TABLE project.chat_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.chat_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.chat_tags;
CREATE POLICY fusion_project_isolation ON project.chat_tags USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true)) WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.chat_tags;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.chat_tags FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
DO $$
BEGIN
  IF to_regclass('project.chat_session_tags') IS NOT NULL THEN
    ALTER TABLE project.chat_session_tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE project.chat_session_tags FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS fusion_project_isolation ON project.chat_session_tags;
    CREATE POLICY fusion_project_isolation ON project.chat_session_tags USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true)) WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
    DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.chat_session_tags;
    CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.chat_session_tags FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
  END IF;
END $$;
