---
"@runfusion/fusion": patch
---

summary: A task actively re-executing can no longer launder an empty reverted branch into done.
category: fix
dev: FN-8141 follow-up 3. `deriveExecutorSignalMemory` (packages/engine/src/overseer-noop-finalize-veto.ts) no longer lets a mid-execution `progressing` overseer observation clear the no-op-finalize veto. A failure park is superseded only by a clean-completion task-log marker (shared `CLEAN_COMPLETION_MARKERS` exported from @fusion/core) strictly newer than it; the executor stage emits no green-completion observation. `merger-ai.ts` threads `task.log` into the derivation.
