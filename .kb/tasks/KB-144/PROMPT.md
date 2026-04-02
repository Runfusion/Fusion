# Task: KB-144 - Prevent mobile zoom on planning mode text inputs

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a localized dashboard CSS fix with very low blast radius. The fix targets specific planning mode text inputs and prevents mobile browser zoom without affecting desktop styling or behavior.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

On mobile Safari and other mobile browsers, focusing on text inputs with font sizes below 16px causes the viewport to zoom in automatically. This is particularly problematic in the Planning Mode modal where users need to type their initial plan, answer text-based questions, and edit the final task summary. Update the dashboard CSS so all planning mode text inputs (initial plan textarea, question response textareas, and summary form fields) render at least 16px font size on mobile, preventing browser zoom-on-focus while preserving existing desktop typography and modal behavior.

## Dependencies

- **None**

**Note:** KB-131 addresses the same mobile zoom issue for the quick entry box and New Task modal, but it is not a blocker for this task. The fix in KB-144 can be implemented independently using the same pattern (set font-size: 16px within a mobile media query).

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — the planning mode component with three views containing text inputs:
  - Initial view: `initialPlan` textarea (`#initial-plan`, `.planning-textarea`)
  - Question view: text answer textarea (`.planning-textarea`)
  - Summary view: title input (`#summary-title`) and description textarea (`.planning-textarea`)
- `packages/dashboard/app/styles.css` — find the `.planning-textarea` styles (around line 6124) and the mobile responsive section for planning modal (around line 6617)
- `packages/dashboard/README.md` — documentation to update

## File Scope

- `packages/dashboard/app/styles.css` — add mobile-only font-size override for planning mode inputs
- `packages/dashboard/app/__tests__/mobile-planning-input-font-size.test.ts` — new regression test for the CSS contract
- `packages/dashboard/README.md` — document the mobile-safe planning mode behavior

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] No blocking dependencies

### Step 1: Implement mobile-safe planning input sizing

- [ ] Add a mobile-only CSS rule in `packages/dashboard/app/styles.css` within the existing `@media (max-width: 768px)` section for `.planning-modal` that sets `font-size: 16px` on:
  - `.planning-textarea` elements (covers initial plan, question responses, and summary description)
  - `#summary-title` input in the summary view
- [ ] Ensure desktop font sizes remain unchanged (14px for textareas as defined in the base `.planning-textarea` rule)
- [ ] Ensure the CSS selector specificity is sufficient to override existing rules without breaking other styling
- [ ] Add automated regression coverage in `packages/dashboard/app/__tests__/mobile-planning-input-font-size.test.ts` that:
  - Reads `styles.css` and verifies a mobile media query exists with planning input font-size >= 16px
  - Tests the CSS selector targets the expected elements
- [ ] Run targeted tests for changed files with `pnpm --filter @kb/dashboard test -- app/__tests__/mobile-planning-input-font-size.test.ts`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)
- `packages/dashboard/app/__tests__/mobile-planning-input-font-size.test.ts` (new)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite with `pnpm test`
- [ ] Fix all failures
- [ ] Build passes with `pnpm build`
- [ ] Manually verify the planning modal inputs on mobile viewport (use browser dev tools mobile mode) to confirm:
  - Initial plan textarea shows 16px font and doesn't zoom on focus
  - Question text response textarea shows 16px font and doesn't zoom on focus
  - Summary title input shows 16px font and doesn't zoom on focus
  - Summary description textarea shows 16px font and doesn't zoom on focus

### Step 3: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` with a short note that planning mode text inputs are sized to avoid browser zoom-on-focus on mobile devices
- [ ] Confirm no changeset is needed because this task is confined to the private `@kb/dashboard` package
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — document the mobile-safe planning mode input behavior so future UI work does not regress it

**Check If Affected:**
- `README.md` — update only if the top-level dashboard feature summary should mention improved mobile planning mode behavior

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Planning mode text inputs do not trigger zoom on mobile Safari/iOS

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-144): complete Step N — description`
- **Bug fixes:** `fix(KB-144): description`
- **Tests:** `test(KB-144): description`

## Do NOT

- Disable pinch zoom or change the viewport meta tag with `maximum-scale=1` / `user-scalable=no` to mask the problem
- Globally raise all dashboard text inputs to 16px — keep the fix scoped to planning mode
- Modify the PlanningModeModal component logic or TypeScript code (this is a CSS-only fix)
- Skip tests
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
