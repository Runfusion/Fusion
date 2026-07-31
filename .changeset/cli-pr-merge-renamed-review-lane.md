---
"@runfusion/fusion": patch
---

summary: Fix PR merges silently never running on boards with a renamed review lane.
category: fix
dev: `processPullRequestMergeTask` now resolves the task's own merge-orchestration lane via `resolveMergeOrchestrationColumn` and passes it to `getTaskMergeBlocker` as `reviewColumns`, instead of letting the blocker fall back to the literal `in-review` and return "skipped". Affects the `daemon`, `serve` and `dashboard` PR-merge drains. Default and v1-upgraded boards are unchanged.
