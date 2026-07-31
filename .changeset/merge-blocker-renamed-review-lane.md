---
"@runfusion/fusion": patch
---

summary: Tasks can be merged and completed on boards whose review column is renamed.
category: fix
dev: Two `getTaskMergeBlocker` callers omitted the optional resolved `reviewColumns`, so the identity check fell back to the literal `in-review` and refused a card sitting in its own board's review lane — `mergeTaskImpl` threw "Cannot merge …" and the completion move threw "Cannot move … to done". Both now pass `resolveReviewColumns` from the task's workflow, unioned with the legacy id.
