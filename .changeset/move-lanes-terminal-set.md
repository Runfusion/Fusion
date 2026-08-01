---
"@runfusion/fusion": patch
---

summary: Cards on boards with two "complete" columns now unblock their dependents correctly.
category: fix
dev: `TaskMoveLanes` gains an optional `terminal?: readonly string[]` carrying every complete/archived-trait column id; `toTaskMoveLanes` fills it from `columnsWithFlag` rather than the first-match `resolveLifecycleColumns`. The scheduler's `mergeParkedColumns` now unions `base.terminal`, the payload's set, and the single lanes instead of rebuilding from `[complete, archived]`.
