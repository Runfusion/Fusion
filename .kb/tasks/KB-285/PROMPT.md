# Task: KB-285 - Agent Dashboard UI

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** UI feature adding new dashboard surface for agent management. Follows established dashboard patterns (tasks, hooks, modals). Moderate blast radius touching navigation and routing. Requires consistent patterns with existing Task components.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Build the dashboard UI for the kb agent system, providing users with a complete interface to view, monitor, and manage agents. The agent dashboard includes:

1. **Agent List View** — Browse all agents with filtering by state and role, showing key metrics (state, last heartbeat, assigned task)
2. **Agent Detail View** — Deep-dive into a single agent with full heartbeat history, active runs, and lifecycle controls
3. **Sidebar Navigation** — Add agents as a top-level navigation section alongside the existing task board/list views
4. **Agent Management Controls** — Pause, resume, and terminate agents directly from the UI

This delivers the user-facing interface for the agent system built on the AgentStore data model (KB-283), enabling operators to monitor agent health, diagnose issues via heartbeat history, and control agent lifecycle states.

## Dependencies

- **Task:** KB-283 — AgentStore data model and heartbeat system must provide:
  - `AgentStore` class with CRUD operations exported from `@kb/core`
  - Agent types: `Agent`, `AgentDetail`, `AgentState`, `AgentCapability`, `AgentHeartbeatEvent`, `AgentHeartbeatRun`
  - Valid state transitions via `AGENT_VALID_TRANSITIONS`

## Context to Read First

**Dashboard Patterns (follow these exactly):**
- `packages/dashboard/app/hooks/useTasks.ts` — Hook pattern with SSE updates
- `packages/dashboard/app/api.ts` — Frontend API layer patterns
- `packages/dashboard/src/routes.ts` — Server route registration patterns (see `/tasks` endpoints)
- `packages/dashboard/app/components/Board.tsx` — Main view component structure
- `packages/dashboard/app/components/Header.tsx` — Navigation and top-level controls
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Detail modal with tabs pattern

**Type References:**
- `packages/core/src/types.ts` — Agent types (lines 837-920): `Agent`, `AgentDetail`, `AgentState`, `AgentCapability`, `AgentHeartbeatEvent`, `AgentHeartbeatRun`, `AgentCreateInput`, `AgentUpdateInput`

**CSS/Styling:**
- `packages/dashboard/app/styles.css` — Uses CSS variables for theming, existing component classes

## File Scope

**New Files:**
- `packages/dashboard/src/agent-routes.ts` — Express routes for agent CRUD and lifecycle APIs
- `packages/dashboard/app/hooks/useAgents.ts` — React hook for agent list with SSE updates
- `packages/dashboard/app/hooks/useAgentDetail.ts` — React hook for single agent with live updates
- `packages/dashboard/app/components/AgentList.tsx` — Main agent list view component
- `packages/dashboard/app/components/AgentList.test.tsx` — Tests for AgentList
- `packages/dashboard/app/components/AgentCard.tsx` — Individual agent card component
- `packages/dashboard/app/components/AgentDetailModal.tsx` — Agent detail modal with heartbeat history
- `packages/dashboard/app/components/AgentDetailModal.test.tsx` — Tests for AgentDetailModal
- `packages/dashboard/app/components/AgentFilters.tsx` — Filter controls for agent list

**Modified Files:**
- `packages/dashboard/src/routes.ts` — Register agent routes via `createAgentRoutes()`
- `packages/dashboard/src/server.ts` — Add agent SSE endpoint for live updates
- `packages/dashboard/app/api.ts` — Add agent API functions
- `packages/dashboard/app/App.tsx` — Add agent view state and navigation
- `packages/dashboard/app/components/Header.tsx` — Add agents navigation tab/button

## Steps

### Step 1: Server-Side Agent API

- [ ] Create `packages/dashboard/src/agent-routes.ts` with Express router
- [ ] Implement `GET /api/agents` — list all agents with optional `?state=` and `?role=` filters
- [ ] Implement `GET /api/agents/:id` — get agent detail with heartbeat history and runs
- [ ] Implement `POST /api/agents` — create new agent (name, role, optional metadata)
- [ ] Implement `PATCH /api/agents/:id` — update agent name, role, or metadata
- [ ] Implement `POST /api/agents/:id/pause` — transition active → paused state
- [ ] Implement `POST /api/agents/:id/resume` — transition paused → active state
- [ ] Implement `POST /api/agents/:id/terminate` — transition to terminated state
- [ ] Implement `DELETE /api/agents/:id` — delete agent (only if terminated or idle)
- [ ] Add validation: invalid state transitions return 400 with clear error message
- [ ] Wire routes into `packages/dashboard/src/routes.ts` via `router.use("/agents", createAgentRoutes(store))`
- [ ] Run targeted tests for agent routes

**Artifacts:**
- `packages/dashboard/src/agent-routes.ts` (new)

### Step 2: Agent SSE Updates

- [ ] Extend SSE in `packages/dashboard/src/server.ts` to emit agent events
- [ ] Emit `agent:created` when new agent is created
- [ ] Emit `agent:updated` when agent state changes
- [ ] Emit `agent:heartbeat` when heartbeat is recorded
- [ ] Emit `agent:deleted` when agent is removed
- [ ] Verify SSE events are received by connected clients

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified — agent events)

### Step 3: Frontend API Layer

- [ ] Add `fetchAgents(filters?)` to `packages/dashboard/app/api.ts`
- [ ] Add `fetchAgentDetail(id)` to get single agent with history
- [ ] Add `createAgent(input)` to create new agent
- [ ] Add `updateAgent(id, updates)` to modify agent
- [ ] Add `pauseAgent(id)` lifecycle control
- [ ] Add `resumeAgent(id)` lifecycle control
- [ ] Add `terminateAgent(id)` lifecycle control
- [ ] Add `deleteAgent(id)` to remove agent
- [ ] Add agent-related error handling following existing patterns
- [ ] Run targeted tests for API functions

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified — new agent functions)

### Step 4: React Hooks

- [ ] Create `packages/dashboard/app/hooks/useAgents.ts`
- [ ] Implement hook returning `{ agents, isLoading, error, refresh }`
- [ ] Connect to SSE for live agent updates (agent:created, agent:updated, agent:deleted)
- [ ] Support filtering by state and role via optional parameters
- [ ] Create `packages/dashboard/app/hooks/useAgentDetail.ts`
- [ ] Implement hook returning `{ agent, isLoading, error, refresh }`
- [ ] Connect to SSE for live heartbeat updates for specific agent
- [ ] Write tests for both hooks

**Artifacts:**
- `packages/dashboard/app/hooks/useAgents.ts` (new)
- `packages/dashboard/app/hooks/useAgentDetail.ts` (new)

### Step 5: Agent List View Components

- [ ] Create `packages/dashboard/app/components/AgentCard.tsx`
- [ ] Display agent name, role badge, state indicator (with color coding)
- [ ] Show last heartbeat timestamp with relative time ("2m ago")
- [ ] Show assigned task ID with link (if taskId present)
- [ ] Add hover state with action buttons (pause/resume/terminate)
- [ ] Create `packages/dashboard/app/components/AgentFilters.tsx`
- [ ] State filter dropdown (idle, active, paused, terminated)
- [ ] Role filter dropdown (triage, executor, reviewer, merger, scheduler, custom)
- [ ] Clear filters button
- [ ] Create `packages/dashboard/app/components/AgentList.tsx`
- [ ] Grid layout of AgentCards (responsive: 1 col mobile, 2 tablet, 3+ desktop)
- [ ] Empty state when no agents exist
- [ ] Empty state when filters match nothing
- [ ] "Create Agent" button opening modal
- [ ] Use `useAgents` hook for data
- [ ] Write tests for components

**Artifacts:**
- `packages/dashboard/app/components/AgentCard.tsx` (new)
- `packages/dashboard/app/components/AgentFilters.tsx` (new)
- `packages/dashboard/app/components/AgentList.tsx` (new)

### Step 6: Agent Detail Modal

- [ ] Create `packages/dashboard/app/components/AgentDetailModal.tsx`
- [ ] Header with agent name, role badge, state indicator
- [ ] Tabs: Overview, Heartbeats, Runs
- [ ] Overview tab: createdAt, updatedAt, lastHeartbeatAt, assigned task link, metadata display
- [ ] Heartbeats tab: chronological list of heartbeat events (status, timestamp)
- [ ] Runs tab: list of heartbeat runs (start/end times, duration, status)
- [ ] Action bar with Pause/Resume/Terminate buttons (state-aware visibility)
- [ ] State transition validation with error toast on failure
- [ ] Write tests for modal

**Artifacts:**
- `packages/dashboard/app/components/AgentDetailModal.tsx` (new)

### Step 7: Navigation Integration

- [ ] Modify `packages/dashboard/app/components/Header.tsx`
- [ ] Add "Agents" tab/button alongside Board/List views
- [ ] Show agent count badge (active/total)
- [ ] Mobile-responsive: include in overflow menu
- [ ] Modify `packages/dashboard/app/App.tsx`
- [ ] Add `view: "agents"` state alongside board/list
- [ ] Add agent view rendering with AgentList component
- [ ] Integrate AgentDetailModal for agent selection
- [ ] Persist view preference to localStorage

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — all packages must compile
- [ ] Verify agent routes respond correctly:
  - `GET /api/agents` returns agent list
  - `GET /api/agents/:id` returns agent detail with history
  - State transitions work and invalid ones return 400
- [ ] Verify SSE events flow to frontend (check browser dev tools)
- [ ] Verify agent list displays correctly with various states
- [ ] Verify agent detail modal opens and shows heartbeat history
- [ ] Verify navigation between tasks and agents works smoothly
- [ ] Verify responsive layout on mobile viewport

### Step 9: Documentation & Delivery

- [ ] Add JSDoc comments to all agent API functions in `api.ts`
- [ ] Add README section in `packages/dashboard/README.md` about the Agents feature
- [ ] Create changeset file for the new feature:
```bash
cat > .changeset/add-agent-dashboard.md << 'EOF'
---
"@dustinbyrne/kb": minor
---

Add Agent Dashboard UI for viewing and managing agents. Includes agent list view, detail modal with heartbeat history, and lifecycle controls (pause, resume, terminate).
EOF
```
- [ ] Out-of-scope findings: If AgentStore doesn't exist, create task to implement it

## Implementation Details

### API Endpoint Specification

```typescript
// GET /api/agents?state=active&role=executor
interface ListAgentsResponse {
  agents: Agent[];
}

// GET /api/agents/:id
interface GetAgentResponse extends AgentDetail {}

// POST /api/agents
interface CreateAgentRequest {
  name: string;
  role: AgentCapability;
  metadata?: Record<string, unknown>;
}

// PATCH /api/agents/:id
interface UpdateAgentRequest {
  name?: string;
  role?: AgentCapability;
  metadata?: Record<string, unknown>;
}

// All lifecycle endpoints return Agent on success
// POST /api/agents/:id/pause
// POST /api/agents/:id/resume
// POST /api/agents/:id/terminate
```

### State Colors (CSS Variables)

Use existing dashboard color scheme:
- `idle` — neutral/gray (`var(--color-text-muted)`)
- `active` — green (`var(--color-success)` or `--color-step-done`)
- `paused` — yellow/amber (`var(--color-warning)` or `--color-step-failed`)
- `terminated` — red (`var(--color-error)`)

### Component Patterns

Follow existing dashboard patterns:
- Use `useToast()` for action feedback (pause/resume/terminate success/error)
- Use modal pattern from `TaskDetailModal` for `AgentDetailModal`
- Use card pattern from `TaskCard` for `AgentCard`
- Use CSS grid/flexbox patterns from `Board` and `Column`
- Use `lucide-react` icons (e.g., `Bot`, `Activity`, `Pause`, `Play`, `Square`, `HeartPulse`)

### Error Handling

- State transition failures: show toast with error message, don't close modal
- Network errors: show toast, allow retry via refresh button
- 404 on agent detail: redirect to list view with "Agent not found" toast

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Agent list view accessible from header navigation
- [ ] Agent detail modal opens and displays heartbeat history
- [ ] Lifecycle controls (pause/resume/terminate) work and persist
- [ ] SSE updates reflect agent state changes in real-time
- [ ] Documentation updated
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-285): complete Step N — description`
- **Bug fixes:** `fix(KB-285): description`
- **Tests:** `test(KB-285): description`

Example:
```
feat(KB-285): complete Step 1 — agent API endpoints
feat(KB-285): complete Step 2 — agent SSE updates
feat(KB-285): complete Step 3 — frontend API layer
feat(KB-285): complete Step 4 — agent hooks
feat(KB-285): complete Step 5 — agent list components
feat(KB-285): complete Step 6 — agent detail modal
feat(KB-285): complete Step 7 — navigation integration
feat(KB-285): complete Step 9 — documentation and changeset
```

## Do NOT

- Implement agent creation/editing UI beyond what's specified (separate task)
- Modify agent execution logic (that's in the engine)
- Skip tests for new components
- Use different styling patterns than existing dashboard components
- Skip JSDoc comments on public APIs
- Implement pagination for agent list (not needed until >50 agents)
- Add real-time heartbeat streaming (SSE updates on state changes only)
