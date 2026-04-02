# Task: KB-301 - Improve test coverage

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This task affects multiple packages and requires understanding existing test patterns to fix failures and add new coverage. Changes are reversible but touch critical test infrastructure.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Achieve a passing test suite across all packages and establish comprehensive test coverage for critical uncovered modules. This involves fixing 24 currently failing tests in the dashboard package and adding new unit tests for engine and dashboard server modules that currently lack coverage.

## Dependencies

- **None**

## Context to Read First

### Existing Test Files (understand patterns)
- `packages/core/src/store.test.ts` — Reference for TaskStore testing patterns
- `packages/core/vitest.config.ts` — Vitest configuration pattern
- `packages/dashboard/app/hooks/__tests__/useTheme.test.ts` — Hook testing pattern with React Testing Library
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Component testing pattern
- `packages/engine/src/restart.integration.test.ts` — Engine testing pattern

### Failing Tests to Analyze
- `packages/dashboard/app/hooks/__tests__/useProjectFileEditor.test.ts` — Error handling mismatch
- `packages/dashboard/app/hooks/__tests__/useWorkspaces.test.ts` — Timeout issues
- `packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx` — Drag/drop jsdom issues
- `packages/dashboard/app/api.test.ts` — Error message format changes
- `packages/dashboard/src/ai-refine.test.ts` — Timeout waiting for AI

### Source Files Needing Tests
**Engine modules:**
- `packages/engine/src/scheduler.ts` — Core scheduling logic, pathsOverlap function
- `packages/engine/src/stuck-task-detector.ts` — Task stagnation detection
- `packages/engine/src/worktree-pool.ts` — Worktree recycling
- `packages/engine/src/cron-runner.ts` — Scheduled task execution
- `packages/engine/src/transient-error-detector.ts` — Error classification
- `packages/engine/src/usage-limit-detector.ts` — Usage tracking

**Dashboard server modules:**
- `packages/dashboard/src/badge-pubsub.ts` — WebSocket badge broadcasting
- `packages/dashboard/src/file-service.ts` — File browser backend
- `packages/dashboard/src/github-poll.ts` — GitHub status polling
- `packages/dashboard/src/github-webhooks.ts` — Webhook handling
- `packages/dashboard/src/rate-limit.ts` — API rate limiting
- `packages/dashboard/src/terminal-service.ts` — Terminal management
- `packages/dashboard/src/usage.ts` — Usage data aggregation

## File Scope

### Test files to fix:
- `packages/dashboard/app/hooks/__tests__/useProjectFileEditor.test.ts`
- `packages/dashboard/app/hooks/__tests__/useWorkspaces.test.ts`
- `packages/dashboard/app/components/__tests__/SubtaskBreakdownModal.test.tsx`
- `packages/dashboard/app/__tests__/api.test.ts`
- `packages/dashboard/src/__tests__/ai-refine.test.ts`
- `packages/dashboard/app/__tests__/mobile-planning-input-font-size.test.ts`
- `packages/dashboard/src/__tests__/routes.test.ts`
- `packages/dashboard/src/__tests__/server.test.ts`

### New test files to create:
- `packages/engine/src/scheduler.test.ts`
- `packages/engine/src/stuck-task-detector.test.ts`
- `packages/engine/src/worktree-pool.test.ts`
- `packages/engine/src/cron-runner.test.ts`
- `packages/engine/src/transient-error-detector.test.ts`
- `packages/engine/src/usage-limit-detector.test.ts`
- `packages/dashboard/src/badge-pubsub.test.ts`
- `packages/dashboard/src/file-service.test.ts`
- `packages/dashboard/src/github-poll.test.ts`
- `packages/dashboard/src/rate-limit.test.ts`
- `packages/dashboard/src/terminal-service.test.ts`

### Potential implementation fixes:
- `packages/dashboard/app/hooks/useProjectFileEditor.ts` — Error state handling
- `packages/dashboard/app/hooks/useWorkspaces.ts` — Polling cleanup
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — Drag event dataTransfer
- `packages/dashboard/app/api.ts` — Error message format (if tests are correct)

## Steps

### Step 1: Fix useProjectFileEditor Tests

- [ ] Analyze the mismatch between test expectations and implementation
- [ ] Tests expect error to persist after setContent, but implementation clears it
- [ ] Either update tests to match implementation, or fix implementation if behavior is wrong
- [ ] Run tests to verify: `cd packages/dashboard && pnpm test app/hooks/__tests__/useProjectFileEditor.test.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useProjectFileEditor.test.ts` (modified)

### Step 2: Fix useWorkspaces Tests

- [ ] Fix timeout issues in workspace polling tests
- [ ] Ensure proper cleanup of intervals in tests
- [ ] Consider using fake timers or reducing POLL_INTERVAL_MS in test environment
- [ ] Run tests to verify: `pnpm test app/hooks/__tests__/useWorkspaces.test.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/__tests__/useWorkspaces.test.ts` (modified)

### Step 3: Fix SubtaskBreakdownModal Tests

- [ ] Mock dataTransfer API for jsdom compatibility
- [ ] Add proper drag event mocking with setData/getData
- [ ] See AGENTS.md CSS classes reference for drag states: `.subtask-item-dragging`, `.subtask-item-drop-target`
- [ ] Run tests to verify: `pnpm test app/components/__tests__/SubtaskBreakdownModal.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/SubtaskBreakdownModal.test.tsx` (modified)

### Step 4: Fix API Error Handling Tests

- [ ] Review current error message format in `app/api.ts`
- [ ] Update test assertions to match actual error format that includes URL
- [ ] Run tests to verify: `pnpm test app/__tests__/api.test.ts`

**Artifacts:**
- `packages/dashboard/app/__tests__/api.test.ts` (modified)

### Step 5: Fix Remaining Broken Tests

- [ ] Fix ai-refine.test.ts timeout (mock AI engine unavailable error faster)
- [ ] Fix mobile CSS test assertions
- [ ] Fix routes.test.ts batch import timing
- [ ] Fix server.test.ts error handler expectation
- [ ] Run full dashboard test suite and ensure all pass

**Artifacts:**
- `packages/dashboard/src/__tests__/ai-refine.test.ts` (modified)
- `packages/dashboard/app/__tests__/mobile-planning-input-font-size.test.ts` (modified)
- `packages/dashboard/src/__tests__/routes.test.ts` (modified)
- `packages/dashboard/src/__tests__/server.test.ts` (modified)

### Step 6: Add Scheduler Tests

- [ ] Test `pathsOverlap()` function with various scenarios:
  - Exact file path matches
  - Directory prefix overlaps (with /* globs)
  - Nested directory overlaps
  - No overlap cases
- [ ] Test Scheduler class dependency resolution
- [ ] Test concurrency limits and worktree limits
- [ ] Test file scope grouping with overlapping detection
- [ ] Test base branch resolution from in-review dependencies
- [ ] Create `packages/engine/src/scheduler.test.ts`

**Artifacts:**
- `packages/engine/src/scheduler.test.ts` (new)

### Step 7: Add Stuck Task Detector Tests

- [ ] Test trackTask/untrackTask functionality
- [ ] Test recordActivity updates last activity timestamp
- [ ] Test isStuck detection with configurable timeout
- [ ] Test killAndRetry disposes session, logs event, moves task to todo
- [ ] Test poll loop with fake timers
- [ ] Create `packages/engine/src/stuck-task-detector.test.ts`

**Artifacts:**
- `packages/engine/src/stuck-task-detector.test.ts` (new)

### Step 8: Add Remaining Engine Tests

- [ ] Test worktree-pool.ts worktree recycling logic
- [ ] Test cron-runner.ts scheduled execution
- [ ] Test transient-error-detector.ts error classification
- [ ] Test usage-limit-detector.ts usage tracking
- [ ] Create corresponding test files

**Artifacts:**
- `packages/engine/src/worktree-pool.test.ts` (new)
- `packages/engine/src/cron-runner.test.ts` (new)
- `packages/engine/src/transient-error-detector.test.ts` (new)
- `packages/engine/src/usage-limit-detector.test.ts` (new)

### Step 9: Add Dashboard Server Tests

- [ ] Test badge-pubsub.ts WebSocket broadcasting
- [ ] Test file-service.ts file operations
- [ ] Test github-poll.ts polling logic
- [ ] Test rate-limit.ts limiting behavior
- [ ] Test terminal-service.ts session management
- [ ] Mock external dependencies appropriately
- [ ] Create corresponding test files in `packages/dashboard/src/`

**Artifacts:**
- `packages/dashboard/src/badge-pubsub.test.ts` (new)
- `packages/dashboard/src/file-service.test.ts` (new)
- `packages/dashboard/src/github-poll.test.ts` (new)
- `packages/dashboard/src/rate-limit.test.ts` (new)
- `packages/dashboard/src/terminal-service.test.ts` (new)

### Step 10: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all packages pass: core, engine, cli, dashboard
- [ ] Check coverage report: `pnpm test:coverage`
- [ ] Fix any remaining failures

### Step 11: Documentation & Delivery

- [ ] Update any README files if testing patterns changed
- [ ] Verify no implementation files were modified without tests
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None expected for this test-only task

**Check If Affected:**
- `packages/dashboard/README.md` — Add testing section if missing
- `packages/engine/README.md` — Add testing section if missing

## Completion Criteria

- [ ] All existing broken tests fixed (24 failures resolved)
- [ ] Full test suite passes: `pnpm test` exits with code 0
- [ ] New test files created for uncovered modules
- [ ] No test failures in any package
- [ ] Coverage report generates successfully

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-301): complete Step N — description`
- **Test fixes:** `test(KB-301): fix failing test — description`
- **New tests:** `test(KB-301): add tests for module — description`
- **Bug fixes:** `fix(KB-301): description` (if implementation fixes needed)

## Do NOT

- Skip or disable failing tests without fixing them
- Modify implementation behavior without verifying it's actually wrong
- Add tests with no assertions or trivial always-pass tests
- Modify files outside the File Scope without good reason
- Reduce test coverage thresholds to make suite pass
- Commit without the task ID prefix
