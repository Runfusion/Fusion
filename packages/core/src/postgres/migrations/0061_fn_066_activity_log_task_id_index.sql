/*
FNXC:ActivityLogTaskSearch 2026-08-20-04:17:
Activity Log task search filters durable central history by an exact ID, so upgraded databases need the same
(task_id, timestamp DESC) index as fresh schemas before operators query a task across project/type filters.
*/
CREATE INDEX IF NOT EXISTS "idxCentralActivityLogTaskIdTimestamp"
  ON central.central_activity_log(task_id, timestamp DESC);
