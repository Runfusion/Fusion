---
"@runfusion/fusion": patch
---

summary: Fix duplicate "Move to Planning" entry in the task card menu for review-lane tasks.
category: fix
dev: TaskCard's supplemental in-review move targets are now filtered against the workflow's declared columns, so the legacy `triage` id is not offered on workflows that no longer declare it.
