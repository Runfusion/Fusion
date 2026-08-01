---
"@runfusion/fusion": patch
---

summary: Merge-confirmed tasks finalize instead of being parked failed on renamed boards.
category: fix
dev: `project-engine`'s merge-confirmed finalization passed the card's real column to `getTaskHardMergeBlocker` with no `reviewColumns`, so on a renamed board the identity check returned a blocker and already-landed work was parked `failed`. Both recovery paths now share an exported `REVIEW_ELIGIBLE_SENTINEL_COLUMN` instead of spelling the sentinel independently.
