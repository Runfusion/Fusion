---
"@runfusion/fusion": patch
---

summary: Three more self-healing repairs use your board's own column names, including one that could disturb a running task.
category: fix
dev: Converts the worktree-metadata reconcile, orphaned-pending-step-results, and agent-link-drift sweeps in `self-healing.ts` to `resolveProjectColumnsForRoles`.
