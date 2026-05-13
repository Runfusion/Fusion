---
"@runfusion/fusion": patch
---

Fix chat queued follow-up delivery so pending messages auto-send when streaming completes through recovery paths (SSE message-added recovery, polling finalization, and visibility-resume), not only fresh-send onDone/onError handlers.
