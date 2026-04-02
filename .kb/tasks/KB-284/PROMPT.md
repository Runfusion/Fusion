# Task: KB-284 - Implement agent task session management

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Builds on KB-283's AgentStore to implement agent-task assignment and session lifecycle. Moderate blast radius affecting TaskExecutor integration. Follows established StuckTaskDetector patterns for tracking and monitoring. Session handoff logic introduces new coordination patterns requiring careful review.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Implement the agent task session management system that enables agents to claim, execute, and release task sessions. This system tracks which agent is working on which task, monitors session duration, and supports handoff logic for transferring work between agents.

Key capabilities:
1. **Task claiming** — Agents claim exclusive rights to execute a task
2. **Session tracking** — Monitor active sessions with start time, duration, and agent assignment
3. **Session lifecycle** — Claim → Execute → Complete/Release with state transitions
4. **Handoff support** — Transfer a task session from one agent to another
5. **Integration** — Hook into TaskExecutor to track agent execution sessions

This builds directly on KB-283's AgentStore (agent data model and heartbeat monitoring) and enables the broader agent system architecture.

## Dependencies

- **Task:** KB-283 (AgentStore data model and heartbeat monitoring must be complete)
  - Requires AgentStore with CRUD operations for agents
  - Requires Agent type definitions (id, name, role, state, taskId)
  - Requires agent state tracking (idle, active, paused, terminated)

## Context to Read First

**Pattern Reference:**
- `packages/engine/src/stuck-task-detector.ts` — Established tracking pattern with Map, polling, disposal
- `packages/engine/src/concurrency.ts` — AgentSemaphore pattern for slot-based resource management

**Integration Points:**
- `packages/engine/src/executor.ts` — TaskExecutor where sessions are created and managed
- `packages/core/src/types.ts` — Type definitions location (add AgentSession types here)
- `packages/core/src/agent-store.ts` — KB-283's AgentStore for agent CRUD operations
- `packages/core/src/index.ts` — Export location for new types and classes

## File Scope

**New Files:**
- `packages/core/src/agent-session.ts` — AgentSession types and session state definitions
- `packages/engine/src/agent-session-manager.ts` — AgentSessionManager class for claim/execute/release
- `packages/engine/src/agent-session-manager.test.ts` — Unit tests for AgentSessionManager

**Modified Files:**
- `packages/core/src/types.ts` — Add AgentSession, AgentSessionState, TaskAssignment types
- `packages/core/src/index.ts` — Export AgentSession types
- `packages/engine/src/executor.ts` — Integrate session claiming and tracking into TaskExecutor
- `packages/core/src/agent-store.ts` — Add methods for task assignment/unassignment (if not in KB-283)

## Steps

### Step 1: Agent Session Type Definitions

- [ ] Add agent session types to `packages/core/src/types.ts`
- [ ] Define `AgentSessionState` union: `"claiming" | "active" | "releasing" | "completed" | "handed-off"`
- [ ] Define `AgentSession` interface with:
  - `id` — unique session identifier
  - `agentId` — reference to the agent
  - `taskId` — reference to the task being executed
  - `state` — current session state
  - `startedAt` — ISO-8601 timestamp when session began
  - `endedAt` — optional timestamp when session ended
  - `durationMs` — computed session duration
  - `handedOffTo` — optional agentId if session was transferred
  - `metadata` — optional additional data
- [ ] Define `TaskAssignment` interface tracking current task-to-agent mapping
- [ ] Define `AgentSessionManagerOptions` for configuration
- [ ] Run targeted tests for types compilation

**Artifacts:**
- `packages/core/src/types.ts` (modified — new agent session types added)

### Step 2: AgentSessionManager Implementation

- [ ] Create `packages/engine/src/agent-session-manager.ts`
- [ ] Implement `AgentSessionManager` class with:
  - Constructor accepting `AgentStore`, `TaskStore`, and options
  - `claimSession(agentId, taskId)` — attempt to claim task execution rights
  - `releaseSession(sessionId, outcome?)` — end session with success/failure
  - `handoffSession(sessionId, toAgentId)` — transfer session to another agent
  - `getActiveSession(agentId)` — get current session for an agent
  - `getSessionForTask(taskId)` — get current session for a task
  - `getSession(sessionId)` — retrieve session by ID
  - `listActiveSessions()` — list all currently active sessions
  - `getSessionDuration(sessionId)` — get elapsed or total duration
- [ ] Implement session persistence to `.fusion/agent-sessions/{sessionId}.json`
- [ ] Implement claim validation (prevent double-claiming same task)
- [ ] Implement session state transitions with validation
- [ ] Emit events: `session:claimed`, `session:released`, `session:handed-off`
- [ ] Run targeted tests for AgentSessionManager

**Artifacts:**
- `packages/engine/src/agent-session-manager.ts` (new)

### Step 3: Unit Tests for AgentSessionManager

- [ ] Create `packages/engine/src/agent-session-manager.test.ts`
- [ ] Test session claiming (success and conflict cases)
- [ ] Test session release with outcomes
- [ ] Test session handoff between agents
- [ ] Test claim validation (same task cannot be double-claimed)
- [ ] Test session duration tracking
- [ ] Test event emission (claimed, released, handed-off)
- [ ] Test state transition validation (invalid transitions throw)
- [ ] Test persistence (sessions saved to disk, survive manager restart)
- [ ] Test concurrent claim attempts (race condition handling)
- [ ] Run tests — all must pass

**Artifacts:**
- `packages/engine/src/agent-session-manager.test.ts` (new)

### Step 4: AgentStore Task Assignment Integration

- [ ] Verify `AgentStore` from KB-283 has task assignment methods:
  - `assignTask(agentId, taskId)` — set agent.taskId and agent.state="active"
  - `unassignTask(agentId)` — clear agent.taskId, set agent.state="idle"
  - `getAgentByTask(taskId)` — find agent assigned to a task
- [ ] If missing, add these methods to `packages/core/src/agent-store.ts`
- [ ] Ensure task assignment updates agent heartbeat state
- [ ] Run targeted tests for AgentStore task assignment

**Artifacts:**
- `packages/core/src/agent-store.ts` (modified — task assignment methods)

### Step 5: TaskExecutor Integration

- [ ] Modify `packages/engine/src/executor.ts` TaskExecutor class:
  - Add `AgentSessionManager` as optional constructor dependency
  - In `execute()` method, claim session before starting agent
  - Release session on completion, failure, or pause
  - Handle handoff scenarios when pausing/resuming
- [ ] Add session context to agent logger output
- [ ] Update `onComplete`, `onError`, `onPause` callbacks to include session info
- [ ] Ensure session is released even if agent crashes/errors
- [ ] Run targeted tests for executor integration

**Artifacts:**
- `packages/engine/src/executor.ts` (modified — session integration)

### Step 6: Export Integration

- [ ] Update `packages/core/src/index.ts` to export AgentSession types
- [ ] Update `packages/engine/src/index.ts` to export AgentSessionManager
- [ ] Verify all exports compile correctly
- [ ] Run targeted tests

**Artifacts:**
- `packages/core/src/index.ts` (modified — new exports)
- `packages/engine/src/index.ts` (modified — new exports)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — all packages must compile
- [ ] Verify AgentSessionManager tests cover: claiming, releasing, handoffs, duration, events
- [ ] Verify TaskExecutor integration tests pass
- [ ] Ensure no TypeScript errors in new or modified files
- [ ] Test integration manually (optional): verify sessions are created and released

### Step 8: Documentation & Delivery

- [ ] Add JSDoc comments to all public AgentSessionManager methods
- [ ] Document session state transitions in code comments
- [ ] Add usage example in code comments showing claim → execute → release flow
- [ ] Document handoff pattern for session transfers
- [ ] Create changeset for the new feature:
```bash
cat > .changeset/agent-session-management.md << 'EOF'
---
"@kb/core": minor
"@kb/engine": minor
---

Add agent task session management system with claim, execute, release lifecycle.
Implements session tracking, duration monitoring, and agent handoff support.
EOF
```

## Implementation Details

### AgentSession File Structure

Sessions stored at `.fusion/agent-sessions/{sessionId}.json`:
```json
{
  "id": "session-001",
  "agentId": "agent-001",
  "taskId": "KB-123",
  "state": "active",
  "startedAt": "2026-03-31T12:00:00.000Z",
  "endedAt": null,
  "durationMs": 0,
  "handedOffTo": null,
  "metadata": {
    "claimedBy": "scheduler",
    "priority": 1
  }
}
```

### Session State Transitions

Valid transitions:
- `claiming` → `active` (claim accepted, execution begins)
- `active` → `releasing` (task completing, cleanup in progress)
- `active` → `handed-off` (session transferred to another agent)
- `releasing` → `completed` (session ended normally)
- `releasing` → `completed` (session ended with error)

Invalid transitions throw errors (e.g., `completed` → `active`).

### Claim Validation

- A task can only have ONE active session at a time
- An agent can only have ONE active session at a time
- Claim fails if task already has active session
- Claim fails if agent already has active session

### Handoff Pattern

```typescript
// Original agent releases with handoff
sessionManager.handoffSession(sessionId, newAgentId);

// Results in:
// 1. Old session state: "handed-off"
// 2. New session created for newAgentId
// 3. Old session.handedOffTo = newAgentId
// 4. Event emitted: session:handed-off
```

### TaskExecutor Integration Points

```typescript
// In TaskExecutor.execute():
async execute(task: Task): Promise<void> {
  // Claim session before starting
  const session = await this.sessionManager?.claimSession(agentId, task.id);
  
  try {
    // ... existing execution logic ...
    
    // Release on completion
    await this.sessionManager?.releaseSession(session.id, "success");
  } catch (error) {
    // Release on failure
    await this.sessionManager?.releaseSession(session.id, "failure");
    throw error;
  }
}
```

### Session Manager Pattern

Follow the `StuckTaskDetector` pattern:
- Use `Map<string, AgentSession>` for in-memory session cache
- Persist to disk on state changes
- EventEmitter for external notification
- File-based session storage for recovery

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] AgentSessionManager persists sessions to `.fusion/agent-sessions/`
- [ ] Task claims are exclusive (no double-claiming)
- [ ] Session handoffs create proper audit trail
- [ ] TaskExecutor integrates with session management
- [ ] Duration tracking works for active and completed sessions
- [ ] Changeset file included in commit

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-284): complete Step N — description`
- **Bug fixes:** `fix(KB-284): description`
- **Tests:** `test(KB-284): description`

Example:
```
feat(KB-284): complete Step 1 — add agent session type definitions
feat(KB-284): complete Step 2 — implement AgentSessionManager
feat(KB-284): complete Step 3 — add unit tests for session manager
feat(KB-284): complete Step 4 — integrate task assignment with AgentStore
feat(KB-284): complete Step 5 — integrate sessions into TaskExecutor
feat(KB-284): complete Step 6 — export AgentSessionManager from packages
feat(KB-284): complete Step 8 — add changeset and documentation
```

## Do NOT

- Skip tests — AgentSessionManager needs comprehensive coverage
- Modify database schema — stick to filesystem-based storage
- Implement full multi-agent orchestration (that's KB-286)
- Add UI components for session visualization (future work)
- Skip error handling for race conditions in claim attempts
- Allow a single agent to hold multiple task sessions simultaneously
- Skip JSDoc comments on public APIs
- Skip the changeset (this is a new feature, needs minor version bump)
