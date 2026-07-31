---
"@runfusion/fusion": patch
---

summary: Stale-card diagnostics now cover every review and hold column, not just the first of each.
category: fix
dev: `runSurfacingSweep`'s role gate resolves membership (`resolveReviewColumns` / `columnsWithFlag(ir,"hold")`) instead of `resolveLifecycleColumns()[role]`; signals receive the column SET, and each card's recovery policy is read from its own column. Adds `StalePausedTodoContext.holdColumns`.
