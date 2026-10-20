---
"@runfusion/fusion": patch
---

summary: Prevent completed or cancelled heartbeats from sending another model request.
category: fix
dev: Chain Pi turn and request hooks onto the existing terminal and cancellation fences, including replacement sessions and asynchronous request preparation; cancel retry scheduling at completion. Review hardening: Install terminal hooks on model and thinking-level recovery sessions before dispatch, and recheck cancellation after final accounting and persistence awaits. Serialize terminal completion and persisted stop under a separate per-agent fence; queued transitions re-read the terminal row before writing or changing agent state.
