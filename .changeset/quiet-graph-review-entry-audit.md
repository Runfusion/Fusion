---
"@runfusion/fusion": patch
---

summary: Stop logging a false handoff-invariant violation every time a task enters a review gate.
category: fix
dev: `moves.ts` now recognises `workflowMoveSource: "workflow-graph"` (set only by the executor's column boundary) as a legitimate entry into `in-review` via the shared `isRecognizedInReviewEntry` predicate, used by both the backend and SQLite `task:handoff-invariant-violation` emit sites. Non-graph movers (operator drags, engine/self-healing moves, foreign provenance values) still emit the audit unchanged.
