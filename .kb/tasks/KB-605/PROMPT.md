# Task: KB-605 - Fix the Agent View

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** The agent view (Agents management modal) may have rendering, API, or state management issues. The fix requires investigation across the frontend component, API routes, and AgentStore.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Diagnose and fix why the Agents management view (AgentListModal) doesn't work in the dashboard. The agent view is the modal that opens when clicking "Manage Agents" in the header. This includes:
- The AgentListModal React component
- The /api/agents REST endpoints
- The AgentStore persistence layer
- Real-time agent log streaming via SSE

The fix must ensure agents can be listed, created, updated, deleted, and their states managed through the UI.

## Dependencies

- **None**

## Context to Read First

1. `/packages/dashboard/app/components/AgentListModal.tsx` — The agents UI component
2. `/packages/dashboard/app/api.ts` (lines 1509-1555) — Agent API client functions
3. `/packages/dashboard/src/routes.ts` (lines 5194-5385) — Agent REST API routes
4. `/packages/core/src/agent-store.ts` — Agent persistence and business logic
5. `/packages/dashboard/app/App.tsx` (lines 23, 45, 252-253, 417-420) — Agent modal integration
6. `/packages/dashboard/app/components/Header.tsx` (lines 314-322, 395-403) — Agent button in header

## File Scope

- `packages/dashboard/app/components/AgentListModal.tsx` (modify)
- `packages/dashboard/app/components/__tests__/AgentListModal.test.tsx` (create)
- `packages/dashboard/src/routes.ts` (modify if API issues found)
- `packages/core/src/agent-store.ts` (modify if store issues found)
- `packages/dashboard/app/api.ts` (modify if client issues found)
- `packages/dashboard/app/App.tsx` (modify if integration issues found)

## Steps

### Step 1: Diagnose the Issue

- [ ] Run the dashboard and click "Manage Agents" button to observe behavior
- [ ] Check browser console for JavaScript errors
- [ ] Check network tab for API request failures (/api/agents)
- [ ] Verify the modal opens (isOpen state works)
- [ ] Identify specific failure: rendering, API, state management, or CSS
- [ ] Run existing tests to check for failures: `pnpm test --run AgentListModal`

**Artifacts:**
- Document the specific failure mode found

### Step 2: Create Reproduction Tests

- [ ] Create `/packages/dashboard/app/components/__tests__/AgentListModal.test.tsx`
- [ ] Write test: modal opens when isOpen=true
- [ ] Write test: fetches and displays agent list
- [ ] Write test: creates new agent via form
- [ ] Write test: updates agent state
- [ ] Write test: deletes agent
- [ ] Write test: filters agents by state
- [ ] Run tests to confirm reproduction of the issue

**Artifacts:**
- `packages/dashboard/app/components/__tests__/AgentListModal.test.tsx` (new)

### Step 3: Fix the Identified Issue

Based on diagnosis from Step 1, fix the specific issue:

If **rendering issue**:
- [ ] Fix React component errors (null checks, prop types)
- [ ] Ensure CSS classes are correct
- [ ] Fix modal overlay click handling

If **API issue**:
- [ ] Fix agent routes error handling in routes.ts
- [ ] Ensure AgentStore.init() is called before operations
- [ ] Fix response JSON formatting

If **state management issue**:
- [ ] Fix useState hooks in AgentListModal
- [ ] Ensure proper cleanup on unmount
- [ ] Fix event handler bindings

If **integration issue**:
- [ ] Fix App.tsx props passing to AgentListModal
- [ ] Ensure onOpenAgents/onClose handlers work

- [ ] Run tests to verify the fix

**Artifacts:**
- Modified source files with fixes

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run AgentListModal-specific tests: `pnpm test --run AgentListModal`
- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test --run`
- [ ] Manually verify the fix:
  1. Open dashboard
  2. Click "Manage Agents" button
  3. Verify modal opens
  4. Create a test agent
  5. Verify agent appears in list
  6. Change agent state (Start/Pause/Stop)
  7. Delete the test agent
- [ ] Build passes: `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update AGENTS.md if API changes made
- [ ] Add JSDoc to any modified functions
- [ ] Create changeset file for the fix
- [ ] Mark task as done in kb

**Out-of-scope findings to create as new tasks:**
- If unrelated dashboard issues found, create separate tasks
- If AgentStore architecture needs refactoring, create a follow-up task

## Documentation Requirements

**Must Update:**
- Add test file documentation in the test file itself

**Check If Affected:**
- `AGENTS.md` — update if API behavior changed
- `README.md` — update if user-facing behavior changed

## Completion Criteria

- [ ] Agent modal opens correctly when clicking "Manage Agents"
- [ ] Agent list displays with name, role, state, and health status
- [ ] Can create new agents through the UI
- [ ] Can change agent states (idle → active → paused → terminated)
- [ ] Can delete terminated agents
- [ ] All new tests pass
- [ ] Full test suite passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-605): complete Step N — description`
- **Bug fixes:** `fix(KB-605): description`
- **Tests:** `test(KB-605): add AgentListModal tests`

## Do NOT

- Expand scope to rewrite the entire agent system
- Skip writing tests for the fix
- Modify files outside the File Scope without documenting why
- Break existing task/agent log functionality
- Change the agent state machine transitions
