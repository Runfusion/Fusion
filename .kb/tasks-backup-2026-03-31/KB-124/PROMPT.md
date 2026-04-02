# Task: KB-124 - Fix ntfy.sh Duplicate Notifications

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Straightforward bug fix removing redundant notification code. The duplicate notification happens because both `task:moved` (to "done") and `task:merged` events send notifications. The fix removes the redundant notification from `handleTaskMoved`, keeping only `task:merged` as the source of truth.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Eliminate duplicate ntfy.sh notifications when tasks are merged. Currently when a task completes merge, two identical "Task X merged" notifications are sent because:
1. `task:moved` to "done" column triggers a notification in `handleTaskMoved`
2. `task:merged` event also triggers a notification in `handleTaskMerged`

The fix removes the notification from `handleTaskMoved` for the "done" column, keeping only the semantically correct `task:merged` notification.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/notifier.ts` — Main notifier implementation
- `packages/engine/src/notifier.test.ts` — Test suite for the notifier
- `packages/engine/src/merger.ts` — Emits `task:merged` after `moveTask` (see `completeTask` function line ~1168)
- `packages/core/src/store.ts` — `moveTask` emits `task:moved` event (line ~426)

## File Scope

- `packages/engine/src/notifier.ts` (modify)
- `packages/engine/src/notifier.test.ts` (modify)

## Steps

### Step 1: Remove Duplicate Notification

- [ ] In `handleTaskMoved`, remove the notification block for `to === "done"` (currently lines 99-109)
- [ ] Replace with a comment explaining that `task:merged` handles this
- [ ] Keep the "in-review" notification intact (this one is correct)
- [ ] Keep `handleTaskMerged` unchanged — it's the correct source of merge notifications

**Code change:** Remove this block from `handleTaskMoved`:
```typescript
// Notify when task moves to done (merged to main)
if (to === "done") {
  this.maybeNotify(task.id, () =>
    this.sendNotification(
      this.config.topic!,
      `Task ${task.id} merged`,
      `Task "${task.title ?? task.id}" has been merged to main`,
      "default",
    ),
  );
}
```

**Replace with:**
```typescript
// Note: task:moved to "done" does NOT send notification here.
// The task:merged event is the sole source of "merged" notifications.
```

**Artifacts:**
- `packages/engine/src/notifier.ts` (modified)

### Step 2: Update Tests for Correct Behavior

- [ ] Update test "sends notification when task moves to done" — rename to "does not send notification when task moves to done (task:merged handles this)" and change assertion to verify NO notification is sent
- [ ] Add test "sends notification only once on merge (not duplicate)" — verify that when both `task:moved` and `task:merged` fire, only one notification is sent
- [ ] Ensure test "sends notification when task is merged" still passes (tests `task:merged` event)
- [ ] Run all notifier tests to verify no regressions

**Artifacts:**
- `packages/engine/src/notifier.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm vitest run packages/engine/src/notifier.test.ts` — all tests must pass
- [ ] Run `pnpm test` in `packages/engine` — all engine tests must pass
- [ ] Run full `pnpm test` from root — verify no regressions across packages
- [ ] Run `pnpm build` — ensure no build errors

### Step 4: Documentation & Delivery

- [ ] Create changeset file: `.changeset/fix-ntfy-duplicate-notifications.md`
- [ ] Changeset content:
```md
---
"@dustinbyrne/kb": patch
---

Remove duplicate ntfy notification on task merge

Previously, when a task was merged to main, two identical notifications were sent because both `task:moved` (to "done") and `task:merged` events triggered notifications. Now only the `task:merged` event sends the notification, eliminating the duplicate.
```

**Artifacts:**
- `.changeset/fix-ntfy-duplicate-notifications.md` (new)

## Documentation Requirements

**Must Update:**
- None — behavior change aligns with expected behavior, no docs needed

**Check If Affected:**
- `AGENTS.md` — verify notification behavior documentation is accurate (update if incorrect)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (20+ notifier tests, including new "sends notification only once on merge" test)
- [ ] No duplicate notifications when task is merged
- [ ] Notifications still correctly sent for:
  - Task moved to "in-review" (ready for review)
  - Task merged (via task:merged event)
  - Task failed (high priority)
- [ ] Changeset file created
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-124): remove duplicate ntfy notification on task merge`
- **Tests:** `test(KB-124): update tests for single notification on merge`
- **Changeset:** `docs(KB-124): add changeset for ntfy duplicate fix`

## Do NOT

- Expand task scope to add new notification features (different sound effects, custom messages, etc.)
- Skip tests — the duplicate notification bug must have test coverage
- Modify files outside the File Scope
- Remove the "in-review" notification — that one is correct and should remain
- Remove `handleTaskMerged` — it's the correct source of merge notifications
- Cherry-pick from kb/kb-085 branch — the fix is simple enough to reapply cleanly
