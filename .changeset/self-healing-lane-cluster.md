---
"@runfusion/fusion": patch
---

summary: Fourteen more self-healing repairs now use your board's own column names instead of the built-in ones.
category: fix
dev: Converts 30 column guards in `self-healing.ts` to `resolveProjectColumnsForRoles` with existing role helpers; no new helpers, no signature changes.
