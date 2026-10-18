---
"@runfusion/fusion": patch
---

summary: Keep the Memory Keeper heartbeat interval an operator saved across restarts.
category: fix
dev: Startup convergence now preserves a valid saved heartbeatIntervalMs and restores the default only for a missing or non-positive value.
