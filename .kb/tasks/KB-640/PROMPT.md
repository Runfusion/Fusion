# Task: KB-640 - Fix Header Agent Icon Click Handler

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI bug fix with isolated scope. The fix involves correcting a likely missing or broken prop binding between App.tsx and Header.tsx. No security concerns, fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

The agent icon (Bot icon) in the dashboard header appears but does nothing when clicked. It should open the AgentListModal to allow users to view and manage AI agents. This task fixes the click handler binding to ensure the icon properly opens the agent management view.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/App.tsx` — Main app component that manages modal state and passes handlers to Header
- `packages/dashboard/app/components/Header.tsx` — Header component that renders the agent icon button
- `packages/dashboard/app/components/AgentListModal.tsx` — Modal that should open when the icon is clicked
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — Existing header tests for reference patterns

## File Scope

- `packages/dashboard/app/App.tsx` — Verify/correct the `handleOpenAgents` callback and its binding to Header
- `packages/dashboard/app/components/Header.tsx` — Verify the agent button onClick handler is correctly wired
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — Add test to verify agent button opens modal

## Steps

### Step 1: Diagnose and Fix the Agent Icon Click Handler

- [ ] Identify why the agent icon button click doesn't open the modal:
  - Check if `onOpenAgents` prop is properly passed from App.tsx to Header
  - Check if the button's `onClick` handler is correctly bound to `onOpenAgents`
  - Check if `handleOpenAgents` callback correctly sets `agentsOpen` state to `true`
  - Verify no CSS or z-index issues prevent clicking (button not covered by other elements)
  - Check for any console errors when clicking the icon
- [ ] Fix the identified issue:
  - If prop not passed: ensure `onOpenAgents={handleOpenAgents}` is on Header component
  - If handler not bound: correct the `onClick={onOpenAgents}` binding
  - If state not updating: verify `setAgentsOpen(true)` is called in `handleOpenAgents`
  - If CSS issue: adjust z-index or positioning to make button clickable
- [ ] Ensure the agent button renders with correct `data-testid="agents-btn"`
- [ ] Verify the button has proper accessibility: `title="Manage Agents"` and focusable

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified if prop binding issue found)
- `packages/dashboard/app/components/Header.tsx` (modified if onClick binding issue found)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test in `Header.test.tsx` for agent button click:
  - Test that clicking "Manage Agents" button calls `onOpenAgents` callback
  - Test that button is visible on desktop when `onOpenAgents` is provided
  - Test that button is not visible when `onOpenAgents` is not provided
  - Test that button is in mobile overflow menu on mobile viewport
- [ ] Add integration-style verification in existing dashboard tests if applicable
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Manual verification: Click the agent icon in the dashboard header and confirm AgentListModal opens

**Artifacts:**
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] Verify no documentation updates needed (this is a bug fix, not a feature change)
- [ ] If out-of-scope issues found (e.g., AgentListModal has its own bugs), create new tasks via `task_create`
- [ ] Mark task complete when icon click successfully opens the agent view

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Clicking the agent icon (Bot icon) in the header opens the AgentListModal
- [ ] No console errors when clicking the icon

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-640): complete Step N — description`
- **Bug fixes:** `fix(KB-640): description`
- **Tests:** `test(KB-640): description`

## Do NOT

- Expand task scope beyond fixing the click handler
- Skip tests
- Modify AgentListModal internal functionality (keep scope focused on the header icon)
- Change agent API endpoints
- Add new features to the agent system
- Commit without the task ID prefix
