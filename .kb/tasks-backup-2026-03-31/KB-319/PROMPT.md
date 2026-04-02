# Task: KB-319 - Implement Proactive Orphaned Task Monitoring

**Created:** 2026-03-31
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This introduces a new background monitoring component that runs periodically and interacts with notification systems. While the pattern is familiar (similar to StuckTaskDetector), it requires careful handling of filesystem edge cases and notification delivery. Review needed for settings integration and test coverage.

**Score:** 4/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Implement a proactive orphaned task monitoring system that periodically scans the `.fusion/tasks/` directory for directories that exist but have missing or corrupted `task.json` files. These "orphaned" task directories may result from failed writes, crashes during task creation, or filesystem corruption. The monitor should detect these issues, log warnings, and optionally send notifications via ntfy.sh to alert administrators early — before users notice missing tasks.

The monitor runs as a background service integrated into the engine startup sequence, similar to `StuckTaskDetector`, with configurable check intervals and opt-out support via settings.

## Dependencies

- **None**

## Context to Read First

Before implementing, read these files to understand patterns and conventions:

1. **`packages/engine/src/stuck-task-detector.ts`** — The reference implementation for background monitoring. Study its class structure, polling pattern, start/stop lifecycle, and logging approach.

2. **`packages/engine/src/notifier.ts`** — The `NtfyNotifier` class shows how to send ntfy.sh notifications. Study the notification payload format and best-effort error handling.

3. **`packages/core/src/types.ts`** (lines 503-653) — Review `ProjectSettings` interface to understand where to add new settings fields. Note the JSDoc documentation pattern for settings.

4. **`packages/core/src/store.ts`** (lines 560-600, 2070-2100) — Study `listTasks()` and how it handles invalid task directories (the `catch { // skip invalid task dirs }` pattern). This is where orphaned tasks currently go unnoticed.

5. **`packages/cli/src/commands/dashboard.ts`** (lines 190-220, 580-610) — See how `StuckTaskDetector` and `NtfyNotifier` are instantiated and started during engine initialization.

## File Scope

**New Files:**
- `packages/engine/src/orphaned-task-detector.ts` — Main detector implementation
- `packages/engine/src/orphaned-task-detector.test.ts` — Unit tests

**Modified Files:**
- `packages/core/src/types.ts` — Add `orphanedTaskCheckEnabled` and `orphanedTaskCheckIntervalMs` to `ProjectSettings`
- `packages/core/src/types.ts` — Update `DEFAULT_PROJECT_SETTINGS` with new defaults
- `packages/engine/src/index.ts` — Export new `OrphanedTaskDetector` class
- `packages/cli/src/commands/dashboard.ts` — Instantiate and start the detector alongside other monitors

## Steps

### Step 1: Add Settings Fields

Add two new optional settings to the `ProjectSettings` interface in `packages/core/src/types.ts`:

- [ ] Add `orphanedTaskCheckEnabled?: boolean` — Default: `true`. When enabled, the detector periodically scans for orphaned task directories.
- [ ] Add `orphanedTaskCheckIntervalMs?: number` — Default: `3600000` (1 hour). The interval between scans in milliseconds. Minimum: `60000` (1 minute).

Update `DEFAULT_PROJECT_SETTINGS` with the defaults.

Follow the JSDoc documentation pattern used for `taskStuckTimeoutMs` (lines 599-604 in types.ts).

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Implement OrphanedTaskDetector

Create `packages/engine/src/orphaned-task-detector.ts` with the following structure:

```typescript
export interface OrphanedTaskDetectorOptions {
  /** Polling interval in milliseconds. Default: 3600000 (1 hour). */
  checkIntervalMs?: number;
  /** Called when orphaned tasks are detected. */
  onOrphaned?: (orphaned: OrphanedTaskInfo[]) => void;
}

export interface OrphanedTaskInfo {
  taskId: string;
  dirPath: string;
  issue: "missing-task-json" | "corrupted-task-json" | "empty-directory";
  details?: string;
}
```

The `OrphanedTaskDetector` class should:

- [ ] Accept `TaskStore` in constructor (for settings access and logging)
- [ ] Implement `start()` and `stop()` methods for lifecycle management
- [ ] Use `setInterval` for periodic checks (similar to `StuckTaskDetector.start()`)
- [ ] Implement `checkNow()` for immediate one-off checks
- [ ] Scan `.fusion/tasks/` directories matching the task ID pattern (`^[A-Z]+-\d+$/`)
- [ ] For each directory, check if `task.json` exists and is valid JSON
- [ ] Detect three issue types:
  - `missing-task-json`: Directory exists but has no `task.json` file
  - `corrupted-task-json`: `task.json` exists but cannot be parsed as valid JSON
  - `empty-directory`: Directory exists but is completely empty
- [ ] Log warnings via `createLogger("orphaned-detector")` for each orphaned task found
- [ ] Call the optional `onOrphaned` callback with the list of detected issues
- [ ] Read settings on each check cycle so changes take effect without restart
- [ ] Skip the check if `orphanedTaskCheckEnabled` is false
- [ ] Respect `orphanedTaskCheckIntervalMs` from settings (with clamping to min 60s)

**Artifacts:**
- `packages/engine/src/orphaned-task-detector.ts` (new)

### Step 3: Add Unit Tests

Create `packages/engine/src/orphaned-task-detector.test.ts` with comprehensive tests:

- [ ] Test detector starts and stops correctly
- [ ] Test detects missing task.json
- [ ] Test detects corrupted/invalid JSON in task.json
- [ ] Test detects empty directories
- [ ] Test respects `orphanedTaskCheckEnabled` setting (skips when disabled)
- [ ] Test respects `checkIntervalMs` setting
- [ ] Test `checkNow()` triggers immediate check
- [ ] Test `onOrphaned` callback receives correct data
- [ ] Test logs warnings appropriately
- [ ] Test does not flag valid task directories
- [ ] Test multiple orphaned tasks in single scan
- [ ] Test minimum interval clamping (60 seconds)

Use the test patterns from `stuck-task-detector.test.ts` for mocking and structure.

**Artifacts:**
- `packages/engine/src/orphaned-task-detector.test.ts` (new)

### Step 4: Export from Engine Index

Add the export to `packages/engine/src/index.ts`:

- [ ] Export `OrphanedTaskDetector` class
- [ ] Export `OrphanedTaskDetectorOptions` interface
- [ ] Export `OrphanedTaskInfo` interface

**Artifacts:**
- `packages/engine/src/index.ts` (modified)

### Step 5: Integrate into Dashboard Command

Modify `packages/cli/src/commands/dashboard.ts`:

- [ ] Import `OrphanedTaskDetector` from `@kb/engine`
- [ ] Instantiate `OrphanedTaskDetector` after `stuckTaskDetector` (around line 195)
- [ ] Start the detector after other monitors: `orphanedTaskDetector.start()`
- [ ] Add an `onOrphaned` callback that sends ntfy notifications when orphaned tasks are detected
- [ ] The notification should include: count of orphaned tasks, their IDs, and brief issue summary
- [ ] Only send notifications if `ntfyEnabled` is true and `ntfyTopic` is configured
- [ ] Ensure the detector is properly cleaned up on shutdown (no explicit cleanup needed if using standard intervals)

**Example notification format:**
```
Title: "Orphaned Tasks Detected"
Message: "Found 3 orphaned task directories: KB-001 (missing task.json), KB-045 (corrupted task.json), KB-089 (empty directory). Check .fusion/tasks/ for details."
Priority: "high"
```

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all existing tests must pass
- [ ] New tests in `orphaned-task-detector.test.ts` must pass
- [ ] Build passes: `pnpm build`
- [ ] TypeScript type checking passes
- [ ] Test manually by:
  1. Creating a task directory without task.json in `.fusion/tasks/`
  2. Creating a task directory with malformed JSON
  3. Creating an empty task directory
  4. Starting the dashboard and verifying warnings appear in logs
  5. Verifying ntfy notifications are sent (if configured)

### Step 7: Documentation & Delivery

- [ ] Create changeset file: `.changeset/add-orphaned-task-detector.md` (patch level — new feature)
- [ ] The changeset should describe the new orphaned task monitoring feature
- [ ] Verify all files in File Scope are modified as expected
- [ ] Verify no files outside File Scope were modified

**Changeset content:**
```markdown
---
"@dustinbyrne/kb": patch
---

Add proactive orphaned task monitoring. The engine now periodically scans for task directories with missing or corrupted task.json files and logs warnings. When ntfy notifications are enabled, alerts are sent for early intervention.
```

## Documentation Requirements

**Must Update:**
- `packages/core/src/types.ts` — Add settings fields with JSDoc documentation
- `packages/engine/src/index.ts` — Add exports

**No additional docs required** — this is an internal monitoring feature that doesn't require user-facing documentation changes.

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Settings changes follow existing patterns
- [ ] Orphaned tasks are correctly detected (missing JSON, corrupted JSON, empty dirs)
- [ ] Warnings are logged when orphaned tasks are found
- [ ] ntfy notifications sent when enabled and orphaned tasks detected
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-319): complete Step N — description`
- **Bug fixes:** `fix(KB-319): description`
- **Tests:** `test(KB-319): description`

## Do NOT

- Modify task directories automatically (the detector only reports, never repairs)
- Delete any files or directories (read-only monitoring only)
- Send notifications if `ntfyEnabled` is false
- Run checks more frequently than the minimum 60-second clamp
- Break existing `listTasks()` behavior — it should continue skipping invalid dirs
- Add UI controls for these settings (engine-only configuration for now)
