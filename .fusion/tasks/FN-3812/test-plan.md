# FN-3812 Room Test Plan (Rebuilt for FN-3926)

## Preflight ownership decisions

- The four dedicated room suites already existed as `it.todo` scaffolds and are being populated with real assertions.
- Existing room coverage in broad suites is **kept** (Leave + Annotate) unless duplication becomes confusing or brittle.
- `chat-routes.rooms.test.ts` will focus on missing room HTTP assertions and room SSE payload/cleanup assertions; legacy `chat-room-routes.test.ts` and `sse-chat-rooms.test.ts` remain valid broad/smoke coverage.
- FN-3812 prompt file was not present in this worktree, so this rebuilt plan is derived from shipped source contracts.

## Layer 1 — Core store (`chat-store.rooms.test.ts`)

- `createRoom` normalizes `#Engineering Team` to `name: "Engineering Team"`, `slug: "engineering-team"`.
- `createdBy` member receives `role: "owner"`; other listed members receive `"member"`.
- Same-project slug collisions throw; same slug in different project is allowed.
- `getRoom`, `getRoomBySlug`, `listRooms`, `updateRoom`, `deleteRoom` lifecycle assertions.
- `addRoomMember` idempotency and `removeRoomMember` true/false behavior.
- `listRoomsForAgent` respects membership/project/status filters.
- `deleteRoom` cascades room members and room messages.
- `addRoomMessage` + `getRoomMessages({ before })` preserve timeline and cursor behavior.
- `mentions` metadata round-trips via `addRoomMessage` / `getRoomMessage`.
- `addRoomMessageAttachment` appends attachment metadata and emits updated message.
- Room event emission: created/updated/deleted/member added/member removed/message added/message updated/message deleted.

## Layer 2 — Orchestration (`chat.rooms.test.ts`)

- `resolveRoomResponders` returns direct/ambient/nonMemberMentions partitions.
- Mentioned room members are direct responders; remaining room members become ambient responders.
- Non-member mentions are excluded from responders and returned in `nonMemberMentions`.
- Duplicate mentions dedupe to one direct responder.
- `sendRoomMessage` persists user room message + assistant replies for resolved responders.
- `sendRoomMessage` emits non-member explanatory assistant note when non-member mentions are present.

## Layer 3 — HTTP + SSE (`chat-routes.rooms.test.ts`)

- Room CRUD + member route contract assertions:
  - create/list/get/update/delete success paths
  - missing name => 400
  - same-project slug collision => 409
  - unknown room => 404
  - member add/remove including remove-not-found 404
- Message route contract assertions:
  - POST trims content and rejects `senderAgentId` unless null/omitted
  - POST path uses injected `chatManager.sendRoomMessage` assistant-reply workflow
  - pagination and `before` behavior
  - delete message is idempotent via 404 on repeat
  - attachment metadata route updates room message attachments
- Room SSE assertions against real `ChatStore`:
  - `chat:room:created`, `chat:room:updated`, `chat:room:deleted`
  - `chat:room:member:added`, `chat:room:member:removed`
  - `chat:room:message:added`, `chat:room:message:updated`, `chat:room:message:deleted`
  - deleted room/message payloads are wrapper objects `{ id }`
  - cleanup leaves `EventEmitter.listenerCount(chatStore, event) === 0` after close

## Layer 4 — UI (`ChatView.rooms.test.tsx`)

- Rooms scope toggle renders and switches Direct/Rooms (`chat-sidebar-scope-*`).
- Room list selection switches active room without message leakage.
- Create-room modal submit calls `createRoom` and updates active room context.
- Mobile room mode back button returns from thread to sidebar.
- Room send path uses `sendRoomMessage` (Enter and send button).
- Delete-room confirmation confirm/cancel behavior.
- Hook-driven room message rerender when room message state updates.
- Direct-mode regression guard: direct scope still uses `sendMessage` path.
- FN-3811 mention/member-order note: assert only behavior exposed by current UI contract; do not invent additional mention ordering behavior.

## Broad suite cross-reference (kept coverage)

- `packages/core/src/__tests__/chat-store.test.ts` retains broad room CRUD/message smoke.
- `packages/dashboard/src/__tests__/chat-manager-room-hybrid.test.ts` remains helper-focused room responder suite.
- `packages/dashboard/src/__tests__/chat-room-routes.test.ts` retains broad room route coverage.
- `packages/dashboard/src/__tests__/sse-chat-rooms.test.ts` retains broad SSE room smoke.
- `packages/dashboard/app/components/__tests__/ChatView.test.tsx` retains direct-chat + mixed integration coverage.
