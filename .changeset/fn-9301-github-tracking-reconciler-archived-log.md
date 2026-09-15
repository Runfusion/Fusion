---
"@runfusion/fusion": patch
---

summary: Stop archived GitHub tracking reconciliation from repeatedly logging failures.
category: fix
dev: Adds a shared task-log refusal classifier, removes deleted-pass task-log writes, and deduplicates first-occurrence diagnostics.
