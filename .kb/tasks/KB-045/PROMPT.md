# Task: KB-045 - Add Scheduled Tasks (Cron Jobs) to Dashboard

**Created:** 2026-03-30
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This feature spans the entire stack—core types, store operations, engine scheduling, REST API, and dashboard UI. It introduces persistent cron-based execution with potential security implications (arbitrary command execution). Full review required due to blast radius across all packages and security considerations.

**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Add a cron-based scheduled task system to kb that allows users to create, manage, and monitor automated tasks that run on user-defined schedules. The system supports preset intervals (hourly, daily, weekly, monthly) and custom cron expressions. Each scheduled task tracks its last run time and execution history. A dedicated dashboard view provides full CRUD operations for schedules.

This enables automated workflows like periodic dependency updates, scheduled reports, or recurring maintenance tasks without manual intervention.

## Dependencies

- **None**

## Context to Read First

### Core Domain Model
- `packages/core/src/types.ts` — Task type definitions, Column types, Settings interface. Note the pattern for optional fields and timestamps.
- `packages/core/src/store.ts` — TaskStore class with CRUD operations, file locking, atomic writes, and event emission patterns. Study `createTask`, `updateTask`, `atomicWriteTaskJson` patterns.

### Dashboard API
- `packages/dashboard/src/routes.ts` — REST API route patterns. Note the error handling patterns, validation, and how routes interact with TaskStore.
- `packages/dashboard/src/server.ts` — Server setup and route mounting.

### Dashboard UI
- `packages/dashboard/app/api.ts` — Frontend API client patterns. Study how API calls are wrapped with error handling.
- `packages/dashboard/app/components/SettingsModal.tsx` — Complex modal with tabs, form state management, and async operations.
- `packages/dashboard/app/App.tsx` — Main app component showing how modals are managed and state flows.

### Engine/Scheduler
- `packages/engine/src/scheduler.ts` — How the scheduler polls and triggers work. Study the re-entrance guard, async patterns, and integration with store events.

### Package Structure
- `packages/core/package.json` — Note exports and dependencies (none, pure TypeScript).
- `packages/dashboard/package.json` — Note express, react dependencies.
- `packages/engine/package.json` — Note dependencies on @kb/core.

## File Scope

### New Files (Core)
- `packages/core/src/automation.ts` — Automation types, ScheduledTask interface, execution result types
- `packages/core/src/automation-store.ts` — AutomationStore class with CRUD, scheduling logic, persistence

### New Files (Engine)
- `packages/engine/src/cron-runner.ts` — CronRunner class that polls schedules and executes tasks

### New Files (Dashboard UI)
- `packages/dashboard/app/components/ScheduledTasksModal.tsx` — Main modal for viewing/managing scheduled tasks
- `packages/dashboard/app/components/ScheduleForm.tsx` — Form for creating/editing schedules
- `packages/dashboard/app/components/ScheduleCard.tsx` — Individual schedule item display

### Modified Files
- `packages/core/src/index.ts` — Export new automation types and store
- `packages/core/src/types.ts` — Add Automation types (if extending existing types)
- `packages/dashboard/src/routes.ts` — Add REST API endpoints for automations
- `packages/dashboard/app/api.ts` — Add API client methods for scheduled tasks
- `packages/dashboard/app/App.tsx` — Add scheduled tasks modal integration
- `packages/dashboard/app/components/Header.tsx` — Add menu/button to open scheduled tasks
- `packages/cli/src/commands/dashboard.ts` — Initialize and start the CronRunner alongside scheduler

## Steps

### Step 1: Core Types and Automation Store

- [ ] Create `packages/core/src/automation.ts` with types:
  - `ScheduleType`: "hourly" | "daily" | "weekly" | "monthly" | "custom"
  - `ScheduledTask` interface: id, name, description, scheduleType, cronExpression, command, enabled, lastRunAt, lastRunResult, nextRunAt, runCount, createdAt, updatedAt
  - `AutomationRunResult` interface: success, output, error, startedAt, completedAt
  - `AUTOMATION_PRESETS` mapping preset types to cron expressions
- [ ] Create `packages/core/src/automation-store.ts` with `AutomationStore` class:
  - Store location: `.fusion/automations/` directory with one JSON file per schedule
  - Methods: `createSchedule(input)`, `updateSchedule(id, updates)`, `deleteSchedule(id)`, `getSchedule(id)`, `listSchedules()`, `recordRun(id, result)`
  - EventEmitter pattern matching TaskStore: `schedule:created`, `schedule:updated`, `schedule:deleted`, `schedule:run`
  - File locking pattern matching TaskStore for atomic writes
  - Method `getDueSchedules()` returning schedules where nextRunAt <= now
  - Method `computeNextRun(cronExpression, fromDate?)` using `cron-parser` package
- [ ] Export from `packages/core/src/index.ts`
- [ ] Write unit tests for AutomationStore in `packages/core/src/automation-store.test.ts`

**Artifacts:**
- `packages/core/src/automation.ts` (new)
- `packages/core/src/automation-store.ts` (new)
- `packages/core/src/automation-store.test.ts` (new)

### Step 2: Cron Runner (Engine)

- [ ] Add `cron-parser` dependency to `packages/engine/package.json`
- [ ] Create `packages/engine/src/cron-runner.ts`:
  - `CronRunner` class taking `TaskStore` and `AutomationStore`
  - Poll interval: 60 seconds (configurable)
  - `start()` method: begins polling loop
  - `stop()` method: stops polling loop
  - `executeSchedule(schedule)` method:
    - Log start to schedule history
    - Execute the command using Node.js `child_process.exec` with timeout (5 min default)
    - Record result via `automationStore.recordRun()`
    - Handle success/failure, capture stdout/stderr
  - `tick()` method: calls `getDueSchedules()`, filters enabled schedules, executes each
  - Re-entrance guard like Scheduler (don't run if already running)
  - Event listeners: pause when `globalPause` or `enginePaused` settings are true
- [ ] Write unit tests for CronRunner in `packages/engine/src/cron-runner.test.ts`

**Artifacts:**
- `packages/core/package.json` (modified — add cron-parser to dependencies)
- `packages/engine/src/cron-runner.ts` (new)
- `packages/engine/src/cron-runner.test.ts` (new)

### Step 3: REST API Routes

- [ ] In `packages/dashboard/src/routes.ts`, add automation routes:
  - `GET /api/automations` — List all scheduled tasks
  - `POST /api/automations` — Create new schedule (body: name, description, scheduleType, cronExpression?, command, enabled)
  - `GET /api/automations/:id` — Get single schedule with run history
  - `PATCH /api/automations/:id` — Update schedule (body: partial updates)
  - `DELETE /api/automations/:id` — Delete schedule
  - `POST /api/automations/:id/run` — Trigger manual run immediately
  - `POST /api/automations/:id/toggle` — Toggle enabled/disabled
- [ ] Validation: name required, command required, scheduleType must be valid, cronExpression required for custom type and must be valid cron syntax
- [ ] Error handling: 400 for validation errors, 404 for missing schedules, 500 for internal errors

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)
- `packages/dashboard/src/routes.test.ts` (modified — add automation route tests)

### Step 4: Dashboard API Client

- [ ] In `packages/dashboard/app/api.ts`, add methods:
  - `fetchAutomations(): Promise<ScheduledTask[]>`
  - `fetchAutomation(id: string): Promise<ScheduledTaskDetail>`
  - `createAutomation(input): Promise<ScheduledTask>`
  - `updateAutomation(id, updates): Promise<ScheduledTask>`
  - `deleteAutomation(id): Promise<void>`
  - `runAutomation(id): Promise<void>` — manual trigger
  - `toggleAutomation(id): Promise<ScheduledTask>`
- [ ] Add TypeScript interfaces matching the API responses

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)

### Step 5: UI Components

- [ ] Create `packages/dashboard/app/components/ScheduleForm.tsx`:
  - Props: `schedule?` (for editing), `onSubmit`, `onCancel`
  - Form fields: name (text), description (textarea), scheduleType (select with presets + custom), cronExpression (text, shown only for custom), command (text), enabled (checkbox)
  - Validation: show inline errors for invalid cron
  - Preset selection auto-fills cronExpression (disabled for presets, enabled for custom)
  - Submit button: "Create Schedule" or "Save Changes"

- [ ] Create `packages/dashboard/app/components/ScheduleCard.tsx`:
  - Props: `schedule`, `onEdit`, `onDelete`, `onRun`, `onToggle`
  - Display: name, description, schedule badge (hourly/daily/etc), next run time, last run result (success/failure badge), run count
  - Actions: Run now (play button), Enable/Disable toggle, Edit, Delete (with confirmation)
  - Relative time display for next/last run (e.g., "in 2 hours", "2 hours ago")

- [ ] Create `packages/dashboard/app/components/ScheduledTasksModal.tsx`:
  - Full-page modal like SettingsModal
  - Header: "Scheduled Tasks" with close button
  - List view of all schedules using ScheduleCard
  - "New Schedule" button opening ScheduleForm in create mode
  - Empty state when no schedules exist
  - Real-time updates: subscribe to SSE or refresh on events

- [ ] Update `packages/dashboard/app/components/Header.tsx`:
  - Add "Schedules" button/icon in header
  - onClick opens ScheduledTasksModal

**Artifacts:**
- `packages/dashboard/app/components/ScheduleForm.tsx` (new)
- `packages/dashboard/app/components/ScheduleCard.tsx` (new)
- `packages/dashboard/app/components/ScheduledTasksModal.tsx` (new)
- `packages/dashboard/app/components/Header.tsx` (modified)

### Step 6: App Integration

- [ ] In `packages/dashboard/app/App.tsx`:
  - Add `schedulesOpen` state
  - Add handler to open/close ScheduledTasksModal
  - Pass `onOpenSchedules` to Header
  - Render `ScheduledTasksModal` when `schedulesOpen` is true
- [ ] Ensure modal stacks properly with other modals (Settings, Task Detail, etc.)

**Artifacts:**
- `packages/dashboard/app/App.tsx` (modified)

### Step 7: CLI Integration

- [ ] In `packages/cli/src/commands/dashboard.ts`:
  - Import `AutomationStore` from `@kb/core`
  - Import `CronRunner` from `@kb/engine`
  - Initialize `automationStore` after `taskStore.init()`
  - Create `CronRunner` instance with both stores
  - Start cron runner: `cronRunner.start()`
  - Stop cron runner on SIGINT: `cronRunner.stop()`
  - Pass `automationStore` to `createServer` via options (so routes can access it)

- [ ] Update `packages/dashboard/src/server.ts` ServerOptions to include `automationStore`
- [ ] Update route creation to pass `automationStore` to `createApiRoutes`

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)
- `packages/dashboard/src/server.ts` (modified)
- `packages/dashboard/src/routes.ts` (modified — accept automationStore)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all core tests pass
- [ ] Run `pnpm test` — all engine tests pass  
- [ ] Run `pnpm test` — all dashboard tests pass
- [ ] Build passes: `pnpm build`
- [ ] Typecheck passes: `pnpm typecheck`
- [ ] Manual verification:
  - Create schedule with hourly preset → verify cron expression auto-filled
  - Create schedule with custom cron → verify validation
  - Toggle schedule enabled/disabled → verify state persists
  - Trigger manual run → verify execution and result recording
  - Wait for scheduled run → verify automatic execution
  - Delete schedule → verify removal
  - Verify last run time displays correctly

### Step 9: Documentation & Delivery

- [ ] Create changeset file: `.changeset/add-scheduled-tasks.md` with minor bump for `@dustinbyrne/kb`
- [ ] Update `packages/core/README.md` with AutomationStore API (if exists)
- [ ] Verify no debug code, console.logs, or TODOs left in production code
- [ ] Out-of-scope findings: If UI patterns need refactoring, create follow-up task via `task_create`

## Documentation Requirements

**Must Update:**
- `.changeset/add-scheduled-tasks.md` — Describe new scheduled tasks feature for changelog

**Check If Affected:**
- `README.md` — Add section on scheduled tasks if user-facing docs exist
- `AGENTS.md` — No changes needed (internal architecture)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passing (`pnpm build`)
- [ ] Typecheck passing (`pnpm typecheck`)
- [ ] Manual verification of create/edit/delete/run/toggle flows
- [ ] Cron expressions correctly parsed and schedules execute at expected times
- [ ] Last run time and result displayed in UI
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-045): complete Step N — description`
- **Bug fixes:** `fix(KB-045): description`
- **Tests:** `test(KB-045): description`

Example commits:
```
feat(KB-045): complete Step 1 — add core automation types and store
feat(KB-045): complete Step 2 — add cron runner engine
feat(KB-045): complete Step 3 — add REST API routes for automations
feat(KB-045): complete Step 4 — add API client methods
feat(KB-045): complete Step 5 — add UI components for scheduled tasks
feat(KB-045): complete Step 6 — integrate into App.tsx
feat(KB-045): complete Step 7 — integrate into CLI dashboard command
feat(KB-045): complete Step 8 — testing and verification
test(KB-045): add automation store unit tests
test(KB-045): add cron runner unit tests
```

## Do NOT

- **Execute arbitrary commands without timeout** — All schedule executions must have configurable timeouts (default 5 min) to prevent runaway processes
- **Run schedules during globalPause** — CronRunner must respect the `globalPause` setting and skip executions when paused
- **Allow invalid cron expressions** — Validate all cron expressions using cron-parser before saving
- **Store credentials in schedule commands** — Commands are stored plaintext; do not encourage or allow credential storage
- **Break existing TaskStore patterns** — Follow the file locking, atomic write, and event emission patterns exactly
- **Skip accessibility** — All form inputs must have proper labels, buttons must have aria-labels where icon-only
- **Use client-side cron calculation only** — Server must compute nextRunAt; client can display but authoritative calculation is server-side
- **Poll more frequently than 60 seconds** — Default poll interval is 60 seconds to avoid excessive CPU; configurable but minimum 10 seconds

## Security Considerations

1. **Command Execution**: The `command` field in schedules will be executed via `child_process.exec`. This is inherently dangerous:
   - Commands run with the user's permissions
   - No shell injection protection beyond basic validation
   - Document that this feature is for trusted users only
   - Consider future enhancement: whitelist allowed commands/patterns

2. **Timeout Protection**: All executions must have a timeout to prevent hanging processes (default 5 minutes, configurable per schedule).

3. **Output Capture**: stdout/stderr should be captured but limited in size (e.g., max 1MB each) to prevent memory exhaustion from verbose commands.

4. **No Concurrent Runs**: Same schedule should not run concurrently — if still running when next tick fires, skip and log.

## Future Enhancements (Out of Scope)

These are noted for potential follow-up tasks but NOT part of this implementation:

- Email/webhook notifications on schedule failure
- Schedule execution history with log viewing
- Schedule templates (predefined command patterns)
- Schedule run dependencies (run B only if A succeeded)
- Schedule output artifact capture
- Pause schedules individually (currently only global pause)
