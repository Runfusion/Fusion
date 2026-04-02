# Task: KB-085 - Fix ntfy.sh Duplicate Notifications Bug

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** The issue is a straightforward logic bug causing duplicate notifications when tasks are merged. Both `task:moved` (to "done") and `task:merged` events trigger notifications for the same event. Fix requires removing the redundant notification from `handleTaskMoved` for the "done" column.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the ntfy.sh notification system to eliminate duplicate "merged" notifications. Currently, when a task is successfully merged to main, two identical notifications are sent because both `task:moved` (to "done") and `task:merged` events trigger notifications. The fix removes the redundant notification from the `task:moved` handler for the "done" column, keeping only the `task:merged` notification which is more semantically correct.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/notifier.ts` — Main notifier implementation with event handlers
- `packages/engine/src/notifier.test.ts` — Test suite for the notifier
- `packages/core/src/store.ts` — Store events (`task:moved`, `task:merged`, `task:updated`)
- `packages/engine/src/merger.ts` — How `aiMergeTask` emits `task:merged` after `moveTask`

## File Scope

- `packages/engine/src/notifier.ts` (modify)
- `packages/engine/src/notifier.test.ts` (modify)

## Steps

### Step 1: Identify and Remove Duplicate Notification

- [ ] In `handleTaskMoved`, remove the notification block for `to === "done"` (lines 99-109)
- [ ] Keep the notification for `to === "in-review"` (task completed, ready for review)
- [ ] Keep `handleTaskMerged` unchanged — it correctly handles successful merge notifications
- [ ] Run existing notifier tests to ensure no regressions

**Rationale:** The `task:merged` event is always emitted after a successful merge (see `store.mergeTask()` line 772 and `merger.ts` `completeTask()`). This event should be the sole source of "merged" notifications. The `task:moved` to "done" is a side effect and should not trigger notifications.

**Artifacts:**
- `packages/engine/src/notifier.ts` (modified)

### Step 2: Update Tests for Correct Behavior

- [ ] Update test "sends notification when task moves to done" — change to verify NO notification is sent on `task:moved` to "done"
- [ ] Add test "sends notification only once on merge" — verify that when both `task:moved` and `task:merged` fire, only one notification is sent
- [ ] Ensure test "sends notification when task is merged" still passes (this tests `task:merged` event)
- [ ] Verify all 20 notifier tests pass

**Artifacts:**
- `packages/engine/src/notifier.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm vitest run src/notifier.test.ts` — all 20 tests must pass
- [ ] Run `pnpm test` in `packages/engine` — all engine tests must pass
- [ ] Run full `pnpm test` from root — verify no regressions across packages

### Step 4: Documentation & Delivery

- [ ] Add changeset file: `.changeset/fix-ntfy-duplicate-notifications.md` (patch bump for `@dustinbyrne/kb`)
- [ ] Commit message: `fix(KB-085): remove duplicate ntfy notification on task merge`

## Documentation Requirements

**Must Update:**
- None — behavior change aligns with expected behavior, no docs needed

**Check If Affected:**
- `AGENTS.md` — check if notification behavior is documented (update if incorrect)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (including new "sends notification only once on merge" test)
- [ ] No duplicate notifications when task is merged
- [ ] Notifications still sent for: task moved to "in-review", task merged, task failed

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `fix(KB-085): remove duplicate ntfy notification on task merge`
- **Tests:** `test(KB-085): add test for single notification on merge`

## Do NOT

- Expand task scope to add new notification features (different sound effects, custom messages, etc.)
- Skip tests — the duplicate notification bug must have test coverage
- Modify files outside the File Scope
- Remove the "in-review" notification — that one is correct and should remain
- Remove `handleTaskMerged` — it's the correct source of merge notifications
