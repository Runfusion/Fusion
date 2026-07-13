---
"@runfusion/fusion": minor
---

summary: Remove task mesh replication on the PostgreSQL backend — nodes replicate through the shared database instead.
category: feature
dev: In backend mode POST /mesh/tasks/create answers 409 task-replication-disabled-postgres; /mesh/sync ignores inbound shared-state domains except authMaterial and offers only authMaterial back (peer topology exchange unchanged); /mesh/task-ids/* never forwards to a remote coordinator (the shared distributed_task_id_state rows are the coordinator). Legacy SQLite topology unchanged.
