# Task: KB-106 - Fix ntfy duplicate notifications causing rate limiting

**Created:** 2026-03-30
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple fix to deduplicate notifications by removing redundant handler and adding per-event-type tracking. Low blast radius - isolated to notifier.ts.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Fix the ntfy "too many requests" error by eliminating duplicate notifications. Currently, when a task is successfully merged, TWO notifications are sent:
1. From `handleTaskMoved` when task moves to "done" column
2. From `handleTaskMerged` when the `task:merged` event fires

The fix: remove the redundant "done" notification from `handleTaskMoved` and add per-event-type tracking to ensure each significant event (in-review, merged, failed) only sends one notification per task.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/notifier.ts` — The NtfyNotifier class with duplicate notification handlers
- `packages/engine/src/notifier.test.ts` — Existing tests for the notifier
- `packages/core/src/store.ts` — How `moveToDone` emits `task:moved` before `task:merged`
- `packages/engine/src/merger.ts` — How `completeTask` calls `moveTask` then emits `task:merged`

## File Scope

- `packages/engine/src/notifier.ts` (modify)
- `packages/engine/src/notifier.test.ts` (modify — update tests to reflect single-notification behavior)

## Steps

### Step 1: Remove Duplicate Notification Handler

- [ ] Remove the "done" notification from `handleTaskMoved` — only notify for "in-review"
- [ ] The `handleTaskMoved` should only send notification when `to === "in-review"`
- [ ] Keep `handleTaskMerged` for sending the "merged" notification (this is the correct single source)
- [ ] Run existing notifier tests to verify they pass after change

**Artifacts:**
- `packages/engine/src/notifier.ts` (modified)

### Step 2: Add Per-Event-Type Deduplication

- [ ] Replace `lastNotificationTime` Map with a Set that tracks `(taskId, eventType)` tuples
- [ ] Define event types: `"in-review"`, `"merged"`, `"failed"`
- [ ] Update `maybeNotify` to check if `(taskId, eventType)` was already sent
- [ ] Ensure a task can still receive multiple different notifications (e.g., in-review then merged), but never duplicates of the same type
- [ ] Clear tracking when appropriate (task restarts, etc.) — or use a simple Set that persists for the lifetime of the notifier process

**Artifacts:**
- `packages/engine/src/notifier.ts` (modified)

### Step 3: Update Tests

- [ ] Update existing test: `handleTaskMoved` no longer sends notification for "done" column
- [ ] Add test: `handleTaskMerged` is the sole source of "merged" notifications
- [ ] Add test: duplicate `task:merged` events for the same task only send one notification
- [ ] Add test: a task can receive both "in-review" and "merged" notifications (different types)
- [ ] Remove or update any tests that expect "done" move to trigger notification

**Artifacts:**
- `packages/engine/src/notifier.test.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/engine` — all notifier tests must pass
- [ ] Run `pnpm test` at root — full suite must pass
- [ ] Build passes with `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Update AGENTS.md if notification behavior documentation needs clarification
- [ ] Create changeset for patch release: `ntfy duplicate notifications fixed`

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — verify the notification events section still matches behavior

## Completion Criteria

- [ ] Only ONE notification sent per task for each event type (in-review, merged, failed)
- [ ] A task can receive in-review notification, then later a merged notification
- [ ] A task can receive in-review notification, then later a failed notification
- [ ] Duplicate events for the same task and type are silently ignored
- [ ] All tests passing
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-106): complete Step N — description`
- **Bug fixes:** `fix(KB-106): description`
- **Tests:** `test(KB-106): description`

## Do NOT

- Add rate limiting logic (ntfy.sh handles that)
- Change the debounce interval (5s is fine for rapid transitions)
- Modify the store event emission pattern (task:moved + task:merged is correct)
- Remove the 5-second debounce entirely (keep it for rapid column transitions)
