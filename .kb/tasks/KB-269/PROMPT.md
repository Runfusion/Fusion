# Task: KB-269 - Add workflow step results viewer in dashboard show

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI-focused feature that adds a workflow step results viewer to the task detail modal. It follows existing dashboard patterns (tabs, API integration, component structure) and requires coordination with the workflow step data model from KB-218. Low blast radius as it's additive UI only.

**Score:** 4/8 — Blast radius: 1 (dashboard UI only), Pattern novelty: 1 (follows existing tab patterns), Security: 1 (reads existing task data), Reversibility: 1 (purely additive)

## Mission

Add a workflow step results viewer to the task detail modal so users can see what each quality gate found during execution. When a task has workflow steps enabled (from KB-218), users need visibility into:
- Which workflow steps ran
- Pass/fail status for each step
- The output/findings from each step
- When each step executed

This gives users transparency into the automated quality checks that run after task implementation but before review.

## Dependencies

- **Task:** KB-218 (Add Global Workflow Steps for Post-Implementation Review) — Must provide:
  - `WorkflowStepResult` type with fields: `workflowStepId`, `workflowStepName`, `status` ("passed" | "failed" | "skipped" | "pending"), `output`, `startedAt`, `completedAt`
  - `workflowStepResults?: WorkflowStepResult[]` field on `Task` and `TaskDetail` types
  - `enabledWorkflowSteps?: string[]` field on `Task` type (stores IDs of selected workflow steps)
  - API endpoint `GET /api/tasks/:id/workflow-results` or include results in existing task detail response
  - Store methods for saving workflow step results during execution

## Context to Read First

### Dashboard Component Patterns
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Existing tab structure (definition, activity, agent-log, steering, model), how to add a new tab
- `packages/dashboard/app/components/AgentLogViewer.tsx` — Component pattern for displaying execution output with status indicators
- `packages/dashboard/app/components/SteeringTab.tsx` — Simpler tab component pattern with data display

### API Patterns
- `packages/dashboard/app/api.ts` — Frontend API functions, error handling patterns
- `packages/dashboard/src/routes.ts` — Backend route patterns, task-related endpoints around line 300-500

### Type Patterns
- `packages/core/src/types.ts` — Task, TaskDetail, and related type definitions (see what KB-218 adds)

### Styling Patterns
- `packages/dashboard/public/styles.css` — Existing CSS classes for tabs, badges, status colors (success, error, warning, info)

## File Scope

### Dashboard UI
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified) — Add "Workflow" tab to tab bar, conditionally show based on task having workflow data
- `packages/dashboard/app/components/WorkflowResultsTab.tsx` (new) — Component displaying workflow step results list with pass/fail/output
- `packages/dashboard/app/components/WorkflowResultsTab.test.tsx` (new) — Tests for the workflow results viewer

### API Layer
- `packages/dashboard/app/api.ts` (modified) — Add `fetchWorkflowResults(taskId: string)` function
- `packages/dashboard/src/routes.ts` (modified) — Add `GET /api/tasks/:id/workflow-results` endpoint (if KB-218 hasn't added it)

### Types (if KB-218 hasn't defined them)
- `packages/core/src/types.ts` (modified) — Add `WorkflowStepResult` interface (only if not present from KB-218)

## Steps

### Step 1: Define Types and API Contract

Establish the data structures and API for workflow step results. Skip type definitions if KB-218 already added them.

- [ ] Verify KB-218 types are available (WorkflowStepResult, workflowStepResults on Task)
- [ ] If types missing from KB-218, add `WorkflowStepResult` interface to `packages/core/src/types.ts`:
  ```typescript
  export interface WorkflowStepResult {
    workflowStepId: string;
    workflowStepName: string;
    status: "passed" | "failed" | "skipped" | "pending";
    output?: string;
    startedAt?: string;
    completedAt?: string;
  }
  ```
- [ ] Add `workflowStepResults?: WorkflowStepResult[]` to `Task` type (if not present from KB-218)
- [ ] Add `enabledWorkflowSteps?: string[]` to `Task` type (if not present from KB-218)
- [ ] Add `fetchWorkflowResults(id: string): Promise<WorkflowStepResult[]>` to `packages/dashboard/app/api.ts`
- [ ] Add `GET /api/tasks/:id/workflow-results` endpoint to `packages/dashboard/src/routes.ts`:
  - Returns `WorkflowStepResult[]` for the task
  - 404 if task not found
  - Empty array if no workflow results yet

**Artifacts:**
- `packages/core/src/types.ts` (modified — if needed)
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)

### Step 2: Create WorkflowResultsTab Component

Build the UI component for displaying workflow step results.

- [ ] Create `packages/dashboard/app/components/WorkflowResultsTab.tsx`:
  - Props interface: `{ taskId: string; results: WorkflowStepResult[]; loading?: boolean }`
  - Render list of workflow step results
  - Each result shows:
    - Step name (bold)
    - Status badge with appropriate color:
      - "passed" → green (var(--color-success))
      - "failed" → red (var(--color-error))
      - "skipped" → gray (var(--text-dim))
      - "pending" → blue/yellow spinner or "Running..." indicator
    - Execution time (if completed): "Completed in Xs" or "Started at ..."
    - Output section (expandable or pre-expanded):
      - Show `output` field content in a `<pre>` or scrollable container
      - Handle empty/missing output gracefully
  - Empty state: "No workflow steps have run yet" (if enabledWorkflowSteps exists but no results)
  - No workflow steps state: "This task has no workflow steps enabled" (if no enabledWorkflowSteps)

- [ ] Style with CSS classes following existing patterns:
  - Use `.detail-section` for container
  - Use status color variables for badges
  - Follow typography patterns from other tabs

- [ ] Create `packages/dashboard/app/components/WorkflowResultsTab.test.tsx`:
  - Test renders list of results with correct status badges
  - Test shows output content for each result
  - Test handles empty results array
  - Test handles missing results prop
  - Test shows appropriate status colors
  - Test loading state

**Artifacts:**
- `packages/dashboard/app/components/WorkflowResultsTab.tsx` (new)
- `packages/dashboard/app/components/WorkflowResultsTab.test.tsx` (new)

### Step 3: Integrate into TaskDetailModal

Add the Workflow tab to the task detail modal.

- [ ] Modify `packages/dashboard/app/components/TaskDetailModal.tsx`:
  - Add "workflow" to `activeTab` union type: `| "workflow"`
  - Add tab button in the tab bar (between "model" and the closing div):
    ```tsx
    <button
      className={`detail-tab${activeTab === "workflow" ? " detail-tab-active" : ""}`}
      onClick={() => setActiveTab("workflow")}
    >
      Workflow
    </button>
    ```
  - Conditionally render tab only when task has workflow data:
    - Show if `task.enabledWorkflowSteps && task.enabledWorkflowSteps.length > 0`
    - Or show if `task.workflowStepResults && task.workflowStepResults.length > 0`
    - Hide tab entirely if no workflow steps ever enabled for this task
  - Add tab content rendering in the conditional chain:
    ```tsx
    {activeTab === "workflow" ? (
      <div className="detail-section">
        <WorkflowResultsTab
          taskId={task.id}
          results={task.workflowStepResults || []}
        />
      </div>
    ) : ...
    ```
  - Import `WorkflowResultsTab` at top of file

- [ ] Ensure proper handling when switching between tasks (tab state should persist or reset appropriately)

- [ ] Update `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (or create if missing):
  - Test Workflow tab appears when task has `enabledWorkflowSteps`
  - Test Workflow tab appears when task has `workflowStepResults`
  - Test Workflow tab hidden when no workflow data
  - Test clicking Workflow tab shows WorkflowResultsTab

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Run typecheck: `pnpm typecheck`  
- [ ] Build all packages: `pnpm build`
- [ ] All tests must pass
- [ ] Manual verification (if KB-218 complete):
  - Open task with workflow steps enabled
  - Verify Workflow tab appears
  - Verify results display correctly with status badges
  - Verify output content is visible
  - Test with passed, failed, and skipped statuses

**Artifacts:**
- All test files with passing tests
- No TypeScript errors
- Successful build

### Step 5: Documentation & Delivery

- [ ] Update `AGENTS.md` (if workflow section exists from KB-218):
  - Document that workflow step results appear in dashboard task detail
  - Explain what users will see (pass/fail status, output)

- [ ] Create changeset file (only if KB-218 hasn't created one covering this):
  ```bash
  cat > .changeset/workflow-results-viewer.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Add workflow step results viewer to task detail modal. Users can now see pass/fail status and output from each quality gate that ran on a task.
  EOF
  ```

**Artifacts:**
- `AGENTS.md` (modified — if needed)
- `.changeset/workflow-results-viewer.md` (new — if needed)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add note about workflow results visibility in dashboard (if workflow section exists)

**Check If Affected:**
- `README.md` — Update workflow steps feature section if it exists

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Typecheck clean (`pnpm typecheck`)
- [ ] Build successful (`pnpm build`)
- [ ] Workflow tab appears in task detail when task has workflow data
- [ ] WorkflowResultsTab displays step names, status badges, and output
- [ ] Tab hidden for tasks without workflow steps
- [ ] Documentation updated
- [ ] Changeset created (if not covered by KB-218)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-269): complete Step N — description`
- **Bug fixes:** `fix(KB-269): description`
- **Tests:** `test(KB-269): description`

## Do NOT

- Skip tests for the new component
- Modify workflow step execution logic (that's KB-218's scope)
- Create workflow step management UI (that's KB-218's scope)
- Show the Workflow tab for all tasks (only when workflow data exists)
- Skip handling empty/loading states gracefully
- Modify files outside the File Scope without explicit justification

## Implementation Notes

### Status Badge Colors
Use CSS variables from the theme:
- Passed: `var(--color-success, #3fb950)` (green)
- Failed: `var(--color-error, #f85149)` (red)
- Skipped: `var(--text-dim, #484f58)` (gray)
- Pending: `var(--todo, #58a6ff)` (blue) or use a spinner animation

### Output Display
- Use a `<pre>` element with `white-space: pre-wrap` for readable formatting
- Add `max-height` and `overflow-y: auto` for long outputs
- Use monospace font stack from existing CSS

### Conditional Tab Visibility
The Workflow tab should only appear when relevant:
```typescript
const hasWorkflowData = 
  (task.enabledWorkflowSteps && task.enabledWorkflowSteps.length > 0) ||
  (task.workflowStepResults && task.workflowStepResults.length > 0);
```

This ensures:
- Old tasks without workflow steps don't show an empty tab
- Tasks with workflow steps enabled show the tab even before execution
- Tasks with results show the tab to view historical results
