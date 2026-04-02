# Task: KB-192 - Move Progress Bars to Top of Definition Tab

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a straightforward UI layout change with no blast radius outside a single component. Pattern is standard React reordering with well-defined CSS classes.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Move the step progress bar section from the bottom of the Definition tab to the top, positioning it immediately after the tab navigation and before the task prompt content. This improves visibility of task progress when users first open a task's definition.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskDetailModal.tsx` — Main component containing the Definition tab layout
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` — Tests for the modal, including step progress tests

## File Scope

- `packages/dashboard/app/components/TaskDetailModal.tsx` (modify)
- `packages/dashboard/app/components/__tests__/TaskDetailModal.test.tsx` (verify existing tests still pass)

## Steps

### Step 1: Relocate Progress Section in Definition Tab

- [ ] Move the `detail-step-progress` section from its current position (after dependencies, ~line 887) to the top of the Definition tab content (after the tab buttons, ~line 421)
- [ ] The progress section should appear as the first content element when the "Definition" tab is active
- [ ] Maintain all existing props, styling, and conditional rendering logic
- [ ] Preserve the `step-progress-wrapper`, `step-progress-bar`, and `step-progress-label` structure

**Current location:** After dependencies section (~line 887)
**New location:** After tab navigation, before the markdown prompt section (~line 421, inside the `activeTab === "definition"` block)

**Artifacts:**
- `packages/dashboard/app/components/TaskDetailModal.tsx` (modified — section reordered)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the TaskDetailModal test suite: `pnpm --filter @kb/dashboard test -- TaskDetailModal`
- [ ] All existing tests must pass, including:
  - `step progress` test group (renders step progress section, segments have correct status/classes, displays correct completion count)
  - Tab switching tests (progress only renders in Definition tab)
- [ ] Verify visually (if running dashboard) that progress bar appears at top of Definition tab
- [ ] Verify progress bar still appears correctly for tasks with and without steps
- [ ] Build passes: `pnpm build`

**Artifacts:**
- Test output showing all passing tests

### Step 3: Documentation & Delivery

- [ ] No documentation updates required (UI change only, no behavior change)
- [ ] Create changeset for patch release:
  ```bash
  cat > .changeset/move-progress-bar-top.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Move progress bars to top of task definition tab for better visibility
  EOF
  ```

**Artifacts:**
- `.changeset/move-progress-bar-top.md` (new)

## Completion Criteria

- [ ] Progress section relocated to top of Definition tab content
- [ ] All TaskDetailModal tests passing
- [ ] Full test suite passes
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-192): complete Step N — description`
- **Bug fixes:** `fix(KB-192): description`
- **Tests:** `test(KB-192): description`

## Do NOT

- Change the visual styling of the progress bar (keep CSS classes identical)
- Modify the step progress data structure or logic
- Skip tests
- Add new features or functionality beyond the layout change
- Modify other tabs (Activity, Agent Log, Steering, Model, Spec, Files)
