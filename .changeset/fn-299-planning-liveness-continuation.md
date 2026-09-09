---
"@runfusion/fusion": patch
---

summary: A task being planned is no longer treated as abandoned work and re-dispatched mid-planning.
category: fix
dev: `reconcileStrandedWorkflowContinuations` now consults `isPlanningLive` alongside the session registry and executing-task lock, so a planner that holds no worktree (post plan-before-worktree) is not read as a dead lease.
