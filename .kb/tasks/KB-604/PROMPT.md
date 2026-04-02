# Task: KB-604 - Include task title or description in ntfy notifications

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Small, localized change to notification message formatting in a single file with well-defined test coverage.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Enhance ntfy push notifications to include meaningful task context when no title is set. Currently notifications use `task.title ?? task.id`, falling back to the task ID when no title exists. Update the fallback behavior to use the first 200 characters of the task description instead of the task ID. This makes notifications actionable even for tasks without explicit titles.

## Dependencies

- **None**

## Context to Read First

- `packages/engine/src/notifier.ts` — The NtfyNotifier class that sends notifications (lines 95, 111, 126 show current `task.title ?? task.id` pattern)
- `packages/engine/src/notifier.test.ts` — Existing test suite with notification assertions
- `packages/core/src/types.ts` — Task type definition (title, description fields)

## File Scope

- `packages/engine/src/notifier.ts` (modify)
- `packages/engine/src/notifier.test.ts` (modify)

## Steps

### Step 1: Update Notification Message Format

- [ ] Create helper function `formatTaskIdentifier(task: Task): string` in `notifier.ts` that:
  - Returns `"{title}"` (just the title text) if title exists
  - Returns `"{id}: {first 200 chars of description}"` if no title (truncate with "..." if > 200 chars)
- [ ] Update `handleTaskMoved` (line 95) to use the helper: change `task.title ?? task.id` to `formatTaskIdentifier(task)`
- [ ] Update `handleTaskUpdated` (line 111) to use the helper: change `task.title ?? task.id` to `formatTaskIdentifier(task)`
- [ ] Update `handleTaskMerged` (line 126) to use the helper: change `result.task.title ?? result.task.id` to `formatTaskIdentifier(result.task)`
- [ ] Keep notification titles unchanged (e.g., "Task KB-001 completed")
- [ ] Keep message templates unchanged — only the identifier portion changes

**Artifacts:**
- `packages/engine/src/notifier.ts` (modified)

### Step 2: Update Tests

- [ ] Update existing test assertions that expect `"KB-001"` in the body when no title is present
- [ ] Add test case for task with title (uses title in body, e.g., `"Task \"Test Task\" is ready for review"`)
- [ ] Add test case for task without title (uses `"KB-001: {description snippet}"` format)
- [ ] Add test case for description exactly at 200 char boundary (no truncation needed)
- [ ] Add test case for description over 200 chars (verifies truncation with "...")
- [ ] Run tests: `pnpm test packages/engine/src/notifier.test.ts`

**Artifacts:**
- `packages/engine/src/notifier.test.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Run build: `pnpm build`
- [ ] Verify all notifier tests pass

### Step 4: Documentation & Delivery

- [ ] Update `AGENTS.md` lines 264-291 (the ntfy section) — add a bullet after the configuration example explaining: "Notifications include the task title when available, or fall back to a truncated task description snippet (first 200 characters) when no title is set."
- [ ] Create changeset for patch release:
  ```bash
  cat > .changeset/include-task-context-in-notifications.md << 'EOF'
  ---
  "@dustinbyrne/kb": patch
  ---

  Include task title or description snippet in ntfy push notifications for better context.
  EOF
  ```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Notification messages include task title when available
- [ ] Notification messages fall back to first 200 chars of description (prefixed with task ID) when no title
- [ ] Messages are truncated with "..." when description exceeds 200 characters
- [ ] AGENTS.md updated with notification content behavior

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-604): complete Step N — description`
- **Bug fixes:** `fix(KB-604): description`
- **Tests:** `test(KB-604): description`

## Do NOT

- Change the notification title format (keep "Task KB-XXX completed/failed/merged")
- Change priority levels or notification event types
- Modify any files outside of notifier.ts, notifier.test.ts, and AGENTS.md
- Skip the changeset creation (user-facing improvement deserves a patch note)
- Remove the task ID from the fallback format — keep "{id}: {description}" when no title
