# Task: KB-189 - Prevent Mobile Zoom on Quick Task Entry Inputs

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Pure CSS change to prevent mobile browser zoom behavior. No logic changes, no security implications, easily reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Prevent iOS Safari and mobile Chrome from zooming in when users tap on quick task entry input fields in the dashboard. Mobile browsers auto-zoom when input font sizes are smaller than 16px. The dashboard already has this fix applied to `.quick-entry-input` and `#new-task-description`, but the inline create card inputs (list view) and task card editing inputs still use 13px font size, causing unwanted zoom behavior.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/styles.css` — Lines 2423-2450 contain the existing mobile media query that fixes zoom for `.quick-entry-input` and `#new-task-description`
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Uses `.inline-create-input` class for the inline task creation textarea (list view)
- `packages/dashboard/app/components/TaskCard.tsx` — Uses `.card-edit-title-input` and `.card-edit-desc-textarea` classes when editing task cards inline
- `packages/dashboard/app/index.html` — Already has proper viewport meta tag: `width=device-width, initial-scale=1.0`

## File Scope

- `packages/dashboard/app/styles.css` — Modify existing mobile media query (max-width: 768px)

## Steps

### Step 1: Extend Mobile Font Size Fix to All Quick Entry Inputs

- [ ] Locate the existing mobile media query at line 2423 (`@media (max-width: 768px)`)
- [ ] Extend the font-size: 16px rule to include `.inline-create-input`, `.card-edit-title-input`, and `.card-edit-desc-textarea`
- [ ] Ensure the CSS selector list remains readable (one selector per line)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

**Change to make:**
```css
/* Mobile task-entry font sizing: prevent Safari zoom-on-focus by ensuring
   task entry inputs are at least 16px on mobile viewports */
.quick-entry-input,
#new-task-description,
.inline-create-input,
.card-edit-title-input,
.card-edit-desc-textarea {
  font-size: 16px;
}
```

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify all tests pass
- [ ] Build passes: `pnpm build`

### Step 3: Documentation & Delivery

- [ ] Create changeset file for the dashboard fix (patch level — UI improvement)
- [ ] Verify no documentation updates needed (CSS-only mobile UX fix)

## Documentation Requirements

**Must Update:**
- None — CSS-only mobile UX fix

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Mobile inputs no longer trigger browser zoom on focus (test by opening dashboard on mobile device or simulator, tapping quick entry inputs)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-189): complete Step N — description`
- **Bug fixes:** `fix(KB-189): description`
- **Tests:** `test(KB-189): description`

## Do NOT

- Add JavaScript-based workarounds (this is a CSS-only fix)
- Modify the viewport meta tag (already correctly configured)
- Use `user-scalable=no` (accessibility anti-pattern)
- Add device detection or UA sniffing
- Change font sizes on desktop (keep 13px there — only mobile needs 16px)
- Skip the test run even though this is a CSS-only change
