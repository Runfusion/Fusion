---
"@runfusion/fusion": patch
---

summary: Make workflow steps compatible with callback-only plugin runtimes.
category: fix
dev: Adds the missing `AgentSession.subscribe` compatibility at the shared runtime boundary, preserves native subscriptions, and relays events across deferred cross-runtime swaps.
