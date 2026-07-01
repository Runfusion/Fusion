---
"@runfusion/fusion": patch
---

summary: Stop repeat no-op phantom-reservation audit writes and preserve the worktree across phantom binding reclaim.
category: fix
dev: reconcilePhantomCommittedReservations now emits the task:reconcile-phantom-committed-reservation audit row only when orphaned child rows were actually pruned, instead of every maintenance tick (~19k wasted writes/day); the committed reservation stays committed so the ID is never reused. clearPhantomExecutorBinding gains a preserveWorktrees option the self-healing phantom reclaim uses so moveTask(preserveWorktree:true) re-dispatch reattaches to the same worktree instead of orphaning it and acquiring a new one (FN-7249). Regression: store-phantom-reservation-reconcile.test.ts, executor-workspace.test.ts.
