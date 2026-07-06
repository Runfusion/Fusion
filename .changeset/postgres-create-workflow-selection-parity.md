---
"@runfusion/fusion": patch
---

summary: Fix task creation dropping the workflow selection when a workflow and step toggles are submitted together.
category: fix
dev: PostgreSQL create paths in task-creation.ts predated the SQLite-side FNXC:WorkflowCreation 2026-06-28 fix; they now record task_workflow_selection with explicit stepIds, and serialization.ts hydrates an explicit empty enabledWorkflowSteps as [] (not undefined). Store-integration coverage in builtin-workflows.test.ts ported to the shared PG harness (pgDescribe).
