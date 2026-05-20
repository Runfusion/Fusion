---
"@runfusion/fusion": patch
---

Atomic in-review handoff: introduce `TaskStore.handoffToReview` that performs the column move and `mergeQueue` enqueue inside a single transaction, and migrate every executor + self-healing site that promotes a completed task into `in-review` to use it. Direct `moveTask(taskId, "in-review")` writes now emit a `task:handoff-invariant-violation` run-audit event for forensics. Pairs with FN-5242 (queue schema) and FN-5243 (merger lease consumption).
