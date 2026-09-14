-- FNXC:WorkflowIdentity 2026-09-14-19:06:
-- `builtin:coding-ideas` is the durable Coding (Ideas) identity. The temporary v2
-- publication must collapse onto it transactionally, while conflicting operator
-- settings and prompt overrides remain recoverable and project-isolated.

CREATE TABLE IF NOT EXISTS project.archived_workflow_settings (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  archive_id text NOT NULL,
  workflow_id text NOT NULL,
  replacement_workflow_id text,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at text NOT NULL,
  archived_at text NOT NULL,
  reason text NOT NULL CONSTRAINT archived_workflow_settings_reason CHECK (reason IN ('identity-merge-loser', 'model-lane-reset')),
  PRIMARY KEY (project_id, workflow_id, reason, archived_at),
  CONSTRAINT uq_archived_workflow_settings_episode UNIQUE (project_id, archive_id)
);
CREATE INDEX IF NOT EXISTS idx_archived_workflow_settings_project_workflow
  ON project.archived_workflow_settings(project_id, workflow_id);

CREATE TABLE IF NOT EXISTS project.workflow_prompt_overrides_archive (
  project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
  archive_id text NOT NULL,
  workflow_id text NOT NULL,
  replacement_workflow_id text,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at text NOT NULL,
  archived_at text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (project_id, archive_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_prompt_overrides_archive_project_workflow
  ON project.workflow_prompt_overrides_archive(project_id, workflow_id);

ALTER TABLE project.archived_workflow_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.archived_workflow_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.archived_workflow_settings;
CREATE POLICY fusion_project_isolation ON project.archived_workflow_settings
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.archived_workflow_settings;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.archived_workflow_settings
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

ALTER TABLE project.workflow_prompt_overrides_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE project.workflow_prompt_overrides_archive FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fusion_project_isolation ON project.workflow_prompt_overrides_archive;
CREATE POLICY fusion_project_isolation ON project.workflow_prompt_overrides_archive
  USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
  WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
DROP TRIGGER IF EXISTS fusion_assign_project_id ON project.workflow_prompt_overrides_archive;
CREATE TRIGGER fusion_assign_project_id BEFORE INSERT OR UPDATE OF project_id ON project.workflow_prompt_overrides_archive
  FOR EACH ROW EXECUTE FUNCTION project.fusion_assign_project_id();

-- The v2 row is the configuration users were actually executing. If both ids
-- exist, archive the old canonical row rather than merging keys into the winner.
-- Historical schema-applier fixtures can predate these runtime tables; the real
-- 0000 baseline always has all four and therefore enters this branch.
DO $migration$
BEGIN
IF to_regclass('project.workflow_settings') IS NOT NULL
   AND to_regclass('project.workflow_prompt_overrides') IS NOT NULL
   AND to_regclass('project.task_workflow_selection') IS NOT NULL
   AND to_regclass('project.boards') IS NOT NULL THEN
INSERT INTO project.archived_workflow_settings (
  project_id, archive_id, workflow_id, replacement_workflow_id, values,
  source_updated_at, archived_at, reason
)
SELECT old.project_id,
       md5(old.project_id || ':settings:identity-loser:' || old.workflow_id || ':' || old.updated_at || ':' || COALESCE(old.values, '{}'::jsonb)::text),
       old.workflow_id, 'builtin:coding-ideas', COALESCE(old.values, '{}'::jsonb),
       old.updated_at, clock_timestamp()::text, 'identity-merge-loser'
FROM project.workflow_settings old
WHERE old.workflow_id = 'builtin:coding-ideas'
  AND EXISTS (
    SELECT 1 FROM project.workflow_settings winner
    WHERE winner.project_id = old.project_id
      AND winner.workflow_id = 'builtin:coding-ideas-v2'
  )
ON CONFLICT (project_id, archive_id) DO NOTHING;

INSERT INTO project.workflow_prompt_overrides_archive (
  project_id, archive_id, workflow_id, replacement_workflow_id, overrides,
  source_updated_at, archived_at, reason
)
SELECT old.project_id,
       md5(old.project_id || ':prompts:identity-loser:' || old.workflow_id || ':' || old.updated_at || ':' || old.overrides::text),
       old.workflow_id, 'builtin:coding-ideas', old.overrides,
       old.updated_at, clock_timestamp()::text, 'identity-merge-loser'
FROM project.workflow_prompt_overrides old
WHERE old.workflow_id = 'builtin:coding-ideas'
  AND EXISTS (
    SELECT 1 FROM project.workflow_prompt_overrides winner
    WHERE winner.project_id = old.project_id
      AND winner.workflow_id = 'builtin:coding-ideas-v2'
  )
ON CONFLICT (project_id, archive_id) DO NOTHING;

-- Project-model lanes were historically written into whichever workflow happened
-- to be selected. Preserve each affected row before removing only model selectors;
-- workflow policy values in the same JSON object remain active. Operator decision: do not
-- migrate these abandoned values to project settings. Their semantics change from project
-- baseline to stronger workflow override; carrying them forward would silently make them win.
INSERT INTO project.archived_workflow_settings (
  project_id, archive_id, workflow_id, replacement_workflow_id, values,
  source_updated_at, archived_at, reason
)
SELECT row.project_id,
       md5(row.project_id || ':settings:model-lanes:' || row.workflow_id || ':' || row.updated_at || ':' || COALESCE(row.values, '{}'::jsonb)::text),
       row.workflow_id,
       CASE WHEN row.workflow_id = 'builtin:coding-ideas-v2' THEN 'builtin:coding-ideas' ELSE row.workflow_id END,
       COALESCE(row.values, '{}'::jsonb), row.updated_at, clock_timestamp()::text,
       'model-lane-reset'
FROM project.workflow_settings row
WHERE COALESCE(row.values, '{}'::jsonb) ?| ARRAY[
  'executionProvider', 'executionModelId', 'executionThinkingLevel', 'executionCredentialInstanceId',
  'executionFallbackProvider', 'executionFallbackModelId', 'executionFallbackThinkingLevel', 'executionFallbackCredentialInstanceId',
  'planningProvider', 'planningModelId', 'planningThinkingLevel', 'planningCredentialInstanceId',
  'planningFallbackProvider', 'planningFallbackModelId', 'planningFallbackThinkingLevel', 'planningFallbackCredentialInstanceId',
  'validatorProvider', 'validatorModelId', 'validatorThinkingLevel', 'validatorCredentialInstanceId',
  'validatorFallbackProvider', 'validatorFallbackModelId', 'validatorFallbackThinkingLevel', 'validatorFallbackCredentialInstanceId'
]
ON CONFLICT (project_id, archive_id) DO NOTHING;

UPDATE project.workflow_settings
SET values = COALESCE(values, '{}'::jsonb) - ARRAY[
  'executionProvider', 'executionModelId', 'executionThinkingLevel', 'executionCredentialInstanceId',
  'executionFallbackProvider', 'executionFallbackModelId', 'executionFallbackThinkingLevel', 'executionFallbackCredentialInstanceId',
  'planningProvider', 'planningModelId', 'planningThinkingLevel', 'planningCredentialInstanceId',
  'planningFallbackProvider', 'planningFallbackModelId', 'planningFallbackThinkingLevel', 'planningFallbackCredentialInstanceId',
  'validatorProvider', 'validatorModelId', 'validatorThinkingLevel', 'validatorCredentialInstanceId',
  'validatorFallbackProvider', 'validatorFallbackModelId', 'validatorFallbackThinkingLevel', 'validatorFallbackCredentialInstanceId'
]
WHERE COALESCE(values, '{}'::jsonb) ?| ARRAY[
  'executionProvider', 'executionModelId', 'executionThinkingLevel', 'executionCredentialInstanceId',
  'executionFallbackProvider', 'executionFallbackModelId', 'executionFallbackThinkingLevel', 'executionFallbackCredentialInstanceId',
  'planningProvider', 'planningModelId', 'planningThinkingLevel', 'planningCredentialInstanceId',
  'planningFallbackProvider', 'planningFallbackModelId', 'planningFallbackThinkingLevel', 'planningFallbackCredentialInstanceId',
  'validatorProvider', 'validatorModelId', 'validatorThinkingLevel', 'validatorCredentialInstanceId',
  'validatorFallbackProvider', 'validatorFallbackModelId', 'validatorFallbackThinkingLevel', 'validatorFallbackCredentialInstanceId'
];

DELETE FROM project.workflow_settings old
WHERE old.workflow_id = 'builtin:coding-ideas'
  AND EXISTS (
    SELECT 1 FROM project.workflow_settings winner
    WHERE winner.project_id = old.project_id
      AND winner.workflow_id = 'builtin:coding-ideas-v2'
  );
UPDATE project.workflow_settings
SET workflow_id = 'builtin:coding-ideas'
WHERE workflow_id = 'builtin:coding-ideas-v2';

DELETE FROM project.workflow_prompt_overrides old
WHERE old.workflow_id = 'builtin:coding-ideas'
  AND EXISTS (
    SELECT 1 FROM project.workflow_prompt_overrides winner
    WHERE winner.project_id = old.project_id
      AND winner.workflow_id = 'builtin:coding-ideas-v2'
  );
UPDATE project.workflow_prompt_overrides
SET workflow_id = 'builtin:coding-ideas'
WHERE workflow_id = 'builtin:coding-ideas-v2';

UPDATE project.task_workflow_selection
SET workflow_id = 'builtin:coding-ideas'
WHERE workflow_id = 'builtin:coding-ideas-v2';

UPDATE project.boards
SET workflow_id = 'builtin:coding-ideas'
WHERE workflow_id = 'builtin:coding-ideas-v2';
END IF;
END
$migration$;

-- Config contains scalar selection overrides, enabled-id arrays, and capacity-pool
-- maps. A recursive exact-string rewrite covers every persisted setting shape
-- without rewriting prose that merely mentions the retired id.
CREATE OR REPLACE FUNCTION project.fn_0079_rewrite_builtin_workflow_identity(value jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE jsonb_typeof(value)
    WHEN 'string' THEN CASE
      WHEN value = '"builtin:coding-ideas-v2"'::jsonb THEN '"builtin:coding-ideas"'::jsonb
      ELSE value
    END
    WHEN 'array' THEN COALESCE((
      SELECT jsonb_agg(project.fn_0079_rewrite_builtin_workflow_identity(element) ORDER BY ordinality)
      FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(element, ordinality)
    ), '[]'::jsonb)
    WHEN 'object' THEN COALESCE((
      SELECT jsonb_object_agg(
        CASE WHEN key = 'builtin:coding-ideas-v2' THEN 'builtin:coding-ideas' ELSE key END,
        project.fn_0079_rewrite_builtin_workflow_identity(member)
        ORDER BY (key = 'builtin:coding-ideas-v2')
      )
      FROM jsonb_each(value) AS entries(key, member)
    ), '{}'::jsonb)
    ELSE value
  END
$fn$;

DO $migration$
BEGIN
IF to_regclass('project.config') IS NOT NULL THEN
  -- Preserve the complete config preimage, including a losing capacity-pool entry,
  -- before the executed v2 key wins an exact-identity object-key collision.
  INSERT INTO project.archived_workflow_settings (
    project_id, archive_id, workflow_id, replacement_workflow_id, values,
    source_updated_at, archived_at, reason
  )
  SELECT project_id, md5(project_id || ':config:identity:' || settings::text),
    'builtin:coding-ideas', 'builtin:coding-ideas',
    jsonb_build_object('source', 'project.config', 'settings', settings),
    updated_at, clock_timestamp()::text, 'identity-merge-loser'
  FROM project.config
  WHERE COALESCE(settings, '{}'::jsonb)::text LIKE '%builtin:coding-ideas-v2%'
  ON CONFLICT (project_id, archive_id) DO NOTHING;

  UPDATE project.config
  SET settings = project.fn_0079_rewrite_builtin_workflow_identity(COALESCE(settings, '{}'::jsonb))
  WHERE COALESCE(settings, '{}'::jsonb)::text LIKE '%builtin:coding-ideas-v2%';

  UPDATE project.config
  SET settings = jsonb_set(settings, '{enabledBuiltinWorkflowIds}', (
    SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinality), '[]'::jsonb)
    FROM (
      SELECT value, min(ordinality) AS first_ordinality
      FROM jsonb_array_elements(settings->'enabledBuiltinWorkflowIds') WITH ORDINALITY AS ids(value, ordinality)
      GROUP BY value
    ) deduplicated
  ))
  WHERE jsonb_typeof(settings->'enabledBuiltinWorkflowIds') = 'array';
END IF;
END
$migration$;

DROP FUNCTION project.fn_0079_rewrite_builtin_workflow_identity(jsonb);
