---
"@runfusion/fusion": patch
---

summary: Glasses plugin review actions now work on boards whose review column is renamed.
category: fix
dev: `requestReview`/`acceptReview`/`returnToAgent`/`retryTask` gated on literal columns and moved to literal destinations. Their review lane also could not resolve at all, because `resolveLifecycleColumns` keys `review` on `mergeOrchestration` alone; `laneContext` now widens to `mergeBlocker`/`humanReview` when that role is absent.
