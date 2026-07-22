---
"@runfusion/fusion": patch
---

summary: Stop workflow-definition creates from failing when a WF-id is already taken.
category: fix
dev: createWorkflowDefinition allocates past occupied global workflows.id values and retries id-PK unique conflicts instead of leaking Postgres 23505 to plugins/API callers (multi-project / stale next_workflow_definition_id).
