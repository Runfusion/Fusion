---
"@runfusion/fusion": patch
---

summary: A card whose Plan Review passed now resumes past that gate instead of replaying planning on every automatic retry.
category: fix
dev: Resume placement is decided by one shared evidence-aware resolver, `resolveResumePlacement` in `packages/engine/src/workflows/resume-placement.ts` — a gate whose latest step result is `passed`, satisfies core's `isPlanReviewSatisfied`, or carries an operator `bypassedBy` waiver is never re-dispatched, and the run enters the IR's own successor node (for the built-in coding IR that is `parse`). Two-actor release rule is unchanged: the graph only records the ready-for-release seam (`suspended`, reason `capacity`) and moves no column, while `packages/engine/src/execution/hold-release.ts` remains the sole `hold → wip` mover. New run-audit event `task:resume-placement-mismatch` reports a pin/column disagreement with ids and fixed enums only, classifying a legal seam park (`pin-at-release-seam`) apart from genuine incoherence.
