---
"@fusion/dashboard": patch
---

Fix two mobile chat send failures. The regular chat send button was dead to touch because the action only ran on `onClick`, which iOS suppresses after `preventDefault()` in the touch sequence — it now fires from pointerdown/touchstart with a dedupe latch. Quick chat messages could strand in the composer (shown locally but never sent to the agent or persisted) when a queued message's delivery trigger bailed — a dropped stream leaving the streaming flag stuck `true`, or a stream that looked healthy when queued but then stalled. A queued send now detects a stale flag at send time via the stream's connection state and the server's generation status, and a delivery watchdog re-confirms any message that stays pending and force-delivers it once no generation is actually in flight.
