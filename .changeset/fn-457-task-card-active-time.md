---
"@runfusion/fusion": minor
---

summary: Task card clock chip now shows real worked time, with a planning/execution/verification tooltip.
category: feature
dev: Adds durable `cumulativePausedMs` / `pausedStartedAt` columns (migration `0081_fn_457_task_pause_accounting.sql`, registered in `schema-applier.ts`) plus the shared `tasks/task-pause-accounting.ts` writer wired into every seam that writes `task.paused`, guarded by a source census test. Dashboard `taskTiming.ts` gains `getVerificationRuntimeMs` (allow-list + interval union, excluding Plan Review and `source: "node"` results) and `getTaskRuntimeBreakdown`, which replaces the four lane-specific duration helpers in `TaskCard.tsx`. `getWorkflowRuntimeMs` is unchanged.
