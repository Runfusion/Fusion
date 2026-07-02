---
"@runfusion/fusion": patch
---

summary: Workflow definitions load in PG mode — /api/workflows no longer errors.
category: fix
dev: readAllWorkflowDefinitions/getWorkflowDefinition read custom rows from project.workflows via the AsyncDataLayer in backend mode (the sync store.db SELECT threw, 500'ing /api/workflows). New async-workflow-store.ts helpers re-stringify jsonb ir/layout for the shared toWorkflowDefinition mapper; builtins still come from code constants. Every caller already awaited these reads, so no consumer changes. Adds workflow-definitions.pg.test.ts to test:pg-gate.
