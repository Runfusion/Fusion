# Dashboard Real-Time & SSE Ownership Guide

[← Docs index](./README.md) · [Architecture](./architecture.md)

This document is the **canonical maintainer contract** for dashboard/event-stream architecture.

- If this file and other docs differ, treat this file as source-of-truth and update the others.
- Do not add parallel SSE architecture docs; link here instead.

---

## 1) Stream inventory and ownership boundaries

Fusion intentionally uses multiple realtime mechanisms. Keep their ownership boundaries explicit.

### A. Shared browser SSE bus for `/api/events`

- Endpoint: `GET /api/events`
- Browser owner: `packages/dashboard/app/sse-bus.ts`
- Main task consumer: `packages/dashboard/app/hooks/useTasks.ts`
- Additional consumers: `packages/dashboard/app/App.tsx` (mailbox unread updates + approval banner trigger handling for new `awaiting-approval` transitions)

Contract: **one `EventSource` per URL**, fan-out via `subscribeSse(...)`.

### B. Dedicated streams that are intentionally separate

These should not be collapsed into `/api/events` unless product architecture changes:

- Task logs SSE: `GET /api/tasks/:id/logs/stream` in `packages/dashboard/src/server.ts`
- Legacy terminal SSE: `GET /api/terminal/sessions/:id/stream` in `packages/dashboard/src/server.ts`
- Chat session stream manager + SSE route plumbing: `packages/dashboard/src/chat.ts` + `packages/dashboard/src/routes.ts`
- Planning/session stream manager + SSE route plumbing: `packages/dashboard/src/planning.ts` + `packages/dashboard/src/routes.ts`
- Dev-server logs SSE: `GET /api/dev-server/logs/stream` in `packages/dashboard/src/dev-server-routes.ts`
- Remote node `/api/events` proxy stream: `GET /api/proxy/:nodeId/events` in `packages/dashboard/src/routes/register-proxy-routes.ts`

---

## 2) Shared `/api/events` browser contract (`sse-bus.ts`)

Why this exists: browsers have limited HTTP/1.1 per-origin connection slots (commonly ~6). Multiple raw `EventSource` instances cause slot starvation and can stall normal `fetch` calls.

`packages/dashboard/app/sse-bus.ts` enforces:

1. one channel per exact URL (`Map<string, Channel>`)
2. subscription multiplexing (`subscribeSse`)
3. close on last unsubscribe
4. reconnect + heartbeat liveness
5. unload/bfcache cleanup

### URL identity and scoping

Channel identity is URL-based. These are distinct channels:

- `/api/events`
- `/api/events?projectId=A`
- `/api/events?projectId=B`
- `/api/proxy/<nodeId>/events?...`

This is the first line of project/node isolation in the browser.

### `clientId` and keepalive/disconnect controls (local `/api/events` only)

For same-origin `/api/events`, the bus appends session-scoped `clientId` and uses:

- `POST /api/events/keepalive?clientId=...&projectId=...`
- `POST /api/events/disconnect?clientId=...&projectId=...`

`clientId` storage:

- primary: `sessionStorage` key `fusion:sse-client-id`
- fallback: in-memory random id

Purpose:

- stale stream reaping on server
- explicit unload release (`sendBeacon`/`fetch keepalive` fallback)
- supersede older stream for same `(clientId, projectId)`

### Reconnect and liveness constants

From `sse-bus.ts`:

- heartbeat timeout: `45_000ms`
- reconnect delay: `3_000ms`
- keepalive interval: `2_000ms`

Behavior:

- stream `error` → `forceReconnect(...)`
- missing heartbeat/message > timeout → reconnect
- `onReconnect` callback lets consumers refetch authoritative state
- reconnect is suppressed once channel is closed/unsubscribed

### Unload / bfcache lifecycle

`sse-bus.ts` listens to:

- `pagehide`
- `beforeunload`
- `pageshow` (`persisted` bfcache restore)

This prevents background/leaked connections after refresh/navigation and safely reopens persisted subscriptions.

---

## 3) View-aware gating and stale-event protection (`useTasks.ts`, `App.tsx`)

`useTasks` is the reference consumer for `/api/events` task lifecycle updates.

### View-aware gating

`App.tsx` computes:

- `taskSseEnabled = taskView === "board" || taskView === "list"`

and passes it into `useTasks({ sseEnabled })`.

This disables board-task SSE in non-task views to reduce unnecessary background connections.

### Non-board task creators must ingest created tasks locally

When a feature creates tasks outside board/list surfaces (for example `TodoView`), it must feed each successful create response back into app task state via the canonical ingest path (`ingestCreatedTasks(...)` in `useTasks`, typically wired from `App.tsx`).

Do **not** rely on eventual `task:created` SSE delivery or manual refresh to reveal newly created tasks. Local ingestion keeps board/list views coherent immediately and avoids user-visible stale UI in the gap before SSE fan-out.

### Project-switch stale guards

`useTasks.ts` protects against stale cross-project callbacks via:

- `projectContextVersionRef`
- captured request `projectId` checks in `refreshTasks`
- stale handler checks before applying SSE updates

This is the primary defense against old-project events mutating current-project state.

---

## 4) Server `/api/events` ownership and store coherence (`server.ts`, `sse.ts`, `project-store-resolver.ts`)

### Route ownership

`packages/dashboard/src/server.ts` owns:

- `GET /api/events`
- `POST /api/events/keepalive`
- `POST /api/events/disconnect`

### Project-scoped store resolution order

For `projectId` streams, server prefers engine-owned stores to keep EventEmitter identity coherent with mutation paths:

1. `engineManager.getEngine(projectId)?.getTaskStore()` (plus engine message/agent/automation stores)
2. fallback `getOrCreateProjectStore(projectId)`

`packages/dashboard/src/project-store-resolver.ts` caches per-project `TaskStore` instances so API routes and SSE listeners share the same in-memory emitter graph.

### SSE listener symmetry and teardown

`createSSE(...)` in `packages/dashboard/src/sse.ts` subscribes to task/mission/AI-session/plugin/agent/message/chat/automation events with `on(...)` and removes every one with `off(...)` in cleanup.

**Invariant:** any new forwarded event must preserve strict `on(...)`/`off(...)` symmetry.

### Connection safety controls (`sse.ts`)

- active connection tracking + high-water stats
- heartbeat event every 30s (`event: heartbeat`)
- stale client timer (`SSE_CLIENT_STALE_MS = 5_000`) refreshed by keepalive endpoint
- supersede prior same `(clientId, projectId)` connection
- backpressure guard (`SSE_MAX_BUFFERED_BYTES`)
- cleanup paths: request close/aborted, response close, socket close/error, send failure, stale timeout, supersede, backpressure

---

## 5) Remote-node SSE proxy contract (`register-proxy-routes.ts`, `useRemoteNodeEvents.ts`)

Proxy endpoint:

- `GET /api/proxy/:nodeId/events`

Server behavior (`register-proxy-routes.ts`):

- forwards query string to upstream `/api/events`
- forwards bearer auth from node `apiKey`
- preserves SSE framing
- aborts upstream and destroys stream on downstream client disconnect

Client behavior (`useRemoteNodeEvents.ts`):

- subscribes via `subscribeSse(...)`
- inherits shared bus multiplexing/reconnect semantics per proxy URL

---

## 6) Known pitfalls to explicitly avoid

1. **Raw `new EventSource(...)` in feature hooks/components**
   - bypasses bus multiplexing, creates duplicate streams, risks HTTP/1.1 slot starvation.
2. **Missing `off(...)` during SSE server cleanup**
   - leaks listeners and cross-session events.
3. **Project-switch stale callbacks not guarded**
   - old project events mutate current project state.
4. **Store instance mismatch for project streams**
   - sharing the same PostgreSQL database is not enough; EventEmitter instance identity matters for realtime propagation.
5. **Background SSE when view does not need it**
   - unnecessary connection pressure and noisy updates.
6. **Ambiguous stream ownership**
   - do not route chat/planning/task-logs/dev-server streams through `/api/events` by default.

---

## 7) Test suites that protect this contract

Run these whenever changing SSE/event-stream behavior:

- `packages/dashboard/app/__tests__/sse-bus.test.ts`
  - URL-scoped multiplexing, reconnect, teardown
- `packages/dashboard/app/hooks/__tests__/useTasks.test.ts`
  - stale project-event guards, reconnect resync, heartbeat behavior
- `packages/dashboard/src/__tests__/sse.test.ts`
  - server clientId keepalive/disconnect/supersede, listener cleanup, backpressure close
- `packages/dashboard/src/__tests__/server.events.test.ts`
  - `/api/events` wiring integration
- `packages/dashboard/src/__tests__/proxy-routes.test.ts`
  - remote SSE proxy forwarding, timeout/transport failure handling, disconnect cleanup

---

## 8) Maintainer checklist for adding/modifying streams

Before merge:

1. **Choose ownership intentionally**: shared `/api/events` bus vs dedicated stream.
2. **Preserve scoping**: URL/query-based project and remote-node isolation.
3. **Preserve emitter coherence**: use engine-owned project stores when available.
4. **Preserve cleanup symmetry**: every `on(...)` has matching `off(...)`.
5. **Preserve reconnect semantics**: consumers refetch on reconnect when consistency matters.
6. **Preserve view-aware gating**: avoid unnecessary background SSE.
7. **Update this doc** if the contract changed.
8. **Run contract tests** listed above.
