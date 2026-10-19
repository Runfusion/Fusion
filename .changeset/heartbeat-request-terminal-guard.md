---
"@runfusion/fusion": patch
---

summary: Prevent completed or cancelled heartbeats from sending another model request.
category: fix
dev: Chain Pi turn and request hooks onto the existing terminal and cancellation fences, including replacement sessions and asynchronous request preparation; cancel retry scheduling at completion.
