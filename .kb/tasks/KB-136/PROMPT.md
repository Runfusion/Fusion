# Task: KB-136 - Scale Dashboard Badge WebSocket Broadcasts with Shared Pub/Sub

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This changes the dashboard’s real-time delivery path and introduces optional cross-instance infrastructure for `/api/ws`. The work is still well-bounded to badge updates, but it needs careful review for fan-out correctness, per-server poller isolation, packaging, loop prevention, and backwards-compatible local fallback behavior.
**Score:** 6/8 — Blast radius: 2, Pattern novelty: 2, Security: 1, Reversibility: 1

## Mission

Make badge updates delivered over `/api/ws` stay consistent when the dashboard is running on more than one app instance behind a load balancer. Today `setupBadgeWebSocket()` and `WebSocketManager` only fan out updates inside a single Node process, so a PR/issue badge change detected on instance A never reaches subscribed clients connected to instance B. Add a shared pub/sub layer (Redis-backed is the preferred implementation) so badge snapshots can cross instance boundaries while preserving the existing focused-poller behavior, websocket message shape, and 5-minute refresh fallback. The shared message contract should stay badge-only and explicit — e.g. `{ sourceId, taskId, timestamp, prInfo?, issueInfo? }` — so every instance can validate, dedupe, and rebroadcast snapshots safely.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/server.ts` — current `/api/ws` setup, badge snapshot cache, and `githubPoller` wiring
- `packages/dashboard/src/websocket.ts` — `WebSocketManager` subscription tracking and badge broadcast behavior
- `packages/dashboard/src/github-poll.ts` — current poller class plus the exported singleton that must not leak across multi-server tests
- `packages/dashboard/src/routes.ts` — PR/issue status routes that currently read from the shared `githubPoller`
- `packages/dashboard/src/routes.test.ts` — existing route coverage for PR/issue stale-refresh behavior that must keep working after poller injection
- `packages/dashboard/src/__tests__/websocket.test.ts` — existing websocket manager + `/api/ws` integration coverage
- `packages/dashboard/src/__tests__/github-poll.test.ts` — current poller expectations and useful patterns for isolated poller tests
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` — client-side protocol expectations for `badge:updated` snapshots
- `packages/dashboard/app/components/TaskCard.tsx` — freshness merge rules between websocket badge snapshots and task/SSE data
- `packages/dashboard/package.json` — dashboard runtime dependencies and test/build scripts
- `packages/cli/package.json` — published package dependency list used when `kb dashboard` runs outside the monorepo
- `packages/cli/tsup.config.ts` — why third-party runtime dependencies still need to exist in the published CLI package
- `packages/cli/src/__tests__/package-config.test.ts` — reference coverage for published-package dependency expectations
- `packages/dashboard/README.md` — architecture/API docs for `/api/ws`
- `packages/cli/STANDALONE.md` — user-facing dashboard startup/deployment docs for the published CLI package

## File Scope

- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/websocket.ts`
- `packages/dashboard/src/badge-pubsub.ts` (new)
- `packages/dashboard/src/index.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/dashboard/src/github-poll.ts`
- `packages/dashboard/src/__tests__/websocket.test.ts`
- `packages/dashboard/src/__tests__/badge-pubsub.test.ts` (new)
- `packages/dashboard/src/__tests__/github-poll.test.ts` (if poller construction/export behavior changes)
- `packages/dashboard/package.json`
- `packages/cli/package.json`
- `packages/cli/src/__tests__/package-config.test.ts`
- `pnpm-lock.yaml`
- `packages/dashboard/README.md`
- `packages/cli/STANDALONE.md`
- `.changeset/*.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Add a shared badge pub/sub adapter and package it correctly for the published API + CLI

- [ ] Create `packages/dashboard/src/badge-pubsub.ts` with a small adapter boundary for badge snapshot fan-out (`publish`, `subscribe/start`, `dispose`) and a validated envelope contract: `{ sourceId: string, taskId: string, timestamp: string, prInfo?: PrInfo | null, issueInfo?: IssueInfo | null }`
- [ ] Implement a Redis-backed adapter using exact env names `KB_BADGE_PUBSUB_REDIS_URL` and `KB_BADGE_PUBSUB_CHANNEL`, with `kb:badge-updates` as the default channel value when `KB_BADGE_PUBSUB_CHANNEL` is unset, and make `createServer()` use env-based construction only as the default when no adapter is injected through `ServerOptions.badgePubSub`
- [ ] Expose injectable `ServerOptions.badgePubSub` and `ServerOptions.githubPoller` surfaces so tests and embedders can supply their own pub/sub adapter and per-server `GitHubPollingService` instance instead of requiring live Redis or the process-global poller in automated tests
- [ ] Update `packages/dashboard/src/index.ts` to export the package-root surfaces embedders need for that injection story: `GitHubPollingService` plus the new badge pub/sub interfaces/types/factory helpers used by `ServerOptions`
- [ ] Update runtime packaging so the Redis client is available when users install `@dustinbyrne/kb`: add the dependency where the dashboard code actually executes in published builds (`packages/cli/package.json`) in addition to any workspace-local package wiring needed for `@kb/dashboard`
- [ ] Add or update `packages/cli/src/__tests__/package-config.test.ts` so it explicitly asserts the published CLI package declares the Redis runtime dependency required by the bundled dashboard server
- [ ] Handle malformed inbound pub/sub payloads and adapter shutdown cleanly without crashing the process or leaking connections/listeners
- [ ] Run targeted tests for the new adapter and dependency wiring

**Artifacts:**
- `packages/dashboard/src/badge-pubsub.ts` (new)
- `packages/dashboard/src/__tests__/badge-pubsub.test.ts` (new)
- `packages/dashboard/src/index.ts` (modified)
- `packages/dashboard/package.json` (modified)
- `packages/cli/package.json` (modified)
- `packages/cli/src/__tests__/package-config.test.ts` (modified)
- `pnpm-lock.yaml` (modified)

### Step 2: Refactor `/api/ws` and poller wiring for cross-instance delivery with per-server isolation

- [ ] Update `createServer()`, `createApiRoutes()`, and `setupBadgeWebSocket()` so each server can use its own `GitHubPollingService` instance through `ServerOptions.githubPoller` instead of hard-wiring the process-wide `githubPoller` singleton into every server in the same process
- [ ] Update `setupBadgeWebSocket()` in `packages/dashboard/src/server.ts` so badge-relevant `task:updated` changes still broadcast locally, but now also publish the freshest badge snapshot to the shared pub/sub bus even when the detecting instance has no local websocket subscribers
- [ ] Replace the current string-only `badgeSnapshots` cache with structured snapshot data so remote pub/sub messages can update local cache state, preserve timestamps, and be rebroadcast to local websocket subscribers without requiring the local `TaskStore` to emit its own `task:updated`
- [ ] Extend `WebSocketManager` in `packages/dashboard/src/websocket.ts` so `setupBadgeWebSocket()` can send the current cached badge snapshot to a newly subscribed socket for that task **when a cached snapshot exists** (targeted send or per-client subscription event is fine); this is required so an instance with stale local task data can still serve the latest remotely-published badge state to late subscribers
- [ ] Prevent duplicate echo loops: a server must ignore its own pub/sub messages, and a local client subscribed to the origin instance must not receive the same badge snapshot twice from local broadcast + shared rebroadcast
- [ ] Keep badge polling instance-local and subscription-driven: remote pub/sub fan-out must not centralize polling, mutate another server’s watch set, change `replaceTaskWatches()` semantics, or remove the existing 5-minute REST refresh fallback routes
- [ ] Run targeted websocket/server/route integration tests that exercise the changed cross-instance behavior and preserve route-side stale refresh logic

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified)
- `packages/dashboard/src/websocket.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/dashboard/src/github-poll.ts` (modified)
- `packages/dashboard/src/__tests__/websocket.test.ts` (modified)
- `packages/dashboard/src/__tests__/github-poll.test.ts` (modified if needed)

### Step 3: Prove multi-instance delivery and poller isolation with real automated tests

- [ ] Add unit tests in `packages/dashboard/src/__tests__/badge-pubsub.test.ts` covering publish/subscribe round-trips, malformed message handling against the explicit envelope contract, no-config fallback behavior, and adapter cleanup/disposal
- [ ] Expand `packages/dashboard/src/__tests__/websocket.test.ts` with a multi-instance integration test: start two dashboard servers with separate stores, separate `GitHubPollingService` instances, and a shared in-memory test pub/sub adapter; keep origin instance A at zero local websocket subscribers, emit a badge-changing `task:updated` on instance A, subscribe a websocket client to instance B, and assert instance B delivers a `badge:updated` message with the expected snapshot
- [ ] Add an integration assertion that the origin instance does not double-send the same badge snapshot when shared pub/sub echoes the published event back to its own subscriber
- [ ] Add coverage for late subscription replay from the structured snapshot cache so a client subscribing after a remote pub/sub update still receives the freshest cached badge snapshot for that task when one exists
- [ ] Add a poller-isolation assertion proving subscriptions/watch changes on instance B do not mutate the watched-task state used by instance A in the same test process
- [ ] Update `packages/dashboard/src/routes.test.ts` so PR/issue status routes still report cached badge status and stale-refresh behavior correctly when `createApiRoutes()` uses an injected per-server poller instead of the global singleton
- [ ] Run targeted tests with assertions for all changed server/pubsub/poller files

**Artifacts:**
- `packages/dashboard/src/__tests__/badge-pubsub.test.ts` (new/modified)
- `packages/dashboard/src/__tests__/websocket.test.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)
- `packages/dashboard/src/__tests__/github-poll.test.ts` (modified if needed)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run targeted tests: `pnpm --filter @kb/dashboard test -- src/__tests__/badge-pubsub.test.ts src/__tests__/websocket.test.ts src/routes.test.ts src/__tests__/github-poll.test.ts` and `pnpm --filter @dustinbyrne/kb test -- src/__tests__/package-config.test.ts`
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update docs for the new shared badge pub/sub deployment mode, including `KB_BADGE_PUBSUB_REDIS_URL`, `KB_BADGE_PUBSUB_CHANNEL`, the default `kb:badge-updates` channel, local-only fallback behavior, the per-instance polling model, and the fact that `/api/ws` payloads remain badge snapshots rather than full task objects
- [ ] Add a changeset for the published `@dustinbyrne/kb` package because this is a user-facing dashboard deployment capability
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — document shared badge pub/sub support for multi-instance deployments, the Redis/env configuration, per-instance focused polling, and the unchanged `/api/ws` snapshot contract
- `packages/cli/STANDALONE.md` — document how to enable multi-instance badge fan-out when running `kb dashboard` in deployed environments
- `.changeset/*.md` — describe the new multi-instance badge websocket support as a patch release for `@dustinbyrne/kb`

**Check If Affected:**
- `README.md` — update if root-level deployment guidance or dashboard feature summaries mention websocket badge delivery

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] A badge update detected on one dashboard instance is delivered to subscribed websocket clients on another instance through the shared pub/sub layer
- [ ] Origin instances do not double-broadcast their own pub/sub messages
- [ ] Separate dashboard servers in the same process keep separate `GitHubPollingService` watch state
- [ ] `@kb/dashboard` root exports include the injection surfaces needed by embedders (`GitHubPollingService` and the badge pub/sub types/factories used by `ServerOptions`)
- [ ] The published CLI package declares the Redis runtime dependency needed by the bundled dashboard server
- [ ] Local single-instance behavior still works when shared pub/sub is not configured

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-136): complete Step N — description`
- **Bug fixes:** `fix(KB-136): description`
- **Tests:** `test(KB-136): description`

## Do NOT

- Expand scope into websocket authorization hardening beyond what is needed for this pub/sub transport work (that belongs in KB-135)
- Replace the focused GitHub polling design with webhook ingestion (that belongs in KB-137)
- Broadcast full task objects over `/api/ws` or the shared pub/sub channel; keep messages limited to badge snapshot data
- Remove or weaken the existing 5-minute refresh endpoints as a fallback path
- Require a live Redis service in CI tests; use injected/test doubles for automated coverage
- Skip the full `pnpm test` and `pnpm build` quality gates
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
