# Task: KB-123 - Verify Subtask Breakdown Toggle Implementation

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a verification task. The feature appears fully implemented across all layers (UI, API, types, storage, triage agent). Verification confirms end-to-end integration works correctly.
**Score:** 2/8 — Blast radius: 0 (verification only), Pattern novelty: 0 (existing patterns), Security: 1 (input validation check), Reversibility: 1 (feature can be disabled)

## Mission

Verify the "Break into subtasks" toggle feature is fully implemented and working correctly end-to-end. The toggle appears during new task creation on the dashboard and signals the AI triage agent to break complex tasks into smaller child tasks instead of writing a single large specification. This verification ensures all components are properly integrated: UI toggle, API transport, storage layer, and triage agent behavior.

## Dependencies

- **None**

## Context to Read First

1. `packages/dashboard/app/components/InlineCreateCard.tsx` — Toggle UI implementation
2. `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — Existing tests for the toggle
3. `packages/core/src/types.ts` — `breakIntoSubtasks` field in Task and TaskCreateInput
4. `packages/core/src/store.ts` — Storage of the flag in createTask()
5. `packages/dashboard/app/api.ts` — Frontend API client passing the flag
6. `packages/dashboard/src/routes.ts` — Backend route accepting the flag
7. `packages/engine/src/triage.ts` — Triage agent handling of subtask breakdown

## File Scope

Verification only — no changes expected unless issues found:

- `packages/dashboard/app/components/InlineCreateCard.tsx` — verify toggle UI
- `packages/dashboard/app/components/__tests__/InlineCreateCard.test.tsx` — verify test coverage
- `packages/dashboard/app/api.ts` — verify API transport
- `packages/dashboard/src/routes.ts` — verify backend validation
- `packages/core/src/store.ts` — verify storage
- `packages/core/src/types.ts` — verify type definitions
- `packages/engine/src/triage.ts` — verify triage agent logic

## Steps

### Step 1: Verify UI Implementation

- [ ] Confirm `InlineCreateCard.tsx` has `breakIntoSubtasks` state with `useState(false)`
- [ ] Confirm checkbox with `data-testid="break-into-subtasks-toggle"` exists and is visible
- [ ] Verify toggle is positioned near the Deps button as specified in KB-040
- [ ] Verify toggle is hidden when `submitting` is true
- [ ] Verify toggle is included in cancel conditions (focusout handler)
- [ ] Run InlineCreateCard tests: `pnpm vitest run InlineCreateCard.test`

**Expected Artifacts:**
- State: `const [breakIntoSubtasks, setBreakIntoSubtasks] = useState(false);`
- Checkbox input with testid present
- Toggle passed in submit payload via `onSubmit({ breakIntoSubtasks })`

### Step 2: Verify Type Definitions

- [ ] Confirm `Task` interface has optional `breakIntoSubtasks?: boolean` with JSDoc comment "User-requested hint for triage: prefer splitting into child tasks when appropriate."
- [ ] Confirm `TaskCreateInput` interface has `breakIntoSubtasks?: boolean`
- [ ] Run type check: `pnpm --filter @kb/core typecheck` if available, or `pnpm build` to verify types compile

**Expected Artifacts:**
- `packages/core/src/types.ts` — both interfaces updated with optional boolean field

### Step 3: Verify API Transport

- [ ] Confirm `api.ts` `createTask()` destructures and passes `breakIntoSubtasks` in request body
- [ ] Confirm `routes.ts` POST `/api/tasks` extracts and validates `breakIntoSubtasks` as boolean
- [ ] Verify validation rejects non-boolean values with 400 error
- [ ] Run dashboard routes tests: `pnpm vitest run routes.test.ts`

**Expected Artifacts:**
- `packages/dashboard/app/api.ts` — `createTask` destructures `breakIntoSubtasks` from input
- `packages/dashboard/src/routes.ts` — route handler validates `typeof breakIntoSubtasks !== 'boolean'` and passes to store

### Step 4: Verify Storage Layer

- [ ] Confirm `TaskStore.createTask()` stores `breakIntoSubtasks` in task.json (only when true)
- [ ] Verify only `true` values are stored (not `false` or `undefined`)
- [ ] Run store tests: `pnpm vitest run store.test.ts`

**Expected Artifacts:**
- `packages/core/src/store.ts` — stores as `breakIntoSubtasks: input.breakIntoSubtasks === true ? true : undefined`

### Step 5: Verify Triage Agent Integration

- [ ] Confirm `TRIAGE_SYSTEM_PROMPT` includes "Triage subtask breakdown" section (around line 153)
- [ ] Confirm `buildSpecificationPrompt()` adds subtask instructions when `task.breakIntoSubtasks` is true
- [ ] Verify `task_create` tool is conditionally enabled via `allowTaskCreate: detail.breakIntoSubtasks === true`
- [ ] Verify triage logic creates subtasks and deletes parent when flag is set (around line 515-522)
- [ ] Run engine tests: `pnpm --filter @kb/engine test`

**Expected Artifacts:**
- `packages/engine/src/triage.ts` — all subtask logic present
- System prompt includes subtask breakdown instructions
- Parent task deleted after subtasks created (clean replacement behavior)

### Step 6: Testing & Verification

> ZERO test failures allowed in scope-related tests.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify InlineCreateCard tests all pass (expecting 16+ tests including subtask toggle tests)
- [ ] Verify no regressions in dashboard, core, or engine tests
- [ ] Build passes: `pnpm build`

### Step 7: Documentation & Delivery

- [ ] If any issues found in verification, fix them
- [ ] If implementation is complete, document any gaps found
- [ ] Create changeset if any fixes made: `.changeset/verify-subtask-toggle-kb123.md`
- [ ] If fully verified with no changes needed, mark as complete with commit: `chore(KB-123): verify subtask toggle implementation complete`

## Documentation Requirements

**Must Update (if any fixes made):**
- Inline code comments if unclear
- AGENTS.md if behavior differs from documented

**Check If Affected:**
- `AGENTS.md` — verify subtask behavior matches documentation
- `packages/dashboard/README.md` — add note about subtask creation feature if applicable

## Completion Criteria

- [ ] All verification steps complete
- [ ] InlineCreateCard tests passing (16/16 or similar)
- [ ] Full test suite passing (or only pre-existing unrelated failures)
- [ ] Build passes
- [ ] Feature fully functional end-to-end:
  - Toggle appears in task creation UI
  - Toggle state flows to API and is stored
  - Flag persists in task.json
  - Triage agent respects flag and can create subtasks

## Git Commit Convention

If fixes needed:
- **Fixes:** `fix(KB-123): description`
- **Tests:** `test(KB-123): description`

If no changes needed:
- **Verification:** `chore(KB-123): verify subtask toggle implementation complete`

## Do NOT

- Reimplement working features
- Change existing test logic unless fixing actual bugs
- Modify the feature behavior (verify what exists)
- Skip verification steps even if code looks correct
- Commit without the task ID prefix

## Notes

Based on code inspection, this feature appears to be already fully implemented:
- UI toggle exists in InlineCreateCard.tsx with proper state management
- Tests exist and should pass for the subtask toggle
- Types defined in packages/core/src/types.ts
- API transport in packages/dashboard/app/api.ts
- Backend route validation in packages/dashboard/src/routes.ts
- Storage in packages/core/src/store.ts
- Triage agent handling in packages/engine/src/triage.ts with full subtask logic

The purpose of this task is to verify the complete integration works correctly from UI → API → storage → AI behavior. If fully verified with no changes needed, this task can be completed with a simple chore commit.
