# Task: KB-206 - Stuck Task Detection and Recovery

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This involves a new subsystem (stuck task detection) that integrates with the executor and scheduler, monitoring agent sessions and implementing recovery logic. The pattern is novel (heartbeat-based timeout) but the integration points are well-defined.
**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Implement a stuck task detection and recovery system that monitors in-progress tasks for agent session stagnation. When a task spends too long without agent activity (no text deltas, tool calls, or progress updates), the system should detect this, terminate the stuck agent session, and automatically retry execution from the current step.

This prevents tasks from hanging indefinitely on unresponsive AI API calls, infinite loops, or stuck tool executions.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/types.ts` — Settings and Task type definitions
- `packages/engine/src/executor.ts` — Task execution flow, agent session lifecycle, and activeSessions tracking
- `packages/engine/src/scheduler.ts` — Task scheduling and status management
- `packages/engine/src/pi.ts` — Agent session creation and event subscription
- `packages/engine/src/concurrency.ts` — AgentSemaphore for concurrency control
- `packages/engine/src/notifier.ts` — Reference pattern for store event listeners

## File Scope

- `packages/core/src/types.ts` — Add `taskStuckTimeoutMs` to Settings type and DEFAULT_SETTINGS
- `packages/engine/src/stuck-task-detector.ts` — New stuck task detector implementation (new file)
- `packages/engine/src/stuck-task-detector.test.ts` — Tests for stuck task detector (new file)
- `packages/engine/src/executor.ts` — Integrate heartbeat tracking into agent session
- `packages/engine/src/index.ts` — Export StuckTaskDetector
- `packages/cli/src/commands/dashboard.ts` — Initialize and start the stuck task detector

## Steps

### Step 1: Add Timeout Setting to Core Types

- [ ] Add `taskStuckTimeoutMs?: number` to Settings interface in `packages/core/src/types.ts`
- [ ] Add `taskStuckTimeoutMs: undefined` to DEFAULT_SETTINGS
- [ ] Document the setting: "Timeout in milliseconds for detecting stuck tasks. When a task's agent session shows no activity (no text deltas, tool calls, or progress updates) for longer than this duration, the task is considered stuck and will be terminated and retried. Default: undefined (disabled). Suggested value: 600000 (10 minutes)."
- [ ] Run typecheck to verify changes compile

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Create StuckTaskDetector Class

- [ ] Create `packages/engine/src/stuck-task-detector.ts` with the StuckTaskDetector class
- [ ] Implement constructor that accepts TaskStore and options (pollIntervalMs, default 30s)
- [ ] Implement `start()` method that begins polling via setInterval
- [ ] Implement `stop()` method that clears the interval
- [ ] Implement `trackTask(taskId: string, session: AgentSession)` to register active sessions for monitoring
- [ ] Implement `untrackTask(taskId: string)` to remove tasks from monitoring
- [ ] Implement `recordActivity(taskId: string)` to update last activity timestamp
- [ ] Implement `getLastActivity(taskId: string): number` returning timestamp or undefined
- [ ] Implement `isStuck(taskId: string, timeoutMs: number): boolean` checking if elapsed > timeout
- [ ] Implement `killAndRetry(taskId: string)` that: disposes the agent session, logs the event, resets task status to allow retry, and emits event for executor to restart
- [ ] Add private `checkStuckTasks()` polling method that iterates tracked tasks, reads timeout from settings, and triggers killAndRetry for stuck tasks

**Artifacts:**
- `packages/engine/src/stuck-task-detector.ts` (new)

### Step 3: Write Tests for StuckTaskDetector

- [ ] Create `packages/engine/src/stuck-task-detector.test.ts`
- [ ] Test that tracking a task records initial activity timestamp
- [ ] Test that recordActivity updates the timestamp
- [ ] Test that isStuck returns true when elapsed > timeout
- [ ] Test that isStuck returns false when elapsed < timeout
- [ ] Test that killAndRetry calls session.dispose() and emits stuck:retry event
- [ ] Test that untrackTask removes the task from monitoring
- [ ] Test that checkStuckTasks only kills tasks exceeding timeout (mock time progression)
- [ ] Test that detector respects settings changes (different timeout values)
- [ ] Test that stop() halts polling and prevents further stuck checks

**Artifacts:**
- `packages/engine/src/stuck-task-detector.test.ts` (new)

### Step 4: Integrate Heartbeat Tracking into Executor

- [ ] Modify `TaskExecutor` class to accept optional `stuckTaskDetector` in TaskExecutorOptions
- [ ] In `execute()` method, after creating agent session, call `stuckTaskDetector?.trackTask(task.id, sessionRef.current)`
- [ ] Add `stuckTaskDetector?.recordActivity(task.id)` calls at appropriate points:
  - On every text delta (in agentLogger.onText handler)
  - On every tool start (in agentLogger.onToolStart handler)
  - On every step status update (in task_update tool execution)
- [ ] In the `finally` block of agentWork, call `stuckTaskDetector?.untrackTask(task.id)`
- [ ] Ensure activity is recorded when session starts (initial prompt)
- [ ] Handle case where task is paused (stuck detector should untrack)

**Artifacts:**
- `packages/engine/src/executor.ts` (modified)

### Step 5: Handle Stuck Task Recovery Flow

- [ ] In StuckTaskDetector, when killing a stuck task, set task status to "stuck-killed" (transient status)
- [ ] Log entry: "Task terminated due to stuck agent session (no activity for X minutes)"
- [ ] After killing session, move task back to "todo" column (preserving current step progress)
- [ ] Clear the "stuck-killed" status on move
- [ ] Ensure scheduler will pick up the task again for retry
- [ ] Test that retry preserves current step (doesn't reset to step 0)

**Artifacts:**
- `packages/engine/src/stuck-task-detector.ts` (modified)
- `packages/engine/src/executor.ts` (modified)

### Step 6: Export and Initialize in Dashboard Command

- [ ] Add export for StuckTaskDetector to `packages/engine/src/index.ts`
- [ ] Import StuckTaskDetector in `packages/cli/src/commands/dashboard.ts`
- [ ] Instantiate StuckTaskDetector after creating TaskStore
- [ ] Pass stuckTaskDetector to TaskExecutor options
- [ ] Call `stuckTaskDetector.start()` after scheduler starts
- [ ] Call `stuckTaskDetector.stop()` in shutdown handler (before other stops)
- [ ] Wire up logging integration (stuck events should log to task log)

**Artifacts:**
- `packages/engine/src/index.ts` (modified)
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm typecheck` — no type errors
- [ ] Run `pnpm build` — build succeeds
- [ ] Manual verification: Set a very short timeout (10s) in settings, start a task, mock no activity, verify it gets killed and retried

### Step 8: Documentation & Delivery

- [ ] Add documentation to AGENTS.md about the stuck task detection feature and `taskStuckTimeoutMs` setting
- [ ] Create changeset file for the new feature (minor bump)
- [ ] Verify no out-of-scope findings requiring new tasks

**Artifacts:**
- `.changeset/stuck-task-detection.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add section under Settings documenting `taskStuckTimeoutMs`: what it does, recommended values (10 minutes = 600000), and behavior when enabled

**Check If Affected:**
- `packages/dashboard` settings UI — may need UI field for `taskStuckTimeoutMs` (create follow-up task if needed, out of scope for this implementation)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (including new stuck-task-detector.test.ts)
- [ ] Documentation updated
- [ ] Changeset created
- [ ] Typecheck passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-206): complete Step N — description`
- **Bug fixes:** `fix(KB-206): description`
- **Tests:** `test(KB-206): description`

## Do NOT

- Modify the pi-coding-agent library internals (only use public API via pi.ts)
- Implement UI changes for the dashboard (CLI-only setting for now)
- Add per-task timeout overrides (global setting only)
- Change existing task execution flow beyond adding heartbeat tracking
- Skip tests for the new stuck task detector
- Implement infinite retry loops (let scheduler handle retries naturally)
