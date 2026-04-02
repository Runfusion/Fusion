# Task: KB-608 - Terminal from dashboard doesn't work

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** The terminal feature spans multiple layers (frontend React components, WebSocket hook, API routes, and node-pty backend service). A medium review level is appropriate due to cross-component integration complexity and the need to verify WebSocket and PTY handling.

**Score:** 5/8 — Blast radius: 2 (affects terminal subsystem only), Pattern novelty: 1 (standard WebSocket/PTY patterns), Security: 1 (command validation exists), Reversibility: 1 (terminal is non-critical feature).

## Mission

Diagnose and fix the non-functional terminal feature in the kb dashboard. The terminal should provide an interactive PTY session via WebSocket where users can execute commands in the project directory. Identify the root cause (whether WebSocket connection, PTY session creation, API routing, or frontend integration) and implement the fix with proper test coverage.

## Dependencies

- **None**

## Context to Read First

Before implementing, read these files to understand the current terminal architecture:

1. **`packages/dashboard/app/components/TerminalModal.tsx`** — React component that renders the terminal UI using xterm.js
2. **`packages/dashboard/app/hooks/useTerminal.ts`** — WebSocket client hook that manages connection to `/api/terminal/ws`
3. **`packages/dashboard/src/terminal-service.ts`** — Backend PTY service using node-pty for shell session management
4. **`packages/dashboard/src/server.ts`** — WebSocket server setup in `setupTerminalWebSocket()` function
5. **`packages/dashboard/src/routes.ts`** — REST API routes for terminal session creation (`POST /api/terminal/sessions`)
6. **`packages/dashboard/app/api.ts`** — Frontend API functions including `createTerminalSession()` and `killPtyTerminalSession()`

## File Scope

**Read/modify these files as needed to fix the terminal:**

- `packages/dashboard/app/components/TerminalModal.tsx` (diagnose/fix UI issues)
- `packages/dashboard/app/hooks/useTerminal.ts` (diagnose/fix WebSocket client)
- `packages/dashboard/src/terminal-service.ts` (diagnose/fix PTY session creation)
- `packages/dashboard/src/server.ts` (diagnose/fix WebSocket server setup)
- `packages/dashboard/src/routes.ts` (verify/fix REST API routes)
- `packages/dashboard/app/api.ts` (verify/fix API functions)

**Test files to update:**

- `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx`
- `packages/dashboard/app/hooks/useTerminal.test.ts`
- `packages/dashboard/src/terminal-service.test.ts`
- `packages/dashboard/src/routes.test.ts` (if API route issues found)

## Steps

### Step 1: Run Tests and Identify Failures

First, run the existing terminal tests to identify what's broken.

- [ ] Run `pnpm test` in `packages/dashboard` directory
- [ ] Identify which terminal tests fail (TerminalModal, useTerminal, terminal-service)
- [ ] Document specific error messages and failure points
- [ ] Check if node-pty native module loads correctly (may fail in test environment)

**Artifacts:**
- Test failure report with specific error messages

### Step 2: Diagnose WebSocket Connection

Verify the WebSocket upgrade handling and connection flow.

- [ ] Verify `setupTerminalWebSocket()` in `server.ts` attaches to HTTP server correctly
- [ ] Check that the `upgrade` event handler filters for `/api/terminal/ws` pathname
- [ ] Verify WebSocket connection can be established from browser/client
- [ ] Check that session validation works (returns 4004 for invalid sessionId)
- [ ] Verify heartbeat/ping-pong keeps connection alive
- [ ] Write/update tests for WebSocket connection handling

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified if WebSocket setup issues found)
- Updated tests in `packages/dashboard/src/server.test.ts` (if it exists, otherwise add WebSocket tests to appropriate file)

### Step 3: Diagnose PTY Session Creation

Verify the PTY session creation and management works correctly.

- [ ] Check `POST /api/terminal/sessions` route in `routes.ts` creates sessions properly
- [ ] Verify `terminal-service.ts` lazy-loads node-pty and handles load failures gracefully
- [ ] Test shell detection logic works for current platform (darwin/linux/win32)
- [ ] Verify session limit enforcement doesn't block legitimate sessions
- [ ] Check that scrollback buffer is returned to new WebSocket connections
- [ ] Write/update tests for PTY session creation

**Artifacts:**
- `packages/dashboard/src/terminal-service.ts` (modified if PTY issues found)
- `packages/dashboard/src/routes.ts` (modified if API route issues found)
- Updated tests

### Step 4: Diagnose Frontend Integration

Verify the frontend correctly creates sessions and connects to WebSocket.

- [ ] Verify `TerminalModal` calls `createTerminalSession()` API on open
- [ ] Check that `useTerminal` hook receives the sessionId and connects WebSocket
- [ ] Verify xterm.js initializes correctly with proper container ref
- [ ] Check that terminal data flows bidirectionally (input → PTY → output → xterm)
- [ ] Verify resize events propagate to PTY
- [ ] Write/update tests for frontend integration

**Artifacts:**
- `packages/dashboard/app/components/TerminalModal.tsx` (modified if UI issues found)
- `packages/dashboard/app/hooks/useTerminal.ts` (modified if hook issues found)
- `packages/dashboard/app/api.ts` (modified if API client issues found)
- Updated tests

### Step 5: Integration Testing & Verification

Run the full test suite and verify terminal works end-to-end.

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test` (all packages)
- [ ] Verify all terminal-related tests pass
- [ ] Build the dashboard: `pnpm build` in `packages/dashboard`
- [ ] Verify build succeeds without errors
- [ ] Create a changeset for the fix (patch level for bug fix)

**Artifacts:**
- `.changeset/fix-dashboard-terminal.md` (changeset file)

### Step 6: Documentation & Delivery

Update any relevant documentation and mark task complete.

- [ ] Update `packages/dashboard/README.md` if terminal usage instructions need changes
- [ ] Add inline comments for any non-obvious fixes
- [ ] Out-of-scope findings (larger refactors) created as new tasks via `task_create`

## Documentation Requirements

**Must Update:**
- None unless terminal usage changed significantly

**Check If Affected:**
- `packages/dashboard/README.md` — verify terminal section is accurate

## Completion Criteria

- [ ] All terminal tests pass
- [ ] Full test suite passes
- [ ] Build succeeds
- [ ] Terminal feature works end-to-end (session creation → WebSocket connection → command execution)
- [ ] Changeset created for the fix

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-608): complete Step N — description`
- **Bug fixes:** `fix(KB-608): description`
- **Tests:** `test(KB-608): description`

## Do NOT

- Expand scope beyond fixing the terminal feature
- Skip tests even if node-pty native module is hard to mock (use proper mocks)
- Modify unrelated dashboard features
- Remove the terminal feature entirely (must fix, not delete)
- Ignore WebSocket security considerations (keep session validation)
