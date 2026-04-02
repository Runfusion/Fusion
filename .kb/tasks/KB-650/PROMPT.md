# Task: KB-650 - Refresh usage when bringing up the usage modal

**Created:** 2026-04-01
**Size:** S

## Review Level: 0 (None)

**Assessment:** Small focused change to a single component. Adding a one-time refresh trigger when modal opens. Low blast radius, no security implications, fully reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Modify the `UsageIndicator` component to automatically trigger a fresh data fetch when the usage modal is opened (when `isOpen` transitions from `false` to `true`). Currently, the modal only starts auto-polling when opened and may display stale cached data until the next 30-second poll or until the user manually clicks refresh. This change ensures users see up-to-date usage information immediately upon opening the modal.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/UsageIndicator.tsx` — Main component that renders the usage modal. Uses `useUsageData` hook with `autoRefresh: isOpen`.
- `packages/dashboard/app/hooks/useUsageData.ts` — Hook that manages usage data fetching and polling. Provides `refresh()` function for manual refresh.
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Existing tests for the usage modal. Use as reference for writing new tests.
- `packages/dashboard/app/hooks/useUsageData.test.ts` — Existing tests for the hook.

## File Scope

- `packages/dashboard/app/components/UsageIndicator.tsx` — Add effect to trigger refresh on open
- `packages/dashboard/app/components/UsageIndicator.test.tsx` — Add test for refresh-on-open behavior

## Steps

### Step 1: Add Refresh-on-Open Effect to UsageIndicator

- [ ] Add a `useEffect` in `UsageIndicator` that watches `isOpen` prop
- [ ] When `isOpen` transitions from `false` to `true`, call the `refresh()` function from `useUsageData`
- [ ] Skip the refresh if data was just fetched (within last 5 seconds) to avoid duplicate requests when modal is rapidly toggled
- [ ] Ensure the effect handles cleanup properly and doesn't call refresh on unmount

**Implementation approach:**
- Use a ref to track the previous `isOpen` value: `const wasOpenRef = useRef(isOpen)`
- In the effect, compare `isOpen` (now true) with `wasOpenRef.current` (was false)
- Also check `lastUpdated` timestamp to avoid redundant refreshes
- Call `refresh()` only when: `!wasOpenRef.current && isOpen && (!lastUpdated || Date.now() - lastUpdated.getTime() > 5000)`
- Update `wasOpenRef.current = isOpen` at the end of the effect

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test in `UsageIndicator.test.tsx` to verify `refresh()` is called when `isOpen` becomes `true`
- [ ] Add test to verify `refresh()` is NOT called when `isOpen` is already `true` on mount (initial load)
- [ ] Add test to verify `refresh()` is NOT called when modal is closed (`isOpen` becomes `false`)
- [ ] Add test to verify duplicate refresh is skipped if data was updated within last 5 seconds
- [ ] Run all usage-related tests: `pnpm test -- packages/dashboard/app/components/UsageIndicator.test.tsx`
- [ ] Run hook tests: `pnpm test -- packages/dashboard/app/hooks/useUsageData.test.ts`
- [ ] Run full test suite: `pnpm test`
- [ ] Build passes: `pnpm build`

**Test implementation notes:**
- Mock the `useUsageData` hook's `refresh` function and assert it's called
- Use `rerender({ isOpen: true })` to simulate opening the modal
- Mock `lastUpdated` to test the 5-second debounce logic

**Artifacts:**
- `packages/dashboard/app/components/UsageIndicator.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] No documentation updates needed (internal behavior change, no user-facing API changes)
- [ ] Create changeset file for the dashboard package:
  ```bash
  cat > .changeset/refresh-usage-modal.md << 'EOF'
  ---
  "@fusion/dashboard": patch
  ---

  Refresh usage data automatically when opening the usage modal
  EOF
  ```

**Artifacts:**
- `.changeset/refresh-usage-modal.md` (new)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Usage modal refreshes data automatically when opened
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-650): complete Step 1 — add refresh-on-open effect`
- **Bug fixes:** `fix(KB-650): description`
- **Tests:** `test(KB-650): add tests for refresh-on-open behavior`
- **Changeset:** `chore(KB-650): add changeset for usage modal refresh`

## Do NOT

- Expand task scope to add new UI elements or features
- Skip tests for the new behavior
- Modify `useUsageData` hook interface (use existing `refresh()` function)
- Modify server-side usage caching logic
- Add configurable refresh interval settings
- Change the existing polling behavior (keep the 30s auto-refresh)
