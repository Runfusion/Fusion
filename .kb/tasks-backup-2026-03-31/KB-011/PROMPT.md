# Task: KB-011 - Make TaskDetailModal Dependencies Clickable Links

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** UI-only change making dependency IDs into clickable links within TaskDetailModal. No business logic changes, no API changes, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Convert the static dependency IDs displayed in TaskDetailModal into clickable links. When clicked, these links should fetch and display the dependency task's details, allowing users to navigate between related tasks directly from the dependency list.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/TaskDetailModal.tsx` — Current dependency list display (lines 384-413), renders `{dep}` as static text
2. `packages/dashboard/app/App.tsx` — How `handleDetailOpen` callback works for opening task details
3. `packages/dashboard/app/api.ts` — `fetchTaskDetail(id: string)` function for fetching full task details
4. `packages/dashboard/app/styles.css` — `.detail-dep-list` and `.detail-deps` styling (lines 1059-1080)

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — add clickable links, add onOpenDetail prop)
- `packages/dashboard/app/App.tsx` (modified — pass onOpenDetail prop to TaskDetailModal)
- `packages/dashboard/app/styles.css` (modified — add `.detail-dep-link` hover styles)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified — add tests for clickable dependencies)

## Steps

### Step 1: Add Navigation Prop and Click Handler to TaskDetailModal

- [ ] Add `onOpenDetail: (task: TaskDetail) => void` prop to `TaskDetailModalProps` interface (line 33)
- [ ] Import `fetchTaskDetail` from `../api` at the top of the file
- [ ] Create `handleDepClick` callback that:
  - Takes a dependency ID string
  - Calls `fetchTaskDetail(depId)` to get full TaskDetail
  - Calls `onOpenDetail(detail)` to open the dependency (this replaces the current task in the modal)
  - Catches errors and shows toast via `addToast`
- [ ] Add `onOpenDetail` to the destructured props in the component function signature (line 48)

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 2: Convert Dependency Text to Clickable Links

- [ ] Modify the dependency list rendering (around line 387-402): wrap each dependency ID in a clickable `<span>` or `<a>` element
- [ ] Add CSS class `detail-dep-link` to each dependency link
- [ ] Add `onClick={() => handleDepClick(dep)}` handler to each link
- [ ] Add `role="link"` and `tabIndex={0}` for accessibility
- [ ] Add keyboard handler for Enter key to support keyboard navigation
- [ ] Ensure the remove button (×) click doesn't trigger the link click (stopPropagation already handled, but verify)
- [ ] Maintain the existing remove button functionality unchanged

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified)

### Step 3: Update App.tsx to Pass Navigation Callback

- [ ] Add `onOpenDetail={handleDetailOpen}` prop to the `TaskDetailModal` component in App.tsx (around line 127)
- [ ] Verify the prop type matches - `handleDetailOpen` takes `TaskDetail` which matches our new prop signature

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 4: Add CSS Styling for Clickable Dependencies

- [ ] Add `.detail-dep-link` class to `styles.css` after the existing `.detail-dep-list li` styles:
  - `cursor: pointer`
  - `color: var(--todo)` (same as current, but ensure hover state)
  - `text-decoration: none`
  - `:hover` with `text-decoration: underline`
  - `:focus` with `outline: 1px solid var(--todo)` for accessibility
- [ ] Ensure the styling maintains the monospace font family from parent

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to ensure all existing tests pass
- [ ] Add tests to `TaskDetailModal.test.tsx`:
  - Test that dependencies are rendered as clickable elements with `role="link"`
  - Test that clicking a dependency calls `fetchTaskDetail` with the correct ID
  - Test that clicking a dependency calls `onOpenDetail` with the fetched task
  - Test error handling: when `fetchTaskDetail` fails, toast is shown and `onOpenDetail` is not called
  - Test that remove button still works independently (clicking × doesn't trigger navigation)
- [ ] Run `pnpm build` to ensure TypeScript compiles without errors
- [ ] Manual verification (run dev server):
  - Open a task with dependencies in detail view
  - Verify dependency IDs appear as links (hover shows underline)
  - Click a dependency → modal should show the dependency task details
  - Use keyboard (Tab + Enter) to navigate to and open a dependency

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (modified)

### Step 6: Documentation & Delivery

- [ ] Create changeset for the feature:
  ```bash
  cat > .changeset/clickable-detail-dependencies.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Dashboard: Task dependencies in detail view are now clickable links
  EOF
  ```

**Artifacts:**
- `.changeset/clickable-detail-dependencies.md` (new)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Dependencies in TaskDetailModal are clickable links with hover styling
- [ ] Clicking a dependency opens that task's details in the modal
- [ ] Error handling shows toast when dependency fetch fails
- [ ] Keyboard navigation works (Tab to focus, Enter to activate)
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step 1:** `feat(KB-011): add onOpenDetail prop and click handler to TaskDetailModal`
- **Step 2:** `feat(KB-011): convert dependency text to clickable links`
- **Step 3:** `feat(KB-011): wire onOpenDetail callback through App.tsx`
- **Step 4:** `feat(KB-011): add hover styles for dependency links`
- **Step 5:** `test(KB-011): add tests for clickable dependency navigation`
- **Step 6:** `docs(KB-011): add changeset for clickable detail dependencies`

## Do NOT

- Change how dependencies are stored or updated (add/remove functionality stays the same)
- Implement nested/recursive dependency tree visualization
- Add breadcrumb navigation or "back" button (simple replacement behavior)
- Modify the TaskCard component (out of scope - see KB-006)
- Change the API or task store behavior
- Skip accessibility (keyboard navigation required)
- Skip error handling
