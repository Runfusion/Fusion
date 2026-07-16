---
"@runfusion/fusion": minor
---

summary: Add a one-click "Restart Fusion" button to the Settings modal after an in-app update.
category: feature
dev: Adds a capability-aware restart affordance to SettingsModal's footer update-success state; reuses POST /api/system/restart via requestSystemRestart and restartSupported, with a disabled manual-restart fallback when unsupervised.
