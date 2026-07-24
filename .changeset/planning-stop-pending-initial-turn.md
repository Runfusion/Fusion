---
"@runfusion/fusion": patch
---

summary: Stopping a plan now also cancels generations that haven't started streaming yet.
category: fix
dev: `stopGeneration` discards a still-pending initial turn (registered by start-streaming but not yet consumed by a stream connect) instead of returning false and letting the "stopped" generation restart on the next connect; stops remain strictly per-session when multiple plans generate concurrently.
