---
"@runfusion/fusion": patch
---

summary: Cards in renamed in-progress or review lanes now show their live elapsed-time indicator.
category: fix
dev: `wantsLiveTimeIndicator`'s dependency list omitted `isWipColumn`/`isReviewColumn`/`taskColumnFlags`, so the memo kept the pre-load answer computed before workflow traits resolved.
