# Task: KB-063 - Real-time Badge Updates via WebSocket

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This task adds WebSocket infrastructure for real-time badge updates, integrating with existing PR/issue badge system. Moderate complexity involving server-side WebSocket management, efficient change detection, and frontend subscription handling.
**Score:** 5/8 — Blast radius: 1 (localized to badge system), Pattern novelty: 2 (new WebSocket layer), Security: 1 (standard WebSocket patterns), Reversibility: 1 (can fall back to polling)

## Mission

Add WebSocket support to push real-time updates to GitHub PR and issue badges when their status changes on GitHub. Currently the system relies on 5-minute polling staleness checks (`refreshPrInBackground` in routes.ts) which causes delayed badge state updates. WebSocket connections will enable immediate badge color/state changes when PRs are merged, issues are closed, or comments are added.

This improves dashboard responsiveness and reduces unnecessary GitHub API polling by only fetching when the server detects changes.

## Dependencies

- **Task:** KB-022 — GitHub Badges on Task Cards (must complete first)
  - Provides `IssueInfo` type in `packages/core/src/types.ts`
  - Provides `updateIssueInfo` method in `packages/core/src/store.ts`
  - Provides issue badge display in `TaskCard.tsx` and `GitHubBadge.tsx`
  - Provides `/tasks/:id/issue/status` and `/tasks/:id/issue/refresh` endpoints

## Context to Read First

- `packages/dashboard/src/server.ts` — Express server setup, existing SSE endpoint pattern
- `packages/dashboard/src/sse.ts` — SSE implementation pattern for task events
- `packages/dashboard/src/routes.ts` — Current PR status endpoints, `refreshPrInBackground` polling
- `packages/dashboard/src/github.ts` — `GitHubClient` class with `getPrStatus` and `getIssueStatus` methods
- `packages/dashboard/app/hooks/useTasks.ts` — How frontend currently receives task updates via SSE
- `packages/dashboard/app/components/TaskCard.tsx` — Badge display, uses `prInfo` and will use `issueInfo`
- `packages/dashboard/app/components/GitHubBadge.tsx` — Created by KB-022, displays PR/issue badges
- `packages/dashboard/app/api.ts` — API functions including `fetchPrStatus`, `refreshPrStatus`
- `packages/core/src/store.ts` — `updatePrInfo`, `updateIssueInfo` methods that emit `task:updated` events
- `packages/core/src/types.ts` — `PrInfo`, `IssueInfo` type definitions

## File Scope

- `packages/dashboard/package.json` — Add `ws` dependency
- `packages/dashboard/src/server.ts` — Integrate WebSocket server with Express
- `packages/dashboard/src/websocket.ts` — New WebSocket manager (connection handling, subscriptions, message routing)
- `packages/dashboard/src/github-poll.ts` — New optimized GitHub polling service that pushes changes via WebSocket
- `packages/dashboard/src/routes.ts` — Modify PR/issue refresh to emit WebSocket updates
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` — New frontend hook for WebSocket badge subscriptions
- `packages/dashboard/app/components/TaskCard.tsx` — Subscribe to badge updates for visible tasks
- `packages/dashboard/app/components/GitHubBadge.tsx` — Listen for real-time updates
- `packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts` — Tests for WebSocket hook
- `packages/dashboard/src/__tests__/websocket.test.ts` — Tests for WebSocket server

## Steps

### Step 0: Preflight

- [ ] KB-022 is complete (IssueInfo types, updateIssueInfo, issue badge endpoints exist)
- [ ] Run `pnpm install` to ensure dependencies are current

### Step 1: Add WebSocket Dependency

- [ ] Add `ws` to `packages/dashboard/package.json` dependencies:
  ```json
  "ws": "^8.18.0"
  ```
- [ ] Add `@types/ws` to devDependencies:
  ```json
  "@types/ws": "^8.5.0"
  ```
- [ ] Run `pnpm install` in `packages/dashboard`

**Artifacts:**
- `packages/dashboard/package.json` (modified)

### Step 2: Create WebSocket Manager

- [ ] Create `packages/dashboard/src/websocket.ts`:
  - Export `WebSocketManager` class
  - Track client connections with unique IDs
  - Support subscription channels: `badge:${taskId}` for per-task badge updates
  - Methods:
    - `addClient(ws: WebSocket, clientId: string)` — Register new connection
    - `removeClient(clientId: string)` — Clean up disconnected client subscriptions
    - `subscribe(clientId: string, taskId: string)` — Client subscribes to badge updates for a task
    - `unsubscribe(clientId: string, taskId: string)` — Unsubscribe from task updates
    - `broadcastBadgeUpdate(taskId: string, badgeData: BadgeUpdate)` — Push update to all subscribed clients
  - Message protocol (JSON):
    - Client → Server: `{ type: "subscribe", taskId: string }`, `{ type: "unsubscribe", taskId: string }`
    - Server → Client: `{ type: "badge:updated", taskId: string, prInfo?: PrInfo, issueInfo?: IssueInfo, timestamp: string }`
  - Heartbeat/ping-pong to detect dead connections (30s interval)
  - Proper cleanup on disconnect to prevent memory leaks

**Artifacts:**
- `packages/dashboard/src/websocket.ts` (new)

### Step 3: Create Optimized GitHub Polling Service

- [ ] Create `packages/dashboard/src/github-poll.ts`:
  - Export `GitHubPollingService` class
  - Tracks tasks with PRs/issues that need monitoring
  - Configurable polling interval (default 60s for WebSocket-monitored tasks vs 5min for background)
  - Methods:
    - `start()` — Begin polling loop
    - `stop()` — Stop polling loop
    - `watchTask(taskId: string, type: "pr" | "issue", owner: string, repo: string, number: number)` — Add task to watch list
    - `unwatchTask(taskId: string)` — Remove task from watch list
  - For each poll cycle:
    - Batch GitHub API requests (reuse existing `GitHubClient`)
    - Compare fetched status with cached status from `store.getTask()`
    - If status changed: call `store.updatePrInfo()` or `store.updateIssueInfo()` (which emits `task:updated`)
    - The store event will trigger WebSocket broadcast (Step 4)
  - Use `GitHubRateLimiter` to respect API limits
  - Export singleton instance `githubPoller` for use across routes

**Artifacts:**
- `packages/dashboard/src/github-poll.ts` (new)

### Step 4: Integrate WebSocket with Server

- [ ] Modify `packages/dashboard/src/server.ts`:
  - Import `WebSocketManager` and `githubPoller`
  - Import `WebSocketServer` from `ws`
  - Create WebSocket server attached to HTTP server
  - On connection: register client with WebSocketManager, start `githubPoller` if first client
  - On disconnect: remove client, stop `githubPoller` if no clients remain
  - Bridge store events to WebSocket:
    - Listen to `store.on("task:updated")`
    - If update includes `prInfo` or `issueInfo` changes, call `wsManager.broadcastBadgeUpdate(task.id, { prInfo, issueInfo })`
  - Add WebSocket endpoint at `/api/ws` (same origin, no CORS issues)

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified)

### Step 5: Add Frontend WebSocket Hook

- [ ] Create `packages/dashboard/app/hooks/useBadgeWebSocket.ts`:
  - Connect to `wss://${window.location.host}/api/ws` (or `ws://` for localhost)
  - Auto-reconnect with exponential backoff (max 5s delay)
  - Methods:
    - `subscribeToBadge(taskId: string)` — Send subscribe message
    - `unsubscribeFromBadge(taskId: string)` — Send unsubscribe message
  - Return:
    - `badgeUpdates: Map<string, { prInfo?: PrInfo; issueInfo?: IssueInfo }>` — Latest badge data by taskId
    - `isConnected: boolean`
    - `subscribeToBadge(taskId: string)` function
  - Handle messages:
    - On `badge:updated`: update `badgeUpdates` map
  - Cleanup: unsubscribe all on unmount

**Artifacts:**
- `packages/dashboard/app/hooks/useBadgeWebSocket.ts` (new)

### Step 6: Integrate Badge Updates in TaskCard

- [ ] Modify `packages/dashboard/app/components/TaskCard.tsx`:
  - Import `useBadgeWebSocket` hook
  - Call `subscribeToBadge(task.id)` when card mounts/enters viewport
  - Call `unsubscribeFromBadge(task.id)` when card unmounts/leaves viewport
  - Merge real-time badge data with task data:
    ```typescript
    const { badgeUpdates, subscribeToBadge, unsubscribeFromBadge } = useBadgeWebSocket();
    const livePrInfo = badgeUpdates.get(task.id)?.prInfo ?? task.prInfo;
    const liveIssueInfo = badgeUpdates.get(task.id)?.issueInfo ?? task.issueInfo;
    ```
  - Pass `livePrInfo` and `liveIssueInfo` to `GitHubBadge` component

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Create `packages/dashboard/src/__tests__/websocket.test.ts`:
  - Test `WebSocketManager` subscription/unsubscription
  - Test `broadcastBadgeUpdate` delivers to correct clients
  - Test heartbeat/ping-pong keeps connections alive
  - Test cleanup on disconnect removes subscriptions
- [ ] Create `packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts`:
  - Test hook connects and reconnects on close
  - Test `subscribeToBadge` sends correct message
  - Test badge updates are received and stored
  - Test unsubscribes on unmount
- [ ] Create `packages/dashboard/src/__tests__/github-poll.test.ts`:
  - Test `watchTask` adds to polling list
  - Test status change detection triggers store update
  - Test rate limiter integration
  - Test batch fetching
- [ ] Run `pnpm test` in `packages/dashboard` — fix all failures
- [ ] Run `pnpm build` — ensure TypeScript compilation passes

**Artifacts:**
- `packages/dashboard/src/__tests__/websocket.test.ts` (new)
- `packages/dashboard/app/hooks/__tests__/useBadgeWebSocket.test.ts` (new)
- `packages/dashboard/src/__tests__/github-poll.test.ts` (new)

### Step 8: Documentation & Delivery

- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/websocket-badge-updates.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add real-time WebSocket updates for GitHub PR and issue badges. Badges now update immediately when PR/issue status changes on GitHub, replacing the 5-minute polling delay.
  EOF
  ```
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - WebSocket security/authorization (if needed beyond same-origin)
  - Scaling WebSocket to multiple dashboard instances (Redis pub/sub)
  - GitHub App webhook integration for instant push notifications (bypass polling entirely)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section on WebSocket badge updates, document `useBadgeWebSocket` hook

**Check If Affected:**
- `packages/dashboard/README.md` — Update architecture diagram if it exists

## Completion Criteria

- [ ] WebSocket server runs at `/api/ws` and accepts connections
- [ ] Dashboard cards auto-subscribe to badge updates when visible
- [ ] Badge color/state updates immediately when PR/issue changes on GitHub (<5s latency)
- [ ] Unsubscribing when cards leave viewport prevents unnecessary traffic
- [ ] GitHub API rate limits respected (batched requests, interval spacing)
- [ ] All tests passing
- [ ] Build passes
- [ ] No memory leaks (verified with heap snapshots or long-running tests)
- [ ] Graceful fallback: if WebSocket fails, badges still work via existing polling

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-063): complete Step N — description`
- **Bug fixes:** `fix(KB-063): description`
- **Tests:** `test(KB-063): description`

## Do NOT

- Remove the existing 5-minute background refresh — keep it as fallback
- Use WebSocket for all task updates (only badge-specific real-time updates)
- Implement GitHub webhooks (out of scope, requires external webhook receiver)
- Add authentication to WebSocket (same-origin is sufficient for dashboard)
- Use Socket.IO or other heavy libraries — stick with `ws` for lightweight solution
- Poll GitHub more frequently than 60s for watched tasks (rate limit protection)
- Send full task objects over WebSocket (only badge data: prInfo/issueInfo)
