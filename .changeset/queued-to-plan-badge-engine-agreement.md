---
"@runfusion/fusion": patch
---

summary: "Queued to plan" and "Ready" badges now match what the engine will actually do with the card.
category: fix
dev: New shared `isTaskAwaitingPlanning` predicate (PROMPT.md seed-ness + replan park) replaces TaskCard's `steps.length` proxy; `GET /api/tasks` attaches transient `awaitingPlanning` for Todo rows (best-effort, capped at 200 reads/request), carried across same-column SSE updates while the step count is unchanged.
