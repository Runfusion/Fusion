---
"@runfusion/fusion": patch
---

Stop queued chat messages from disappearing after back-navigation while the assistant is still responding (GitHub #1279).

Re-entering a chat restored the queued follow-up and immediately flushed it based on the client's local `isGenerating` flag — which is stale mid-generation (it is a route-level enrichment the `chat:session:updated` SSE payload lacks). The premature send aborted the live generation server-side and could lose the queued message entirely, since its persisted copy was deleted before the send.

The restore path in both Chat and Quick Chat now confirms with the server before flushing: if a generation is still in flight it re-attaches to the stream and lets completion deliver the queued message; the message is sent immediately only when the server reports no active generation. On a failed check the queued bubble is kept for a later flush trigger.
