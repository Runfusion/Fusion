# Task: KB-646 - Fix Agent Icon in Header Not Opening Agent View

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI bug fix with isolated blast radius. No security concerns. Fully reversible change.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Fix the agent icon (Bot icon) in the dashboard header so that clicking it properly opens the AgentListModal. Currently, the Agents button in the header appears to be rendering but clicking it doesn't bring up the agent view. The issue appears to be related to the button's placement in the Header component's JSX structure—it's positioned after the mobile overflow menu conditional block, which may cause rendering or event handling issues.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — The component containing the agent icon button
- `packages/dashboard/app/App.tsx` — Parent component that defines `handleOpenAgents` callback and renders `AgentListModal`
- `packages/dashboard/app/components/AgentListModal.tsx` — The modal that should open when the agent button is clicked
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — Existing test patterns (note: no tests currently exist for the Agents button)

## File Scope

- `packages/dashboard/app/components/Header.tsx` — Fix Agents button rendering/position
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — Add tests for Agents button functionality

## Steps

### Step 1: Investigate and Fix Header Agents Button

- [ ] Read the current Header.tsx implementation to understand the JSX structure
- [ ] Identify why the Agents button isn't triggering `onOpenAgents`:
  - Check if the button is being rendered in the wrong place (after mobile overflow menu)
  - Verify the button has proper event handling
  - Check for any CSS z-index or pointer-events issues
- [ ] Move the Agents button to the correct position in the header:
  - It should be grouped with other desktop-only action buttons (GitHub Import, Planning, Schedules, Terminal, Files, Git Manager, Workflow Steps)
  - Place it BEFORE the pause/stop controls for consistency
  - Ensure it's properly ordered: Workflow Steps → Agents → Settings
- [ ] Verify the button has the correct onClick handler bound:
  ```tsx
  <button
    className="btn-icon"
    onClick={onOpenAgents}
    title="Manage Agents"
    data-testid="agents-btn"
  >
    <Bot size={16} />
  </button>
  ```
- [ ] Ensure the overflow menu version also works on mobile:
  - The overflow menu already has the agents button at lines 468-476
  - Verify it's using `handleOverflowAction(onOpenAgents)` correctly

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Add Tests for Agents Button

- [ ] Add test: "renders agents button when onOpenAgents is provided" — verify button is found with title "Manage Agents"
- [ ] Add test: "calls onOpenAgents when agents button is clicked" — verify click handler is invoked
- [ ] Add test: "agents button is hidden on mobile viewport" — verify button is not rendered when `isMobile` is true
- [ ] Add test: "agents button is hidden when onOpenAgents is not provided" — verify button is not rendered when prop is undefined
- [ ] Add test: "mobile overflow menu shows agents button when onOpenAgents provided" — verify overflow menu contains "Manage Agents" item on mobile
- [ ] Run existing Header tests to ensure no regressions

**Artifacts:**
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modified)

### Step 3: Verify End-to-End Integration

- [ ] Check App.tsx integration:
  - Verify `handleOpenAgents` is defined and calls `setAgentsOpen(true)`
  - Verify `AgentListModal` is rendered with `isOpen={agentsOpen}`
  - Verify `onClose` prop on `AgentListModal` properly sets `agentsOpen` to false
- [ ] Run the dashboard and manually verify:
  - Clicking the Agents button opens the AgentListModal
  - The modal shows "Agents" title with Bot icon
  - Closing the modal works correctly (clicking overlay, clicking X button)

**Artifacts:**
- Integration verified (no file changes expected in App.tsx or AgentListModal.tsx unless bugs found)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`
- [ ] Verify no TypeScript errors: `pnpm typecheck` (if available)

**Artifacts:**
- Test suite passing

### Step 5: Documentation & Delivery

- [ ] No documentation updates required — this is a bug fix restoring expected behavior
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Clicking the agent icon in the header opens the AgentListModal
- [ ] Mobile overflow menu agents button also works correctly
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-646): complete Step N — description`
- **Bug fixes:** `fix(KB-646): description`
- **Tests:** `test(KB-646): description`

## Do NOT

- Expand task scope beyond fixing the agent icon click behavior
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Change the AgentListModal internal functionality (keep scope focused on the header button)
