---
"@runfusion/fusion": patch
---

summary: Make chat Stop and Force send interrupt active model turns before teardown.
category: fix
dev: `ChatManager.cancelGeneration` now makes a duck-typed, bounded native-interrupt request before disposal, mirroring the engine abort-then-dispose seam; `beginGeneration` remains controller-only.
