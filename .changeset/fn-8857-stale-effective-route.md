---
"@runfusion/fusion": patch
---

summary: Clear stale task dispatch routes when a node override changes.
category: fix
dev: shouldInvalidateEffectiveRoute at the updateTaskUnlockedImpl seam uses load-time checkout capture and clears only unsupplied fields of a replacement route.
