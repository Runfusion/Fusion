---
"@runfusion/fusion": patch
---

summary: One queued badge family — scheduler-queued cards read "Queued", and Queued to plan is the same badge as Planning.
category: fix
dev: Raw status "queued" no longer renders the lowercase engine token; the standalone queued-to-plan pill is removed and folds into the main status badge span (same classes/tooltip, testid preserved), so a card can never show two queued labels.
