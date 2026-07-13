---
"@runfusion/fusion": minor
---

summary: Remove task mesh replication entirely — nodes replicate through the shared PostgreSQL database.
category: feature
dev: POST /mesh/tasks/create is deleted (with applyReplicatedTaskCreate and the replicated-create payload helpers); /mesh/sync shared-state is reduced to projectSettings (legacy sqlite settings sync only) + authMaterial in both directions, and the task-metadata/mission/agent/agent-run/activity-log/run-audit snapshot machinery is removed from the stores; /mesh/task-ids/* never forwards to a remote coordinator in backend mode (the shared distributed_task_id_state rows are the coordinator). Peer topology exchange unchanged.
