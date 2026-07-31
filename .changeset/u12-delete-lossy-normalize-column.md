---
"@runfusion/fusion": patch
---

summary: Custom board columns can no longer be silently rewritten to Planning by an internal helper.
category: internal
dev: Deletes `normalizeColumn` from `@fusion/core` (zero callers; the dashboard migrated to the non-lossy `normalizeColumnId` when the data loss was diagnosed) and adds `no-lossy-column-coercion-export.test.ts`, which bans any exported single-argument column helper that maps a valid custom id onto a legacy one — by behaviour, not by name.
