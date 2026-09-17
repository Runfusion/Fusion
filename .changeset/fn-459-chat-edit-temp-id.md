---
"@runfusion/fusion": patch
---

summary: Editing a just-sent chat message no longer fails, and a rejected edit keeps your correction.
category: fix
dev: `ChatManager.sendMessage` now broadcasts an in-band `user_message` stream event carrying the persisted user row (emitted before every early return, including the mentions dispatch, and best-effort so a hostile sink cannot fail the send). `streamChatResponse`/`attachChatStream` parse it as a non-terminal event into a new `onUserMessage` handler, and `createChatStreamHandlers` joins the stream's own `tempUserMessageId` so the optimistic bubble is reconciled by exact id instead of content equality. A shared `isPersistedChatMessageId` helper (`app/hooks/chatTypes.ts`) gates the edit affordance on both chat surfaces — `msg-`/`rmsg-` are persisted and stay editable — and `useChat.editMessageAndResend` realigns or refuses a non-persisted target locally rather than posting an id the server's `prepareReplacement` 404 guard (unchanged) would reject. Failed edits publish `editDraftRestore`, which reopens the inline editor pre-filled.
