---
"@runfusion/fusion": patch
---

Wire `TaskStore` into the runtime's `AgentStore` so the heartbeat auto-claim
path can call `claimTaskForAgent` without warning
`TaskStore not configured for task-claim operations`. The `InProcessRuntime`
previously built its `AgentStore` with only `rootDir`, which left task-claim,
checkout, and release operations unconfigured even though the runtime had a
`TaskStore` available.
