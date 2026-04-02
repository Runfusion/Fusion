# Task: KB-174 - Align Search and Board Switcher Center with Header Icons

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused CSS alignment fix with minimal blast radius. The changes are limited to header component styling and are easily reversible.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the vertical alignment of the search input and board switcher (view-toggle) so they are centered with the rest of the header icons. The current implementation has these elements sitting slightly off-center compared to the icon buttons (settings, terminal, pause controls), which is particularly noticeable on mobile viewports.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — Header component structure with view-toggle and search elements
- `packages/dashboard/app/styles.css` — Existing header styles, view-toggle styles (around line 192), header-search styles (around line 220), and mobile media queries (around line 2459)
- `packages/dashboard/app/components/Header.test.tsx` — Existing tests to ensure no regressions

## File Scope

- `packages/dashboard/app/styles.css` — Modify CSS rules for header alignment
- `packages/dashboard/app/components/Header.tsx` — Minor class adjustments if needed for alignment
- `packages/dashboard/app/components/Header.test.tsx` — Add visual regression assertions if applicable

## Steps

### Step 0: Preflight

- [ ] Required files exist: `packages/dashboard/app/components/Header.tsx`, `packages/dashboard/app/styles.css`
- [ ] No dependencies required
- [ ] Run existing Header tests to establish baseline: `pnpm test packages/dashboard/app/components/Header.test.tsx`

### Step 1: Analyze Current Alignment Issues

- [ ] Inspect `.header-actions` flex container alignment — check `align-items` property
- [ ] Inspect `.view-toggle` element — verify it lacks explicit vertical centering
- [ ] Inspect `.header-search` element — check its vertical alignment within flex container
- [ ] Inspect `.btn-icon` elements — document their vertical centering approach
- [ ] On mobile viewport (< 768px), verify `.mobile-search-expanded` absolute positioning doesn't break centering
- [ ] Document specific misalignment in pixels or alignment strategy differences

**Artifacts:**
- Alignment analysis notes (comments in code or brief markdown)

### Step 2: Implement Alignment Fixes

- [ ] Add `align-items: center` to `.view-toggle` if missing, or adjust existing alignment
- [ ] Ensure `.header-search` has consistent vertical centering with other header actions
- [ ] Fix mobile search expanded positioning — ensure it stays vertically centered when open
- [ ] Verify all header action elements share consistent height/vertical alignment
- [ ] Check that desktop search input (`min-width: 160px`) aligns with icon buttons
- [ ] Ensure view-toggle buttons (28x24px) align with icon buttons (16px icons with padding)

**Key alignment targets:**
- All elements in `.header-actions` should share the same vertical centerline
- The 16px Lucide icons in `.btn-icon` buttons should align with the 16px icons in `.view-toggle-btn`
- Mobile search expanded (`right: 140px`) should maintain vertical center with adjacent buttons

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run Header component tests: `pnpm test packages/dashboard/app/components/Header.test.tsx`
- [ ] Run full dashboard test suite: `pnpm test packages/dashboard`
- [ ] Fix any test failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (visual fix only)
- [ ] Verify no out-of-scope changes needed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Search input vertically centered with header icons on desktop and mobile
- [ ] Board switcher (view-toggle) vertically centered with header icons on desktop and mobile
- [ ] No visual regressions in header layout

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-174): complete Step N — description`
- **Bug fixes:** `fix(KB-174): description`
- **Tests:** `test(KB-174): description`

## Do NOT

- Expand task scope to redesign the entire header
- Skip tests
- Modify files outside the File Scope without good reason
- Change header functionality or behavior — only alignment/positioning
- Alter the mobile overflow menu behavior or positioning
- Affect the view-toggle active state styling or colors
- Commit without the task ID prefix
