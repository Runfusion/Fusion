---
"@runfusion/fusion": patch
---

summary: Fix the column capacity check so a task with no workflow selection is counted against the limit.
category: fix
dev: `moves.ts` asked `countActiveInCapacitySlotAsync` for pool `"builtin:coding"` while the counter buckets selection-less rows under `DEFAULT_WORKFLOW_POOL_ID`, so the count was always 0 and a finite limit could never bind. Both sides now derive the pool through the shared `resolveCapacityPoolId`. NOTE: no operator-visible change yet — the capacity block is still gated on `experimentalFeatures.workflowColumns`, which nothing in production sets (Phase A3 R2). If that gate is removed, this becomes user-visible and the changeset should be re-categorised.
