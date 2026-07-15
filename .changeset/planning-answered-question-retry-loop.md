---
"@runfusion/fusion": patch
---

summary: Fix Planning Mode getting stuck retrying and re-asking a question that was already answered.
category: fix
dev: Sessions now clear `currentQuestion` the moment an answer is accepted (Planning Mode and agent onboarding), `retrySession` scrubs stale questions from pre-fix rows, and restored sessions only keep a question when the persisted row is `awaiting_input`. This stops the SSE catch-up path from re-emitting answered questions to the fresh connections opened by FN-7946 auto-retries, which reset the bounded retry budget and looped forever.
