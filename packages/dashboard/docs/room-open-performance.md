# Room Open Performance (FN-5388)

## Architecture overview

Room open flow in the dashboard:
1. Rooms list hydrates from SWR cache (`CHAT_ROOMS`) and revalidates from `fetchChatRooms`.
2. Active room is resolved from persisted active-room cache.
3. `loadRoomData` does a warm-first read of per-room message/member caches, then background revalidation (`fetchChatRoomMembers` + `fetchChatRoomMessages` in `Promise.all`).
4. SSE continues to update rooms, members, and messages and writes through to cache.

## Per-room SWR cache contract

### Keys
- Messages: `SWR_CACHE_KEYS.CHAT_ROOM_MESSAGES_PREFIX + <projectId|global>:<roomId>`
- Members: `SWR_CACHE_KEYS.CHAT_ROOM_MEMBERS_PREFIX + <projectId|global>:<roomId>`

### TTL
- Room warm-open message TTL: `SWR_CHAT_ROOM_MAX_AGE_MS = 60_000`
- Members read with `SWR_DEFAULT_MAX_AGE_MS`

### Write points
- `loadRoomData` revalidate success writes members + messages.
- SSE write-through:
  - `chat:room:message:added|updated|deleted|messages:cleared`
  - `chat:room:member:added|removed`
- Post-send transcript refresh writes room-message cache.

### Invalidation points
- `clearRoom` writes empty message snapshot.
- `chat:room:deleted` and `deleteRoom` write empty message/member snapshots.

## Diagnostics

Enable diagnostics by setting:

```js
localStorage.setItem("kb-debug-room-open", "1");
```

`[room-open]` debug payload includes `roomId`, warm flags, `totalMs`, and per-phase deltas (`select`, `cache-hit`, `members-fetch`, `messages-fetch`, `hydrate`, `sse-reconnect-refresh`, `complete`).

## Ordering invariant

Server room-message API is requested with `order: "desc"` and returns newest-first. Client render order remains unchanged and cache snapshots intentionally mirror that `desc` order.

## Out of scope

- Direct-chat (`useChat`) cache/latency changes
- ChatView virtualization
- Scroll restoration changes (FN-5380)
- Generic dashboard resume/reliability instrumentation (FN-5385/FN-5389)

## Follow-up threshold

If `hydrate -> complete` is consistently >150ms on a 100-message room, file a follow-up task for ChatView virtualization (do not implement virtualization in FN-5388).
