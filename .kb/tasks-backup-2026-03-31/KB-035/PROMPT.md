# Task: KB-035 - Make the dashboard kanban columns scrollable on mobile

**Created:** 2025-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small, focused CSS change with existing test coverage. Modifies mobile responsive styles only.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Ensure individual kanban columns on the dashboard can scroll vertically on mobile devices. The board already has horizontal scroll-snap working (swiping between columns), but the column content area needs to support vertical scrolling so users can view all tasks within a column when the content exceeds the viewport height.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/styles.css` — Current CSS styles including the `@media (max-width: 768px)` mobile section
2. `packages/dashboard/app/__tests__/mobile-scroll-snap.test.ts` — Existing tests for mobile scroll-snap behavior
3. `packages/dashboard/app/__tests__/column-fixed-width.test.ts` — Tests for column width constraints
4. `packages/dashboard/app/components/Column.tsx` — Column component structure
5. `packages/dashboard/app/components/Board.tsx` — Board component that renders columns

## File Scope

- `packages/dashboard/app/styles.css` — modify mobile responsive styles for `.column` and `.column-body`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

**Artifacts:**
- `packages/dashboard/app/styles.css` (exists)
- `packages/dashboard/app/__tests__/mobile-scroll-snap.test.ts` (exists)

### Step 1: Analyze Current Mobile CSS

- [ ] Read the current `@media (max-width: 768px)` CSS block in `styles.css`
- [ ] Identify the `.column` and `.column-body` styles within the media query
- [ ] Verify current `.column-body` has `overflow-y: auto` in base styles but check if it's being overridden
- [ ] Run existing tests to confirm baseline: `pnpm test packages/dashboard`

**Artifacts:**
- `packages/dashboard/app/styles.css` (read)

### Step 2: Fix Column Vertical Scrolling on Mobile

- [ ] In the `@media (max-width: 768px)` block, add/verify styles for `.column`:
  - `max-height: calc(100vh - 100px)` or similar to constrain height within viewport
  - `display: flex; flex-direction: column;` to enable flex layout
- [ ] In the `@media (max-width: 768px)` block, ensure `.column-body` has:
  - `flex: 1;` to take remaining space
  - `overflow-y: auto;` to enable vertical scrolling
  - `min-height: 0;` to allow flex shrinking
  - `-webkit-overflow-scrolling: touch;` for smooth iOS scrolling
- [ ] Ensure `.column-header` does not shrink (has fixed or auto height)

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test packages/dashboard`
- [ ] Verify existing `mobile-scroll-snap.test.ts` still passes
- [ ] Verify existing `column-fixed-width.test.ts` still passes
- [ ] Create a new test file `packages/dashboard/app/__tests__/column-mobile-scroll.test.ts` that validates:
  - Mobile CSS contains `overflow-y: auto` within the media query for column-body
  - Mobile CSS contains `-webkit-overflow-scrolling: touch` for iOS momentum scrolling
  - Mobile `.column` has height constraints (`max-height` or equivalent)
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/__tests__/column-mobile-scroll.test.ts` (new)

### Step 4: Documentation & Delivery

- [ ] Verify no documentation updates needed (CSS change is self-documenting via tests)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — CSS change is covered by tests

**Check If Affected:**
- `packages/dashboard/README.md` — check if mobile behavior is documented, add note if needed

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (including new `column-mobile-scroll.test.ts`)
- [ ] Build passes
- [ ] Mobile kanban columns can scroll vertically independently when content overflows viewport height

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-035): complete Step N — description`
- **Bug fixes:** `fix(KB-035): description`
- **Tests:** `test(KB-035): description`

## Do NOT

- Expand task scope to redesign the entire mobile layout
- Modify desktop styles outside the mobile media query
- Change the horizontal scroll-snap behavior (it's already working)
- Skip tests or rely on manual verification
- Add JavaScript/TypeScript logic when CSS-only solution suffices
