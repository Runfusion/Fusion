---
"@runfusion/fusion": patch
---

summary: Cancelling a merging task now stops it immediately instead of stalling for 30 minutes.
category: fix
dev: The `merge` runtime primitive and legacy merge seam raced the merge only against their own 30-minute `GRAPH_MERGE_TIMEOUT_MS`, never observing the graph's abort — `WorkflowPrimitiveContext` had no `signal`. Threads the graph `AbortSignal` through `primitiveNodeContext`/`primitiveContextForNode` into both merge paths (linked via `AbortSignal.any`, timeout preserved as the wedged-queue bound) and returns a distinct `merge-cancelled` value that does not route into bounded auto-merge retry.
