---
"@runfusion/fusion": patch
---

Treat pi-ai Codex WebSocket transport drops (`WebSocket error`, `WebSocket closed …`, `WebSocket stream closed before response.completed`) as transient errors so the engine retries them instead of marking the task failed. Tag the model id onto the thrown error and emit a structured warn so future drops can be triaged by which provider/model is unstable.
