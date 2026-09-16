---
"@runfusion/fusion": patch
---

summary: Chat Snippets stays up to date on its own; its Close and Refresh buttons are gone.
category: fix
dev: Removes the `onClose` prop from `SnippetsView` (and the callback `MainContent` passed it) plus the `snippets-refresh` control. A successful global write that touches `chatSnippets` now publishes a content-free `settings:chat-snippets-updated` SSE event from `packages/dashboard/src/sse.ts`; the shared `useChatSnippetsCache` subscribes once through the existing `/api/events` multiplexer, coalesces bursts, and defers an invalidation received during its mutation FIFO. The error state keeps its Retry.
