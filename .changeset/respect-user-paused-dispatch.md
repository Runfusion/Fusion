---
"@runfusion/fusion": patch
---

summary: Keep manually parked tasks out of scheduler and remembered-owner dispatch until explicitly unpaused.
category: fix
dev: Treats either paused flag as a dispatch stop and invalidates scheduler candidacy when userPaused changes.
