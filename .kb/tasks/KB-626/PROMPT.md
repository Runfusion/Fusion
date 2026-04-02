# Task: KB-626 - Fix Mobile Scrolling in Model Dropdown Lists

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a CSS-only fix for a mobile viewport issue. No logic changes, no security implications, easily reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Fix the model dropdown (`.model-combobox-dropdown`) on mobile devices where users cannot scroll to the bottom of the model list. The dropdown currently has a fixed `max-height: 320px` that doesn't account for mobile viewport constraints, causing the dropdown to extend beyond the visible area and making bottom items inaccessible.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/styles.css` — Lines 5180-5335 contain the `.model-combobox-*` styles
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — The component using these styles

## File Scope

- `packages/dashboard/app/styles.css` — Add mobile media queries for `.model-combobox-dropdown`

## Steps

### Step 1: Add Mobile Responsive Styles for Model Dropdown

- [ ] Add `@media (max-width: 640px)` media query at the end of the model-combobox CSS section (around line 5330)
- [ ] Reduce `max-height` to `60vh` or `calc(100dvh - 200px)` to ensure dropdown fits within mobile viewport
- [ ] Ensure `width` adapts to mobile (use `calc(100vw - 32px)` or similar)
- [ ] Add `max-height: 70vh` for tablet-sized screens in `@media (max-width: 768px)`
- [ ] Verify the dropdown container uses `overflow-y: auto` (already present, confirm working)

**CSS changes to add:**
```css
/* Mobile responsive model dropdown */
@media (max-width: 768px) {
  .model-combobox-dropdown {
    max-height: 70vh;
    max-height: 70dvh; /* Use dynamic viewport height where supported */
  }
}

@media (max-width: 640px) {
  .model-combobox-dropdown {
    max-height: 60vh;
    max-height: 60dvh;
    /* Ensure dropdown doesn't overflow horizontally on small screens */
    left: 50%;
    transform: translateX(-50%);
    width: calc(100vw - 32px);
    min-width: unset;
  }
}
```

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` to verify no existing tests break
- [ ] Verify build passes: `pnpm build`
- [ ] Manually test the dropdown on mobile viewport (Chrome DevTools mobile emulation):
  - Open CustomModelDropdown in task creation modal
  - Verify dropdown stays within viewport bounds at 375px width (iPhone SE)
  - Verify dropdown stays within viewport bounds at 768px width (iPad)
  - Verify all model options remain accessible via scroll

### Step 3: Documentation & Delivery

- [ ] Update inline CSS comments to document the mobile responsive behavior
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:** None — CSS changes are self-documenting with proper comments

**Check If Affected:**
- `AGENTS.md` — No changes needed for this CSS-only fix

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Mobile dropdown fits within viewport at ≤640px and ≤768px breakpoints
- [ ] Dropdown remains scrollable to access all model options
- [ ] No visual regressions on desktop (>768px)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-626): complete Step N — description`
- **Bug fixes:** `fix(KB-626): description`
- **Tests:** `test(KB-626): description`

## Do NOT

- Expand task scope beyond the mobile scrolling fix
- Modify the TypeScript/React component logic
- Skip the manual mobile viewport verification
- Change any styles that affect desktop behavior
