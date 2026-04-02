# Task: KB-275 - Planning mode should allow more text to be entered

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 — None

**Assessment:** This is a straightforward UI constraint removal. No architectural changes, no complex logic, just removing a character limit that was unnecessarily restrictive.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Remove the 500-character limit on the initial plan text input in Planning Mode. Users often want to provide detailed context when planning tasks, and the current 500-character restriction is too limiting. Other similar text inputs in the dashboard (task description, spec editor feedback) already use 2000 characters as a reasonable upper bound.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/PlanningModeModal.tsx` — The component containing the 500-character limit
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` — Tests that may reference the character count display

## File Scope

- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified if needed)

## Steps

### Step 1: Remove Character Limit

- [ ] Remove `maxLength={500}` attribute from the initial plan textarea
- [ ] Remove `.slice(0, 500)` from the `onChange` handler
- [ ] Remove or update the character count display (`planning-char-count` div showing `{initialPlan.length}/500 characters`)
- [ ] Verify the textarea accepts text beyond 500 characters

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.tsx` (modified)

### Step 2: Update Tests

- [ ] Review and update any tests that reference the 500-character limit
- [ ] Remove or update tests checking for the character counter display
- [ ] Run the test file to ensure all tests pass

**Artifacts:**
- `packages/dashboard/app/components/PlanningModeModal.test.tsx` (modified if needed)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run dashboard tests: `pnpm test --filter @kb/dashboard`
- [ ] Verify all PlanningModeModal tests pass
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Create changeset file since this is a user-facing improvement to the published `@dustinbyrne/kb` package (via dashboard changes)
- [ ] Verify no documentation updates needed (this is a behavior fix, not a feature change)

## Documentation Requirements

**Must Update:**
- None — this is a straightforward UI behavior fix

**Check If Affected:**
- None

## Completion Criteria

- [ ] Initial plan textarea no longer has a 500-character limit
- [ ] Character count display removed from the UI
- [ ] All dashboard tests passing
- [ ] Full test suite passing
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-275): complete Step N — description`
- **Bug fixes:** `fix(KB-275): description`
- **Tests:** `test(KB-275): description`

## Do NOT

- Add a new character limit (the point is to remove the restriction)
- Modify unrelated components
- Skip tests
- Add complex validation logic
