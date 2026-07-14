-- FNXC:AutomationIsolation 2026-07-14-00:05:
-- Existing PostgreSQL installations created automations without project ownership. Derive ownership only when exactly one registered project proves it; otherwise abort with operator remediation instead of silently parking schedules where no project can inspect or run them.
ALTER TABLE project.automations
  ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project.automations WHERE project_id = '')
     AND (SELECT count(*) FROM central.projects) <> 1 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot assign legacy automations to a project',
      DETAIL = 'Legacy automation rows have no project_id and the central registry does not contain exactly one project.',
      HINT = 'Back up the database, assign project.automations.project_id explicitly, then restart Fusion to resume migration 0001.';
  END IF;
END $$;

UPDATE project.automations
SET project_id = (SELECT min(id) FROM central.projects)
WHERE project_id = '';

ALTER TABLE project.automations
  DROP CONSTRAINT IF EXISTS automations_pkey;

ALTER TABLE project.automations
  ADD CONSTRAINT automations_pkey PRIMARY KEY (project_id, id);

DROP INDEX IF EXISTS project."idxAutomationsScope";
CREATE INDEX IF NOT EXISTS "idxAutomationsProjectScope"
  ON project.automations(project_id, scope);
CREATE INDEX IF NOT EXISTS "idxAutomationsProjectDue"
  ON project.automations(project_id, enabled, next_run_at);
