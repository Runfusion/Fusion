---
"@runfusion/fusion": patch
---

summary: Renamed-column boards no longer reuse an in-use checkout or carry stale merge details into a re-run.
category: fix
dev: `executor.ts` — `findActiveWorktreeOwner`'s durable leg and `resetMergeStateIfNeeded` compared `task.column` against the legacy ids, so on a renamed board the first matched nobody (a live checkout read as unowned after a restart) and the second never fired (a re-entering card kept its previous `mergeDetails`). Both now resolve from the task's own workflow, unioned with the legacy ids.
