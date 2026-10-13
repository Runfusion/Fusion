---
"@runfusion/fusion": patch
---

summary: Stop completed and paused agent heartbeats from continuing provider work.
category: fix
dev: Heartbeat completion now owns a terminal cancellation boundary and bounded progress protection.
