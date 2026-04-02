# Task: KB-086 - Add Global Activity Log View to Dashboard

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This feature touches multiple packages (core, dashboard server, dashboard client), requires new data types and storage, and integrates with existing event emission patterns. The blast radius spans the TaskStore, API routes, and React components, but follows established patterns.

**Score:** 5/8 — Blast radius: 2, Pattern novelty: 1, Security: 1, Reversibility: 1

## Mission

Add a global activity log feature that captures task lifecycle events (created, moved, completed, failed, merged) and displays them in a dedicated view accessible from the dashboard header. This provides users with a centralized timeline of all significant events across their task board, complementing the existing per-task activity logs.

## Dependencies

- **None**

## Context to Read First

- `/Users/eclipxe/Projects/kb/packages/core/src/types.ts` — Review `TaskLogEntry` type (line ~95) for existing per-task activity pattern
- `/Users/eclipxe/Projects/kb/packages/core/src/store.ts` — Review `TaskStore` class, especially event emitters (`task:created`, `task:moved`, `task:updated`, `task:merged`, `settings:updated`) and how `NtfyNotifier` listens to them
- `/Users/eclipxe/Projects/kb/packages/engine/src/notifier.ts` — Review how events are consumed (this is the pattern to follow for activity logging)
- `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — Review existing API route patterns
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/Header.tsx` — Review header button patterns
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/components/TerminalModal.tsx` — Review modal component structure to follow
- `/Users/eclipxe/Projects/kb/packages/dashboard/app/api.ts` — Review API client patterns

## File Scope

### Core Package
- `packages/core/src/types.ts` — Add `ActivityLogEntry` and `ActivityEventType` types
- `packages/core/src/store.ts` — Add activity log methods and event listeners

### Dashboard Server
- `packages/dashboard/src/routes.ts` — Add `/activity` GET endpoint

### Dashboard Client
- `packages/dashboard/app/api.ts` — Add `fetchActivityLog()` function
- `packages/dashboard/app/components/ActivityLogModal.tsx` — New modal component
- `packages/dashboard/app/components/Header.tsx` — Add activity log button
- `packages/dashboard/app/App.tsx` — Add modal state management

### Tests
- `packages/core/src/store.test.ts` — Add tests for activity log methods
- `packages/dashboard/app/components/__tests__/ActivityLogModal.test.tsx` — New test file

## Steps

### Step 1: Add Activity Log Types to Core

- [ ] Add `ActivityEventType` union type: `"task:created" | "task:moved" | "task:updated" | "task:deleted" | "task:merged" | "task:failed" | "settings:updated"`
- [ ] Add `ActivityLogEntry` interface with fields: `id` (string), `timestamp` (string), `type` (ActivityEventType), `taskId?` (string), `taskTitle?` (string), `details` (string), `metadata?` (object for extra data like column transitions)
- [ ] Export new types from `packages/core/src/index.ts`
- [ ] Run `pnpm build` in core package to verify

**Artifacts:**
- `packages/core/src/types.ts` (modified)
- `packages/core/src/index.ts` (modified)

### Step 2: Add Activity Log Storage to TaskStore

- [ ] Add `activityLogPath` property pointing to `.fusion/activity-log.jsonl` (JSON Lines format for append-only log)
- [ ] Add `recordActivity(entry: Omit<ActivityLogEntry, "id" | "timestamp">): Promise<ActivityLogEntry>` method that appends to JSONL file with auto-generated ID and timestamp
- [ ] Add `getActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType }): Promise<ActivityLogEntry[]>` method that reads and parses JSONL file (newest first)
- [ ] Add `clearActivityLog(): Promise<void>` method for maintenance
- [ ] Ensure activity log directory is created in `init()` method

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 3: Wire Up Event Listeners in TaskStore

- [ ] In `TaskStore` constructor or initialization, subscribe to existing events:
  - `task:created` → record activity with task title
  - `task:moved` → record activity with from/to columns
  - `task:merged` → record activity with merge result status
  - `task:updated` → record only when status changes to "failed"
  - `settings:updated` → record when ntfy or important settings change
- [ ] Ensure listeners are bound with proper `this` context
- [ ] Keep recording best-effort (errors logged but don't break operations)

**Artifacts:**
- `packages/core/src/store.ts` (modified)

### Step 4: Add API Endpoint

- [ ] Add `GET /api/activity` endpoint in `routes.ts`
- [ ] Support query params: `limit` (default 100, max 1000), `since` (ISO timestamp for pagination), `type` (filter by event type)
- [ ] Return JSON array of `ActivityLogEntry` objects sorted newest first
- [ ] Add `DELETE /api/activity` endpoint for clearing log (optional, for maintenance)

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 5: Add API Client Function

- [ ] Add `fetchActivityLog(options?: { limit?: number; since?: string; type?: string }): Promise<ActivityLogEntry[]>` to `api.ts`
- [ ] Add `clearActivityLog(): Promise<void>` to `api.ts`
- [ ] Re-export `ActivityLogEntry` type from core for convenience

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 6: Create ActivityLogModal Component

- [ ] Create `ActivityLogModal.tsx` following the pattern of `TerminalModal.tsx`:
  - Accept `isOpen: boolean` and `onClose: () => void` props
  - Use `modal-overlay` and `modal` CSS classes
  - Header with title "Activity Log" and close button (X icon)
  - Main content area showing scrollable list of activity entries
- [ ] Each entry should display:
  - Timestamp (formatted nicely, use existing `formatTimestamp` pattern from TaskDetailModal)
  - Event type icon (different icon per type: ✓ for merged, ✗ for failed, → for moved, + for created)
  - Task ID (clickable - opens task detail)
  - Task title (if available)
  - Details text
- [ ] Add filter dropdown for event type (All, Task Created, Task Moved, Task Completed, Task Failed)
- [ ] Add "Load More" button for pagination (using `since` param)
- [ ] Add "Clear Log" button with confirmation dialog (only shown when log has entries)
- [ ] Auto-refresh every 30 seconds when modal is open
- [ ] Handle empty state: "No activity recorded yet"

**Artifacts:**
- `packages/dashboard/app/components/ActivityLogModal.tsx` (new)

### Step 7: Integrate with Header and App

- [ ] Add `Activity` (or `History`) icon button to `Header.tsx` next to the terminal button
- [ ] Use `History` icon from `lucide-react`
- [ ] Add tooltip: "View Activity Log"
- [ ] Add `onOpenActivityLog` prop to `Header` component
- [ ] In `App.tsx`:
  - Add `activityLogOpen` state (boolean)
  - Add `handleOpenActivityLog` and `handleCloseActivityLog` callbacks
  - Pass `onOpenActivityLog` to `Header`
  - Render `<ActivityLogModal isOpen={activityLogOpen} onClose={handleCloseActivityLog} />`

**Artifacts:**
- `packages/dashboard/app/components/Header.tsx` (modified)
- `packages/dashboard/app/App.tsx` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Add tests to `packages/core/src/store.test.ts`:
  - `recordActivity()` appends to log file
  - `getActivityLog()` returns entries newest first
  - `getActivityLog({ limit: 10 })` respects limit
  - `getActivityLog({ type: "task:created" })` filters by type
  - Event listeners record activities on task operations
- [ ] Create `packages/dashboard/app/components/__tests__/ActivityLogModal.test.tsx`:
  - Renders without crashing when open
  - Does not render when closed
  - Displays activity entries correctly
  - Calls onClose when close button clicked
  - Calls API on initial load
  - Filters by type when dropdown changed
- [ ] Run full test suite: `pnpm test`
- [ ] Fix all failures
- [ ] Build passes: `pnpm build`

**Artifacts:**
- `packages/core/src/store.test.ts` (modified)
- `packages/dashboard/app/components/__tests__/ActivityLogModal.test.tsx` (new)

### Step 9: Documentation & Delivery

- [ ] Update `packages/dashboard/README.md` — Add section about Activity Log feature
- [ ] Update `AGENTS.md` if there's a relevant section about dashboard features
- [ ] Create changeset file for this feature (minor bump since it's a new feature)
- [ ] Out-of-scope findings: If you notice the existing `App.tsx` has a merge conflict marker (<<<<<<< HEAD), create a task to fix it

**Artifacts:**
- `packages/dashboard/README.md` (modified)
- `.changeset/add-activity-log.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/dashboard/README.md` — Add "Activity Log" subsection under Features describing the global activity timeline

**Check If Affected:**
- `AGENTS.md` — Check if dashboard features are documented, update if relevant

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Activity log button appears in header
- [ ] Clicking button opens modal showing recent task events
- [ ] Activity entries show timestamp, type, task info, and details
- [ ] Filter dropdown works to show only specific event types
- [ ] Log survives server restarts (persisted to disk)

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-086): complete Step N — description`
- **Bug fixes:** `fix(KB-086): description`
- **Tests:** `test(KB-086): description`

Example commits:
- `feat(KB-086): complete Step 1 — add ActivityLogEntry types`
- `feat(KB-086): complete Step 2 — add activity log storage methods`
- `feat(KB-086): complete Step 6 — create ActivityLogModal component`
- `test(KB-086): add ActivityLogModal component tests`

## Do NOT

- Expand task scope beyond the activity log feature
- Skip tests for the new functionality
- Modify files outside the File Scope without good reason
- Change the existing per-task activity log in TaskDetailModal
- Add real-time WebSocket updates (polling is sufficient for now)
- Implement complex search/filter beyond the type dropdown
- Add export functionality (out of scope)
