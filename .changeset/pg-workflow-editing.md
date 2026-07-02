---
"@runfusion/fusion": minor
---

summary: Creating, editing, and deleting custom workflows works on the PostgreSQL backend.
category: feature
dev: Completes the workflow-definition write path in PG. Adds a next_workflow_definition_id counter to project.config (schema + 0000_initial.sql baseline) with an async counter (nextWorkflowDefinitionIdAsyncImpl) that preserves project settings on bump; createWorkflowDefinitionImpl gains a backend branch that INSERTs into project.workflows via Drizzle (ir/layout as jsonb objects). Complements the update/delete/select backend branches in workflow-ops.ts. Adds workflow-create.pg.test.ts to test:pg-gate.
