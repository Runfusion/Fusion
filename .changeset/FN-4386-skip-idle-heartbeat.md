---
"@runfusion/fusion": minor
---

Add per-agent runtime setting `skipHeartbeatWhenIdle` that pauses scheduled (timer) heartbeats when an agent has no assigned task. Assignment-trigger and on-demand wakeups still fire. Default: off.
