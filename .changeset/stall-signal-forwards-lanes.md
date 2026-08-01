---
"@runfusion/fusion": patch
---

summary: Review cards no longer all report a false stall on boards with renamed columns.
category: fix
dev: `getInReviewStallReason` satisfied its own lane check from `context.reviewColumns` but called `getTaskMergeBlocker` without them, so the helper re-checked against the literal `in-review` and returned an identity message for every healthy card — surfaced as a merge-blocker stall, and masking the real reason on genuinely failed ones.
