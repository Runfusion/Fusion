---
"@runfusion/fusion": patch
---

summary: Board boot now repairs task-history rows stored as JSON scalars instead of failing reads later.
category: fix
dev: `TaskStore.init` runs `repairDoubleEncodedTaskLogsAsync()` scoped to the store's project: jsonb scalars that unwrap to an array are rewritten as arrays, anything else is counted and warned about with ids only, and `updated_at` is never bumped so dwell/stall measurements keep their anchor.
