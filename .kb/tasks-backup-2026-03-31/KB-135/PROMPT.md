# Task: KB-135 - Harden dashboard badge WebSocket authorization

**Created:** 2026-03-30
**Size:** M

## Review Level: 3 (Full)

**Assessment:** This task changes the badge WebSocket handshake across the dashboard server, API surface, and shared browser socket store, and it introduces new security-sensitive token/origin validation. The blast radius is still localized to badge realtime updates, but mistakes would silently preserve or reintroduce the exact exposure this task is meant to close.
**Score:** 6/8 — Blast radius: 1, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Right now `setupBadgeWebSocket()` in `packages/dashboard/src/server.ts` upgrades any request targeting `/api/ws`, and `useBadgeWebSocket()` in `packages/dashboard/app/hooks/useBadgeWebSocket.ts` connects directly to that path with no authentication material beyond the browser's normal same-origin behavior. That is only safe while the dashboard is effectively treated as a local, implicit-trust tool. Harden the badge socket path so realtime PR/issue badge updates require a short-lived signed authorization token delivered via `/api/ws?token=...` plus origin-aware validation during the WebSocket upgrade, while preserving the existing `badge:updated` message format, `githubPoller` watch lifecycle, and the shared ref-counted client behavior already used by `TaskCard.tsx`. The out-of-the-box default must remain usable for `kb dashboard` on a single instance, but must fail closed for unexpected origins and clearly document the extra env needed for multi-instance or reverse-proxied deployments.

## Dependencies

- **Task:** KB-063 (must deliver the badge WebSocket baseline first)
  - KB-063 owns the `/api/ws` badge socket, `packages/dashboard/src/websocket.ts`, `packages/dashboard/src/github-poll.ts`, `packages/dashboard/app/hooks/useBadgeWebSocket.ts`, and viewport-driven badge subscriptions from `TaskCard.tsx`
  - If KB-063 is not merged yet, rebase this task onto its delivered file set before starting even if some of those files already exist in the current tree

## Context to Read First

- `package.json` — authoritative workspace test/build commands: `pnpm test`, `pnpm build`
- `packages/dashboard/src/server.ts` — current `/api/ws` upgrade flow, `setupBadgeWebSocket()`, and poller wiring
- `packages/dashboard/src/websocket.ts` — current badge socket message protocol and subscription manager
- `packages/dashboard/src/github-poll.ts` — existing watch lifecycle that must remain intact after handshake hardening
- `packages/dashboard/src/routes.ts` — place to add the token-minting HTTP endpoint
- `packages/dashboard/src/routes.test.ts` — established route test patterns
- `packages/dashboard/src/__tests__/websocket.test.ts` — existing badge WebSocket integration tests
- `packages/dashboard/app/api.ts` — frontend API helpers
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` — shared browser badge socket store and reconnect logic
- `packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts` — current hook behavior that must stay stable
- `packages/dashboard/app/components/TaskCard.tsx` — current viewport-driven `subscribeToBadge()` / `unsubscribeFromBadge()` usage that should not need a public API change
- `packages/cli/src/commands/dashboard.ts` — current dashboard server bootstrap context; useful for understanding why relying on implicit localhost/same-origin trust is fragile
- `packages/dashboard/README.md` — API and architecture docs that already mention `WS /api/ws`

## File Scope

- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/badge-ws-auth.ts`
- `packages/dashboard/src/__tests__/badge-ws-auth.test.ts`
- `packages/dashboard/src/__tests__/websocket.test.ts`
- `packages/dashboard/src/routes.test.ts`
- `packages/dashboard/app/api.ts`
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts`
- `packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts`
- `packages/dashboard/README.md`
- `.changeset/harden-badge-websocket-auth.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] KB-063 badge WebSocket baseline is present in the checked-out tree (`setupBadgeWebSocket()`, `WebSocketManager`, `githubPoller`, and `useBadgeWebSocket()`)
- [ ] If KB-134 is still open, confirm any remaining full-suite failures are unrelated before starting; do not silently absorb unrelated dashboard regression cleanup into this security task

### Step 1: Add signed badge WebSocket auth primitives and mint endpoint

- [ ] Create `packages/dashboard/src/badge-ws-auth.ts` with a process-wide auth helper that issues short-lived signed tokens for the badge socket, binds them to the request `Origin`, transports them as the `/api/ws?token=...` query param, and verifies signatures with constant-time comparison
- [ ] Define explicit safe defaults: when `KB_DASHBOARD_WS_SECRET` is unset, generate one per-process random secret so local/single-instance `kb dashboard` still works; when `KB_DASHBOARD_ALLOWED_ORIGINS` is unset, allow only the dashboard's own origin derived from the current request/proxy headers rather than falling back to a permissive wildcard; document that multi-instance deployments must provide a shared `KB_DASHBOARD_WS_SECRET`
- [ ] Add a dedicated HTTP endpoint in `packages/dashboard/src/routes.ts` for minting badge WebSocket auth tokens (for example `POST /api/ws/auth`) that returns `{ token, expiresAt }`, sets `Cache-Control: no-store`, returns `400` for missing/malformed origin and `403` for disallowed origin, and never mints unrestricted tokens
- [ ] Keep the token scope badge-socket-specific only: purpose/versioned payload, short TTL, no persistence in task data or browser storage, and no dependency on GitHub polling state
- [ ] Add targeted tests in `packages/dashboard/src/__tests__/badge-ws-auth.test.ts` and `packages/dashboard/src/routes.test.ts` covering default fallback behavior, allowlist parsing, origin binding, expiry, tamper rejection, and successful minting for an allowed origin
- [ ] Run targeted tests for changed files: `cd packages/dashboard && pnpm test -- src/__tests__/badge-ws-auth.test.ts src/routes.test.ts`

**Artifacts:**
- `packages/dashboard/src/badge-ws-auth.ts` (new)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/__tests__/badge-ws-auth.test.ts` (new)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 2: Guard `/api/ws` upgrades with token and origin validation

- [ ] Update `setupBadgeWebSocket()` in `packages/dashboard/src/server.ts` so `/api/ws` upgrades are rejected before `wss.handleUpgrade()` with `401` for missing/invalid/expired/tampered tokens and `403` for origin mismatch or disallowed origin
- [ ] Preserve the existing successful-path behavior after authorization: authenticated clients still register through `WebSocketManager`, `badgeSnapshots` still dedupe broadcasts, and `githubPoller.replaceTaskWatches()` / `unwatchTask()` lifecycle stays unchanged
- [ ] Return explicit HTTP rejection responses for unauthorized upgrades rather than accepting the socket and sending late error frames
- [ ] Extend `packages/dashboard/src/__tests__/websocket.test.ts` with real `/api/ws` integration coverage at the upgrade boundary: at least one test that asserts a mismatched/disallowed origin is rejected before upgrade, one that asserts an expired or tampered token is rejected before upgrade, and one happy-path test that subscribes and receives `badge:updated` with a freshly minted valid token
- [ ] Run targeted tests for changed files: `cd packages/dashboard && pnpm test -- src/__tests__/websocket.test.ts`

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified)
- `packages/dashboard/src/__tests__/websocket.test.ts` (modified)

### Step 3: Acquire fresh auth tokens inside the shared browser badge socket store

- [ ] Add a frontend API helper in `packages/dashboard/app/api.ts` for the new badge-socket auth endpoint, and update `packages/dashboard/app/hooks/useBadgeWebSocket.ts` so every new socket connection fetches a fresh token before opening `/api/ws?token=...` instead of relying on a bare same-origin connect
- [ ] Preserve the current shared-store behavior: one socket for the whole page, ref-counted per-task subscriptions, cached badge snapshots, re-subscription after reconnect, and no duplicate subscribe frames when multiple hook instances subscribe to the same task
- [ ] Handle async connect races safely: if multiple subscriptions arrive while disconnected, only one auth fetch/socket open sequence should proceed; if all subscribers disappear while auth fetch is in flight, do not leave an orphaned socket open
- [ ] Extend `packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts` to cover token fetch-before-connect, reconnect with a fresh token, and stable subscription replay without duplicate sends
- [ ] Run targeted tests for changed files: `cd packages/dashboard && pnpm test -- app/hooks/__tests__/useBadgeWebSocket.test.ts`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` (modified)
- `packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` to document the badge WebSocket auth handshake, the new token mint endpoint, and the operator env vars `KB_DASHBOARD_WS_SECRET` / `KB_DASHBOARD_ALLOWED_ORIGINS`
- [ ] Add `.changeset/harden-badge-websocket-auth.md` describing the dashboard badge WebSocket hardening as a patch release change for `@dustinbyrne/kb`
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (for example: terminal WebSocket auth parity, reverse-proxy identity integration, or secret rotation / multi-instance key management)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — document that `WS /api/ws` now requires a short-lived auth token minted over HTTP, explain the expected handshake flow, and describe `KB_DASHBOARD_WS_SECRET` / `KB_DASHBOARD_ALLOWED_ORIGINS`

**Check If Affected:**
- `README.md` — update only if root-level operator/deployment docs mention dashboard networking or reverse-proxy setup and should reference the new badge WebSocket auth env vars

## Completion Criteria

- [ ] `/api/ws` no longer upgrades connections without a valid signed, unexpired badge WebSocket token bound to an allowed origin
- [ ] Safe defaults are explicit and documented: local single-instance `kb dashboard` works without new env vars, while cross-origin or multi-instance deployments require intentional `KB_DASHBOARD_ALLOWED_ORIGINS` / shared `KB_DASHBOARD_WS_SECRET` configuration
- [ ] `useBadgeWebSocket()` transparently fetches fresh auth tokens and reconnects without breaking the current shared subscription model or badge snapshot merging
- [ ] Valid authorized clients still receive `badge:updated` payloads with the existing message shape
- [ ] README and changeset updated
- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-135): complete Step N — description`
- **Bug fixes:** `fix(KB-135): description`
- **Tests:** `test(KB-135): description`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Turn this into a full dashboard login/session system or multi-user authorization model
- Change `/api/terminal/ws`, terminal session auth, or PTY security in this task
- Persist badge WebSocket auth tokens in localStorage/sessionStorage or make them long-lived bearer credentials
- Rely on `Origin` checks alone without a signed token-based handshake
- Break the existing `badge:updated` payload format, shared single-socket store, or `TaskCard.tsx` viewport subscription behavior
- Expand into multi-instance broadcast scaling (KB-136) or GitHub webhook ingestion (KB-137)
- Add permissive global CORS as a substitute for explicit badge socket authorization
