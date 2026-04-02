# Task: KB-286 - Refinement: Implement agent heartbeat system for runtime state tracking

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Foundational infrastructure implementing AgentStore data model and heartbeat monitoring. Follows established StuckTaskDetector pattern with moderate blast radius affecting core types and engine monitoring. Full review warranted for data model design and integration points.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Implement the missing AgentStore data model and runtime heartbeat monitoring system that KB-283 specified but never actually checked in. This foundational infrastructure provides:

1. **Agent lifecycle management** — Track agents through idle → active → paused → terminated states with persistent storage
2. **Heartbeat monitoring** — Detect unresponsive agents via periodic pings and auto-terminate missed heartbeats
3. **Runtime state tracking** — Last-seen timestamps, heartbeat event history, and agent health metrics

The implementation follows the established `StuckTaskDetector` pattern (`packages/engine/src/stuck-task-detector.ts`) for consistency with existing monitoring systems. This enables the broader agent system architecture (KB-284, KB-285, KB-287) to build upon reliable agent state management.

## Dependencies

- **Task:** KB-283 (AgentStore data model spec) — The specification exists but implementation was never checked in; this task implements the missing pieces

## Context to Read First

**Pattern Reference (follow this structure exactly):**
- `packages/engine/src/stuck-task-detector.ts` — Established monitoring pattern with polling, tracking Map, and disposal
- `packages/engine/src/stuck-task-detector.test.ts` — Test patterns for monitoring classes

**Storage Pattern Reference:**
- `packages/core/src/store.ts` — TaskStore pattern for filesystem-based persistence (see init(), taskLocks, serialization patterns)

**Integration Points:**
- `packages/core/src/types.ts` — Type definitions location (add Agent types here following existing patterns)
- `packages/core/src/index.ts` — Export location for AgentStore

## File Scope

**New Files:**
- `packages/core/src/agent-store.ts` — AgentStore class with CRUD operations and persistence
- `packages/core/src/agent-store.test.ts` — Unit tests for AgentStore
- `packages/engine/src/agent-heartbeat.ts` — HeartbeatMonitor class for runtime monitoring
- `packages/engine/src/agent-heartbeat.test.ts` — Unit tests for HeartbeatMonitor

**Modified Files:**
- `packages/core/src/types.ts` — Add Agent, AgentState, AgentHeartbeatEvent, AgentHeartbeatRun, AgentCreateInput types
- `packages/core/src/index.ts` — Export AgentStore and agent types

## Steps

### Step 0: Preflight

- [ ] Verify no agent types exist in types.ts (confirm KB-283 implementation is missing)
- [ ] Verify no agent-store.ts exists in packages/core/src/
- [ ] Verify no agent-heartbeat.ts exists in packages/engine/src/
- [ ] Dependencies satisfied (KB-283 spec exists)

### Step 1: Agent Type Definitions

- [ ] Add agent-related types to `packages/core/src/types.ts` (append to existing file for cohesion)
- [ ] Define `AgentState` union: `"idle" | "active" | "paused" | "terminated"`
- [ ] Define `Agent` interface with id, name, role, state, taskId (optional), createdAt, updatedAt, lastHeartbeatAt, metadata
- [ ] Define `AgentHeartbeatEvent` interface with agentId, timestamp, status ("ok" | "missed" | "recovered"), runId
- [ ] Define `AgentHeartbeatRun` interface tracking a continuous heartbeat session (id, agentId, startedAt, endedAt, status)
- [ ] Define `AgentCreateInput` interface for creating agents
- [ ] Run targeted tests for types compilation (`pnpm typecheck`)

**Artifacts:**
- `packages/core/src/types.ts` (modified — new agent types added)

### Step 2: AgentStore Implementation

- [ ] Create `packages/core/src/agent-store.ts` with AgentStore class
- [ ] Implement constructor with rootDir and agentsDir path setup (follow TaskStore pattern)
- [ ] Implement `init()` — create agents directory if not exists
- [ ] Implement `createAgent(input)` — create new agent with "idle" state, write to `{agentId}.json`
- [ ] Implement `getAgent(agentId)` — read agent from disk, return null if not found
- [ ] Implement `updateAgent(agentId, updates)` — partial update with updatedAt timestamp
- [ ] Implement `updateAgentState(agentId, state)` — state transition with validation (throw Error on invalid transitions)
- [ ] Implement `listAgents(filter?)` — list all agents, optionally filter by state
- [ ] Implement `deleteAgent(agentId)` — remove agent file
- [ ] Implement `recordHeartbeat(agentId, status, runId?)` — append to `{agentId}-heartbeats.jsonl`
- [ ] Implement `getHeartbeatHistory(agentId, limit?)` — read last N heartbeats from JSONL efficiently
- [ ] Implement `startHeartbeatRun(agentId)` — create new run record, return runId (UUID or incrementing)
- [ ] Implement `endHeartbeatRun(runId, status)` — close run with status, update endedAt
- [ ] Implement `getActiveHeartbeatRun(agentId)` — get current active run (where endedAt is null)
- [ ] Implement file locking/serialization pattern following TaskStore's taskLocks approach
- [ ] Run targeted tests for AgentStore (`pnpm test packages/core/src/agent-store.test.ts`)

**Artifacts:**
- `packages/core/src/agent-store.ts` (new)
- `packages/core/src/agent-store.test.ts` (new)

### Step 3: HeartbeatMonitor Implementation

- [ ] Create `packages/engine/src/agent-heartbeat.ts` with HeartbeatMonitor class
- [ ] Implement constructor with options: `store` (AgentStore), `pollIntervalMs` (default 30000), `heartbeatTimeoutMs` (default 60000), callbacks: `onMissed?`, `onRecovered?`, `onTerminated?`
- [ ] Use **callback pattern** (like StuckTaskDetector) NOT EventEmitter — simpler for this use case
- [ ] Implement `start()` — begin polling interval (safe to call multiple times, no-op if already running)
- [ ] Implement `stop()` — stop polling interval, does not untrack agents
- [ ] Implement `trackAgent(agentId, session, runId)` — register agent for monitoring (session has `dispose(): void` method), records initial heartbeat
- [ ] Implement `untrackAgent(agentId)` — remove from monitoring, does NOT end heartbeat run (caller's responsibility)
- [ ] Implement `recordHeartbeat(agentId)` — update AgentStore with "ok" status, update in-memory lastSeen timestamp
- [ ] Implement `isAgentHealthy(agentId)` — check if last heartbeat within timeout window
- [ ] Implement `getTrackedAgents()` — return array of currently tracked agent IDs (for testing/debugging)
- [ ] Implement `checkMissedHeartbeats()` (private) — poll all tracked agents, identify those exceeding timeout
- [ ] Implement `handleMissedHeartbeat(agentId)` — callback onMissed, record "missed" heartbeat event
- [ ] Implement `handleRecoveredHeartbeat(agentId)` — callback onRecovered when heartbeat resumes after miss, record "recovered" event
- [ ] Implement `terminateUnresponsive(agentId)` — dispose session via `session.dispose()`, update agent state to "terminated", end heartbeat run with "terminated" status, callback onTerminated
- [ ] Run targeted tests for HeartbeatMonitor (`pnpm test packages/engine/src/agent-heartbeat.test.ts`)

**Artifacts:**
- `packages/engine/src/agent-heartbeat.ts` (new)
- `packages/engine/src/agent-heartbeat.test.ts` (new)

### Step 4: Export Integration

- [ ] Update `packages/core/src/index.ts` to export AgentStore class
- [ ] Export agent types: Agent, AgentState, AgentHeartbeatEvent, AgentHeartbeatRun, AgentCreateInput
- [ ] Verify all exports compile correctly (`pnpm typecheck`)
- [ ] Run targeted tests

**Artifacts:**
- `packages/core/src/index.ts` (modified — new exports)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — all packages must compile
- [ ] Verify AgentStore tests cover: CRUD operations, state transitions (valid and invalid), heartbeat recording, JSONL appends, heartbeat run lifecycle, file locking
- [ ] Verify HeartbeatMonitor tests cover: tracking/untracking, missed heartbeat detection, recovery detection, termination, callback invocation, polling start/stop
- [ ] Ensure no TypeScript errors in new or modified files

### Step 6: Documentation & Delivery

- [ ] Add JSDoc comments to all public AgentStore methods explaining parameters, return values, and thrown errors
- [ ] Add JSDoc comments to all public HeartbeatMonitor methods
- [ ] Document state transition rules in code comments: idle→active→paused→terminated, with note that terminated is terminal
- [ ] Document why heartbeat runs exist (track continuous sessions vs. individual heartbeats)
- [ ] Add README note in agent-store.ts header explaining file storage format
- [ ] **No changeset required** — this is internal infrastructure work on private packages, not user-facing

## Implementation Details

### AgentStore File Structure

Agents stored at `.fusion/agents/{agentId}.json`:
```json
{
  "id": "agent-001",
  "name": "Task Executor Alpha",
  "role": "executor",
  "state": "active",
  "taskId": "KB-123",
  "createdAt": "2026-03-31T12:00:00.000Z",
  "updatedAt": "2026-03-31T12:05:00.000Z",
  "lastHeartbeatAt": "2026-03-31T12:04:30.000Z",
  "metadata": {}
}
```

Heartbeat events appended to `.fusion/agents/{agentId}-heartbeats.jsonl`:
```json
{"timestamp":"2026-03-31T12:01:00.000Z","status":"ok","runId":"run-001"}
{"timestamp":"2026-03-31T12:02:00.000Z","status":"ok","runId":"run-001"}
{"timestamp":"2026-03-31T12:04:00.000Z","status":"missed","runId":"run-001"}
{"timestamp":"2026-03-31T12:05:00.000Z","status":"recovered","runId":"run-001"}
```

### HeartbeatMonitor Pattern

Follow the `StuckTaskDetector` pattern exactly:
- Use `Map<string, TrackedAgent>` for in-memory tracking
- Poll on interval (default 30s)
- Compare `lastSeen` timestamp against timeout (default 60s)
- Use callback options (`onMissed`, `onRecovered`, `onTerminated`) not EventEmitter
- Auto-dispose unresponsive sessions via provided `dispose()` method

**TrackedAgent interface:**
```typescript
interface TrackedAgent {
  agentId: string;
  session: { dispose: () => void };
  runId: string;
  lastSeen: number; // timestamp from Date.now()
  missedHeartbeatReported: boolean; // prevent duplicate onMissed calls
}
```

### State Transitions

Valid transitions (invalid ones throw `Error`):
- `idle` → `active` (agent starts work, creates heartbeat run)
- `active` → `paused` (user or system pause)
- `active` → `terminated` (completion, failure, or missed heartbeats)
- `paused` → `active` (resume work)
- `paused` → `terminated` (cancel while paused)
- Any → `terminated` is allowed (terminal state)
- `terminated` → anything throws Error (terminal state, no exit)

### Error Handling Strategy

For filesystem operations, follow TaskStore patterns:
- Use promise chaining for serializing writes per agent file (agentLocks Map)
- Read-modify-write cycles should be atomic where possible
- Throw errors for operations that can't complete (file not found, permission denied)
- Use try/catch in tests to verify error cases

### Type Definitions Template

Add these to `packages/core/src/types.ts` (append after existing types):

```typescript
/** Valid agent lifecycle states */
export const AGENT_STATES = ["idle", "active", "paused", "terminated"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** An agent that can execute tasks and report heartbeats */
export interface Agent {
  id: string;
  name: string;
  role: string;
  state: AgentState;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt?: string;
  metadata?: Record<string, unknown>;
}

/** Individual heartbeat event recorded for an agent */
export interface AgentHeartbeatEvent {
  timestamp: string;
  status: "ok" | "missed" | "recovered";
  runId: string;
}

/** A continuous heartbeat session (from activation to termination) */
export interface AgentHeartbeatRun {
  id: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  status?: "completed" | "terminated" | "failed";
}

/** Input for creating a new agent */
export interface AgentCreateInput {
  name: string;
  role: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] AgentStore persists agent data to `.fusion/agents/`
- [ ] HeartbeatMonitor detects missed heartbeats and terminates unresponsive agents
- [ ] State transitions validate correctly (invalid transitions throw)
- [ ] JSDoc comments on all public APIs
- [ ] Exports added to packages/core/src/index.ts

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-286): complete Step N — description`
- **Bug fixes:** `fix(KB-286): description`
- **Tests:** `test(KB-286): description`

Example:
```
feat(KB-286): complete Step 1 — add agent type definitions
feat(KB-286): complete Step 2 — implement AgentStore with CRUD operations
feat(KB-286): complete Step 3 — implement HeartbeatMonitor with auto-termination
feat(KB-286): complete Step 4 — export AgentStore from core package
feat(KB-286): complete Step 6 — add JSDoc documentation
```

## Do NOT

- Expand scope to implement full agent execution (that's KB-284)
- Skip tests — both AgentStore and HeartbeatMonitor need comprehensive coverage
- Modify TaskStore or existing task execution logic (keep changes localized)
- Add UI components (that's KB-285)
- Implement messaging/inbox (that's KB-287)
- Skip JSDoc comments on public APIs
- Use a database — stick to filesystem-based storage like TaskStore
- Create a changeset — this is internal infrastructure, not user-facing
- Use EventEmitter pattern — use callbacks like StuckTaskDetector for consistency
