---
"@runfusion/fusion": patch
---

summary: Reopening a card on a renamed board now clears its stale review results, branch and failure state.
category: fix
dev: `default-workflow-hooks.ts` reopen predicates resolve intake/hold/wip/review/complete by trait from the task's own IR (passed in from `moves.ts` as `DefaultWorkflowMoveContext.lifecycleColumns`) instead of matching the default lineage's column names. `isReopenIntoPlanning` is exported so the store's former "parity mirror" calls it. The flag-OFF inline block in `moves.ts` stays name-based as the parity reference.
