---
"@runfusion/fusion": patch
---

summary: Auto-recover tasks whose workflow step hits a missing or recycled worktree instead of parking them failed forever.
category: fix
dev: FN-7996 root cause set — `handleGraphFailure` routes `assertValidWorktreeSession` refusals from any graph node into the bounded worktree-session recovery (clear stale metadata, requeue todo, budgeted by `worktreeSessionRetryCount`); `graphFailureValue` now resolves optional-group `group::template` materialized ids so group routing values (e.g. the FN-7977 plan-review provider-failure hold) are visible; Plan Review runs from the repo root when its recorded worktree is gone (spec is store-injected).
