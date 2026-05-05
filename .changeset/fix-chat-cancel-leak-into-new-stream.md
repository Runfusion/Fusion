---
"@runfusion/fusion": patch
---

Fix chat: after stopping a streaming reply, the next message would appear sent but show no Stop button or "Connecting…" indicator. The cancellation broadcast from the previous generation was leaking into the new SSE subscription, immediately marking it as errored. Each `chatManager.sendMessage` now allocates a per-generation id; `ChatStreamManager` only delivers tagged broadcasts to subscribers from the matching generation, and `sendMessage`'s cleanup no longer deletes a newer generation's `activeGenerations` slot when an older one finally unwinds.
