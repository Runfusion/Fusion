# Task: KB-606 - Improve Test Coverage for Critical Uncovered Areas

**Created:** 2026-03-31
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This task involves adding unit tests for existing code patterns. The tests follow established patterns in the codebase and don't affect production code behavior. Low blast radius, established testing patterns, no security implications.

**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Improve test coverage by adding comprehensive unit tests for critical uncovered areas across the kb packages. Focus on core business logic in `@fusion/core` (board transitions, dependency resolution), agent health monitoring in `@fusion/engine` (heartbeat monitor), and UI utilities in `@fusion/dashboard` (model filtering, toast hook).

This task targets files that have zero test coverage but contain critical functionality that should be protected by automated tests.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/board.ts` — Core logic for column transitions and dependency resolution
2. `packages/core/src/types.ts` — Column definitions, VALID_TRANSITIONS constant, Task types
3. `packages/engine/src/agent-heartbeat.ts` — HeartbeatMonitor class for agent health monitoring
4. `packages/dashboard/app/utils/modelFilter.ts` — Model filtering utility function
5. `packages/dashboard/app/hooks/useToast.ts` — React context hook for toast notifications
6. Existing test files for pattern reference:
   - `packages/core/src/store.test.ts` — TaskStore testing patterns
   - `packages/engine/src/stuck-task-detector.test.ts` — Similar polling/detector pattern
   - `packages/dashboard/app/hooks/useTheme.test.ts` — React hook testing pattern

## File Scope

- `packages/core/src/board.test.ts` (new)
- `packages/engine/src/agent-heartbeat.test.ts` (new)
- `packages/dashboard/app/utils/modelFilter.test.ts` (new)
- `packages/dashboard/app/hooks/useToast.test.tsx` (new)

## Steps

### Step 1: Core Board Logic Tests

Create comprehensive tests for `packages/core/src/board.ts`.

- [ ] Test `canTransition()` for all valid column transitions defined in VALID_TRANSITIONS
- [ ] Test `canTransition()` returns false for invalid transitions
- [ ] Test `getValidTransitions()` returns correct arrays for each column
- [ ] Test `resolveDependencyOrder()` with linear dependencies (A → B → C)
- [ ] Test `resolveDependencyOrder()` with diamond dependencies (A → B, A → C, B → D, C → D)
- [ ] Test `resolveDependencyOrder()` with disconnected components (independent tasks)
- [ ] Test `resolveDependencyOrder()` handles circular dependencies gracefully (should not infinite loop)
- [ ] Test `resolveDependencyOrder()` with empty task array
- [ ] Test `resolveDependencyOrder()` with single task (no dependencies)

**Artifacts:**
- `packages/core/src/board.test.ts` (new)

### Step 2: Agent Heartbeat Monitor Tests

Create comprehensive tests for `packages/engine/src/agent-heartbeat.ts`.

- [ ] Test `HeartbeatMonitor` constructor with default options
- [ ] Test `HeartbeatMonitor` constructor with custom pollIntervalMs and heartbeatTimeoutMs
- [ ] Test `start()` initiates polling interval
- [ ] Test `start()` is idempotent (multiple calls don't create multiple intervals)
- [ ] Test `stop()` clears the polling interval
- [ ] Test `isActive()` reflects monitor state
- [ ] Test `trackAgent()` adds agent to tracked set with correct initial state
- [ ] Test `recordHeartbeat()` updates lastSeen timestamp
- [ ] Test `recordHeartbeat()` triggers onRecovered callback after missed heartbeat
- [ ] Test `isAgentHealthy()` returns true for recent heartbeat
- [ ] Test `isAgentHealthy()` returns false for missed heartbeat
- [ ] Test `isAgentHealthy()` returns false for untracked agent
- [ ] Test `getTrackedAgents()` returns all tracked agent IDs
- [ ] Test `getLastSeen()` returns correct timestamp for tracked agent
- [ ] Test missed heartbeat detection triggers onMissed callback
- [ ] Test unresponsive agent termination triggers onTerminated callback and disposes session
- [ ] Test `untrackAgent()` removes agent from tracking
- [ ] Use mocked `AgentStore` with `recordHeartbeat` and `updateAgentState` methods
- [ ] Use fake timers for deterministic polling tests

**Artifacts:**
- `packages/engine/src/agent-heartbeat.test.ts` (new)

### Step 3: Dashboard Utility Tests

Create tests for `packages/dashboard/app/utils/modelFilter.ts`.

- [ ] Test `filterModels()` returns all models when filter is empty string
- [ ] Test `filterModels()` returns all models when filter is whitespace-only
- [ ] Test `filterModels()` filters by provider (case-insensitive)
- [ ] Test `filterModels()` filters by model ID (case-insensitive)
- [ ] Test `filterModels()` filters by model name (case-insensitive)
- [ ] Test `filterModels()` with multi-word filters (AND logic)
- [ ] Test `filterModels()` with partial matches (substring matching)
- [ ] Test `filterModels()` returns empty array when no matches

**Artifacts:**
- `packages/dashboard/app/utils/modelFilter.test.ts` (new)

### Step 4: Dashboard React Hook Tests

Create tests for `packages/dashboard/app/hooks/useToast.ts`.

- [ ] Test `ToastProvider` renders children correctly
- [ ] Test `useToast()` throws error when used outside provider
- [ ] Test `addToast()` adds a toast to the list with correct message and type
- [ ] Test `addToast()` auto-assigns unique incrementing IDs
- [ ] Test `addToast()` defaults type to "info" when not specified
- [ ] Test `addToast()` accepts "success", "error", "info" types
- [ ] Test toasts auto-remove after 4000ms (use fake timers)
- [ ] Test `removeToast()` manually removes a specific toast
- [ ] Test multiple toasts can exist simultaneously
- [ ] Test `useToast()` returns correct context value within provider

**Artifacts:**
- `packages/dashboard/app/hooks/useToast.test.tsx` (new)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite with `pnpm test`
- [ ] Verify all new tests pass
- [ ] Ensure no regressions in existing tests
- [ ] Run `pnpm typecheck` to verify TypeScript types
- [ ] Run `pnpm build` to verify build passes

**Note:** There is one known flaky test in `packages/core/src/store.test.ts` related to parallel task creation (produces valid config.json with unique sequential IDs). This is tracked separately in KB-338. If it fails intermittently, note it but don't block on it.

### Step 6: Documentation & Delivery

- [ ] Update `packages/core/README.md` if it exists — add note about board logic tests
- [ ] Check `AGENTS.md` for any testing guidelines to reference
- [ ] Ensure all test files have proper JSDoc header comments explaining test purpose

## Documentation Requirements

**Must Update:**
- None (tests are self-documenting)

**Check If Affected:**
- `AGENTS.md` — verify testing guidelines are followed
- Package-specific test docs if they exist

## Completion Criteria

- [ ] All steps complete
- [ ] `packages/core/src/board.test.ts` exists with comprehensive coverage of board.ts
- [ ] `packages/engine/src/agent-heartbeat.test.ts` exists with comprehensive coverage of agent-heartbeat.ts
- [ ] `packages/dashboard/app/utils/modelFilter.test.ts` exists with comprehensive coverage of modelFilter.ts
- [ ] `packages/dashboard/app/hooks/useToast.test.tsx` exists with comprehensive coverage of useToast.ts
- [ ] All tests passing (except known flaky test KB-338)
- [ ] TypeScript type checking passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `test(KB-606): complete Step N — add tests for {area}`
- **Bug fixes:** `fix(KB-606): correct test assertion or mock setup`

Example:
- `test(KB-606): complete Step 1 — add tests for core board logic`
- `test(KB-606): complete Step 2 — add tests for agent heartbeat monitor`

## Do NOT

- Expand task scope beyond the four specified files
- Modify production source code (only add tests)
- Skip tests due to perceived complexity — use mocks and fake timers as needed
- Modify the known flaky test in store.test.ts (KB-338 owns that)
- Add tests for already-covered code paths
- Skip the full test suite run at the end
