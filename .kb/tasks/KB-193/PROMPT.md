# Task: KB-193 - Auto-expand steps disclosure for in-progress cards

**Created:** 2026-03-30
**Size:** S

## Review Level: 0 (None)

**Assessment:** Small UI change to initialize steps disclosure state based on column. Low risk, no security implications.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Modify the TaskCard component to automatically expand the steps disclosure when a task is in the "in-progress" column, while keeping it collapsed for tasks in all other columns (triage, todo, in-review, done, archived). This improves visibility into the current execution progress without requiring users to manually expand each card.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/TaskCard.tsx` — The TaskCard component with `showSteps` state and steps toggle UI
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Existing tests for the steps toggle functionality (lines ~1150-1250)

## File Scope

- `packages/dashboard/app/components/TaskCard.tsx` — Modify `showSteps` state initialization
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` — Add tests for the new behavior

## Steps

### Step 1: Implementation

- [ ] Modify `TaskCard.tsx`: Initialize `showSteps` state based on `task.column`
  - When `task.column === "in-progress"`: default `showSteps` to `true`
  - For all other columns: default `showSteps` to `false` (current behavior)
- [ ] Ensure the toggle button still works to manually expand/collapse steps regardless of initial state
- [ ] Run existing tests to confirm no regressions

**Code change location:**
Find this line in TaskCard.tsx:
```tsx
const [showSteps, setShowSteps] = useState(false);
```

Change to:
```tsx
const [showSteps, setShowSteps] = useState(task.column === "in-progress");
```

**Artifacts:**
- `packages/dashboard/app/components/TaskCard.tsx` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add test case: Steps are expanded by default for "in-progress" column tasks
- [ ] Add test case: Steps are collapsed by default for "triage" column tasks  
- [ ] Add test case: Steps are collapsed by default for "todo" column tasks
- [ ] Add test case: Steps are collapsed by default for "in-review" column tasks
- [ ] Add test case: Steps are collapsed by default for "done" column tasks
- [ ] Add test case: Toggle button still works to collapse steps on in-progress cards
- [ ] Add test case: Toggle button still works to expand steps on non-in-progress cards
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/dashboard/app/components/__tests__/TaskCard.test.tsx` (modified)

### Step 3: Documentation & Delivery

- [ ] Update task status to "done"
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- None — This is a self-documenting UI behavior change

**Check If Affected:**
- `packages/dashboard/README.md` — Check if there's a section describing card behavior that should mention this

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] No documentation updates required

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-193): complete Step N — description`
- **Bug fixes:** `fix(KB-193): description`
- **Tests:** `test(KB-193): description`

## Do NOT

- Expand task scope beyond the steps disclosure behavior
- Modify other card behaviors or styling
- Add new props to TaskCard (use existing `task.column` data)
- Change the visual appearance of the steps toggle
- Modify WorktreeGroup or Column components
