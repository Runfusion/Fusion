---
"@runfusion/fusion": minor
---

summary: Pin each task to one derivable worktree directory when worktree naming is "Task ID".
category: feature
dev: `worktreeNaming: "task-id"` now enables task-pinned worktrees — a task always lives in `<worktreesDir>/<task-id>` (derive → validate → reuse-or-recreate in `worktree-pinning.ts`/`worktree-acquisition.ts`), and stale/foreign `task.worktree` metadata self-corrects (audit `worktree:pin-rederived`) without consuming session retries. Task pinning and `recycleWorktrees` are mutually exclusive: enabling both is rejected at the settings-write boundary (`assertWorktreeNamingRecycleExclusive`, enforced in `store.updateSettings` + dashboard `PUT /settings`), the Settings → Worktrees UI enforces the exclusivity bidirectionally (disabling whichever control would create the conflict), and pinning applies only when recycling is off. `"random"`/`"task-title"` naming and the recycle pool are unchanged; worktrunk-managed layouts bypass pinning.
