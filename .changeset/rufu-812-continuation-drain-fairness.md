---
"@runfusion/fusion": patch
---

summary: Cards waiting on Plan Review are no longer starved forever by one blocked card at the head of the queue.
category: fix
dev: A capacity refusal in the workflow continuation drain now stamps the refused work item with a short `retryAfter` (5 s) before stopping the pass. Without it the refused row stayed `runnable` with a NULL `retryAfter`, so the `limit 20` due poll re-read the same head every tick and continuations beyond the batch were never dispatched.
