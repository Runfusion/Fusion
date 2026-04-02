# Task: KB-172 - Fix Terminal Session Leak and "Max Sessions Reached" Error

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a session lifecycle management bug in the dashboard terminal. The fix requires modifying the WebSocket close handler to properly kill sessions, implementing stale session eviction, and adding session inactivity tracking. Test changes required for the new cleanup behavior.

**Score:** 5/8 — Blast radius: 1 (localized to terminal-service), Pattern novelty: 1 (standard resource cleanup), Security: 1 (no security implications), Reversibility: 2 (sessions are ephemeral, safe to kill)

## Mission

Fix the dashboard terminal's "Max sessions may be reached" error by properly cleaning up PTY sessions when WebSockets disconnect. Currently, terminal sessions leak because the WebSocket close handler only unsubscribes from events but doesn't kill the underlying PTY process. Additionally, implement stale session eviction so old/disconnected sessions are automatically cleaned up when the session limit is approached.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/server.ts` — WebSocket terminal server setup, close handler logic (lines ~276-325)
- `packages/dashboard/src/terminal-service.ts` — Session management, singleton pattern, createSession/killSession methods
- `packages/dashboard/src/routes.ts` — Terminal API routes (POST/DELETE /api/terminal/sessions)
- `packages/dashboard/src/terminal-service.test.ts` — Existing tests for session management

## File Scope

- `packages/dashboard/src/server.ts` — Modify WebSocket close handler to kill sessions
- `packages/dashboard/src/terminal-service.ts` — Add session activity tracking, stale session eviction, lastActivity timestamps
- `packages/dashboard/src/terminal-service.test.ts` — Add tests for stale session eviction, activity tracking
- `packages/dashboard/src/routes.test.ts` — Add tests for terminal session cleanup behavior

## Steps

### Step 1: Add Session Activity Tracking to TerminalService

- [ ] Add `lastActivityAt` timestamp field to `TerminalSession` interface
- [ ] Add `updateActivity(sessionId: string)` method to track user interaction
- [ ] Initialize `lastActivityAt` to `new Date()` on session creation
- [ ] Update `write()` method to call `updateActivity()` on input
- [ ] Add `getStaleSessions(thresholdMs: number)` method to find inactive sessions

**Artifacts:**
- `packages/dashboard/src/terminal-service.ts` (modified)

### Step 2: Implement Stale Session Eviction

- [ ] Add `evictStaleSessions(thresholdMs: number = 300_000)` method that kills sessions inactive for >5 minutes
- [ ] Call `evictStaleSessions()` at the start of `createSession()` when at 80% of session limit
- [ ] Sort stale sessions by `lastActivityAt` (oldest first) and evict until below 80% limit
- [ ] Add `STALE_SESSION_THRESHOLD_MS` constant (5 minutes = 300,000ms)
- [ ] Log evictions for observability (`console.info` with session ID and idle duration)

**Artifacts:**
- `packages/dashboard/src/terminal-service.ts` (modified)

### Step 3: Fix WebSocket Close Handler to Kill Sessions

- [ ] In `setupTerminalWebSocket()`, track `sessionId` in connection scope
- [ ] In WebSocket `close` handler, call `terminalService.killSession(sessionId)` after unsubscribing
- [ ] In WebSocket `error` handler, also call `terminalService.killSession(sessionId)`
- [ ] Add try-catch around kill call to prevent errors during cleanup from crashing the handler
- [ ] Ensure `onExit` callback still fires when session is killed via WebSocket disconnect

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified)

### Step 4: Add Session Listing Endpoint for Observability

- [ ] Verify `GET /api/terminal/sessions` returns active sessions with `createdAt` and `cwd`
- [ ] Add `lastActivityAt` to the session listing response format
- [ ] Ensure listing doesn't expose sensitive data (scrollbackBuffer, env vars, etc.)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: `TerminalService` tracks `lastActivityAt` on session creation and input
- [ ] Add test: `evictStaleSessions()` kills sessions inactive beyond threshold
- [ ] Add test: `createSession()` auto-evicts stale sessions when at 80% limit
- [ ] Add test: WebSocket close handler kills the associated PTY session
- [ ] Run `pnpm test` — all tests pass
- [ ] Run `pnpm build` — build succeeds

**Artifacts:**
- `packages/dashboard/src/terminal-service.test.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 6: Documentation & Delivery

- [ ] Update AGENTS.md terminal section if it exists, noting the session lifecycle behavior
- [ ] Create changeset: `.changeset/fix-terminal-session-leak.md` (patch level)
- [ ] Verify terminal modal still works end-to-end (manual check)

**Artifacts:**
- `.changeset/fix-terminal-session-leak.md` (new)

## Documentation Requirements

**Must Update:**
- `.changeset/fix-terminal-session-leak.md` — Brief description of the fix

**Check If Affected:**
- `AGENTS.md` — Terminal section if session behavior is documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] WebSocket disconnect properly kills PTY session (verified via test)
- [ ] Stale sessions are auto-evicted when approaching limit
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-172): complete Step N — description`
- **Bug fixes:** `fix(KB-172): description`
- **Tests:** `test(KB-172): description`

## Do NOT

- Change the default `DEFAULT_MAX_SESSIONS` value (10) without explicit approval
- Remove existing terminal functionality or change the public API
- Add complex session persistence (sessions should remain ephemeral)
- Modify the frontend terminal behavior (keep current UX)
- Skip tests for the new cleanup behavior
