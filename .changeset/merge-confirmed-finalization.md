---
"@runfusion/fusion": patch
---

summary: A task whose branch already merged can no longer get stuck as failed with unfinished steps.
category: fix
dev: `getMergeConfirmedFinalizationBlocker` (core) exempts incomplete `steps` at all four merge-confirmed finalization sites once landing is proven, while a no-op merge that landed no content still blocks. Unfinished steps are logged as `MergeConfirmedFinalizeUnfinishedSteps` rather than dropped.
