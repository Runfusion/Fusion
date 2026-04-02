# Task: KB-294 - Refinement: Implement agent heartbeat system for runtime state tracking

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a refinement task to verify KB-283's agent heartbeat implementation. Focuses on adding comprehensive test coverage for AgentStore and HeartbeatMonitor classes. Moderate complexity due to filesystem mocking and timer-based testing patterns.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Ensure the agent heartbeat system (implemented in KB-283) works correctly by adding comprehensive test coverage. The AgentStore and HeartbeatMonitor classes were implemented but lack tests. This task creates:

1. **AgentStore tests** — CRUD operations, state transitions, heartbeat recording, file persistence
2. **HeartbeatMonitor tests** — Tracking, missed heartbeat detection, recovery, auto-termination
3. **Integration verification** — Both packages build and all tests pass

The implementation follows existing patterns: AgentStore mirrors TaskStore patterns, HeartbeatMonitor mirrors StuckTaskDetector patterns.

## Dependencies

- **Task:** KB-283 — Agent heartbeat system implementation (must be complete)

## Context to Read First

**Test Pattern References:**
- `packages/core/src/store.test.ts` — TaskStore testing patterns (filesystem, mocks, cleanup)
- `packages/engine/src/stuck-task-detector.test.ts` — Timer-based monitoring testing patterns

**Implementation Files (already exist):**
- `packages/core/src/agent-store.ts` — AgentStore implementation
- `packages/engine/src/agent-heartbeat.ts` — HeartbeatMonitor implementation  
- `packages/core/src/types.ts` — Agent types (Agent, AgentState, AgentHeartbeatEvent, etc.)

## File Scope

**New Test Files:**
- `packages/core/src/agent-store.test.ts` — AgentStore unit tests
- `packages/engine/src/agent-heartbeat.test.ts` — HeartbeatMonitor unit tests

**No modifications to source files** — this task is test-only unless bugs are discovered

## Steps

### Step 1: AgentStore Tests

- [ ] Create `packages/core/src/agent-store.test.ts` with comprehensive test coverage
- [ ] Test `createAgent()` — creates agent with idle state, validates required fields, generates ID
- [ ] Test `getAgent()` — returns agent by ID, returns null for non-existent
- [ ] Test `getAgentDetail()` — includes heartbeat history and runs
- [ ] Test `updateAgent()` — partial updates, preserves other fields
- [ ] Test `updateAgentState()` — valid transitions (idle→active→paused→terminated), invalid transitions throw
- [ ] Test `assignTask()` — assigns/unassigns task ID
- [ ] Test `listAgents()` — returns all agents, filter by state, filter by role, sort by createdAt desc
- [ ] Test `deleteAgent()` — removes agent and heartbeat file, throws if not found
- [ ] Test `recordHeartbeat()` — appends to JSONL, updates lastHeartbeatAt on "ok"
- [ ] Test `getHeartbeatHistory()` — returns newest-first, respects limit
- [ ] Test `startHeartbeatRun()` — creates run, returns runId
- [ ] Test `endHeartbeatRun()` — updates run status
- [ ] Test `getActiveHeartbeatRun()` — finds active run, returns null if none
- [ ] Test `getCompletedHeartbeatRuns()` — returns terminated/completed runs
- [ ] Test EventEmitter events: `agent:created`, `agent:updated`, `agent:deleted`, `agent:heartbeat`, `agent:stateChanged`
- [ ] Use temp directory pattern from store.test.ts for filesystem isolation
- [ ] Run targeted tests: `pnpm test -- --run agent-store.test.ts`

**Artifacts:**
- `packages/core/src/agent-store.test.ts` (new)

### Step 2: HeartbeatMonitor Tests

- [ ] Create `packages/engine/src/agent-heartbeat.test.ts` with comprehensive test coverage
- [ ] Test `start()` / `stop()` — starts/stops polling interval, safe to call multiple times
- [ ] Test `isActive()` — returns correct running state
- [ ] Test `trackAgent()` — registers agent, records initial heartbeat, stores session
- [ ] Test `untrackAgent()` — removes from monitoring, does not affect runs
- [ ] Test `recordHeartbeat()` — updates lastSeen, records "ok" event
- [ ] Test `recordHeartbeat()` recovery — records "recovered" after miss, calls onRecovered
- [ ] Test `isAgentHealthy()` — true within timeout, false after timeout, false if not tracked
- [ ] Test `getTrackedAgents()` — returns all tracked IDs
- [ ] Test `getLastSeen()` — returns timestamp or undefined
- [ ] Test missed heartbeat detection — calls onMissed, records "missed" event
- [ ] Test auto-termination — disposes session, updates state to terminated, calls onTerminated
- [ ] Test 2x timeout grace period — terminates only after double timeout (gives recovery window)
- [ ] Use fake timers (vi.useFakeTimers()) like stuck-task-detector.test.ts
- [ ] Run targeted tests: `pnpm test -- --run agent-heartbeat.test.ts`

**Artifacts:**
- `packages/engine/src/agent-heartbeat.test.ts` (new)

### Step 3: Full Test Suite Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` from root — all tests must pass
- [ ] Run `pnpm build` from root — all packages must compile
- [ ] Verify no TypeScript errors in new test files
- [ ] Ensure no test leaks (timers, intervals properly cleaned up)

### Step 4: Documentation & Delivery

- [ ] Verify JSDoc comments exist on all public methods (from KB-283)
- [ ] **No changeset required** — this is test-only work on internal infrastructure
- [ ] If bugs found during testing, fix them and document in commit messages

## Implementation Details

### Test Patterns to Follow

**AgentStore tests** (follow TaskStore patterns):
```typescript
// Use temp directory with cleanup
const tmpDir = await mkdtemp(join(tmpdir(), "agent-store-test-"));
const store = new AgentStore({ rootDir: tmpDir });
await store.init();
// ... tests ...
await rm(tmpDir, { recursive: true });
```

**HeartbeatMonitor tests** (follow StuckTaskDetector patterns):
```typescript
// Use fake timers
vi.useFakeTimers();
const store = createMockAgentStore();
const monitor = new HeartbeatMonitor({ store, pollIntervalMs: 1000, heartbeatTimeoutMs: 2000 });
monitor.start();

// Advance time to trigger behavior
vi.advanceTimersByTime(2000);

// Cleanup
vi.useRealTimers();
monitor.stop();
```

### Mock AgentStore for HeartbeatMonitor Tests

Create a mock AgentStore similar to createMockStore in stuck-task-detector.test.ts:
- Mock `recordHeartbeat`, `updateAgentState`, `startHeartbeatRun`, `endHeartbeatRun`
- Track calls to verify correct behavior
- Keep minimal mock data for assertions

### Key Test Scenarios

**State Transitions (AgentStore):**
- idle → active ✓
- active → paused ✓
- active → terminated ✓
- paused → active ✓
- paused → terminated ✓
- terminated → *any* throws Error

**HeartbeatMonitor Timeout Behavior:**
- 0-59s: healthy (ok)
- 60-119s: missed (onMissed called, "missed" recorded)
- 120s+: terminated (onTerminated called, session.dispose() called, state→terminated)
- Recovery: heartbeat resumes → "recovered" recorded, onRecovered called

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] AgentStore tests cover: CRUD, state transitions, heartbeats, events
- [ ] HeartbeatMonitor tests cover: tracking, health detection, missed heartbeats, auto-termination
- [ ] No test leaks (all timers/intervals cleaned up)
- [ ] Minimum 80% code coverage for both AgentStore and HeartbeatMonitor

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-294): complete Step N — description`
- **Bug fixes:** `fix(KB-294): description`
- **Tests:** `test(KB-294): description`

Example:
```
test(KB-294): complete Step 1 — add comprehensive AgentStore tests
test(KB-294): complete Step 2 — add comprehensive HeartbeatMonitor tests
```

## Do NOT

- Modify AgentStore or HeartbeatMonitor source code unless bugs are found during testing
- Skip tests — comprehensive coverage is the primary goal of this task
- Use real timers in HeartbeatMonitor tests (always use fake timers)
- Use the real filesystem for AgentStore tests without cleanup
- Create a changeset — this is test-only work
- Expand scope to test unrelated components
