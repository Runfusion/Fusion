# Task: KB-603 - Auto-Save Drafts and Make Save Button Create Task

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Small UI behavior change affecting two components - changing Save button semantics and adding consistent draft persistence. Low blast radius, standard React patterns, no security implications, fully reversible.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Unify the task creation experience between QuickEntryBox (list view) and InlineCreateCard (board view) by:
1. Making the **Save button create the task** (instead of just saving a draft toast)
2. Adding **auto-save draft persistence** to InlineCreateCard via localStorage (QuickEntryBox already has this)

This ensures both creation surfaces behave consistently - drafts survive page refreshes, and the Save button has the expected "create" semantics.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/app/components/QuickEntryBox.tsx` — Current implementation with localStorage auto-save and Save button
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Board view creation card, needs draft persistence
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Existing tests for Save button behavior
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Existing tests for inline creation

## File Scope

- `packages/dashboard/app/components/QuickEntryBox.tsx` — Modify Save button to trigger task creation
- `packages/dashboard/app/components/InlineCreateCard.tsx` — Add localStorage draft persistence
- `packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx` — Update Save button tests
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Add tests for draft persistence

## Steps

### Step 1: Modify QuickEntryBox Save Button Behavior

- [ ] Change `handleSaveClick` to call `handleSubmit` instead of just showing a toast
- [ ] Remove the explicit `localStorage.setItem` call (auto-save useEffect already handles this)
- [ ] Ensure the Save button is disabled during submission (`isSubmitting` state)
- [ ] Keep existing disabled state when `!description.trim()`
- [ ] Run QuickEntryBox tests to verify behavior changes

**Artifacts:**
- `packages/dashboard/app/components/QuickEntryBox.tsx` (modified)

### Step 2: Add Draft Persistence to InlineCreateCard

- [ ] Add localStorage key constant `STORAGE_KEY = "kb-inline-create-text"` 
- [ ] Initialize `description` state from `localStorage.getItem(STORAGE_KEY)` or empty string
- [ ] Add `useEffect` to persist `description` to localStorage on every change
- [ ] Add `useEffect` to clear localStorage when task is successfully created (in `handleSubmit` success path)
- [ ] Clear localStorage in the `onCancel` handler (when user explicitly cancels empty card)
- [ ] Add localStorage cleanup to the existing cleanup effect for `pendingImages`

**Artifacts:**
- `packages/dashboard/app/components/InlineCreateCard.tsx` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Update QuickEntryBox Save button tests - now should verify `onCreate` is called instead of toast
- [ ] Remove or update test "clicking save button shows success toast" - now should test task creation
- [ ] Add InlineCreateCard tests for draft persistence:
  - Restores description from localStorage on mount
  - Updates localStorage when typing  
  - Clears localStorage after successful task creation
  - Clears localStorage when cancelling without content
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

### Step 4: Documentation & Delivery

- [ ] No documentation updates required (UI behavior change, no API changes)
- [ ] Out-of-scope findings: If inconsistencies found in other creation surfaces, create follow-up tasks via `task_create`

## Documentation Requirements

**Must Update:**
- None (behavior change only)

**Check If Affected:**
- `AGENTS.md` — Check if task creation patterns are documented; update if Save button semantics are specified

## Completion Criteria

- [ ] QuickEntryBox Save button creates the task (calls `onCreate`)
- [ ] InlineCreateCard persists draft to localStorage as user types
- [ ] InlineCreateCard restores draft from localStorage on mount
- [ ] Both components clear localStorage after successful task creation
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-603): complete Step N — description`
- **Bug fixes:** `fix(KB-603): description`
- **Tests:** `test(KB-603): description`

## Do NOT

- Expand scope to other dashboard components
- Skip tests or reduce test coverage
- Change the Enter key behavior (should still create task)
- Modify the actual task creation API - only change UI behavior
- Add new dependencies
