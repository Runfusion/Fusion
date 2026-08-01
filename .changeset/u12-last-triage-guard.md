---
"@runfusion/fusion": patch
---

summary: The Plan action no longer appears on cards that are already executing.
category: fix
dev: isPreExecutionHoldColumn ORed the legacy `triage` id with the column's traits unconditionally, so a resolved column merely named `triage` was treated as a planning target even when its traits said work was underway. Now flags-first with the id as the documented no-metadata fallback.
