# Task: KB-158 - Fix spacing on the refresh button in usage indicator dropdown

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a simple UI spacing fix on a single button element. No blast radius, standard pattern, no security implications, fully reversible.
**Score:** 0/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 0

## Mission

Fix the spacing on the refresh button within the usage indicator dropdown modal. The refresh button (labeled "Refresh" with a `RefreshCw` icon) in the modal footer currently has incorrect or missing spacing between its icon and text label, or between the button and adjacent elements. Ensure the button follows the same spacing conventions as other buttons in the dashboard.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/UsageIndicator.tsx` — the component containing the refresh button
- `packages/dashboard/app/styles.css` — search for `.usage-actions`, `.modal-actions`, and `.btn` classes to understand current styling

## File Scope

- `packages/dashboard/app/styles.css` — modify `.usage-actions` or related button styles
- `packages/dashboard/app/components/UsageIndicator.tsx` — optional: adjust component structure if needed
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — update if test assertions are affected by DOM changes

## Steps

### Step 1: Diagnose Spacing Issue

- [ ] Open the usage indicator modal in the dashboard (or examine the code)
- [ ] Identify the specific spacing problem on the refresh button:
  - Check icon-to-text spacing within the button (icon is `RefreshCw` from lucide-react)
  - Check button-to-button spacing between Refresh and Close buttons
  - Check button-to-text spacing between Last updated text and Refresh button
- [ ] Compare with other modals (e.g., SettingsModal, NewTaskModal) to identify the expected pattern

### Step 2: Fix the Spacing

- [ ] Apply the appropriate fix in `packages/dashboard/app/styles.css`:
  - If icon-to-text spacing: add margin to the icon element within `.usage-actions .btn`
  - If button-to-button spacing: adjust `gap` in `.usage-actions` or add specific margin classes
  - If Last updated-to-Refresh spacing: adjust `.usage-last-updated` margin or padding
- [ ] Ensure the fix matches the visual pattern used in other modal footers
- [ ] Verify the fix works at both desktop and mobile breakpoints (`.usage-actions` has mobile styles at line ~7201)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in the dashboard package to ensure all tests pass
- [ ] If tests fail due to DOM changes, update `UsageIndicator.test.tsx` to match the new structure
- [ ] Verify no visual regressions in other modals using `modal-actions`
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Update any relevant inline comments if component structure changed
- [ ] Create changeset if user-facing UI change: `cat > .changeset/fix-refresh-spacing.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Fix spacing on refresh button in usage indicator dropdown
EOF`
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any)

## Documentation Requirements

**Must Update:**
- None required for this spacing fix

**Check If Affected:**
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — verify selectors still work if DOM structure changes

## Completion Criteria

- [ ] Spacing on refresh button is visually correct and consistent with dashboard patterns
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] No visual regressions in other modals

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-158): complete Step N — description`
- **Bug fixes:** `fix(KB-158): description`
- **Tests:** `test(KB-158): description`

## Do NOT

- Expand task scope beyond the refresh button spacing
- Skip tests or assume they pass without running
- Modify unrelated modal styles
- Change button functionality (only spacing)
- Skip mobile breakpoint verification
