# Task: KB-165 - Fix PlanningModeModal auto-start planning tests

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple bug fix in a single component. The issue is React 19 StrictMode double-rendering where `useState` for `hasAutoStarted` persists across renders, preventing auto-start on the second (committed) render. The fix involves changing state to a ref.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the failing auto-start planning tests in `PlanningModeModal.test.tsx`. Two tests are failing:
1. "auto-starts planning when initialPlan prop is provided" (line 162)
2. "sets initial plan text in textarea when initialPlan prop is provided" (line 190)

The root cause is React 19's StrictMode behavior where components render twice in development. The current implementation uses `useState` for `hasAutoStarted`, which causes the auto-start to be skipped on the second render because the state persists from the first (discarded) render. The `mockStartPlanning` function is never called because the effect's `!hasAutoStarted` condition fails on the second render.

The fix is to use `useRef` instead of `useState` for the `hasAutoStarted` flag, as refs do not persist across StrictMode's double renders.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — The component with the auto-start logic (lines 58-85)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — The failing tests (lines 162-210)

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` — Fix the hasAutoStarted implementation

## Steps

### Step 1: Analyze the Current Implementation

- [ ] Read the auto-start useEffect in `PlanningModeModal.tsx` (lines ~58-85)
- [ ] Understand the StrictMode double-render issue:
  - First render: `hasAutoStarted` is `false`, effect runs, `setHasAutoStarted(true)` is called, timeout scheduled
  - StrictMode unmount: timeout is cleared via cleanup function
  - Second render: `hasAutoStarted` is already `true` (from first render's state), effect condition `!hasAutoStarted` fails
  - Auto-start never triggers on the committed render

### Step 2: Implement the Fix

- [ ] Replace `const [hasAutoStarted, setHasAutoStarted] = useState(false)` with `const hasAutoStartedRef = useRef(false)`
- [ ] Update the auto-start useEffect to check `hasAutoStartedRef.current` instead of `hasAutoStarted` state
- [ ] Replace `setHasAutoStarted(true)` with `hasAutoStartedRef.current = true`
- [ ] Remove `hasAutoStarted` from the useEffect dependency array (refs don't need to be in dependency arrays)
- [ ] Update the modal close useEffect that resets `hasAutoStarted` to use the ref instead: `hasAutoStartedRef.current = false`
- [ ] Remove the `useState` import for `hasAutoStarted` if no longer needed (keep for other state)
- [ ] Add inline comment explaining why a ref is used instead of state (StrictMode double-render protection)

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run the specific failing tests:
  ```bash
  cd packages/dashboard && pnpm test -- app/components/PlanningModeModal.test.tsx -t "auto-starts planning when initialPlan prop is provided"
  ```
- [ ] Run both auto-start tests:
  ```bash
  cd packages/dashboard && pnpm test -- app/components/PlanningModeModal.test.tsx -t "initialPlan"
  ```
- [ ] Verify both tests now pass
- [ ] Run full PlanningModeModal test suite:
  ```bash
  cd packages/dashboard && pnpm test -- app/components/PlanningModeModal.test.tsx
  ```
- [ ] Run full dashboard test suite:
  ```bash
  cd packages/dashboard && pnpm test
  ```
- [ ] Build passes:
  ```bash
  pnpm build
  ```

### Step 4: Documentation & Delivery

- [ ] Add changeset file since this is a user-facing bug fix:
  ```bash
  cat > .changeset/fix-planning-modal-autostart.md << 'EOF'
  ---
  "@kb/dashboard": patch
  ---

  Fix PlanningModeModal auto-start functionality when initialPlan prop is provided. The auto-start now works correctly in React StrictMode.
  EOF
  ```
- [ ] Out-of-scope findings created as new tasks via `task_create` tool if any

## Documentation Requirements

**Must Update:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` — Add inline comment explaining the ref usage for StrictMode compatibility

**Check If Affected:**
- None

## Completion Criteria

- [ ] All steps complete
- [ ] Both auto-start tests passing:
  - "auto-starts planning when initialPlan prop is provided"
  - "sets initial plan text in textarea when initialPlan prop is provided"
- [ ] Full PlanningModeModal test suite passing
- [ ] Full dashboard test suite passing
- [ ] Build passes
- [ ] Changeset file created
- [ ] Inline comment added explaining the StrictMode fix

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-165): complete Step N — description`
- **Bug fixes:** `fix(KB-165): description`
- **Tests:** `test(KB-165): description`
- **Changeset:** `chore(KB-165): add changeset for planning modal autostart fix`

## Do NOT

- Expand task scope to refactor other parts of the component
- Skip adding the explanatory comment about StrictMode
- Modify files outside the File Scope
- Change the test file — the tests are correct, the implementation is buggy
- Commit without the task ID prefix
- Skip the changeset (this is a user-facing bug fix)
