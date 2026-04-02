# Task: KB-281 - Build an agent system like paperclip

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** Meta-task coordinating agent orchestration system delivery. Requires verifying/fixing KB-284 merge status and using a new task ID for inbox/messaging. Integration complexity demands thorough testing. Full review warranted for coordination logic and dependency resolution.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Build a Paperclip-inspired agent orchestration system for kb. Paperclip (paperclipai/paperclip) enables multiple specialized agents to collaborate on tasks through shared inboxes and structured messaging.

This meta-task ensures all components integrate correctly:

1. **KB-283: Core Agent Data Model** ✅ — AgentStore with lifecycle states
2. **KB-284: Agent Session Management** ⚠️ — Task claiming, handoff (on branch, needs merge)
3. **KB-285: Agent Dashboard UI** ✅ — List view, detail modal, lifecycle controls
4. **KB-286: Heartbeat Refinement** ⏳ — Runtime monitoring (currently in-review)
5. **KB-295: Agent Inbox & Messaging** ⏳ — Inter-agent communication (next available ID)
6. **KB-293: Paperclip Integration** ⏳ — Import/export, companies.sh standard (todo)

This task is complete when: all subtasks are finished, components integrate seamlessly, and end-to-end tests demonstrate agents coordinating on a multi-step task.

## Dependencies

- **Task:** KB-283 — Core Agent Data Model and AgentStore (must be complete)
- **Task:** KB-284 — Agent Session Management (must be merged to main from branch)
- **Task:** KB-285 — Agent Dashboard UI (must be complete)
- **Task:** KB-286 — Heartbeat Refinement (must be complete and marked done)
- **Task:** KB-295 — Agent Inbox & Messaging (must be created via `task_create` and complete)
- **Task:** KB-293 — Paperclip Integration (must be complete)

## Context to Read First

**Verify KB-284 Branch:**
```bash
git branch -a | grep kb-284
git log kb/kb-284 --oneline -5
```

**Agent System Components:**
- `packages/core/src/agent-store.ts` — AgentStore implementation (verify exists)
- `packages/core/src/types.ts` — Agent types (search for AgentSession types)
- `packages/engine/src/agent-heartbeat.ts` — HeartbeatMonitor (verify exists)
- `packages/engine/src/agent-session-manager.ts` — MUST EXIST after KB-284 merge
- `packages/dashboard/app/components/AgentListModal.tsx` — Agent UI
- `packages/dashboard/src/routes.ts` — Agent API routes

**Paperclip Reference:**
- Agents communicate via inbox/mailbox abstraction
- Messages have types: `task`, `question`, `response`, `notification`, `handoff`
- Companies.sh standard defines agent roles and capabilities

## File Scope

**New Files:**
- `packages/core/src/agent-inbox.ts` — AgentInboxStore for message persistence
- `packages/core/src/agent-inbox.test.ts` — Tests for inbox store
- `packages/engine/src/agent-coordinator.ts` — Multi-agent coordination logic
- `packages/engine/src/agent-coordinator.test.ts` — Coordinator tests

**Modified Files:**
- `packages/core/src/types.ts` — Add AgentMessage, AgentInbox types
- `packages/core/src/index.ts` — Export inbox components
- `packages/engine/src/index.ts` — Export coordinator
- `packages/dashboard/app/api.ts` — Add inbox API functions
- `packages/dashboard/src/routes.ts` — Add inbox routes

## Steps

### Step 0: Preflight & Dependency Resolution

- [ ] Check if KB-284 branch exists: `git branch -a | grep kb-284`
- [ ] If branch exists but not merged, create task to merge KB-284 to main
- [ ] Verify `packages/engine/src/agent-session-manager.ts` exists in main
- [ ] If missing, complete KB-284 merge before proceeding with KB-281
- [ ] Verify KB-283: `AgentStore` exported from `@kb/core`
- [ ] Verify KB-285: `AgentListModal` renders without errors
- [ ] Verify KB-286: Heartbeat tests pass
- [ ] Create KB-295 via `task_create`: "Agent Inbox and Messaging System"
- [ ] Verify KB-293: Paperclip import/export implemented
- [ ] Run `pnpm test` — ensure baseline passes
- [ ] Run `pnpm build` — ensure all packages compile

**Artifacts:**
- KB-284 verified/merged to main
- KB-295 created for inbox/messaging
- All dependency subtasks confirmed complete

### Step 1: Agent Inbox Data Model

- [ ] Add `AgentMessage` type to `packages/core/src/types.ts`:
  - id: string
  - fromAgentId: string
  - toAgentId: string | null (null = broadcast)
  - type: AgentMessageType
  - content: string
  - taskId?: string
  - threadId: string
  - createdAt: string
  - readAt?: string
- [ ] Add `AgentMessageType` union: `"task" | "question" | "response" | "notification" | "handoff"`
- [ ] Add `AgentInbox` interface with agentId, messages[], unreadCount
- [ ] Create `packages/core/src/agent-inbox.ts` with `AgentInboxStore` class
- [ ] Implement constructor with rootDir, init() creates agents directory
- [ ] Implement `postMessage(message: AgentMessage)` — append to `{agentId}-inbox.jsonl`
- [ ] Implement `getInbox(agentId, options?: { limit?: number; unreadOnly?: boolean })` — read messages
- [ ] Implement `markRead(agentId, messageId)` — update readAt timestamp
- [ ] Implement `getUnreadCount(agentId)` — count unread messages
- [ ] Implement `getThreads(agentId)` — group messages by threadId
- [ ] Run targeted tests for AgentInboxStore

**Artifacts:**
- `packages/core/src/agent-inbox.ts` (new)
- `packages/core/src/agent-inbox.test.ts` (new)
- `packages/core/src/types.ts` (modified)

### Step 2: Agent Coordinator Implementation

- [ ] Create `packages/engine/src/agent-coordinator.ts`
- [ ] Implement `AgentCoordinator` class with dependencies: AgentStore, AgentInboxStore, AgentSessionManager
- [ ] Implement `createWorkflow(definition: WorkflowDefinition)` — define multi-agent workflow
  - WorkflowDefinition: { id, name, steps: Array<{ role: AgentCapability; action: string }> }
- [ ] Implement `assignStep(workflowId, stepIndex, agentId)` — assign agent to workflow step
- [ ] Implement `startWorkflow(workflowId, initialTaskId)` — begin execution, post initial messages
- [ ] Implement `handleMessage(message: AgentMessage)` — route messages to appropriate agents
- [ ] Implement `handoffTask(fromAgentId, toAgentId, taskId, context)` — structured handoff with context preservation
- [ ] Implement `getWorkflowStatus(workflowId)` — return current step, assigned agents, completion status
- [ ] Integrate with `AgentSessionManager` for session claiming during handoffs
- [ ] Integrate with `AgentInboxStore` for all messaging
- [ ] Run targeted tests

**Artifacts:**
- `packages/engine/src/agent-coordinator.ts` (new)
- `packages/engine/src/agent-coordinator.test.ts` (new)

### Step 3: Dashboard Inbox UI

- [ ] Add inbox API functions to `packages/dashboard/app/api.ts`:
  - `fetchInbox(agentId, options?)`
  - `postMessage(message)`
  - `markRead(agentId, messageId)`
  - `getUnreadCount(agentId)`
- [ ] Add inbox routes to `packages/dashboard/src/routes.ts`:
  - `GET /api/agents/:id/inbox`
  - `POST /api/agents/:id/inbox`
  - `POST /api/agents/:id/inbox/:messageId/read`
  - `GET /api/agents/:id/inbox/unread`
- [ ] Create `packages/dashboard/app/components/AgentInbox.tsx`:
  - Message list showing from/to, type badge, content preview
  - Thread grouping with expandable messages
  - Compose message form (recipient select, type select, content textarea)
  - Unread indicator with count
  - Mark as read button
- [ ] Add inbox tab to AgentListModal or create AgentInboxModal
- [ ] Add "Send Message" button to agent detail view
- [ ] Write tests for inbox UI components

**Artifacts:**
- `packages/dashboard/app/components/AgentInbox.tsx` (new)
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)

### Step 4: Export Integration

- [ ] Update `packages/core/src/index.ts` to export:
  - `AgentInboxStore`
  - `AgentMessage`, `AgentMessageType`, `AgentInbox`
- [ ] Update `packages/engine/src/index.ts` to export:
  - `AgentCoordinator`
  - `WorkflowDefinition`, `WorkflowStatus`
- [ ] Verify all exports compile: `pnpm typecheck`
- [ ] Run targeted tests

**Artifacts:**
- `packages/core/src/index.ts` (modified)
- `packages/engine/src/index.ts` (modified)

### Step 5: End-to-End Integration Testing

> ZERO test failures allowed. Test the complete agent system end-to-end.

- [ ] Create test: Agent creates and heartbeat
  - Create agent via AgentStore
  - Start heartbeat monitoring
  - Verify heartbeat events recorded
  - Verify state transitions work
- [ ] Create test: Multi-agent workflow
  - Create 3 agents: triage, executor, reviewer
  - Coordinator creates workflow: triage → executor → reviewer
  - Start workflow with test task
  - Verify each agent receives inbox message when it's their turn
  - Simulate handoff from triage to executor
  - Simulate handoff from executor to reviewer
  - Verify workflow completion
- [ ] Create test: Session management during handoff
  - Executor claims session
  - Handoff releases executor session, creates reviewer session
  - Verify sessions properly tracked
- [ ] Run full test suite: `pnpm test`
- [ ] Build verification: `pnpm build`
- [ ] Manual dashboard test:
  - Open AgentListModal
  - Create test agent
  - Verify heartbeat appears
  - Send test message to agent inbox
  - Verify message appears in UI

**Artifacts:**
- Integration test suite
- Manual test verification notes

### Step 6: Documentation & Delivery

- [ ] Add JSDoc to all public AgentInboxStore methods
- [ ] Add JSDoc to all public AgentCoordinator methods
- [ ] Document message types and usage patterns in code comments
- [ ] Add agent system overview to AGENTS.md:
  - Architecture diagram (text)
  - Component descriptions
  - Workflow patterns
  - Inbox/messaging concepts
- [ ] Create changeset (only for published package):
  ```bash
  cat > .changeset/agent-system-paperclip.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add Paperclip-inspired agent orchestration system with multi-agent inbox,
  heartbeat monitoring, session management, and dashboard UI. Enables
  specialized agents (triage, executor, reviewer, merger) to collaborate
  on tasks through structured messaging and handoffs.
  EOF
  ```
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

**Artifacts:**
- `.changeset/agent-system-paperclip.md` (new)
- `AGENTS.md` (modified)

## Implementation Details

### Agent Inbox File Structure

Messages stored at `.fusion/agents/{agentId}-inbox.jsonl`:
```json
{"id":"msg-001","fromAgentId":"agent-triage","toAgentId":"agent-executor","type":"task","content":"Implement user authentication","taskId":"KB-123","threadId":"thread-001","createdAt":"2026-03-31T12:00:00.000Z","readAt":null}
{"id":"msg-002","fromAgentId":"agent-executor","toAgentId":"agent-triage","type":"response","content":"Task complete, ready for review","taskId":"KB-123","threadId":"thread-001","createdAt":"2026-03-31T12:30:00.000Z","readAt":"2026-03-31T12:31:00.000Z"}
```

### Message Types

| Type | Purpose | Response Expected |
|------|---------|-------------------|
| `task` | Assign work to an agent | Yes |
| `question` | Request information | Yes |
| `response` | Answer to question | No |
| `notification` | Status update | No |
| `handoff` | Formal task transfer with context | Yes |

### Coordinator Workflow Pattern

```typescript
// Define workflow
const workflow = coordinator.createWorkflow({
  id: "feature-workflow",
  name: "Feature Implementation",
  steps: [
    { role: "triage", action: "analyze" },
    { role: "executor", action: "implement" },
    { role: "reviewer", action: "review" },
    { role: "merger", action: "merge" }
  ]
});

// Assign agents
coordinator.assignStep(workflow.id, 0, "agent-triage-001");
coordinator.assignStep(workflow.id, 1, "agent-executor-001");

// Start with task
coordinator.startWorkflow(workflow.id, "KB-123");

// Handoff between agents
coordinator.handoffTask("agent-triage-001", "agent-executor-001", "KB-123", {
  analysis: "Needs auth middleware",
  estimatedComplexity: "M"
});
```

### Paperclip Companies.sh Standard

The companies.sh format defines:
- `name` — Company/agent team name
- `agents` — Agent definitions with role, model, capabilities
- `workflow` — Default workflow pattern
- `inbox` — Shared or per-agent inbox configuration

KB-293 implements import/export of this format.

## Completion Criteria

- [ ] All steps complete
- [ ] KB-284 verified/merged to main (AgentSessionManager exists)
- [ ] KB-295 created and complete (Agent Inbox & Messaging)
- [ ] All tests passing: `pnpm test`
- [ ] Build passes: `pnpm build`
- [ ] Agent dashboard shows agents with heartbeats
- [ ] Agent inbox UI can send/receive messages
- [ ] End-to-end multi-agent workflow test passes
- [ ] Documentation updated with agent system overview
- [ ] Changeset file created (targeting only @dustinbyrne/kb)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-281): complete Step N — description`
- **Bug fixes:** `fix(KB-281): description`
- **Tests:** `test(KB-281): description`

Example:
```
feat(KB-281): complete Step 0 — verify KB-284 and create KB-295
feat(KB-281): complete Step 1 — agent inbox data model
feat(KB-281): complete Step 2 — agent coordinator implementation
feat(KB-281): complete Step 3 — dashboard inbox UI
feat(KB-281): complete Step 4 — export integration
feat(KB-281): complete Step 5 — end-to-end integration testing
feat(KB-281): complete Step 6 — documentation and changeset
```

## Do NOT

- Proceed if KB-284's AgentSessionManager is missing (fix that first)
- Use KB-288 for inbox (it's already taken)
- Skip verification of subtask completion
- Skip end-to-end integration testing
- Implement features beyond Paperclip-like orchestration
- Skip documentation updates
- Skip the changeset
- Target changeset at @kb/core or @kb/engine (only @dustinbyrne/kb is published)
