# Task: KB-188 - Move usage icon near search and terminal to overflow on mobile

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a focused UI layout change affecting only the Header component. The scope is limited to reordering buttons and adjusting mobile conditional rendering. No new patterns or security implications.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Reorganize the dashboard header button layout on mobile to improve UX: move the usage icon inline near search (where it's more discoverable) and move the terminal button into the overflow menu (where less-used actions belong). On desktop, the usage button should remain immediately after the search input.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/Header.tsx` — The header component with current button layout and mobile conditional rendering
- `packages/dashboard/app/components/Header.test.tsx` — Existing tests that verify button rendering and mobile behavior
- `packages/dashboard/app/styles.css` — Header action styles and mobile overflow menu styling (lines 112-175, 2485-2530)

## File Scope

- `packages/dashboard/app/components/Header.tsx` (modify)
- `packages/dashboard/app/components/Header.test.tsx` (modify — update test expectations for mobile button visibility)

## Steps

### Step 1: Reorganize Header Button Layout

Reorder buttons in Header.tsx to achieve:

**Desktop layout (unchanged functionality, verify order):**
1. View toggle
2. Search input
3. **Usage button** (immediately after search)
4. GitHub import
5. Planning
6. Terminal
7. Pause/Stop controls
8. Settings

**Mobile inline layout:**
1. View toggle
2. Mobile search trigger/expanded
3. **Usage button** (moved from overflow to inline, conditionally rendered with `onOpenUsage`)
4. Pause/Stop controls
5. Overflow trigger

**Mobile overflow menu:**
1. **Terminal** (moved from inline to overflow)
2. GitHub import
3. Planning
4. Settings

Specific changes needed:
- [ ] Move usage button to render unconditionally (remove `!isMobile` condition), keeping the `onOpenUsage` guard
- [ ] Move terminal button to only render when `!isMobile`
- [ ] Add terminal button to mobile overflow menu (before GitHub import, using same pattern as other overflow items)
- [ ] Ensure overflow menu on mobile no longer includes usage button (remove it from the overflow menu)

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Update Tests

Update Header.test.tsx to reflect the new mobile button layout:

- [ ] Update "usage button" tests to verify usage button renders on both mobile and desktop when `onOpenUsage` is provided
- [ ] Update "terminal button" tests to verify terminal button does NOT render inline on mobile (use media query mock or check for visibility)
- [ ] Add test verifying terminal button appears in overflow menu on mobile (if testing overflow menu contents)
- [ ] Ensure all existing desktop tests continue to pass
- [ ] Run `pnpm test packages/dashboard` and fix any failures

**Artifacts:**
- `packages/dashboard/app/components/Header.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test packages/dashboard` — verify all Header tests pass
- [ ] Run `pnpm build` — ensure no TypeScript errors
- [ ] Manual visual verification (if possible): confirm usage icon appears next to search on mobile layout
- [ ] Manual visual verification: confirm terminal appears in overflow menu on mobile

### Step 4: Documentation & Delivery

- [ ] Create changeset file for this UI improvement (patch level: minor UX enhancement)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool (if any)

## Documentation Requirements

**Must Update:**
- None (no user-facing docs for this layout change)

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test packages/dashboard`)
- [ ] Build passes (`pnpm build`)
- [ ] Usage button renders inline on mobile (next to search)
- [ ] Terminal button renders in overflow menu on mobile (not inline)
- [ ] Desktop layout unchanged (usage after search, terminal before pause controls)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-188): complete Step N — description`
- **Bug fixes:** `fix(KB-188): description`
- **Tests:** `test(KB-188): description`

## Do NOT

- Expand task scope beyond header layout changes
- Modify styles in styles.css (existing mobile overflow styles are sufficient)
- Change button functionality or event handlers
- Skip test updates for the changed behavior
- Modify other components or files outside the File Scope
