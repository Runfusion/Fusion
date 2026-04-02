# Task: KB-249 - Check for stuck tasks immediately after timer setting change

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a targeted improvement to the stuck task detector. Requires a single new method and an event handler. Low blast radius, well-contained change.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

When the `taskStuckTimeoutMs` setting is changed (e.g., user reduces timeout from 30 minutes to 10 minutes), the system should immediately check for in-progress tasks that are now stuck under the new timer value. Currently, the stuck task detector only checks on its 30-second polling interval, which means a user lowering the timeout may have to wait up to 30 seconds for already-stuck tasks to be detected and recovered.

The fix: add an immediate check capability to `StuckTaskDetector` and wire it to the `settings:updated` event when `taskStuckTimeoutMs` changes.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/stuck-task-detector.ts` — Current stuck task detector implementation
- `packages/engine/src/stuck-task-detector.test.ts` — Existing tests (shows how detector is tested)
- `packages/cli/src/commands/dashboard.ts` — Where StuckTaskDetector is instantiated and where the `settings:updated` handler should be added (see existing patterns for `globalPause` and `enginePaused` transitions)

## File Scope

- `packages/engine/src/stuck-task-detector.ts` (add public method)
- `packages/engine/src/stuck-task-detector.test.ts` (add tests for new method)
- `packages/cli/src/commands/dashboard.ts` (add event handler)

## Steps

### Step 1: Add Immediate Check Method to StuckTaskDetector

- [ ] Add public `checkNow(): Promise<void>` method to `StuckTaskDetector` class
- [ ] Method should run the same stuck detection logic as the private `checkStuckTasks()` method
- [ ] Method should be callable at any time (safe to call even when detector is stopped)
- [ ] Log at debug level when check is triggered manually vs via polling
- [ ] Run targeted tests for changed files: `pnpm test --filter @kb/engine -- stuck-task-detector`

**Artifacts:**
- `packages/engine/src/stuck-task-detector.ts` (modified)

### Step 2: Add Tests for checkNow Method

- [ ] Add test: `checkNow() detects and kills stuck tasks immediately`
- [ ] Add test: `checkNow() is safe to call when no tasks are tracked`
- [ ] Add test: `checkNow() is safe to call when timeout is disabled (undefined)`
- [ ] Add test: `checkNow() respects current timeout value from settings`
- [ ] Ensure all new tests pass
- [ ] Run targeted tests: `pnpm test --filter @kb/engine -- stuck-task-detector`

**Artifacts:**
- `packages/engine/src/stuck-task-detector.test.ts` (modified)

### Step 3: Wire Up Settings Change Handler in Dashboard Command

- [ ] In `packages/cli/src/commands/dashboard.ts`, locate the `StuckTaskDetector` instantiation (around line 385)
- [ ] Add `settings:updated` event handler after the detector is created
- [ ] Handler should check if `taskStuckTimeoutMs` changed (comparing `previous` vs `settings`)
- [ ] If changed and detector is running, call `stuckTaskDetector.checkNow()`
- [ ] Log message: `[stuck-detector] Timeout changed to ${newTimeoutMs}ms — running immediate check`
- [ ] Follow the same pattern used for `globalPause` and `enginePaused` handlers in the scheduler

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update `AGENTS.md` if there's a section about stuck task detection (add note about immediate check on setting change)
- [ ] No changeset needed — this is an internal improvement, not user-facing feature change

## Documentation Requirements

**Must Update:**
- None — internal behavior improvement

**Check If Affected:**
- `AGENTS.md` — Add brief note in the `taskStuckTimeoutMs` setting description if it exists there

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] When `taskStuckTimeoutMs` is changed via dashboard settings, stuck tasks are checked immediately (not waiting for next 30s poll)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-249): complete Step N — description`
- **Bug fixes:** `fix(KB-249): description`
- **Tests:** `test(KB-249): description`

## Do NOT

- Change the polling interval or default timeout values
- Add new dependencies
- Modify the stuck detection logic (just expose it for immediate calling)
- Add UI changes — this is backend behavior only
- Create changeset for this internal improvement
