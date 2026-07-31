---
"@runfusion/fusion": patch
---

summary: Fix merge re-enqueue failing on boards whose review column is renamed.
category: fix
dev: `enqueueMergeQueue` (and `store.enqueueMergeQueue`) now resolve the task's own review columns and forward them to `enqueueMergeQueueInTransaction`, which previously fell back to `new Set(["in-review"])` and threw `MergeQueueInvalidColumnError`. The two `moves.ts` handoff callers already supplied them; the merger and self-healing re-enqueue paths did not.
