/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Import auto-translation persists one translation per (project, provider, repo, issue, target locale) so re-opening the Import Tasks panel never re-bills the AI helper for an issue already translated.
`source_hash` pins the translation to the ORIGINAL title+body, so an edited issue misses the cache instead of serving stale prose. Rows are written only for OPEN issues and pruned once an issue is observed closed.

FNXC:GitHubImportTranslate 2026-07-15-09:30:
Project isolation here is the SAME contract 0006 applies to every project-owned table, not merely a `project_id` column: RLS enabled, FORCE RLS (so even the table owner is filtered), a `fusion_project_isolation` policy honouring the `fusion.project_bypass` escape used by maintenance paths, and the `fusion_assign_project_id` trigger that stamps the column from `fusion.project_id`.
All projects share this one flat `project` schema, so a table that opts out of the contract would serve one project's translations to another. `schema-applier` verifies this invariant on boot and fails closed, so a new table MUST opt in here rather than rely on query-level predicates alone.
*/
CREATE TABLE IF NOT EXISTS project.import_translation_cache (
  project_id text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__'),
  provider text NOT NULL,
  repo_key text NOT NULL,
  issue_number integer NOT NULL,
  target_locale text NOT NULL,
  source_hash text NOT NULL,
  translated_title text NOT NULL,
  translated_body text NOT NULL,
  detected_locale text,
  recorded_at text NOT NULL,
  CONSTRAINT import_translation_cache_pkey
    PRIMARY KEY (project_id, provider, repo_key, issue_number, target_locale)
);

DO $$
BEGIN
  IF to_regclass('project.import_translation_cache') IS NULL THEN
    RETURN;
  END IF;

  CREATE INDEX IF NOT EXISTS "idxImportTranslationCacheRecordedAt"
    ON project.import_translation_cache (recorded_at);

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

  -- Stamp project_id from the session setting, matching every other project table.
  IF to_regprocedure('project.fusion_assign_project_id()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.import_translation_cache;
    CREATE TRIGGER fusion_assign_project_id
      BEFORE INSERT OR UPDATE OF project_id ON project.import_translation_cache
      FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON project.import_translation_cache TO fusion_runtime;
  END IF;
END
$$;
