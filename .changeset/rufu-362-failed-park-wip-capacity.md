---
"@runfusion/fusion": patch
---

summary: Failed tasks no longer hold a WIP lane slot, so ready cards stop being refused capacity behind dead ones.
category: fix
dev: Column WIP occupancy is now decided by one shared core predicate, `isFailedWipPark`, consumed by both in-transaction counters, the hold/release sweep's mirror and the dashboard workflow-switcher counts. A `status:"failed"` row still renders in its lane but occupies no slot; a transition-pending marker on the same row still counts as a live holder. Exported from both `@fusion/core` barrels (`index.ts` and the merge-gate barrel).
