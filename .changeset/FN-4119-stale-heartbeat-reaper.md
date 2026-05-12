---
"@runfusion/fusion": patch
---

Heartbeat scheduling now auto-reaps stale active heartbeat runs so durable agents recover regular timer ticks without requiring a manual stop/start.
