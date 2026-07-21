ALTER TABLE project.workflow_work_items
  ADD COLUMN IF NOT EXISTS stable_workflow_run_id text,
  ADD COLUMN IF NOT EXISTS continuation_sequence integer,
  ADD COLUMN IF NOT EXISTS wait_reason text,
  ADD COLUMN IF NOT EXISTS source_column text,
  ADD COLUMN IF NOT EXISTS target_column text,
  ADD COLUMN IF NOT EXISTS ir_hash text;

-- Older builds could leave more than one active task work item. Preserve the
-- newest continuation and retire the rest before enforcing single ownership.
WITH ranked AS (
  SELECT project_id, id,
         row_number() OVER (
           PARTITION BY project_id, task_id
           ORDER BY updated_at DESC, id DESC
         ) AS active_rank
  FROM project.workflow_work_items
  WHERE kind = 'task' AND state IN ('runnable', 'running', 'held', 'retrying')
)
UPDATE project.workflow_work_items AS item
SET state = 'succeeded',
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now()::text
FROM ranked
WHERE item.project_id = ranked.project_id
  AND item.id = ranked.id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_work_items_one_active_task_continuation
  ON project.workflow_work_items(project_id, task_id)
  WHERE kind = 'task' AND state IN ('runnable', 'running', 'held', 'retrying');
