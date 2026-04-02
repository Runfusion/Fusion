# Task: KB-014 - Add Spec Edit and AI Revision from Dashboard

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature enhances the dashboard to allow editing task specifications directly in the UI, and provides an AI-assisted revision flow that sends feedback to the triage agent for re-specification. It touches the dashboard UI, API routes, and requires coordination with the existing triage processor.

**Score:** 4/8 — Blast radius: 1 (dashboard-focused), Pattern novelty: 1 (follows existing patterns), Security: 1 (text content only), Reversibility: 1 (additive, can revert to original prompt)

## Mission

Add two capabilities to the web dashboard for managing task specifications:
1. **Manual Edit**: Allow users to directly edit the PROMPT.md content in a new "Spec" tab, saving changes back to the task file.
2. **AI Revision**: Allow users to provide feedback/comments requesting AI to revise the spec, which triggers the triage agent to re-specify the task with that feedback incorporated.

This gives users control over task specs without needing to manually edit files, and enables iterative refinement of AI-generated specifications through natural language feedback.

## Dependencies

- **None**

## Context to Read First

### Existing Implementation
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Current task detail view with tabs (definition, agent-log, steering)
- `packages/dashboard/app/api.ts` — API functions including `updateTask` which already supports updating `prompt`
- `packages/core/src/store.ts` — `updateTask` method handles prompt updates via `writeFile(join(dir, "PROMPT.md"), updates.prompt)`
- `packages/engine/src/triage.ts` — `TriageProcessor` with `specifyTask` method that generates specs; includes `review_spec` tool with REVISE/RETHINK flow
- `packages/dashboard/src/routes.ts` — Existing PATCH `/tasks/:id` route already handles prompt updates

### Patterns to Follow
- Tab UI pattern in TaskDetailModal (definition/agent-log/steering tabs)
- API pattern in api.ts (async functions calling `/api/*` endpoints)
- Modal/overlay pattern with Escape key handling
- Toast notifications via `addToast` callback

## File Scope

### Modified
- `packages/dashboard/app/components/TaskDetailModal.tsx` — Add new "Spec" tab with edit UI
- `packages/dashboard/app/api.ts` — Add `requestSpecRevision` API function
- `packages/dashboard/src/routes.ts` — Add POST `/tasks/:id/spec/revise` endpoint
- `packages/dashboard/src/routes.test.ts` — Add tests for new endpoint
- `packages/core/src/store.ts` — Add method to trigger triage re-specification (or update log entry)

### New
- `packages/dashboard/app/components/SpecEditor.tsx` — New component for editing/viewing spec content
- `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` — Tests for spec editor

## Steps

### Step 1: Add SpecEditor Component

Create a reusable component for viewing and editing task specifications.

- [ ] Create `packages/dashboard/app/components/SpecEditor.tsx`
  - Props interface: `{ content: string; readOnly?: boolean; onSave?: (content: string) => Promise<void>; onRequestRevision?: (feedback: string) => Promise<void>; isSaving?: boolean; isRequesting?: boolean; }`
  - Display modes:
    - View mode: Render markdown using ReactMarkdown with remarkGfm (like current Definition tab)
    - Edit mode: Textarea with monospace font for editing raw PROMPT.md content
  - Include toggle button to switch between View/Edit modes
  - Save button (disabled when not in edit mode or content unchanged)
  - "Ask AI to Revise" section with textarea for feedback and submit button
  - Keyboard shortcut: Ctrl/Cmd+Enter to save when in edit mode (prevent default to avoid form submission conflicts)
- [ ] Create `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx`
  - Test view mode renders markdown content
  - Test edit mode shows textarea with raw content
  - Test toggle between modes
  - Test save callback fires with new content
  - Test revision request callback fires with feedback text
  - Test keyboard shortcut triggers save
  - Test loading states disable buttons

**Artifacts:**
- `packages/dashboard/app/components/SpecEditor.tsx` (new)
- `packages/dashboard/app/components/__tests__/SpecEditor.test.tsx` (new)

### Step 2: Add Spec Revision API

Add backend support for requesting AI revision of a task spec.

- [ ] Add `requestSpecRevision` function to `packages/dashboard/app/api.ts`
  - Signature: `(id: string, feedback: string) => Promise<Task>`
  - Calls POST `/api/tasks/${id}/spec/revise`
  - Body: `{ feedback: string }`
- [ ] Add POST `/tasks/:id/spec/revise` route in `packages/dashboard/src/routes.ts`
  - Body validation: `feedback` string required, max 2000 characters
  - Call `store.logEntry(task.id, "AI spec revision requested", feedback)` to record the request
  - Move task to "triage" column if not already there (so TriageProcessor picks it up)
  - Clear any existing spec status (set status to "needs-respecify" or similar)
  - Return updated Task
  - Error handling: 404 if task not found, 400 if feedback missing/invalid
- [ ] Add tests in `packages/dashboard/src/routes.test.ts`
  - Test successful revision request logs entry and moves task to triage
  - Test error on missing feedback
  - Test 404 on non-existent task
  - Test idempotent behavior (multiple requests queue multiple log entries)

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified)

### Step 3: Enhance TriageProcessor for Re-Specification

Modify the triage processor to handle re-specification of existing tasks with user feedback.

- [ ] Modify `packages/engine/src/triage.ts` `TriageProcessor.specifyTask()`
  - Check if task has a "needs-respecify" status or steering comments requesting spec changes
  - When re-specifying (task already has prompt content):
    - Read existing PROMPT.md content and include it in the agent prompt
    - Include any feedback from the revision request log entry
    - Add instruction to the agent: "Revise this existing specification based on the feedback below. Keep the structure but improve the content."
  - After successful re-specification, move task to "todo" column (standard triage flow)
  - Log entry: "Spec revised by AI" or "Spec revision completed"
- [ ] Update `buildSpecificationPrompt` in `packages/engine/src/triage.ts` to support re-specification mode
  - Add optional `existingPrompt` parameter
  - Add optional `feedback` parameter
  - When these are present, modify the prompt to ask for revision rather than creation
- [ ] Add unit tests in `packages/engine/src/triage.test.ts` (if it exists) or verify in integration tests
  - Test that tasks with revision requests are picked up by poll()
  - Test that re-specification includes existing prompt and feedback
  - Test that task moves to "todo" column after re-specification (standard triage flow)

**Artifacts:**
- `packages/engine/src/triage.ts` (modified)

### Step 4: Integrate Spec Tab in TaskDetailModal

Add the new Spec tab to the task detail view with full edit and revision capabilities.

- [ ] Modify `packages/dashboard/app/components/TaskDetailModal.tsx`
  - Add new tab "Spec" alongside existing "Definition", "Agent Log", "Steering" tabs
  - Import `SpecEditor` component
  - Add state: `specContent` (string), `isEditingSpec` (boolean), `isSavingSpec` (boolean), `isRequestingRevision` (boolean)
  - Fetch full task detail (which includes `prompt`) when tab becomes active
  - Render `SpecEditor` in the Spec tab with:
    - `content={task.prompt || ""}`
    - `onSave` handler that calls `updateTask(task.id, { prompt: newContent })`
    - `onRequestRevision` handler that calls `requestSpecRevision(task.id, feedback)`
    - Loading states wired to `isSavingSpec` and `isRequestingRevision`
  - After successful save: show toast "Spec updated", refresh task data
  - After successful revision request: show toast "AI revision requested", task moves to triage
  - Handle errors with toast notifications
- [ ] Update `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx`
  - Test Spec tab renders SpecEditor component
  - Test save flow updates task and shows success toast
  - Test revision request flow calls API and shows success toast
  - Test error handling shows error toast

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Build all packages: `pnpm build`
- [ ] All tests must pass
- [ ] Manual verification:
  - Open a task in dashboard, click "Spec" tab
  - View existing spec content rendered as markdown
  - Click "Edit", modify content, save — verify file updated on disk
  - Click "Ask AI to Revise", enter feedback, submit — verify task moves to triage
  - Wait for triage processor to re-specify — verify task moves to "todo" with updated spec
  - Test error handling: try to save with empty content, verify error toast

**Artifacts:**
- All test files with passing tests
- No TypeScript errors
- Successful build

### Step 6: Documentation & Delivery

- [ ] Update README.md Dashboard section:
  - Document new "Spec" tab in task detail view
  - Describe manual edit capability
  - Describe "Ask AI to Revise" feature
- [ ] Update AGENTS.md if needed (agent behavior changes)
- [ ] Create changeset file:
  ```bash
  cat > .changeset/add-spec-edit-revision-dashboard.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add spec editing and AI revision from dashboard. New "Spec" tab in task detail view allows manual editing of PROMPT.md and requesting AI revisions with natural language feedback.
  EOF
  ```
- [ ] Create follow-up tasks via `task_create` if needed:
  - Diff view showing changes between spec versions
  - Version history for task specs
  - Approval workflow before applying AI revisions

**Artifacts:**
- `README.md` (modified)
- `.changeset/add-spec-edit-revision-dashboard.md` (new)

## Documentation Requirements

**Must Update:**
- `README.md` — Add documentation for the new Spec tab features

**Check If Affected:**
- `AGENTS.md` — Document any agent behavior changes for re-specification

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Typecheck clean (`pnpm typecheck`)
- [ ] Build successful (`pnpm build`)
- [ ] Manual verification complete:
  - View spec in dashboard works
  - Edit spec saves changes
  - Request AI revision triggers re-specification
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-014): complete Step N — description`
- **Bug fixes:** `fix(KB-014): description`
- **Tests:** `test(KB-014): description`

## Do NOT

- Modify the core task structure (task.json schema remains unchanged)
- Add new database/storage mechanisms (use existing file-based storage)
- Change how triage specifies new tasks (only enhance for re-specification)
- Skip error handling in API endpoints
- Allow empty spec content (validate on save)
- Skip tests for edge cases (empty feedback, network errors, etc.)
