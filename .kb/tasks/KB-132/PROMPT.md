# Task: KB-132 - Fix interactive terminal startup showing disconnected / pattern error

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This bug spans the published `kb board` startup path plus the dashboard terminal client/server flow, but it stays inside the existing PTY/WebSocket design. The fix should be surgical if it follows the current terminal architecture instead of introducing a new transport.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Repair the dashboard’s interactive terminal so opening the Terminal modal in `kb board` creates a real PTY session, reaches a connected state, and no longer shows the raw “string did not match expected pattern” failure. This matters because the terminal is a documented user-facing feature of the dashboard, and right now the startup path is broken across the CLI/server/frontend boundary.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/src/commands/dashboard.ts` — `runDashboard()` boot sequence, `app.listen(...)`, and browser-open behavior
- `packages/dashboard/src/index.ts` — current `@kb/dashboard` public exports
- `packages/dashboard/src/server.ts` — `createServer()` and `setupTerminalWebSocket()` for PTY WebSocket mounting and message handling
- `packages/dashboard/src/routes.ts` — `POST /api/terminal/sessions` REST creation path
- `packages/dashboard/src/terminal-service.ts` — PTY session creation, validation, buffering, and cleanup rules
- `packages/dashboard/app/hooks/useTerminal.ts` — client WebSocket bootstrap, reconnect, and callback dispatch logic
- `packages/dashboard/app/components/TerminalModal.tsx` — modal session lifecycle, error banner, and status UI
- `packages/cli/src/commands/dashboard.test.ts` — existing CLI startup test patterns and `@kb/dashboard` mocking style
- `packages/dashboard/app/hooks/useTerminal.test.ts` — current terminal hook coverage and known connect-path failures
- `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` — current terminal modal regression coverage
- `packages/dashboard/src/terminal-service.test.ts` — existing service-level terminal assertions that may need to be brought back in sync with the repaired bootstrap path
- `packages/dashboard/README.md` — documented interactive terminal behavior and API surface

## File Scope

- `packages/cli/src/commands/dashboard.ts`
- `packages/cli/src/commands/dashboard.test.ts`
- `packages/dashboard/src/index.ts`
- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/server.test.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/terminal-service.ts`
- `packages/dashboard/src/terminal-service.test.ts`
- `packages/dashboard/app/api.ts`
- `packages/dashboard/app/hooks/useTerminal.ts`
- `packages/dashboard/app/hooks/useTerminal.test.ts`
- `packages/dashboard/app/components/TerminalModal.tsx`
- `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx`
- `packages/dashboard/README.md`
- `packages/cli/STANDALONE.md`
- `.changeset/*.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied
- [ ] Reproduce the current failure and capture the exact baseline symptom in code or test form: Terminal modal starts disconnected, and the startup path can surface the raw “string did not match expected pattern” message
- [ ] Record the current `pnpm test` / `pnpm build` baseline before changes so any pre-existing failures encountered during this task are explicit

### Step 1: Restore the terminal bootstrap path in `kb board`

- [ ] `runDashboard()` mounts the PTY WebSocket endpoint used by `useTerminal()` by exporting `setupTerminalWebSocket()` from `@kb/dashboard` and invoking it against the HTTP server returned by `app.listen(...)`
- [ ] Terminal session creation and handshake work end-to-end for `POST /api/terminal/sessions` followed by `WS /api/terminal/ws?sessionId=...`, without weakening `TerminalService` validation or cleanup behavior
- [ ] Add automated tests covering the startup wiring and server-side handshake path, including at minimum: CLI startup wiring in `packages/cli/src/commands/dashboard.test.ts`, missing/unknown session handling in a new `packages/dashboard/src/server.test.ts`, and any service-level regressions introduced in `packages/dashboard/src/terminal-service.test.ts`
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)
- `packages/cli/src/commands/dashboard.test.ts` (modified)
- `packages/dashboard/src/index.ts` (modified)
- `packages/dashboard/src/server.ts` (modified)
- `packages/dashboard/src/server.test.ts` (new)
- `packages/dashboard/src/routes.ts` (modified, if terminal session bootstrap contracts need adjustment)
- `packages/dashboard/src/terminal-service.ts` (modified, if service behavior needs hardening)
- `packages/dashboard/src/terminal-service.test.ts` (modified)

### Step 2: Harden terminal connection and error handling in the dashboard UI

- [ ] `useTerminal()` handles WebSocket URL construction and constructor/connect failures deterministically so the terminal does not stay stuck in a silent disconnected state
- [ ] `TerminalModal` replaces raw browser/DOMException copy like “string did not match expected pattern” with actionable terminal startup messaging, clears stale errors after a successful session start, and preserves reconnect/new-session behavior
- [ ] Add automated tests in `packages/dashboard/app/hooks/useTerminal.test.ts` and `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` covering successful connect, malformed/failed WebSocket bootstrap, disconnect/reconnect transitions, and error-banner behavior
- [ ] Run targeted tests for changed files

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified, if session/bootstrap error handling needs API adjustments)
- `packages/dashboard/app/hooks/useTerminal.ts` (modified)
- `packages/dashboard/app/hooks/useTerminal.test.ts` (modified)
- `packages/dashboard/app/components/TerminalModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/TerminalModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test`
- [ ] Fix all failures caused by this task or living in the terminal-related files touched here before moving on
- [ ] If unrelated failures outside this task’s scope still block the full suite, do not waive them — capture them explicitly and create/update blocker tasks before handoff
- [ ] Run `pnpm build`
- [ ] Build passes

### Step 4: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` so the interactive terminal docs match the repaired PTY/WebSocket startup and error/reconnect behavior
- [ ] Add a patch changeset for `@dustinbyrne/kb` covering the dashboard terminal startup fix
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

**Artifacts:**
- `packages/dashboard/README.md` (modified)
- `packages/cli/STANDALONE.md` (modified, if dashboard startup notes are affected)
- `.changeset/fix-dashboard-terminal-startup.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — document the repaired interactive terminal startup flow, connection states, and user-visible error/reconnect behavior
- `.changeset/fix-dashboard-terminal-startup.md` — patch changeset for the `@dustinbyrne/kb` user-facing terminal fix

**Check If Affected:**
- `packages/cli/STANDALONE.md` — update dashboard usage notes if terminal startup expectations or troubleshooting text are described there
- `packages/cli/README.md` — update only if the dashboard feature list or user guidance references terminal behavior changed by this fix

## Completion Criteria

- [ ] Opening the Terminal modal in `kb board` creates a live PTY session and reaches a connected state under normal local startup
- [ ] The dashboard no longer surfaces raw “string did not match expected pattern” text for terminal bootstrap failures
- [ ] Regression tests cover CLI WebSocket mounting plus terminal hook/modal failure handling
- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-132): complete Step N — description`
- **Bug fixes:** `fix(KB-132): description`
- **Tests:** `test(KB-132): description`

## Do NOT

- Expand task scope
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Reintroduce the deprecated SSE terminal path as the primary fix; keep the PTY/WebSocket architecture authoritative
- Weaken shell allowlists, path traversal protection, session ID validation, or environment sanitization in `packages/dashboard/src/terminal-service.ts`
- Fold unrelated branding or broad dashboard cleanup into this bugfix unless it is required to get the terminal startup path and its tests green
- Skip the required changeset if the final fix changes user-facing `kb board` behavior shipped through `@dustinbyrne/kb`
