# Task: FN-672 - Fix Terminal Session Creation Error Messages

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Surgical fix to improve error diagnostics in terminal session creation. Changes are isolated to terminal-service.ts and routes.ts with clear test updates.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix misleading terminal session creation error messages. Currently, when `TerminalService.createSession()` fails for any reason (max sessions, shell not allowed, PTY module load failure, or PTY spawn failure), it returns `null` and the route handler always returns the same generic error: "Failed to create session. Max sessions may be reached." This is confusing because the actual cause may be completely different.

The fix will:
1. Modify `createSession()` to return discriminated error information instead of just `null`
2. Update the route handler to return specific, actionable error messages based on the actual failure cause
3. Update tests to verify the new error messages

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/terminal-service.ts` — `createSession()` method and error handling
- `packages/dashboard/src/routes.ts` — `POST /api/terminal/sessions` route handler
- `packages/dashboard/src/terminal-service.test.ts` — existing test patterns
- `packages/dashboard/src/routes.test.ts` — existing test patterns for terminal routes

## File Scope

- `packages/dashboard/src/terminal-service.ts` (modify)
- `packages/dashboard/src/routes.ts` (modify)
- `packages/dashboard/src/terminal-service.test.ts` (modify)
- `packages/dashboard/src/routes.test.ts` (modify)

## Steps

### Step 1: Update TerminalService Return Type

- [ ] Create a discriminated union type `CreateSessionResult` in `terminal-service.ts`:
  - `{ success: true; session: TerminalSession }` for successful creation
  - `{ success: false; error: string; code: 'max_sessions' | 'invalid_shell' | 'pty_load_failed' | 'pty_spawn_failed' }` for failures
- [ ] Update `createSession()` to return `Promise<CreateSessionResult>` instead of `Promise<TerminalSession | null>`
- [ ] Update all failure paths to return specific error codes and messages:
  - `max_sessions`: "Maximum terminal sessions reached. Please close an existing terminal and try again."
  - `invalid_shell`: "Shell not allowed. Please use a supported shell (bash, zsh, sh, cmd, powershell)."
  - `pty_load_failed`: "Terminal service unavailable. The PTY module could not be loaded."
  - `pty_spawn_failed`: "Failed to start terminal shell process."
- [ ] Run terminal-service tests and fix any failures

**Artifacts:**
- `packages/dashboard/src/terminal-service.ts` (modified)

### Step 2: Update Routes Handler

- [ ] Update `POST /api/terminal/sessions` route in `routes.ts` to handle the new `CreateSessionResult` type
- [ ] Return specific HTTP status codes based on error type:
  - `max_sessions`: 503 (Service Unavailable)
  - `invalid_shell`: 400 (Bad Request)
  - `pty_load_failed`: 503 (Service Unavailable)
  - `pty_spawn_failed`: 500 (Internal Server Error)
- [ ] Return the specific error message from the result in the response body
- [ ] Run routes tests and fix any failures

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Update Tests

- [ ] Update `terminal-service.test.ts`:
  - Change `expect(session2).toBeNull()` to check for `success: false` and appropriate error code
  - Update all test cases that check for `null` returns to check for error results
- [ ] Update `routes.test.ts`:
  - Update the mock to return the new result type
  - Add assertions for specific error codes and messages
- [ ] Run full test suite for affected files

**Artifacts:**
- `packages/dashboard/src/terminal-service.test.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test -- packages/dashboard/src/terminal-service.test.ts`
- [ ] Run `pnpm test -- packages/dashboard/src/routes.test.ts`
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Create changeset file for patch release (internal improvement)
- [ ] Verify no documentation updates needed (internal diagnostic improvement)
- [ ] No out-of-scope findings expected

## Documentation Requirements

**Must Update:**
- None (internal diagnostic improvement)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes
- [ ] Terminal now returns specific, actionable error messages instead of misleading "Max sessions" message

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-672): complete Step N — description`
- **Bug fixes:** `fix(FN-672): description`
- **Tests:** `test(FN-672): description`

## Do NOT

- Expand task scope beyond error message improvements
- Skip tests
- Modify files outside the File Scope
- Change the PTY module loading mechanism (just report the error)
- Add new dependencies
