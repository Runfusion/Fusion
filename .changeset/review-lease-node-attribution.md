---
"@runfusion/fusion": patch
---

summary: Review-gate leases now record which node holds them, so a restarted engine can tell its own dead leases from a peer's.
category: internal
dev: Adds `WorkflowStepResult.leaseNodeId` and an optional `LocalNodeLeaseIdentity` argument to `classifyReviewLease`. A pending lease stamped with the caller's own node id whose `startedAt` predates the current process boot now classifies as `reclaim` immediately instead of waiting out `PLAN_REVIEW_LEASE_STALENESS_MS`; peer-owned and legacy unattributed leases are unchanged. `InProcessRuntime.start()` resolves the local node id from CentralCore and passes it to SelfHealingManager. The dep is threaded runtime -> TaskExecutor (`getLocalNodeId`, a getter because the runtime resolves the id asynchronously during start()) -> WorkflowGraphTaskRunner -> WorkflowGraphExecutor, which stamps it on the lease.
