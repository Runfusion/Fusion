---
"@runfusion/fusion": patch
---

Stop review entry from freezing the global auto-merge setting onto tasks. Tasks without an explicit per-task auto-merge override now continue to follow the live global setting, so toggling global auto-merge off stops newly-entered non-override in-review tasks from being auto-merge processed.
