---
"@runfusion/fusion": patch
---

summary: Replan bounces now keep the task worktree instead of tearing it down and re-cutting the branch.
category: fix
dev: `moveTaskToReplanColumn` passes `preserveWorktree: true`. `moveTask`'s reopen-to-todo/triage block cleared `task.worktree` while leaving `task.branch`, so the next planning acquisition could not resume, re-created the same `fusion/<id>` branch, collided with the orphaned worktree, and fell into `cleanupConflictingWorktree` (force-remove + `git branch -D` + fresh `git worktree add` + init command) on every bounce. Covers all replan movers: Plan Review REVISE, required-artifact recovery, and the executor/scheduler spec-staleness and filesystem-validation rebounds.
