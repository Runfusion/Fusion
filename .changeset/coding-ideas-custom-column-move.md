---
"@runfusion/fusion": patch
---

summary: Fix "Invalid transition" error when moving cards out of a custom workflow column like Coding (Ideas) → Ideas.
category: fix
dev: moveTaskInternal's compat-flag legacy path validated moves against the legacy VALID_TRANSITIONS table, which is keyed only by the built-in column ids; a task in a non-legacy workflow column (e.g. "ideas") had no key and every move was rejected. The legacy branch now resolves a non-legacy source column's targets from the task's own workflow adjacency (resolveAllowedColumns) while preserving the legacy bare-Error contract for legacy columns.
