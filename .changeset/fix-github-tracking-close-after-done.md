---
"@runfusion/fusion": patch
---

summary: Close Fusion-created GitHub tracking issues when the task is already done.
category: fix
dev: Late-created tracking issues (opened after the task reached Done) now close immediately, and the reconcile sweep prefers recently updated tracked terminals instead of the oldest 200 board rows.
