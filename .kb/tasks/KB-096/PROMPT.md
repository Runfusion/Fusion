# Task: KB-096 - Add Usage Indicator Header Button

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a small UI connection task. The backend, API, hook, and UsageIndicator modal are all already implemented from KB-039. We only need to add the header button to open the modal. Low blast radius, no new patterns, no security concerns, easily reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a usage indicator button to the dashboard header that opens the existing UsageIndicator modal. The button should display an Activity icon (from lucide-react) and be positioned between the view toggle and the GitHub import button. When clicked, it calls the `onOpenUsage` callback prop.

This connects the existing usage indicator infrastructure (backend API, frontend hook, modal component) to the UI so users can actually access it.

## Dependencies

- **None** — All backend and modal infrastructure already exists from KB-039.

## Context to Read First

1. `packages/dashboard/app/components/Header.tsx` — Current header implementation, see how other buttons are structured
2. `packages/dashboard/app/components/Header.test.tsx` — Current header tests, follow the pattern for testing buttons
3. `packages/dashboard/app/App.tsx` — See how `onOpenUsage` is passed to Header and how other modal triggers work

## File Scope

### Modified Files
- `packages/dashboard/app/components/Header.tsx` — Add `onOpenUsage` prop and Activity icon button
- `packages/dashboard/app/components/Header.test.tsx` — Add tests for usage button

## Steps

### Step 1: Add Usage Button to Header

- [ ] Add `onOpenUsage?: () => void` to `HeaderProps` interface
- [ ] Import `Activity` icon from lucide-react (add to existing import)
- [ ] Add usage button between view-toggle and import button (see App.tsx where it's placed in the header-actions)
  - Use `btn-icon` class (consistent with other buttons)
  - Title: "View usage"
  - Only render when `onOpenUsage` prop is provided (consistent pattern with other optional buttons)
  - Position: after view-toggle, before import from GitHub button
- [ ] Run `pnpm lint` to ensure code style is correct

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 2: Add Header Tests

- [ ] Add tests in `Header.test.tsx`:
  - Test that usage button does NOT render when `onOpenUsage` is not provided
  - Test that usage button renders with correct title when `onOpenUsage` is provided
  - Test that clicking the button calls `onOpenUsage`
- [ ] Follow existing test patterns (see `planning button` describe block for reference)
- [ ] Run header tests: `cd packages/dashboard && pnpm test -- Header.test.tsx`

**Artifacts:**
- `packages/dashboard/app/components/Header.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all dashboard tests: `cd packages/dashboard && pnpm test`
  - Header tests must pass
  - UsageIndicator tests must pass
- [ ] Run build: `pnpm build`
- [ ] Manual verification:
  - [ ] Activity icon button appears in header
  - [ ] Clicking opens usage modal with provider data
  - [ ] Modal closes correctly
  - [ ] Mobile view shows button correctly

### Step 4: Documentation & Delivery

- [ ] Create changeset: `.changeset/add-usage-header-button.md`
  ```
  ---
  "@dustinbyrne/kb": patch
  ---

  Add usage indicator button to dashboard header for viewing AI provider subscription usage.
  ```
- [ ] Update ROADMAP.md if this completes a milestone feature

## Documentation Requirements

**Must Update:**
- `.changeset/add-usage-header-button.md` — Changeset for this patch

**Check If Affected:**
- `packages/dashboard/README.md` — Update if there's a feature list

## Completion Criteria

- [ ] Header has Activity icon button that opens usage modal
- [ ] Button only shows when `onOpenUsage` prop provided
- [ ] All tests passing
- [ ] Build passes
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-096): complete Step N — description`
- **Bug fixes:** `fix(KB-096): description`
- **Tests:** `test(KB-096): description`

## Do NOT

- Modify the UsageIndicator component (it's already complete)
- Modify the usage API or backend (already complete)
- Add new dependencies
- Skip tests
- Change button styling beyond existing patterns
