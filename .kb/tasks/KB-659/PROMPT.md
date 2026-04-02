# Task: KB-659 - Add Agents View Toggle to View Selector

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI addition that extends the existing view toggle pattern. Reuses existing AgentListModal content. No security concerns, fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a third view option "agents" to the dashboard's main view selector, allowing users to toggle between board, list, and agents views. Currently, the agent view is only accessible via a modal button in the header. This change integrates it as a first-class view mode alongside board and list, using the same toggle pattern already established in the header.

## Dependencies

- **Task:** KB-646 (The agent icon in the header isn't bringing up the agent view) — Ensures the agent modal functionality works before integrating into the main view

## Context to Read First

- `packages/dashboard/app/App.tsx` — Main app component with view state and component rendering logic
- `packages/dashboard/app/components/Header.tsx` — Contains the view-toggle component with board/list buttons
- `packages/dashboard/app/components/AgentListModal.tsx` — The existing agent list modal with board/list toggle and agent rendering logic
- `packages/dashboard/app/components/Board.tsx` — Reference for how main views are structured and receive props
- `packages/dashboard/app/components/ListView.tsx` — Reference for how main views are structured and receive props

## File Scope

- `packages/dashboard/app/App.tsx` — Update view type to include "agents", add AgentsView rendering
- `packages/dashboard/app/components/Header.tsx` — Add third button to view-toggle for agents view
- `packages/dashboard/app/components/AgentsView.tsx` — New component: inline agent list view (extracted from AgentListModal patterns)
- `packages/dashboard/app/components/AgentListModal.tsx` — Optional: refactor to share components with AgentsView
- `packages/dashboard/app/components/__tests__/Header.test.tsx` — Add tests for new agents view button

## Steps

### Step 1: Extend View Type and Header Toggle

- [ ] Update the view type in `App.tsx` from `"board" | "list"` to `"board" | "list" | "agents"`
- [ ] Update `localStorage` key logic to handle the new view option
- [ ] Add third button to the view-toggle in `Header.tsx`:
  ```tsx
  <button
    className={`view-toggle-btn${view === "agents" ? " active" : ""}`}
    onClick={() => onChangeView("agents")}
    title="Agents view"
    aria-label="Agents view"
    aria-pressed={view === "agents"}
  >
    <Bot size={16} />
  </button>
  ```
- [ ] Import `Bot` icon from lucide-react in Header.tsx if not already imported
- [ ] Update `HeaderProps` interface to accept the new view type
- [ ] Ensure the search input in header is hidden when view is "agents" (agents view doesn't need task search)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Create AgentsView Component

- [ ] Create new `AgentsView.tsx` component in `packages/dashboard/app/components/`
- [ ] Extract and adapt the rendering logic from `AgentListModal.tsx`:
  - Agent list/board view state management (with localStorage persistence)
  - Agent fetching and CRUD operations
  - Agent card rendering (both list and board layouts)
  - Filter controls (state filter, create form)
  - State change handlers (activate, pause, stop, delete)
  - Health status indicators
- [ ] Define `AgentsViewProps` interface:
  ```tsx
  interface AgentsViewProps {
    addToast: (message: string, type?: "success" | "error") => void;
  }
  ```
- [ ] Copy the CSS-in-JSX styles from AgentListModal (or extract shared styles to a common location)
- [ ] Ensure the component handles its own data fetching via the API functions

**Artifacts:**
- `packages/dashboard/app/components/AgentsView.tsx` (new)

### Step 3: Integrate AgentsView in App.tsx

- [ ] Add conditional rendering in App.tsx for the agents view:
  ```tsx
  {view === "agents" ? (
    <AgentsView addToast={addToast} />
  ) : view === "board" ? (
    <Board ... />
  ) : (
    <ListView ... />
  )}
  ```
- [ ] Import `AgentsView` component
- [ ] Hide or disable the separate "Agents" modal button in the header when the agents view toggle is active (optional UX improvement)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests to `Header.test.tsx`:
  - "renders agents view button in view toggle"
  - "calls onChangeView with 'agents' when agents button is clicked"
  - "agents button has active class when view is agents"
- [ ] Add tests for `AgentsView` component (create `AgentsView.test.tsx`):
  - "renders agent list on mount"
  - "fetches agents on mount"
  - "renders empty state when no agents"
  - "can toggle between list and board view"
  - "can filter agents by state"
  - "can create new agent"
  - "can change agent state"
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/Header.test.tsx` (modified)
- `packages/dashboard/app/components/__tests__/AgentsView.test.tsx` (new)

### Step 5: Documentation & Delivery

- [ ] No documentation updates required — this is a UI enhancement following existing patterns
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Build passes
- [ ] View toggle shows three buttons: board, list, and agents
- [ ] Clicking agents button switches to agents view
- [ ] Agents view displays agent list with board/list toggle, filter controls, and create functionality
- [ ] Board and list views continue to work as before
- [ ] View preference persists to localStorage including "agents" option

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-659): complete Step N — description`
- **Bug fixes:** `fix(KB-659): description`
- **Tests:** `test(KB-659): description`

## Do NOT

- Remove or disable the existing AgentListModal (keep it accessible via the header button for now)
- Modify the agent API layer (packages/dashboard/app/api.ts)
- Expand scope beyond adding the agents view toggle
- Skip tests
- Modify files outside the File Scope without good reason
- Change the internal structure of how agents work beyond view presentation
