---
"@runfusion/fusion": minor
---

summary: Add a "Run tasks in worktrees" toggle — turn it off to cap capacity by agent count alone.
category: feature
dev: New project setting `worktreesEnabled` (default true). When false, `resolveWorktreeCapacityLimit` returns null and the scheduler builds no worktree gate at all, so `maxWorktrees` is structurally incapable of binding rather than merely generous; `ConcurrencyGateDiagnostic.maxWorktreesGate` is now optional and the queued-reason string omits the worktree line. Absent `worktreesEnabled` reads as true, so existing projects keep their cap. Also deletes `maxTriageConcurrent`, which had zero enforcement reads since FN-8453 removed its pool — the `/config` response no longer includes it.
