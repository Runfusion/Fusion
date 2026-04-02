# Task: KB-247 - When you select break into subtasks it should

**Created:** 2026-03-31
**Size:** L

## Review Level: 2 (Plan and Code)

**Assessment:** This feature introduces a new interactive subtask breakdown dialog similar to planning mode. It requires backend AI-powered breakdown generation, a new batch task creation API, and a frontend modal with editing capabilities. The pattern is similar to existing planning mode but with different UI requirements (editable task list vs question flow).
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 2

## Mission

Replace the current "break into subtasks" checkbox behavior with an interactive dialog flow. When the user indicates they want to break a task into subtasks, show a dialog where they can see the AI-generated breakdown, edit each subtask's title and description, adjust dependencies between subtasks, and save to create all tasks at once with proper dependencies.

## Dependencies

- **Task:** KB-248 (UI button changes - the buttons that trigger this dialog) — This task provides the UI entry point (buttons instead of checkbox). If KB-248 is not complete, implement the subtask dialog and assume the triggering mechanism will be provided.

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — Reference for streaming AI interaction patterns, dialog structure, and state management
- `packages/dashboard/app/api.ts` — Frontend API client, see `createTask` and planning mode API functions (lines 93-107, 703-850)
- `packages/dashboard/src/routes.ts` — Backend route patterns, especially planning routes around lines 2837-2980 for streaming session patterns
- `packages/dashboard/src/planning.ts` — Planning session implementation (reference for AI-powered session management)
- `packages/core/src/types.ts` — Task and TaskCreateInput type definitions (lines 140-220)
- `packages/dashboard/app/components/QuickEntryBox.tsx` — Task creation entry point with current breakIntoSubtasks checkbox (lines 50-60, 500-530)
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Inline task creation with breakIntoSubtasks toggle (lines 65-75, 525-535)

## File Scope

### New Files
- `packages/dashboard/src/subtask-breakdown.ts` — Backend subtask breakdown session manager with AI agent
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` — Main dialog component for viewing/editing subtasks
- `packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx` — Tests for the modal component

### Modified Files
- `packages/dashboard/src/routes.ts` — Add `/api/subtasks/*` endpoints for breakdown generation and batch creation
- `packages/dashboard/app/api.ts` — Add frontend API functions for subtask breakdown
- `packages/dashboard/app/components/QuickEntryBox.tsx` — Wire up subtask dialog trigger
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Wire up subtask dialog trigger
- `packages/dashboard/app/App.tsx` — Add SubtaskBreakdownModal to the component tree

## Steps

### Step 1: Backend - Subtask Breakdown Session Management

Create the backend infrastructure for AI-powered subtask generation, modeled after planning mode but simpler (no question flow, just a one-time generation).

- [ ] Create `packages/dashboard/src/subtask-breakdown.ts` with session management:
  - `createSubtaskSession(initialDescription: string)` — Creates a session, spawns AI agent to generate subtasks
  - `SubtaskSession` interface with `sessionId`, `subtasks`, `status` fields
  - In-memory session storage with 30-minute TTL cleanup
  - AI agent prompt for breaking down tasks into 2-5 subtasks with proper dependencies

- [ ] Define types for the subtask breakdown:
  ```typescript
  interface SubtaskItem {
    id: string; // temporary ID like "subtask-1", "subtask-2"
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    dependsOn: string[]; // references to other subtask IDs
  }
  interface SubtaskSession {
    sessionId: string;
    initialDescription: string;
    subtasks: SubtaskItem[];
    status: "generating" | "complete" | "error";
    error?: string;
    createdAt: Date;
  }
  ```

- [ ] Implement AI agent prompt for subtask generation (similar to triage but focused on decomposition):
  - Analyze the task description
  - Break into 2-5 independently executable subtasks
  - Assign sizes (S/M/L) to each subtask
  - Determine logical dependencies between subtasks
  - Return structured JSON with subtasks array

- [ ] Add session cleanup job (remove sessions older than 30 minutes)

**Artifacts:**
- `packages/dashboard/src/subtask-breakdown.ts` (new)

### Step 2: Backend - API Routes for Subtask Breakdown

Add REST endpoints for the subtask breakdown feature in `packages/dashboard/src/routes.ts`.

- [ ] Add streaming start endpoint:
  - `POST /api/subtasks/start-streaming` — Start generation, returns `{ sessionId }`
  - Uses the subtask-breakdown module to create session
  - SSE stream at `/api/subtasks/:sessionId/stream` for real-time updates
  - Events: `thinking`, `subtasks`, `error`, `complete`

- [ ] Add batch task creation endpoint:
  - `POST /api/subtasks/create-tasks` — Creates multiple tasks in one call
  - Request body: `{ sessionId: string, subtasks: Array<{title, description, size, dependsOn, tempId}> }`
  - Creates tasks in order, resolving temporary dependency IDs to actual task IDs
  - Returns `{ tasks: Task[], parentTaskClosed?: boolean }`
  - If the request came from a task being converted, mark the parent for deletion

- [ ] Add session cancellation endpoint:
  - `POST /api/subtasks/cancel` — Cancel and cleanup a session

- [ ] Add tests for new routes in `packages/dashboard/src/routes.test.ts`:
  - Test streaming endpoint returns sessionId
  - Test batch creation creates tasks with correct dependencies
  - Test error handling for invalid session

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified - new endpoints)
- `packages/dashboard/src/routes.test.ts` (modified - new tests)

### Step 3: Frontend - Subtask Breakdown Modal Component

Create the main dialog component for viewing and editing AI-generated subtasks.

- [ ] Create `packages/dashboard/app/components/SubtaskBreakdownModal.tsx`:
  - Props interface:
    ```typescript
    interface SubtaskBreakdownModalProps {
      isOpen: boolean;
      onClose: () => void;
      initialDescription: string; // The task description to break down
      onTasksCreated: (tasks: Task[]) => void; // Callback when tasks are created
      parentTaskId?: string; // If converting an existing task
    }
    ```

- [ ] Implement view states (similar to PlanningModeModal):
  - `"initial"` — Ready to start
  - `"generating"` — AI is generating subtasks, show loading with thinking output
  - `"editing"` — Show editable subtask list (main UI)
  - `"creating"` — Creating tasks, show loading

- [ ] Implement the editing view with:
  - List of subtasks, each editable:
    - Title input field
    - Description textarea (auto-resize)
    - Size selector (S/M/L buttons)
    - Dependency selector (dropdown to select other subtasks this depends on)
  - Drag-and-drop reordering (optional but nice — use existing drag patterns from Board)
  - Add/remove subtask buttons
  - Visual dependency graph or indicator showing the dependency chain

- [ ] Implement SSE streaming connection:
  - Connect to `/api/subtasks/:sessionId/stream`
  - Show "AI is thinking..." with collapsible thinking output
  - Handle subtasks event to populate editing view

- [ ] Implement save functionality:
  - Validate all subtasks have titles
  - Transform dependency references (temp IDs → actual task IDs after creation)
  - Call batch create API
  - Close modal and call `onTasksCreated` callback

- [ ] Add keyboard shortcuts:
  - Escape to close (with confirmation if dirty)
  - Enter in title field to move to next subtask

**Artifacts:**
- `packages/dashboard/app/components/SubtaskBreakdownModal.tsx` (new)

### Step 4: Frontend - API Client Functions

Add frontend API functions in `packages/dashboard/app/api.ts`.

- [ ] Add subtask breakdown API functions:
  ```typescript
  export function startSubtaskBreakdown(description: string): Promise<{ sessionId: string }>
  export function connectSubtaskStream(sessionId: string, handlers: {...}): { close: () => void }
  export function createTasksFromBreakdown(sessionId: string, subtasks: SubtaskItem[]): Promise<{ tasks: Task[] }>
  export function cancelSubtaskBreakdown(sessionId: string): Promise<void>
  ```

- [ ] Add TypeScript types for API payloads:
  ```typescript
  export interface SubtaskItem {
    id: string;
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    dependsOn: string[];
  }
  ```

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 5: Frontend - Integration with Task Creation Flows

Wire up the subtask dialog to the existing task creation entry points.

- [ ] Update `QuickEntryBox.tsx`:
  - Remove the "Break into subtasks" checkbox UI
  - Add handler for when subtask button is clicked (from KB-248)
  - Instead of calling `onCreate`, open `SubtaskBreakdownModal` with the entered description
  - In `onTasksCreated` callback, show success toast with created task IDs

- [ ] Update `InlineCreateCard.tsx`:
  - Same pattern as QuickEntryBox
  - Remove checkbox, wire up subtask button to open modal

- [ ] Update `NewTaskModal.tsx`:
  - Remove "Enable planning mode" checkbox (superseded by new buttons)
  - Add integration with subtask dialog

- [ ] Update `App.tsx`:
  - Add `SubtaskBreakdownModal` to the component tree
  - Manage modal open state and pass to appropriate handlers

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified - if needed)
- `packages/dashboard/app/App.tsx` (modified)

### Step 6: Frontend - Component Tests

Add comprehensive tests for the new modal component.

- [ ] Create `packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx`:
  - Test initial state renders correctly
  - Test generating state shows loading spinner
  - Test editing state renders subtask list with editable fields
  - Test adding/removing subtasks
  - Test size selection changes
  - Test dependency selection
  - Test save calls API with correct data
  - Test cancel closes modal
  - Test keyboard shortcuts (Escape)

- [ ] Run component tests: `pnpm test -- packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/SubtaskBreakdownModal.test.tsx` (new)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Manual verification steps:**
- [ ] Start dashboard: `pnpm dev` in packages/dashboard
- [ ] In QuickEntryBox, type a task description and click "Subtask" button (from KB-248)
- [ ] Verify subtask breakdown modal opens
- [ ] Verify AI generates subtasks (may need to mock or use real AI)
- [ ] Edit a subtask title and description
- [ ] Change a subtask's size
- [ ] Add a dependency between subtasks
- [ ] Click "Create Tasks" and verify tasks are created
- [ ] Verify created tasks have correct dependencies set
- [ ] Test cancel flow

**Artifacts:**
- All test files passing

### Step 8: Documentation & Delivery

- [ ] Update relevant documentation:
  - `AGENTS.md` — Document the new subtask breakdown feature for users
  - Add section explaining how to use the subtask dialog

- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/subtask-breakdown-dialog.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---
  
  Add interactive subtask breakdown dialog for splitting tasks before creation
  
  When creating a task, users can now open a subtask breakdown dialog that:
  - Uses AI to analyze the task and suggest 2-5 subtasks
  - Allows editing subtask titles, descriptions, sizes, and dependencies
  - Creates all subtasks in one action with proper dependency links
  EOF
  ```

- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Any improvements to the AI breakdown quality
  - Drag-and-drop reordering enhancement (if not implemented)

**Artifacts:**
- `AGENTS.md` (modified)
- `.changeset/subtask-breakdown-dialog.md` (new)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add user-facing documentation for the new subtask breakdown feature

**Check If Affected:**
- `README.md` — Update if it mentions task creation flows
- `packages/dashboard/README.md` — Update dashboard-specific docs

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Subtask breakdown modal opens when user clicks subtask button
- [ ] AI generates meaningful subtask breakdowns
- [ ] User can edit all subtask fields (title, description, size, dependencies)
- [ ] Creating tasks creates all subtasks with correct dependencies
- [ ] Documentation updated with changeset

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-247): complete Step N — description`
- **Bug fixes:** `fix(KB-247): description`
- **Tests:** `test(KB-247): description`

Example commits:
- `feat(KB-247): complete Step 1 — add backend subtask breakdown session management`
- `feat(KB-247): complete Step 2 — add API routes for subtask breakdown`
- `feat(KB-247): complete Step 3 — add SubtaskBreakdownModal component`
- `feat(KB-247): complete Step 4 — add frontend API client functions`
- `feat(KB-247): complete Step 5 — integrate with task creation flows`

## Do NOT

- Modify the existing planning mode feature (use as reference only)
- Remove the old `breakIntoSubtasks` field from types immediately (mark as deprecated)
- Change the triage agent's subtask handling (that still processes old breakIntoSubtasks flag)
- Skip test coverage for the new components
- Use any external libraries for drag-and-drop (use native HTML5 drag API or simple buttons)
- Modify files outside the File Scope without good reason

## Notes for Implementer

### AI Prompt Strategy

The subtask generation AI prompt should be similar to the triage agent's subtask breakdown section but focused purely on decomposition:

```
Analyze this task description and break it down into 2-5 smaller, independently executable subtasks.

For each subtask, provide:
1. Title (short, descriptive)
2. Description (what needs to be done, 1-2 sentences)
3. Size estimate (S: <2h, M: 2-4h, L: 4-8h)
4. Dependencies (which other subtasks must be completed first)

Guidelines:
- Each subtask should be completable on its own
- Order subtasks by dependency (dependencies first)
- Keep total work reasonable (sum of subtasks should match original scope)
- Use dependencies sparingly — parallel work is preferred

Return ONLY valid JSON in this format:
{
  "subtasks": [
    {
      "id": "subtask-1",
      "title": "...",
      "description": "...",
      "suggestedSize": "S|M|L",
      "dependsOn": []
    }
  ]
}
```

### Dependency Resolution

When creating tasks from the breakdown:
1. Create tasks in the order shown in the UI
2. Track a mapping of `tempId` → `actualTaskId`
3. After creating a task, resolve its `dependsOn` array using the mapping
4. Update the created task with the resolved dependency IDs

### Session Management

Follow the same pattern as planning mode:
- Sessions stored in memory with TTL cleanup
- SSE for real-time updates during generation
- Sessions can be cancelled to free resources
- No persistence needed (ephemeral)

### UI/UX Considerations

- Show clear dependency visualization (even just a simple list like "Depends on: Subtask 1, Subtask 2")
- Allow reordering (drag-drop or up/down buttons) since order matters for dependencies
- Validate that dependencies don't create cycles
- Highlight invalid states (empty titles, circular deps)
- Confirm before closing if user has made edits

### Related Tasks

- **KB-248** — Changes the UI from checkbox to buttons. Coordinate with that task or ensure this task includes the button trigger mechanism.
- The old `breakIntoSubtasks` flag in `TaskCreateInput` should be deprecated but kept for backward compatibility during transition.
```