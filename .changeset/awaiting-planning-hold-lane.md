---
"@runfusion/fusion": patch
---

summary: Fix the "Queued to plan" badge never appearing on boards with a renamed waiting column.
category: fix
dev: The `GET /tasks` awaitingPlanning enrichment filtered on the literal `todo`. It now resolves the `hold` role once per board via `resolveProjectColumnsForRoles`, so a renamed waiting lane is enriched instead of silently falling back to TaskCard's step-count heuristic. One `listWorkflowDefinitions()` read per board load, not one workflow read per row — which is why the earlier per-task attempt was reverted.
