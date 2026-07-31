---
"@runfusion/fusion": minor
---

summary: Add a "Limit concurrent worktrees" toggle — turn it off and Max Concurrent Tasks becomes the only limit.
category: feature
dev: New project setting `worktreeLimitEnabled` (default true). It is CAPACITY ONLY: tasks still execute in their own git worktree with it off — it decides whether the worktree count is a second limit alongside the agent count. When false, `resolveWorktreeCapacityLimit` returns null and the scheduler builds no worktree gate at all, so `maxWorktrees` is structurally incapable of binding rather than merely generous; `ConcurrencyGateDiagnostic.maxWorktreesGate` is now optional and the queued-reason string omits the worktree line. Absent `worktreeLimitEnabled` reads as true, so existing projects keep their cap. Also deletes `maxTriageConcurrent`, which had zero enforcement reads since FN-8453 removed its pool — the `/config` response no longer includes it.
