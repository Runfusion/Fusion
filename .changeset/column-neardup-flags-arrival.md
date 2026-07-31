---
"@runfusion/fusion": patch
---

summary: The duplicate chip now clears once its canonical task lands on a board with renamed lanes.
category: fix
dev: `resolveNearDuplicateCanonicalInactive` kept the pre-load `getTaskColumnFlags` closure; the callback is hoisted so the dependency can be listed.
