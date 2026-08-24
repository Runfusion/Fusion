---
"@runfusion/fusion": patch
---

summary: Fix Chat opening an imported link into a hidden composer and re-anchoring a thread on open.
category: fix
dev: ChatView's composer-prefill seed now sets `detailOpen`, and the thread anchor effect depends on `detailOpen` so `.chat-messages` is anchored when the list-first pane mounts.
