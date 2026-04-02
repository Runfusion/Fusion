# Task: KB-644 - Agent List View Toggle

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI enhancement adding a view toggle to an existing modal. Low blast radius, follows established patterns from the main dashboard view toggle.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Add a board/list view toggle to the AgentListModal component, similar to the existing view toggle in the main dashboard header. Currently, the agent view only displays agents in a detailed card list format. Users should be able to toggle between:

- **Board view**: Compact grid layout showing key agent info (name, state badge, role icon) for quick scanning
- **List view**: Existing detailed card layout with full agent metadata, health status, and action buttons

The view preference should persist to localStorage so the user's choice is remembered across sessions.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/AgentListModal.tsx` — Current agent list implementation with card layout
- `packages/dashboard/app/components/Header.tsx` — Reference implementation of view toggle (see `view-toggle` CSS classes and `onChangeView` pattern)
- `packages/dashboard/app/styles.css` — Search for `.view-toggle` CSS classes (lines 206-247) for styling reference
- `packages/dashboard/app/components/__tests__/AgentListModal.test.tsx` — Existing test patterns

## File Scope

- `packages/dashboard/app/components/AgentListModal.tsx` — Add view state, toggle UI, and board view layout
- `packages/dashboard/app/components/__tests__/AgentListModal.test.tsx` — Add tests for view toggle functionality

## Steps

### Step 1: Add View State and Toggle UI

- [ ] Add local state `view: "board" | "list"` to `AgentListModal` with localStorage persistence (key: `kb-agent-view`)
- [ ] Add view toggle buttons in the modal header next to the refresh/close buttons
- [ ] Use the same `LayoutGrid` and `List` icons as the main dashboard toggle
- [ ] Apply existing `.view-toggle` and `.view-toggle-btn` CSS classes for consistent styling

**Artifacts:**
- `packages/dashboard/app/components/AgentListModal.tsx` (modified)

### Step 2: Implement Board View Layout

- [ ] Create compact board view layout: grid of agent cards (2-3 columns) showing:
  - Agent role icon (emoji)
  - Agent name (truncated if long)
  - State badge (compact version)
  - Health indicator icon only (no text label)
- [ ] Cards in board view are clickable to expand or show a detail panel (reuse existing card click behavior if any)
- [ ] Action buttons (Start/Pause/Resume/Stop/Delete) should be available in board view via hover or inline
- [ ] Keep the existing detailed list view unchanged when `view === "list"`

**Artifacts:**
- `packages/dashboard/app/components/AgentListModal.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test: "toggles between board and list views" — verify clicking toggle buttons changes view
- [ ] Add test: "persists view preference to localStorage" — verify preference is saved and restored
- [ ] Add test: "board view shows compact agent cards" — verify grid layout renders with expected compact elements
- [ ] Add test: "board view cards show action buttons" — verify Start/Pause/etc buttons work in board view
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures

**Artifacts:**
- `packages/dashboard/app/components/__tests__/AgentListModal.test.tsx` (modified)

### Step 4: Documentation & Delivery

- [ ] No documentation updates required — this is a self-explanable UI enhancement
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] View toggle appears in AgentListModal header with board/list buttons
- [ ] Toggle switches between compact board grid and detailed list layout
- [ ] View preference persists to localStorage (key: `kb-agent-view`)
- [ ] All existing AgentListModal tests pass
- [ ] New tests added for view toggle functionality
- [ ] Full test suite passes with zero failures

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-644): complete Step N — description`
- **Bug fixes:** `fix(KB-644): description`
- **Tests:** `test(KB-644): description`

## Do NOT

- Expand task scope to include other modal improvements
- Skip tests or rely on manual verification
- Modify files outside the File Scope
- Change the existing list view behavior (only add the board view alternative)
- Add new CSS classes if existing `.view-toggle` pattern can be reused
