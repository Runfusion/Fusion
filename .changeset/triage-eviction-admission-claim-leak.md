---
"@runfusion/fusion": patch
---

summary: Fix cards stuck on "Queued to plan" with free concurrency slots after a hung planner.
category: fix
dev: TriageProcessor.evictStaleProcessing now also clears `coordinatorAdmittedTaskIds` and drops any untransferred pre-held host slot, so an evicted planner's card is re-offered by the admission coordinator's refresh instead of being filtered out until engine restart.
