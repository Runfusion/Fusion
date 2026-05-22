---
"@runfusion/fusion": patch
---

Fix chat session API endpoints ignoring `projectId` in multi-project mode.

`GET /chat/sessions`, `GET /chat/sessions/:id`, `GET /chat/sessions/:id/messages`
and related mutation endpoints all used `options.chatStore` (the home-directory
project's store) regardless of the `projectId` query parameter. In a multi-project
daemon (e.g. running from `~/`) sessions belonging to secondary projects were
invisible — list returned empty, fetching by ID returned 404.

Root cause: `registerChatRoutes` accessed `options.chatStore` directly instead of
routing through the per-project `resolveProjectChatContext` helper (already used
correctly by `registerChatRoomRoutes` for the rooms API).

Fix: introduce a `resolveScopedChatStore(projectId)` helper inside
`registerChatRoutes` that delegates to `resolveProjectChatContext`, and replace
all ten `options.chatStore` usages with calls to this helper. When `engineManager`
is present and has an engine for the given `projectId`, the engine's own
`ChatStore` is used; otherwise falls back to the default store (backward compatible).
