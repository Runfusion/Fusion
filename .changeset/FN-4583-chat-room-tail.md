---
"@runfusion/fusion": patch
---

Fix chat room thread freshness by loading the newest message window (`order=desc` tail fetch) while preserving ascending message order in responses, and unify dashboard scoped chat event wiring with the engine's live `ChatStore` instance so agent-posted room messages stream to SSE listeners immediately.
