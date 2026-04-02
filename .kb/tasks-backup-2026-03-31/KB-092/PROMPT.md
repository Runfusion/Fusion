# Task: KB-092 - Improve Planning Mode Dialog Layout

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI layout fix with clear visual issues. The planning modal has CSS class mismatches (uses `planning-content` which doesn't exist), lacks proper scroll behavior, and has inconsistent spacing compared to other modals. Low blast radius, no security concerns.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Fix the layout issues in the Planning Mode dialog (PlanningModeModal) that currently "looks horrible" due to CSS class mismatches, poor scroll behavior, and inconsistent spacing. The modal should match the visual quality and usability of other modals like TaskDetailModal.

Key issues to address:
1. The component uses `className="modal-body planning-content"` but `.planning-content` CSS class doesn't exist
2. The modal body lacks proper flex/overflow handling causing content to be cut off or not scroll properly
3. Form spacing in the summary view is inconsistent with the design system
4. The dependency chips list needs better overflow handling
5. Overall visual polish to match the dashboard's design standards

## Dependencies

- **None**

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/PlanningModeModal.tsx` — The modal component that needs layout fixes
2. `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TaskDetailModal.tsx` — Reference modal with good layout patterns (note the `detail-body` class usage)
3. `/Users/eclipxe/Projects/kb/packages/dashboard/app/styles.css` — Review `.modal`, `.modal-body`, `.detail-body`, and `.planning-*` styles

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` (modify)
- `packages/dashboard/app/styles.css` (modify — planning-specific styles section)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (verify tests still pass)

## Steps

### Step 1: Fix CSS Class Mismatches and Structure

- [ ] Replace `className="modal-body planning-content"` with `className="planning-modal-body"` in PlanningModeModal.tsx
- [ ] Update the outer modal class from `className="modal modal-lg planning-modal"` to ensure consistent sizing (keep `planning-modal` for specific overrides)
- [ ] Ensure `.planning-modal-body` has proper flex and overflow properties:
  - `flex: 1`
  - `overflow-y: auto`
  - `min-height: 0` (for proper flex container behavior)
  - `display: flex; flex-direction: column` (to stack views properly)
- [ ] Verify `.planning-modal` CSS doesn't conflict with generic `.modal` styles
- [ ] Run dashboard tests: `cd packages/dashboard && pnpm test PlanningModeModal`

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 2: Improve Scroll Behavior and Content Flow

- [ ] Fix the summary view form layout — currently the form groups use `padding: 0 20px` from `.form-group` but this creates inconsistent horizontal spacing
- [ ] Add a wrapper div with consistent padding around the planning content instead of relying on `.form-group` padding
- [ ] Ensure each view state (initial, question, summary, loading) properly fills available space and scrolls when needed
- [ ] Fix the dependency list (`planning-deps-list`) to have proper max-height and scroll behavior within the form
- [ ] Add `flex-shrink: 0` to action buttons so they stay visible when content scrolls
- [ ] Test scroll behavior with long content in each view

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Polish Visual Design and Spacing

- [ ] Review and fix the initial view layout:
  - Center the content properly
  - Ensure the textarea has consistent width with the example chips below
  - Fix the character counter alignment
- [ ] Fix the question view:
  - Ensure progress bar is visually connected to content
  - Fix option spacing for radio/checkbox groups
  - Ensure the "Continue" button stays at bottom
- [ ] Fix the summary view:
  - Align title input, description textarea, and other form elements
  - Fix the size selector button layout (currently may wrap awkwardly)
  - Polish the dependency chips (better hover states, alignment)
  - Ensure the key deliverables list is properly styled
- [ ] Add consistent vertical rhythm (16px-24px gaps between major sections)
- [ ] Ensure all text colors use theme variables (no hardcoded colors)

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)
- `packages/dashboard/app/styles.css` (modified)

### Step 4: Responsive Layout Fixes

- [ ] Review mobile responsive styles in the `@media (max-width: 768px)` section
- [ ] Ensure the planning modal goes full-screen on mobile (like other modals)
- [ ] Fix the example chips layout on mobile — currently they may overflow or look cramped
- [ ] Ensure the dependency list is usable on mobile (touch-friendly chip sizes)
- [ ] Test the size selector buttons don't become too small on mobile

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified — mobile responsive section)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full dashboard test suite: `cd packages/dashboard && pnpm test`
- [ ] Verify all PlanningModeModal tests pass
- [ ] Build the dashboard: `cd packages/dashboard && pnpm build`
- [ ] Manual visual verification (if possible):
  - Open the planning modal
  - Test the initial view with example chips
  - Go through a question flow
  - Check the summary view with all elements
  - Verify scroll behavior with long content
  - Test on mobile viewport (if testing in browser)

### Step 6: Documentation & Delivery

- [ ] Update any inline comments in the component if layout structure changed significantly
- [ ] Create changeset for the layout fix: `cat > .changeset/fix-planning-modal-layout.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix Planning Mode dialog layout issues — improved scroll behavior, spacing, and responsive design.
EOF`
- [ ] Out-of-scope findings: If you discover deeper issues with the planning API or functionality (not just layout), create new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None required — this is a visual fix, not a feature change

**Check If Affected:**
- `packages/dashboard/README.md` — check if there's documentation about the planning feature that might need updates

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Layout matches dashboard design standards (consistent with other modals)
- [ ] No visual regressions in other modals
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-092): complete Step N — description`
- **Bug fixes:** `fix(KB-092): description`
- **Tests:** `test(KB-092): description`

Example commits:
- `feat(KB-092): complete Step 1 — fix CSS class mismatches and modal structure`
- `feat(KB-092): complete Step 2 — improve scroll behavior and content flow`
- `feat(KB-092): complete Step 3 — polish visual design and spacing`
- `feat(KB-092): complete Step 4 — responsive layout fixes`

## Do NOT

- Expand task scope to redesign the planning flow or change the planning API
- Skip the test verification step
- Modify the planning logic or question handling — this is strictly a layout/CSS fix
- Change the modal's behavior or add new features
- Break existing test assertions unless the test is checking for invalid layout behavior
- Use `!important` in CSS to override styles — use proper specificity instead
