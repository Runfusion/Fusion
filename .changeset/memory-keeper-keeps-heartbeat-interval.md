---
"@runfusion/fusion": patch
---

summary: Keep the Memory Keeper heartbeat interval an operator saved across restarts.
category: fix
dev: Startup convergence now preserves a saved heartbeatIntervalMs between the 1,000 ms agent-config minimum and Node's timer ceiling, and restores the default otherwise.
