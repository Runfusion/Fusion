---
"@runfusion/fusion": patch
---

summary: Clear interrupted manual merge status so cards do not remain stuck as merging.
category: fix
dev: Adds clearOwnedMergeStamp, reconcileUnownedStaleMergeStamp, fenced runAiMerge cleanup, and SIGINT/SIGTERM/SIGHUP CLI handlers.
