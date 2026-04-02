# Task: KB-161 - Fix PlanningModeModal auto-start test failure

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple bug fix in a single component. The fix involves changing React state to a ref to handle StrictMode double-rendering. Well-scoped change with clear test verification.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the failing test "calls startPlanning automatically when initialPlan is provided" in `PlanningModeModal.test.tsx`. The test fails because `mockStartPlanning` is never called when `initialPlan` prop is provided.

The root cause is React 19's StrictMode behavior where components render twice in development. The current implementation uses `useState` for `hasAutoStarted`, which causes the auto-start to be skipped on the second render because the state persists from the first (discarded) render. The fix is to use `useRef` instead of `useState` for the `hasAutoStarted` flag.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — The component with the auto-start logic
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — The failing test
- `packages/dashboard/vitest.config.ts` — Test configuration showing React plugin is used

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` — Fix the hasAutoStarted implementation

## Steps

### Step 1: Analyze the Current Implementation

- [ ] Read the auto-start useEffect in `PlanningModeModal.tsx` (lines ~70-85)
- [ ] Understand the StrictMode double-render issue:
  - First render: `hasAutoStarted` is `false`, effect runs, `setHasAutoStarted(true)` is called, timeout scheduled
  - StrictMode unmount: timeout is cleared via cleanup
  - Second render: `hasAutoStarted` is already `true` (from first render's state), effect condition `!hasAutoStarted` fails
  - Auto-start never triggers

### Step 2: Implement the Fix

- [ ] Replace `const [hasAutoStarted, setHasAutoStarted] = useState(false)` with `const hasAutoStartedRef = useRef(false)`
- [ ] Update the auto-start useEffect to use `hasAutoStartedRef.current` instead of `hasAutoStarted` state
- [ ] Replace `setHasAutoStarted(true)` with `hasAutoStartedRef.current = true`
- [ ] Remove `hasAutoStarted` from the useEffect dependency array (refs don't need to be in dependency arrays)
- [ ] Update the modal close useEffect that resets `hasAutoStarted` to use the ref instead: `hasAutoStartedRef.current = false`
- [ ] Verify no other code references `hasAutoStarted` state

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the specific failing test: `pnpm test -- app/components/PlanningModeModal.test.tsx`
- [ ] Verify "calls startPlanning automatically when initialPlan is provided" now passes
- [ ] Verify "sets initial plan text in textarea when initialPlan prop is provided" also passes
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Add a brief comment explaining why a ref is used instead of state (StrictMode double-render protection)
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Add inline comment explaining the ref usage for StrictMode compatibility

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] Both auto-start tests passing (`"calls startPlanning automatically when initialPlan is provided"` and `"sets initial plan text in textarea when initialPlan prop is provided"`)
- [ ] Full test suite passing
- [ ] Build passes
- [ ] Inline comment added explaining the StrictMode fix

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-161): complete Step N — description`
- **Bug fixes:** `fix(KB-161): description`
- **Tests:** `test(KB-161): description`

## Do NOT

- Expand task scope to refactor other parts of the component
- Skip adding the explanatory comment
- Modify files outside the File Scope
- Change the test file — the test is correct, the implementation is buggy
- Commit without the task ID prefix
