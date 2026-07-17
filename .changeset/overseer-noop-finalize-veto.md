---
"@runfusion/fusion": patch
---

summary: Block a zero-change task from completing when its executor last failed with work unfinished.
category: fix
dev: FN-8141. Adds `evaluateNoOpFinalizeExecutorVeto` + `deriveExecutorSignalMemory` (pure, engine-local) giving the merger cross-stage memory of the most-recent executor overseer signal (derived from the durable `overseer:intervention` timeline). The AI empty-merge lane (`merger-ai.ts`) now vetoes a no-op finalize — moving the task back to `todo` with progress preserved and emitting `overseer:no-op-finalize-vetoed-failed-executor` — when the latest executor signal was failed-with-incomplete-work and no later execution completed green. Non-empty merges are never vetoed; defers to the FN-7514 human-control contract (user-paused / autoMerge:false).
