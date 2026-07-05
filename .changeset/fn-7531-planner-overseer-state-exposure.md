---
"@runfusion/fusion": minor
---

summary: Task cards can now show the planner overseer's active state (idle/watching/steering/recovering/awaiting-confirmation).
category: feature
dev: Adds a serializable `PlannerOverseerRuntimeSnapshot` + pure `derivePlannerOverseerState` (core), a read-only `ProjectEngine.getPlannerOverseerRuntimeSnapshot(taskId)` accessor assembling it from the FN-7511 monitor + FN-7512/7513 recovery controller, and a best-effort additive `plannerOverseerState` enrichment on `GET /api/tasks` (mirrors the `branchProgress` pattern; never persisted, never fails the board load). Consumed by FN-7516's TaskCard.
