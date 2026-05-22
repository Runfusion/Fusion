---
"@runfusion/fusion": patch
---

Fix `useQuickChat` silently truncating sessions longer than 50 messages.

`useQuickChat` (QuickChat FAB) loaded messages with a hardcoded `limit: 50`
at all five fetch sites. Sessions with more than 50 messages appeared cut off
in the chat view — the visible history ended at message 50 regardless of how
many messages existed.

Root cause: the API endpoint caps responses at 200 messages per request
(`Math.min(limit, 200)`), but `useQuickChat` never paginated past the first
page.

Fix: replace all five `fetchChatMessages(..., { limit: 50 }, ...)` calls with
a new `fetchAllMessages()` helper that paginates in 200-message chunks until
the full history is loaded.

Note: `useChat` (full ChatView) is unaffected — it already implements forward
pagination via its `loadMoreMessages` callback triggered on scroll.
