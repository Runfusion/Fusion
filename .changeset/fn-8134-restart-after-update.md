---
"@runfusion/fusion": minor
---

summary: Add a one-click "Restart Fusion" button to the update banner after an in-app update.
category: feature
dev: Reuses POST /api/system/restart via requestSystemRestart and the SystemInfoResponse.restartSupported capability flag; button degrades to a disabled state with a manual-restart note when unsupervised.
