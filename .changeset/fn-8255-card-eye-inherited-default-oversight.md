---
"@runfusion/fusion": patch
---

summary: Hide the task-card overseer eye when a workflow only uses the default (unconfigured) oversight level.
category: fix
dev: TaskCard's showPlannerOverseerStateBadge now reuses showOversightBadge, so the transient eye follows the same FN-7539 inherited-default suppression as the oversight-level badge — an autonomous tier reached purely by workflow inheritance (no explicit per-task/workflow override) renders no eye even with a stale non-idle plannerOverseerState. FN-8221/FN-8239/FN-8251 guards are unchanged.
