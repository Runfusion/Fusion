/*
FNXC:GitHubImportTranslate 2026-07-16-23:30:
0010 is already marked on deployed databases, so correcting its fresh-install
SQL cannot repair their import_translation_cache partition contract. This
forward, idempotent migration makes default, trigger, and RLS agree that an
unset/blank fusion.project_id is the explicit __legacy_unscoped__ partition.
*/
ALTER TABLE project.import_translation_cache
  ALTER COLUMN project_id SET DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__');

CREATE OR REPLACE FUNCTION project.fusion_assign_project_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.project_id := COALESCE(
    NULLIF(NEW.project_id, ''),
    NULLIF(current_setting('fusion.project_id', true), ''),
    '__legacy_unscoped__'
  );
  RETURN NEW;
END;
$$;

ALTER TABLE project.import_translation_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.import_translation_cache FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fusion_project_isolation ON project.import_translation_cache;
CREATE POLICY fusion_project_isolation ON project.import_translation_cache
  USING (
    current_setting('fusion.project_bypass', true) = 'on'
    OR project_id = COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')
  )
  WITH CHECK (
    current_setting('fusion.project_bypass', true) = 'on'
    OR project_id = COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')
  );

DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.import_translation_cache;
CREATE TRIGGER fusion_assign_project_id
  BEFORE INSERT OR UPDATE OF project_id ON project.import_translation_cache
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON project.import_translation_cache TO fusion_runtime;
  END IF;
END
$$;
