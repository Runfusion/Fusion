# Task: KB-291 - Refinement: Agent Dashboard UI

**Created:** 2026-03-31
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** UI refinement task building on existing KB-285 agent dashboard. Improves UX with real-time updates, dedicated data hooks, and enhanced visual design. Low blast radius — only touches agent-related dashboard components.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Refine and polish the Agent Dashboard UI built in KB-285 to provide a more professional, informative, and responsive experience. The improvements focus on:

1. **Real-time Updates** — Add SSE-powered live agent state updates instead of manual refresh
2. **Dedicated Data Hooks** — Create reusable `useAgents` and `useAgentDetail` hooks following dashboard patterns
3. **Agent Detail View** — Expand the modal to show detailed agent information including heartbeat history visualization
4. **Visual Polish** — Improve card design, state indicators, and overall aesthetics to match task card quality
5. **Better Empty States** — Add helpful empty states and loading skeletons
6. **Search & Filter Persistence** — Remember user filter preferences in localStorage

These refinements transform the basic agent list into a production-quality monitoring interface that operators can rely on for real-time agent observability.

## Dependencies

- **Task:** KB-285 — Agent Dashboard UI (base implementation must be complete)

## Context to Read First

**Existing Agent Components:**
- `packages/dashboard/app/components/AgentListModal.tsx` — Current agent list modal implementation
- `packages/dashboard/app/components/AgentLogViewer.tsx` — Agent log display component

**Dashboard Patterns to Follow:**
- `packages/dashboard/app/hooks/useTasks.ts` — Hook pattern with SSE updates (lines 1-200)
- `packages/dashboard/app/api.ts` — Agent API functions (already exist: `fetchAgents`, `fetchAgent`, `createAgent`, `updateAgentState`, `deleteAgent`)
- `packages/dashboard/app/components/TaskCard.tsx` — Card styling patterns
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Modal tab patterns

**Type References:**
- `packages/core/src/types.ts` — Agent types: `Agent`, `AgentDetail`, `AgentState`, `AgentCapability`, `AgentHeartbeatEvent`

## File Scope

**New Files:**
- `packages/dashboard/app/hooks/useAgents.ts` — React hook for agent list with SSE updates
- `packages/dashboard/app/hooks/useAgentDetail.ts` — React hook for single agent with live updates
- `packages/dashboard/app/components/AgentDetailView.tsx` — Agent detail panel with heartbeat history
- `packages/dashboard/app/components/AgentCard.tsx` — Extracted and improved agent card component
- `packages/dashboard/app/components/AgentStats.tsx` — Agent statistics summary component

**Modified Files:**
- `packages/dashboard/app/components/AgentListModal.tsx` — Refactor to use hooks, add detail view, improve styling
- `packages/dashboard/app/styles.css` — Add agent-specific CSS classes and animations

## Steps

### Step 1: Create useAgents Hook

- [ ] Create `packages/dashboard/app/hooks/useAgents.ts`
- [ ] Implement `useAgents(filter?)` returning `{ agents, isLoading, error, refresh, isConnected }`
- [ ] Connect to SSE endpoint `/api/events` for live updates
- [ ] Listen for `agent:created`, `agent:updated`, `agent:deleted` events
- [ ] Implement optimistic updates when filter is active
- [ ] Add JSDoc comments
- [ ] Write hook tests in `packages/dashboard/app/hooks/useAgents.test.ts`

**Pattern from:** `packages/dashboard/app/hooks/useTasks.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/useAgents.ts` (new)
- `packages/dashboard/app/hooks/useAgents.test.ts` (new)

### Step 2: Create useAgentDetail Hook

- [ ] Create `packages/dashboard/app/hooks/useAgentDetail.ts`
- [ ] Implement `useAgentDetail(agentId)` returning `{ agent, isLoading, error, refresh, isConnected }`
- [ ] Connect to SSE for agent-specific updates
- [ ] Listen for `agent:heartbeat` events for the specific agent
- [ ] Add heartbeat history caching
- [ ] Add JSDoc comments
- [ ] Write hook tests in `packages/dashboard/app/hooks/useAgentDetail.test.ts`

**Artifacts:**
- `packages/dashboard/app/hooks/useAgentDetail.ts` (new)
- `packages/dashboard/app/hooks/useAgentDetail.test.ts` (new)

### Step 3: Create AgentCard Component

- [ ] Create `packages/dashboard/app/components/AgentCard.tsx`
- [ ] Design improved card layout following TaskCard patterns
- [ ] Add state-colored left border (idle=gray, active=green, paused=amber, terminated=red)
- [ ] Display: agent icon, name, ID, state badge, health indicator, last heartbeat relative time
- [ ] Add hover state with action buttons (pause/resume/terminate)
- [ ] Add click handler to open detail view
- [ ] Add smooth animations for state changes
- [ ] Write component tests in `packages/dashboard/app/components/AgentCard.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/AgentCard.tsx` (new)
- `packages/dashboard/app/components/AgentCard.test.tsx` (new)

### Step 4: Create AgentStats Component

- [ ] Create `packages/dashboard/app/components/AgentStats.tsx`
- [ ] Display summary stats: total agents, active count, idle count, paused count, terminated count
- [ ] Add health indicator: healthy vs unresponsive count
- [ ] Use consistent badge styling
- [ ] Make stats clickable to filter the list
- [ ] Add subtle background and border styling

**Artifacts:**
- `packages/dashboard/app/components/AgentStats.tsx` (new)

### Step 5: Create AgentDetailView Component

- [ ] Create `packages/dashboard/app/components/AgentDetailView.tsx`
- [ ] Implement tabbed interface: Overview, Heartbeats, Activity
- [ ] **Overview tab:** Agent metadata, current state, assigned task, capabilities, metadata JSON view
- [ ] **Heartbeats tab:** Chronological list with status icons, timestamps, response times
- [ ] **Activity tab:** Recent state transitions and events
- [ ] Add lifecycle controls (pause/resume/terminate) in header
- [ ] Add "Back to list" button
- [ ] Add empty states for no heartbeats/no activity

**Artifacts:**
- `packages/dashboard/app/components/AgentDetailView.tsx` (new)
- `packages/dashboard/app/components/AgentDetailView.test.tsx` (new)

### Step 6: Refactor AgentListModal

- [ ] Refactor `packages/dashboard/app/components/AgentListModal.tsx`
- [ ] Replace inline data fetching with `useAgents` hook
- [ ] Add `AgentStats` component at top of modal
- [ ] Replace inline agent rendering with `AgentCard` component
- [ ] Add detail view mode showing `AgentDetailView` when agent is selected
- [ ] Implement filter persistence in localStorage (`kb-agent-filters`)
- [ ] Add search input for agent name/ID filtering
- [ ] Improve empty state with illustration and helpful text
- [ ] Add loading skeleton state
- [ ] Ensure all CSS classes use theme variables
- [ ] Update tests to work with new structure

**Artifacts:**
- `packages/dashboard/app/components/AgentListModal.tsx` (modified)

### Step 7: Add CSS Styles

- [ ] Add agent-specific CSS classes to `packages/dashboard/app/styles.css`
- [ ] Add `.agent-card` with state variants (`.agent-card--idle`, `.agent-card--active`, etc.)
- [ ] Add `.agent-stats` styling
- [ ] Add `.agent-detail-view` with tab styling
- [ ] Add heartbeat visualization styles (`.heartbeat-item`, `.heartbeat-status--ok`, etc.)
- [ ] Add loading skeleton animations
- [ ] Add smooth transitions for state changes
- [ ] Ensure all colors use CSS theme variables
- [ ] Test responsive layout at mobile viewport

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — all packages must compile
- [ ] Verify `useAgents` hook receives SSE updates correctly
- [ ] Verify `useAgentDetail` hook receives heartbeat events
- [ ] Verify agent cards display correctly with all state variants
- [ ] Verify detail view opens and shows correct information
- [ ] Verify filter persistence works across page reloads
- [ ] Verify responsive layout on mobile viewport
- [ ] Verify all theme colors apply correctly in dark/light modes

### Step 9: Documentation & Delivery

- [ ] Add JSDoc to all new hooks and components
- [ ] Update `packages/dashboard/README.md` with Agent Dashboard section
- [ ] Create changeset file:
```bash
cat > .changeset/refine-agent-dashboard.md << 'EOF'
---
"@dustinbyrne/kb": minor
---

Refine Agent Dashboard UI with real-time SSE updates, dedicated hooks, agent detail view with heartbeat history, improved card design, and filter persistence.
EOF
```
- [ ] Out-of-scope findings: If SSE endpoints don't exist yet, note in task log

## Implementation Details

### Agent State Colors

Use existing CSS variables:
- `idle` — `var(--text-muted)` (neutral gray)
- `active` — `var(--color-success)` (green #3fb950)
- `paused` — `var(--triage)` (amber #d29922)
- `terminated` — `var(--color-error)` (red #f85149)

### Health Status Logic

```typescript
const getHealthStatus = (agent: Agent): HealthStatus => {
  if (agent.state === 'terminated') return { label: 'Terminated', color: 'error' };
  if (agent.state === 'paused') return { label: 'Paused', color: 'warning' };
  if (!agent.lastHeartbeatAt) return { label: 'Idle', color: 'muted' };
  
  const elapsed = Date.now() - new Date(agent.lastHeartbeatAt).getTime();
  const timeoutMs = 60000; // 60 seconds
  
  if (elapsed > timeoutMs) return { label: 'Unresponsive', color: 'error' };
  return { label: 'Healthy', color: 'success' };
};
```

### SSE Event Handling

```typescript
// In useAgents hook
useEffect(() => {
  const eventSource = new EventSource('/api/events');
  
  eventSource.addEventListener('agent:created', (e) => {
    const agent = JSON.parse(e.data);
    setAgents(prev => [...prev, agent]);
  });
  
  eventSource.addEventListener('agent:updated', (e) => {
    const agent = JSON.parse(e.data);
    setAgents(prev => prev.map(a => a.id === agent.id ? agent : a));
  });
  
  eventSource.addEventListener('agent:deleted', (e) => {
    const { id } = JSON.parse(e.data);
    setAgents(prev => prev.filter(a => a.id !== id));
  });
  
  return () => eventSource.close();
}, []);
```

### Filter Persistence

```typescript
// Save filters to localStorage
useEffect(() => {
  localStorage.setItem('kb-agent-filters', JSON.stringify({ state: filterState, search: searchQuery }));
}, [filterState, searchQuery]);

// Load filters on mount
useEffect(() => {
  const saved = localStorage.getItem('kb-agent-filters');
  if (saved) {
    const { state, search } = JSON.parse(saved);
    setFilterState(state ?? 'all');
    setSearchQuery(search ?? '');
  }
}, []);
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] `useAgents` hook provides real-time updates via SSE
- [ ] `useAgentDetail` hook provides live heartbeat updates
- [ ] Agent cards display with improved visual design
- [ ] Agent detail view shows heartbeat history
- [ ] Filter preferences persist across sessions
- [ ] Documentation updated
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-291): complete Step N — description`
- **Bug fixes:** `fix(KB-291): description`
- **Tests:** `test(KB-291): description`

Example:
```
feat(KB-291): complete Step 1 — create useAgents hook with SSE
feat(KB-291): complete Step 2 — create useAgentDetail hook
feat(KB-291): complete Step 3 — create AgentCard component
feat(KB-291): complete Step 4 — create AgentStats component
feat(KB-291): complete Step 5 — create AgentDetailView component
feat(KB-291): complete Step 6 — refactor AgentListModal
feat(KB-291): complete Step 7 — add CSS styles
feat(KB-291): complete Step 9 — documentation and changeset
```

## Do NOT

- Implement server-side SSE endpoints (assume they exist or note if missing)
- Modify agent execution logic or AgentStore
- Change the agent API endpoints in `api.ts`
- Skip tests for new hooks and components
- Use hardcoded colors instead of theme variables
- Break existing agent functionality from KB-285
- Add pagination (not needed until >50 agents)
