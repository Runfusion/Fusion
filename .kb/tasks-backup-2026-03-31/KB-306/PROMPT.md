# Task: KB-306 - Add Agent View Toggle Next to Board/List Toggle

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI addition that extends existing view toggle pattern. Low blast radius, follows established patterns, easily reversible.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Add an "agent" view toggle button next to the existing board and list toggles in the dashboard header. This creates a consistent third view option alongside board and list, allowing users to view active agents as a main dashboard view rather than just via a modal.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — Current view toggle implementation with board/list buttons
- `packages/dashboard/app/App.tsx` — View state management and conditional rendering of Board/ListView
- `packages/dashboard/app/components/AgentListModal.tsx` — The agent UI that will be adapted to the new inline AgentView component
- `packages/dashboard/app/components/Header.test.tsx` — Existing test patterns for the view toggle

## File Scope

- `packages/dashboard/app/components/Header.tsx` — Add agent toggle button
- `packages/dashboard/app/App.tsx` — Add "agent" to view type, render AgentView component
- `packages/dashboard/app/components/AgentView.tsx` — New component (adapted from AgentListModal content)
- `packages/dashboard/app/components/Header.test.tsx` — Add tests for agent toggle
- `packages/dashboard/app/components/AgentView.test.tsx` — New test file for AgentView component

## Steps

### Step 1: Extend View Type and Header Toggle

- [ ] Update `HeaderProps` interface to accept `"agent"` as a view option (line ~34)
- [ ] Update `view` prop type from `"board" | "list"` to `"board" | "list" | "agent"`
- [ ] Add third toggle button for "agent" view in the `view-toggle` div (after list button)
- [ ] Use `Bot` icon from lucide-react (already imported)
- [ ] Add title "Agent view" and aria-label "Agent view"
- [ ] Apply same styling pattern as existing toggles (active state, aria-pressed)

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Create AgentView Component

- [ ] Create new `AgentView.tsx` component based on the content area of `AgentListModal.tsx`
- [ ] Extract agent list display, filter controls, and create form from AgentListModal
- [ ] Maintain all existing functionality: agent cards with state/health badges, filter dropdown, create form, state controls (start/pause/stop/delete)
- [ ] Use same API functions: `fetchAgents`, `createAgent`, `updateAgentState`, `deleteAgent`
- [ ] Add `addToast` prop for notifications
- [ ] Keep inline styles for agent-specific CSS (same pattern as AgentListModal)
- [ ] Export component for use in App.tsx

**Artifacts:**
- `packages/dashboard/app/components/AgentView.tsx` (new)

### Step 3: Integrate Agent View into App

- [ ] Update `view` state type from `"board" | "list"` to `"board" | "list" | "agent"`
- [ ] Update `localStorage` key read/write to handle "agent" value
- [ ] Add third conditional render branch for `view === "agent"`
- [ ] Render `<AgentView addToast={addToast} />` when agent view is active
- [ ] Keep Board and ListView rendering for their respective views

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 4: Testing & Verification

- [ ] Add Header tests for agent toggle:
  - Renders agent view button when onChangeView provided
  - Shows agent view as active when view is 'agent'
  - Calls onChangeView with 'agent' when clicking agent button
  - Correct aria-pressed attribute for agent button
- [ ] Create `AgentView.test.tsx` with tests:
  - Renders agent list when agents loaded
  - Shows empty state when no agents
  - Calls fetchAgents on mount
  - Handles create agent flow
  - Handles state change buttons
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures

**Artifacts:**
- `packages/dashboard/app/components/Header.test.tsx` (modified)
- `packages/dashboard/app/components/AgentView.test.tsx` (new)

### Step 5: Documentation & Delivery

- [ ] Verify the toggle group visually matches the existing board/list toggle style
- [ ] Verify agent view renders correctly with agents data
- [ ] Verify localStorage persists agent view selection
- [ ] Create changeset file for the dashboard change

**Changeset:**
```bash
cat > .changeset/add-agent-view-toggle.md << 'EOF'
---
"@kb/dashboard": minor
---

Add agent view toggle to dashboard header alongside board and list views. Users can now view active agents as a main dashboard view.
EOF
```

**Artifacts:**
- `.changeset/add-agent-view-toggle.md` (new)

## Documentation Requirements

**Must Update:**
- None (UI change is self-documenting through the toggle itself)

**Check If Affected:**
- Dashboard user documentation — mention new agent view if view modes are documented

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Agent toggle appears next to board/list toggles in header
- [ ] Clicking agent toggle switches to agent view showing active agents
- [ ] Agent view persists across page refreshes via localStorage
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-306): complete Step N — description`
- **Bug fixes:** `fix(KB-306): description`
- **Tests:** `test(KB-306): description`

## Do NOT

- Modify the existing AgentListModal behavior (keep it working as a modal)
- Change the visual style of the board/list toggles (match existing)
- Remove any existing functionality from the dashboard
- Skip writing tests for the new AgentView component
- Add features beyond the view toggle and agent list display
