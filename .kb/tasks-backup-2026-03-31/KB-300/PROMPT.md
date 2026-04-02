# Task: KB-300 - Implement and verify agent heartbeat system APIs

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Implementation verification task for agent heartbeat infrastructure. AgentStore and HeartbeatMonitor source files exist but lack comprehensive test coverage. Requires verifying all specified APIs are correctly implemented and fully tested.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Verify and complete the agent heartbeat system implementation that was started in KB-283. The AgentStore class and HeartbeatMonitor class exist but require:

1. **API verification** — Ensure all specified APIs are correctly implemented and functional
2. **HeartbeatMonitor completion** — Verify the monitor follows StuckTaskDetector patterns correctly
3. **Comprehensive test coverage** — Add tests for both AgentStore and HeartbeatMonitor following established patterns
4. **Integration verification** — Ensure all packages build and tests pass

This task completes the foundational agent infrastructure that enables runtime agent lifecycle management and health monitoring.

## Dependencies

- **Task:** KB-283 — Agent heartbeat system implementation (source files exist, needs verification)

## Context to Read First

**Implementation Files (verify these exist and are complete):**
- `packages/core/src/agent-store.ts` — AgentStore with CRUD, heartbeats, state management
- `packages/engine/src/agent-heartbeat.ts` — HeartbeatMonitor for runtime monitoring
- `packages/core/src/types.ts` — Agent types (Agent, AgentState, AgentHeartbeatEvent, etc.)
- `packages/core/src/index.ts` — Export verification for AgentStore and types

**Pattern References (follow for testing):**
- `packages/core/src/store.test.ts` — TaskStore testing patterns (filesystem, mocks, cleanup)
- `packages/engine/src/stuck-task-detector.test.ts` — Timer-based monitoring testing patterns

## File Scope

**Existing Implementation (verify completeness):**
- `packages/core/src/agent-store.ts` — Must have: recordHeartbeat, getHeartbeatHistory, startHeartbeatRun, endHeartbeatRun, getActiveHeartbeatRun, getCompletedHeartbeatRuns, updateAgentState, assignTask, getAgentDetail
- `packages/engine/src/agent-heartbeat.ts` — Must follow StuckTaskDetector patterns

**New Test Files:**
- `packages/core/src/agent-store.test.ts` — Comprehensive AgentStore tests
- `packages/engine/src/agent-heartbeat.test.ts` — Comprehensive HeartbeatMonitor tests

## Steps

### Step 1: Verify AgentStore Implementation

First, verify all required APIs exist and are correctly implemented in the existing agent-store.ts:

- [ ] Verify `recordHeartbeat(agentId, status, runId?)` — appends to JSONL, updates lastHeartbeatAt on "ok"
- [ ] Verify `getHeartbeatHistory(agentId, limit?)` — returns newest-first, respects limit
- [ ] Verify `startHeartbeatRun(agentId)` — creates run, returns runId
- [ ] Verify `endHeartbeatRun(runId, status)` — updates run status
- [ ] Verify `getActiveHeartbeatRun(agentId)` — finds active run (endedAt is null)
- [ ] Verify `getCompletedHeartbeatRuns(agentId)` — returns terminated/completed runs
- [ ] Verify `updateAgentState(agentId, state)` — validates transitions, throws on invalid
- [ ] Verify `assignTask(agentId, taskId?)` — assigns/unassigns task ID
- [ ] Verify `getAgentDetail(agentId, heartbeatLimit?)` — returns agent + heartbeat history + runs
- [ ] Verify EventEmitter events: `agent:created`, `agent:updated`, `agent:deleted`, `agent:heartbeat`, `agent:stateChanged`
- [ ] Verify file locking/serialization pattern (withLock method)
- [ ] Fix any incomplete implementations
- [ ] Run typecheck: `pnpm typecheck`

**Artifacts:**
- `packages/core/src/agent-store.ts` (verified/updated)

### Step 2: Verify HeartbeatMonitor Implementation

Verify the existing HeartbeatMonitor follows StuckTaskDetector patterns:

- [ ] Verify `start()` / `stop()` — starts/stops polling interval, safe to call multiple times
- [ ] Verify `isActive()` — returns correct running state
- [ ] Verify `trackAgent(agentId, session, runId)` — registers agent, records initial heartbeat
- [ ] Verify `untrackAgent(agentId)` — removes from monitoring
- [ ] Verify `recordHeartbeat(agentId)` — updates lastSeen, records "ok" or "recovered"
- [ ] Verify `isAgentHealthy(agentId)` — true within timeout, false after timeout
- [ ] Verify `getTrackedAgents()` — returns all tracked IDs
- [ ] Verify `getLastSeen(agentId)` — returns timestamp or undefined
- [ ] Verify missed heartbeat detection — calls onMissed, records "missed" event
- [ ] Verify auto-termination — disposes session, updates state, calls onTerminated
- [ ] Verify 2x timeout grace period before termination
- [ ] Verify callback pattern (not EventEmitter) matches StuckTaskDetector
- [ ] Fix any incomplete implementations
- [ ] Run typecheck: `pnpm typecheck`

**Artifacts:**
- `packages/engine/src/agent-heartbeat.ts` (verified/updated)

### Step 3: Create AgentStore Tests

Create comprehensive tests following TaskStore patterns:

- [ ] Create `packages/core/src/agent-store.test.ts`
- [ ] Test `createAgent()` — creates with idle state, validates required fields, generates ID
- [ ] Test `getAgent()` — returns agent or null
- [ ] Test `getAgentDetail()` — includes heartbeat history and runs
- [ ] Test `updateAgent()` — partial updates, preserves other fields
- [ ] Test `updateAgentState()` — valid transitions (idle→active→paused→terminated), invalid throws
- [ ] Test `assignTask()` — assigns/unassigns task ID
- [ ] Test `listAgents()` — returns all, filter by state, filter by role, sort by createdAt desc
- [ ] Test `deleteAgent()` — removes agent and heartbeat file, throws if not found
- [ ] Test `recordHeartbeat()` — appends to JSONL, updates lastHeartbeatAt on "ok"
- [ ] Test `getHeartbeatHistory()` — returns newest-first, respects limit
- [ ] Test `startHeartbeatRun()` — creates run, returns runId
- [ ] Test `endHeartbeatRun()` — updates run status
- [ ] Test `getActiveHeartbeatRun()` — finds active run, returns null if none
- [ ] Test `getCompletedHeartbeatRuns()` — returns terminated/completed runs
- [ ] Test EventEmitter events are fired correctly
- [ ] Use temp directory pattern from store.test.ts for filesystem isolation
- [ ] Run targeted tests: `pnpm test -- --run agent-store.test.ts`

**Artifacts:**
- `packages/core/src/agent-store.test.ts` (new)

### Step 4: Create HeartbeatMonitor Tests

Create comprehensive tests following StuckTaskDetector patterns:

- [ ] Create `packages/engine/src/agent-heartbeat.test.ts`
- [ ] Test `start()` / `stop()` — starts/stops polling, safe multiple calls
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
- [ ] Test 2x timeout grace period — terminates only after double timeout
- [ ] Use fake timers (vi.useFakeTimers()) like stuck-task-detector.test.ts
- [ ] Create mock AgentStore for testing
- [ ] Run targeted tests: `pnpm test -- --run agent-heartbeat.test.ts`

**Artifacts:**
- `packages/engine/src/agent-heartbeat.test.ts` (new)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` from root — all tests must pass
- [ ] Run `pnpm build` from root — all packages must compile
- [ ] Verify no TypeScript errors in new or modified files
- [ ] Ensure no test leaks (timers, intervals properly cleaned up)
- [ ] Verify minimum 80% code coverage for both AgentStore and HeartbeatMonitor

### Step 6: Documentation & Delivery

- [ ] Verify JSDoc comments exist on all public AgentStore methods
- [ ] Verify JSDoc comments exist on all public HeartbeatMonitor methods
- [ ] Verify state transition rules are documented in code comments
- [ ] Verify exports in `packages/core/src/index.ts` include AgentStore and all agent types
- [ ] **No changeset required** — this is internal infrastructure work on private packages

## Implementation Details

### Test Patterns to Follow

**AgentStore tests** (follow TaskStore patterns from store.test.ts):
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

Create a mock similar to createMockStore in stuck-task-detector.test.ts:
- Mock `recordHeartbeat`, `updateAgentState`, `startHeartbeatRun`, `endHeartbeatRun`
- Track calls to verify correct behavior
- Keep minimal mock data for assertions

### State Transitions (AgentStore)

Valid transitions (invalid ones throw Error):
- `idle` → `active` ✓
- `active` → `paused` ✓
- `active` → `terminated` ✓
- `paused` → `active` ✓
- `paused` → `terminated` ✓
- `terminated` → *any* throws Error (terminal state)

### HeartbeatMonitor Timeout Behavior

- 0 to timeout-1: healthy (ok)
- timeout to (timeout*2)-1: missed (onMissed called, "missed" recorded)
- timeout*2+: terminated (onTerminated called, session.dispose() called, state→terminated)
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

- **Step completion:** `feat(KB-300): complete Step N — description`
- **Bug fixes:** `fix(KB-300): description`
- **Tests:** `test(KB-300): description`

Example:
```
feat(KB-300): complete Step 1 — verify AgentStore API implementations
feat(KB-300): complete Step 2 — verify HeartbeatMonitor implementation
feat(KB-300): complete Step 3 — add comprehensive AgentStore tests
test(KB-300): complete Step 4 — add comprehensive HeartbeatMonitor tests
```

## Do NOT

- Skip tests — comprehensive coverage is required
- Use real timers in HeartbeatMonitor tests (always use fake timers)
- Use the real filesystem for AgentStore tests without cleanup
- Create a changeset — this is test-only/internal work on private packages
- Expand scope to implement full agent execution (that's KB-284)
- Add UI components (that's KB-285)
- Implement messaging/inbox (that's KB-286)
