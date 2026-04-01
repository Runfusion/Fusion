# Task: FN-671 - Add Quick Add Disclosure for Board and List Views

**Created:** 2026-04-01
**Size:** S

## Review Level: 2 (Plan and Code)

**Assessment:** This is a UI enhancement with limited blast radius affecting only the QuickEntryBox component and its consumers. The pattern is straightforward (disclosure/collapsible pattern already exists in ListView), and changes are fully reversible.
**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 2

## Mission

Add a disclosure control (expand/collapse) to the QuickEntryBox component that allows users to show or hide the full set of quick add options (Deps, Models, Plan, Subtask, Refine, Save buttons). Currently, QuickEntryBox auto-expands on focus showing all controls. The new design should:

1. Always show the text input (compact mode)
2. Add a disclosure toggle (chevron/arrow button) to expand/collapse the full options panel
3. When collapsed: show only the input + disclosure toggle
4. When expanded: show input + all option buttons (Deps, Models, Plan, Subtask, Refine, Save)
5. Persist the expanded/collapsed state in localStorage
6. Apply to both Board view (triage column) and List view (above the table)

This addresses the related tasks KB-656 and KB-657 by giving users control over the quick add visibility.

## Dependencies

- **None**

## Context to Read First

Read these files to understand the current implementation:

1. `packages/dashboard/app/components/QuickEntryBox.tsx` — The component to modify. Note:
   - Uses `isExpanded` state for focus-based expansion
   - Has `showExpandedControls` boolean that gates the control buttons
   - Uses `localStorage` key `kb-quick-entry-text` for input persistence
   - Has buttons: Deps, Models, Plan, Subtask, Refine, Save

2. `packages/dashboard/app/components/Column.tsx` — Board view usage. Note:
   - QuickEntryBox is rendered in the triage column with `onQuickCreate`, `onPlanningMode`, `onSubtaskBreakdown`

3. `packages/dashboard/app/components/ListView.tsx` — List view usage. Note:
   - QuickEntryBox is rendered above the table in `list-quick-entry-above-table` div
   - Uses the same props as Column.tsx

4. `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing test patterns

5. `packages/dashboard/app/styles.css` — Search for `quick-entry-*` classes. Note:
   - `.quick-entry-box` — container
   - `.quick-entry-input` / `.quick-entry-input--expanded` — textarea
   - `.quick-entry-controls` — buttons container
   - `.list-quick-entry-above-table` — list view container

## File Scope

**Modify:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` — Add disclosure toggle and state management
- `packages/dashboard/app/styles.css` — Add styles for disclosure toggle and collapsed/expanded states

**Update Tests:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Add tests for disclosure behavior

## Steps

### Step 1: Add Disclosure State and Toggle to QuickEntryBox

- [ ] Add new localStorage key `kb-quick-entry-expanded` to persist disclosure state
- [ ] Add `isDisclosureExpanded` state initialized from localStorage (default: true for backward compatibility)
- [ ] Add `ChevronDown`/`ChevronUp` or `ChevronRight`/`ChevronDown` icons to imports from lucide-react
- [ ] Add disclosure toggle button with appropriate aria attributes (`aria-expanded`, `aria-label`)
- [ ] Modify `showExpandedControls` logic to use `isDisclosureExpanded` instead of `isExpanded` for showing/hiding the full controls panel
- [ ] Keep `isExpanded` for textarea height/focus styling only
- [ ] Persist `isDisclosureExpanded` to localStorage when toggled
- [ ] Position disclosure toggle button at the right side of the input area

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Add CSS Styles for Disclosure Pattern

- [ ] Add `.quick-entry-disclosure-toggle` class for the toggle button
  - Position: absolute right side of input container or flex item
  - Style: icon button, subtle, matches dashboard aesthetic
  - States: default, hover, focus-visible
- [ ] Add `.quick-entry-input-container` wrapper if needed for positioning
- [ ] Update `.quick-entry-controls` to animate height/opacity when expanding/collapsing (optional polish)
- [ ] Ensure collapsed state maintains compact layout without breaking surrounding UI
- [ ] Ensure expanded state doesn't overflow in list view container
- [ ] Test responsive behavior at various widths

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Integration Testing and Verification

- [ ] Test in Board view (triage column):
  - Disclosure toggle works
  - State persists across page reloads
  - Creating a task resets to appropriate state (keep expanded/collapsed based on preference)
  - All buttons (Deps, Models, Plan, Subtask, Refine, Save) work when expanded
- [ ] Test in List view (above table):
  - Same behavior as board view
  - Layout doesn't break table positioning
- [ ] Test keyboard navigation:
  - Tab focuses disclosure toggle
  - Enter/Space toggles disclosure
  - Escape still clears/closes as before
- [ ] Run existing QuickEntryBox tests to ensure no regressions

**Artifacts:**
- Manual verification complete

### Step 4: Add Unit Tests for Disclosure Behavior

- [ ] Test that disclosure state persists to localStorage
- [ ] Test that disclosure toggle button appears
- [ ] Test that clicking toggle expands/collapses controls
- [ ] Test that `aria-expanded` updates correctly
- [ ] Test that initial state reads from localStorage (default true)
- [ ] Test that creating a task preserves disclosure preference

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all QuickEntryBox tests: `pnpm test packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx`
- [ ] Run full dashboard test suite: `pnpm test packages/dashboard`
- [ ] Build passes: `pnpm build`

### Step 6: Documentation & Delivery

- [ ] Update relevant documentation (none required — UI change is self-documenting)
- [ ] Out-of-scope findings: Create follow-up tasks if any

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Disclosure toggle works in both Board and List views
- [ ] State persists across page reloads via localStorage
- [ ] No visual regressions in existing functionality
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-671): complete Step N — description`
- **Bug fixes:** `fix(FN-671): description`
- **Tests:** `test(FN-671): description`

Example commits:
```
feat(FN-671): complete Step 1 — add disclosure state and toggle to QuickEntryBox
feat(FN-671): complete Step 2 — add CSS styles for disclosure pattern
test(FN-671): add unit tests for disclosure behavior
```

## Do NOT

- Change the behavior of InlineCreateCard (that's a separate component used elsewhere)
- Remove the auto-focus behavior completely (just gate the full controls behind disclosure)
- Use global state or context (keep it component-local with localStorage)
- Change the API of QuickEntryBox (keep all existing props working)
- Skip testing the localStorage persistence behavior
