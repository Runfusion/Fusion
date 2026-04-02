# Task: KB-257 - Save quick entry text to localstorage so you don't lose it if the page refreshes

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Small, focused change adding localStorage persistence to a single React component. Well-tested codebase with clear patterns to follow. No security concerns, easily reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 0

## Mission

Add localStorage persistence to the QuickEntryBox component so that when a user types a task description, the text survives page refreshes. The saved text should be restored when the component mounts, and cleared when the task is successfully created or when the user explicitly clears the input.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — The component to modify
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests to extend
- `packages/dashboard/app/App.tsx` — See `localStorage.getItem("kb-dashboard-view")` pattern for reference
- `packages/dashboard/app/components/UsageIndicator.tsx` — See `localStorage.getItem('kb-usage-view-mode')` pattern for reference

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` (modify)
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modify)

## Steps

### Step 1: Implement localStorage Persistence

- [ ] Add localStorage key constant: `const STORAGE_KEY = "kb-quick-entry-text"`
- [ ] Initialize `description` state from localStorage on mount (read `STORAGE_KEY`, use value if present)
- [ ] Add `useEffect` that saves `description` to localStorage whenever it changes (debounce optional but not required)
- [ ] Clear localStorage in `resetForm()` function (called after successful task creation)
- [ ] Clear localStorage when Escape key clears non-empty input (in `handleKeyDown`)
- [ ] Ensure localStorage is only accessed inside `useEffect` or event handlers (not during SSR)

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Add Tests

- [ ] Test that description is restored from localStorage on mount
- [ ] Test that typing updates localStorage
- [ ] Test that successful creation clears localStorage
- [ ] Test that Escape key clearing input also clears localStorage
- [ ] Mock localStorage in tests (already available in jsdom environment)

**Artifacts:**
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in packages/dashboard
- [ ] Run `pnpm test` in root to verify all tests pass
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates needed (feature is self-explanatory)
- [ ] No out-of-scope findings expected for this small change

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] User can type in QuickEntryBox, refresh page, and see their text restored
- [ ] localStorage is cleared after successful task creation

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-257): complete Step N — description`
- **Bug fixes:** `fix(KB-257): description`
- **Tests:** `test(KB-257): description`

## Do NOT

- Use a storage key that doesn't follow the `kb-` prefix pattern
- Access localStorage during render (causes hydration issues)
- Add complex debouncing (simple useEffect on change is sufficient)
- Change the component's external props or behavior beyond localStorage persistence
- Add dependencies on external libraries
