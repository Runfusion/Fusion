---
"@runfusion/fusion": patch
---

summary: A card waiting on capacity now backs off instead of being re-dispatched on every scheduler pass.
category: fix
dev: Graph runs that suspend with `reason: "capacity"` stamp a bounded `retryAfter` on the continuation through the existing same-state `transitionWorkflowWorkItem` CAS (ladder 60s/2m/5m/15m, cap 15m), so `listDueWorkflowWorkItems` stops returning the row every pass. Only capacity waits are deferred — `pause` and other boundary waits keep their external releaser. No column move is performed.
