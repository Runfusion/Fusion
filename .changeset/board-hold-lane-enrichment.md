---
"@runfusion/fusion": patch
---

summary: The "Queued to plan" / "Ready" badges now work on boards whose waiting lane is not called Todo.
category: fix
dev: `GET /api/tasks`'s `awaitingPlanning` enrichment filtered on the literal `todo`. It now resolves the project's `hold` lanes once per board load via `resolveProjectColumnsForRoles` — one `listWorkflowDefinitions()` read, flat in task count, with the per-row PROMPT.md reads still bounded by `AWAITING_PLANNING_ENRICH_LIMIT`.
