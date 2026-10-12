---
"@runfusion/fusion": patch
---

summary: Self-healing board sweeps stop decoding the task-log text they never look at, cutting per-pass memory on large boards.
category: performance
dev: Five more `listTasks` call sites in `self-healing.ts` pass `excludeLog: true` — the hold/WIP/review blockedBy union, the three paged planning-lane scans, and the review-stall candidate read — each proven log-free at its own call site (the stall sweep's log reads run on a row the store re-fetches inside its own lock). The full-hydration ratchet ledger for `self-healing.ts` drops 8 → 3; the three survivors are the surfacing cycle and the two done-marker sweeps, which read raw log entries and now say so in place.
