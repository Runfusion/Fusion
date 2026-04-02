# Task: KB-131 - Prevent mobile zoom on dashboard task-entry inputs

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized dashboard UI/CSS fix with low blast radius and no security implications. The main risk is accidentally changing typography for unrelated controls, so the work should stay tightly scoped to task-entry inputs and backed by regression tests.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Mobile browsers currently zoom the page when users focus dashboard task-entry controls because the rendered font size is below the iOS Safari no-zoom threshold. Update the dashboard so the quick entry box and the New Task modal’s title/description fields can be focused on mobile without viewport jumps, while preserving existing desktop styling, task-creation behavior, and accessibility.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — quick-create input rendered at the top of the Triage column
- `packages/dashboard/app/components/NewTaskModal.tsx` — title and description controls for modal task creation
- `packages/dashboard/app/styles.css` — shared form styles, quick-entry styling, and mobile `@media (max-width: 768px)` overrides
- `packages/dashboard/app/index.html` — current viewport meta tag; read this so you avoid solving the problem by disabling zoom globally
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — current quick-entry behavior coverage
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` — current modal task-creation coverage
- `packages/dashboard/app/__tests__/mobile-scroll-snap.test.ts` — example pattern for stylesheet-level regression tests that read `styles.css` directly
- `packages/dashboard/README.md` — dashboard feature documentation to update after the fix
- `AGENTS.md` — changeset policy and required root test/build commands

## File Scope

- `packages/dashboard/app/styles.css`
- `packages/dashboard/app/components/QuickEntryBox.tsx`
- `packages/dashboard/app/components/NewTaskModal.tsx`
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx`
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx`
- `packages/dashboard/app/__tests__/mobile-input-font-size.test.ts`
- `packages/dashboard/README.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Implement mobile-safe task-entry sizing

- [ ] Add a mobile-only styling contract in `packages/dashboard/app/styles.css` so `.quick-entry-input` plus the New Task modal’s title and description fields resolve to at least `16px` on mobile, preventing Safari focus zoom while preserving current desktop font sizes and focus styles
- [ ] Keep task-entry behavior unchanged in `QuickEntryBox` and `NewTaskModal` (submission, focus retention, validation, modal state, and placeholders must continue to behave exactly as they do now)
- [ ] Add automated regression coverage for the mobile CSS contract, using a stylesheet-level test in `packages/dashboard/app/__tests__/mobile-input-font-size.test.ts` and any targeted component assertions needed if you introduce new selector hooks/classes
- [ ] Run targeted tests for changed files with `pnpm --filter @kb/dashboard test -- app/__tests__/mobile-input-font-size.test.ts app/components/__tests__/QuickEntryBox.test.tsx app/components/__tests__/NewTaskModal.test.tsx`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified if selector hooks are needed)
- `packages/dashboard/app/components/NewTaskModal.tsx` (modified if selector hooks are needed)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified if needed)
- `packages/dashboard/app/components/__tests__/NewTaskModal.test.tsx` (modified if needed)
- `packages/dashboard/app/__tests__/mobile-input-font-size.test.ts` (new)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite with `pnpm test`
- [ ] Fix all failures
- [ ] Build passes with `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` with a short note that mobile task-entry fields (quick entry and New Task modal title/description inputs) are sized to avoid browser zoom-on-focus
- [ ] Confirm no changeset is needed because this task is confined to the private `@kb/dashboard` package
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — document the mobile-safe task-entry behavior so future UI work does not regress it

**Check If Affected:**
- `README.md` — update only if the top-level dashboard feature summary should mention improved mobile task-entry behavior

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-131): complete Step N — description`
- **Bug fixes:** `fix(KB-131): description`
- **Tests:** `test(KB-131): description`

## Do NOT

- Expand task scope into unrelated mobile layout work such as modal scrolling, header overflow, or board responsiveness already tracked elsewhere
- Disable pinch zoom or change the viewport meta tag with `maximum-scale=1` / `user-scalable=no` to mask the problem
- Globally raise all dashboard text inputs to `16px` unless they are part of the targeted task-entry flows in this task
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
