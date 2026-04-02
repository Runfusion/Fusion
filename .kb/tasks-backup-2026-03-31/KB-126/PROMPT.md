# Task: KB-126 - Make New Task Modal Scrollable

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a straightforward CSS fix to add scrolling to an existing modal. Low blast radius, no pattern novelty, no security implications, fully reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

The New Task Modal in the dashboard has grown to contain many form fields (title, description, dependencies, model selection for executor/validator, planning mode toggle, and attachments). On smaller viewports or when the model dropdowns expand, the modal content extends beyond the visible area and cannot be scrolled. Add `overflow-y: auto` to the modal body so users can access all form fields regardless of viewport size.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/NewTaskModal.tsx` — The modal component structure
- `packages/dashboard/app/styles.css` — Current modal styling (search for `.new-task-modal` and `.modal-body`)

## File Scope

- `packages/dashboard/app/styles.css` — Add scroll behavior to new task modal body
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — Add test for scrollable behavior

## Steps

### Step 1: Add Scroll CSS

- [ ] Add `overflow-y: auto` to `.new-task-modal .modal-body` in styles.css
- [ ] Verify the modal body scrolls when content exceeds available height (max-height is inherited from `.modal` at 80vh)
- [ ] Run existing NewTaskModal tests to ensure no regressions: `cd packages/dashboard && pnpm test -- --run NewTaskModal`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Add Scroll Behavior Test

- [ ] Add a test that verifies the modal body has the correct CSS class for scrolling
- [ ] Test should query the modal body element and verify `overflow-y: auto` is applied via computed styles or class presence
- [ ] Run the new test to ensure it passes

**Artifacts:**
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (UI fix only)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if discovered

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Modal body scrolls when content exceeds viewport height
- [ ] Modal header and action buttons remain fixed (sticky) while content scrolls

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-126): complete Step N — description`
- **Bug fixes:** `fix(KB-126): description`
- **Tests:** `test(KB-126): description`

## Do NOT

- Expand task scope beyond scrolling fix
- Modify the NewTaskModal.tsx component structure (CSS-only change)
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
