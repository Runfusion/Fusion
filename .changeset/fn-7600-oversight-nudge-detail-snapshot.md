---
"@runfusion/fusion": patch
---

summary: Fix the task-detail Nudge control staying disabled when the overseer is actively watching.
category: fix
dev: GET /api/tasks/:id now attaches the transient plannerOverseerState snapshot (mirrors the list route); TaskDetailModal reads the snapshot from workingTask so detail refetches no longer drop it.
