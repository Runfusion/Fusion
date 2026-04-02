# Task: KB-211 - Fix dashboard TaskCard memoization test

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a test-only fix for React StrictMode double-render behavior. No production code changes, minimal blast radius.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix the failing TaskCard memoization test `'does not re-render when parent re-renders with an equivalent task object'` which is failing due to React StrictMode's intentional double-render behavior. The test expects 1 render but receives 2 renders. Fix the test to properly account for StrictMode while preserving the intent of verifying memoization behavior.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/vitest.config.ts` — Vitest configuration using `@vitejs/plugin-react` with StrictMode enabled by default
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — The failing test at lines 61-96 (the memoization test block)
- `packages/dashboard/app/components/TaskCard.tsx` — The component's memoization comparator `areTaskCardPropsEqual` (lines 79-129)

## File Scope

- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Modify the failing test only

## Steps

### Step 1: Analyze and Fix the Failing Test

- [ ] Read the failing test `'does not re-render when parent re-renders with an equivalent task object'` (lines 61-96)
- [ ] Understand that React StrictMode intentionally renders components twice to detect side effects
- [ ] Fix the test by using the same custom comparator that `TaskCard` uses (`areTaskCardPropsEqual`), OR adjust the test to account for StrictMode

**Fix Options (choose one):**

**Option A (Recommended):** Make the test's `MemoizedProbe` use the same deep comparison as `TaskCard`:
```tsx
// Import or replicate the comparator logic from TaskCard
import { areTaskCardPropsEqual } from "../TaskCard";

// Use it with React.memo
const MemoizedProbe = React.memo(MemoProbe, (prevProps, nextProps) => {
  // Compare only the task prop since that's what changes
  return areTaskCardPropsEqual(
    { task: prevProps.task } as TaskCardProps,
    { task: nextProps.task } as TaskCardProps
  );
});
```

**Option B:** Account for StrictMode in assertions by expecting 2 renders instead of 1, with a comment explaining why.

- [ ] Run the specific failing test to verify the fix
- [ ] Ensure all other TaskCard tests still pass

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the full TaskCard test file: `pnpm vitest run "TaskCard.test.tsx"`
- [ ] Confirm all 150+ tests pass (only 1 currently failing)
- [ ] Run dashboard package build: `pnpm build` (to ensure no type errors)

### Step 3: Documentation & Delivery

- [ ] Verify the fix is minimal and focused on the failing test
- [ ] No changeset needed (test-only fix, no user-facing changes)

## Documentation Requirements

**Must Update:** None (test-only fix)

**Check If Affected:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Add a brief comment explaining the comparator usage if Option A is chosen

## Completion Criteria

- [ ] All steps complete
- [ ] All TaskCard tests passing
- [ ] Dashboard build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-211): complete Step N — description`
- **Bug fixes:** `fix(KB-211): description`
- **Tests:** `test(KB-211): description`

## Do NOT

- Modify production code (`TaskCard.tsx`) — the component is correctly memoized
- Disable StrictMode globally — it exists to catch real issues
- Use `vi.spyOn` or other workarounds that don't address the root cause
- Expand task scope beyond fixing this single failing test
