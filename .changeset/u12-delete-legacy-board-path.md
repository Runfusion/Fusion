---
"@runfusion/fusion": patch
---

summary: Remove the unreachable legacy board and list rendering path left over from the workflow-columns rollout.
category: internal
dev: Deletes Board's legacy single-lane `COLUMNS` render, ListView's `LEGACY_LIST_COLUMNS`, the `workflowColumnsEnabled`/`settingsLoaded` prop threading, the `shouldHydrateCache` gate, and TaskDetailModal's `flagEnabled` early return. Core side drops the `workflowColumns` ON→OFF evacuation (`evacuateCustomColumnsToLegacy`) and the uncalled `runWorkflowColumnsIntegrityPass`, superseded by `reconcileUndeclaredTaskColumns`. `flagEnabled` stays on the board-workflows wire as a constant for stale clients.
