---
"@runfusion/fusion": patch
---

summary: Internal gate fix; no user-visible change.
category: internal
dev: The lane-wiring census now resolves a call to a same-file declaration before a same-named exported one, removing two false positives in ModelSelectorTab.
