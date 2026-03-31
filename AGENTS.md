# Project Guidelines

## Finalizing changes

When making changes that affect published packages, create a changeset file:

```bash
cat > .changeset/<short-description>.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Short description of the change.
EOF
```

Bump types:

- **patch**: bug fixes, internal changes
- **minor**: new features, new CLI commands, new tools
- **major**: breaking changes

Include the changeset file in the same commit as the code change. The filename should be a short kebab-case description (e.g. `fix-merge-conflict.md`, `add-retry-button.md`).

Only create changesets for changes that affect the published `@dustinbyrne/kb` package — user-facing features, bug fixes, CLI changes, tool changes. Do NOT create changesets for internal docs (AGENTS.md, README), CI config, or refactors that don't change behavior.

## Package Structure

- `@kb/core` — domain model, task store (private, not published)
- `@kb/dashboard` — web UI + API server (private, not published)
- `@kb/engine` — AI agents: triage, executor, reviewer, merger, scheduler (private, not published)
- `@dustinbyrne/kb` — CLI + pi extension (published to npm)

Only `@dustinbyrne/kb` is published. The others are internal workspace packages.

## SQLite Storage Architecture

kb uses a hybrid storage architecture: structured metadata lives in SQLite while large blob files remain on the filesystem.

### Database Location

- **Project database:** `.kb/kb.db` — SQLite database with WAL mode enabled
- **Blob files:** `.kb/tasks/{ID}/PROMPT.md`, `agent.log`, `attachments/` — remain on filesystem
- **Global settings:** `~/.pi/kb/settings.json` — remains file-based (not in SQLite)

### Tables

| Table | Purpose |
|-------|---------|
| `tasks` | Task metadata with JSON columns for nested arrays/objects |
| `config` | Single-row project config (nextId, settings, workflowSteps) |
| `activityLog` | Activity log entries with indexed timestamp/type/taskId |
| `archivedTasks` | Compact archived task entries (full metadata as JSON) |
| `automations` | Scheduled automation definitions |
| `agents` | Agent state and metadata |
| `agentHeartbeats` | Agent heartbeat events (FK cascade from agents) |
| `__meta` | Schema version and change detection timestamp |

### WAL Mode & Concurrency

The database runs in WAL (Write-Ahead Logging) mode for concurrent reader/writer access. Foreign keys are enforced per connection. Change detection uses a monotonic `lastModified` timestamp in the `__meta` table.

### Auto-Migration from Legacy Storage

On first run, if legacy file-based data exists (`.kb/tasks/`, `.kb/config.json`, etc.) but no `.kb/kb.db`, the system automatically migrates all data to SQLite:

1. Config, tasks, activity log, archive, automations, and agents are migrated
2. Original files are backed up (`.bak` suffix)
3. Blob files (PROMPT.md, agent.log, attachments) remain in place
4. Individual `task.json` files are renamed to `task.json.bak`
5. Migration is idempotent — re-running with an existing database is a no-op

### Recovery

If something goes wrong after migration:
- Backup files (`.bak`) contain the original data
- Delete `.kb/kb.db` and rename `.bak` files back to restore legacy storage
- The system will re-migrate on next startup

### JSON Columns

Nested data (arrays, objects) is stored as JSON text in SQLite columns:
- Array columns: `dependencies`, `steps`, `log`, `attachments`, `steeringComments`, etc.
- Nullable object columns: `prInfo`, `issueInfo`, `lastRunResult`
- Use `toJson()` for array columns, `toJsonNullable()` for nullable object columns
- Use `fromJson<T>()` to parse JSON columns back to TypeScript types

## Testing

```bash
pnpm test          # run all tests
pnpm build         # build all packages
```

Tests are required. Typechecks and manual verification are not substitutes for real tests with assertions.

## Pi Extension (`packages/cli/src/extension.ts`)

The pi extension provides tools and a `/kb` command for interacting with kb from within a pi session. It ships as part of `@dustinbyrne/kb` — one `pi install` gives you both the CLI and the extension.

Update it when:

- **CLI commands change** — if `kb task create`, `kb task list`, `kb task show`, `kb task attach`, `kb task pause`, or `kb task unpause` change their behavior, flags, or output, update the corresponding tool in `packages/cli/src/extension.ts`.
- **Task store API changes** — the extension calls `TaskStore` directly (`createTask`, `listTasks`, `getTask`, `addAttachment`, `pauseTask`). If these methods change signature or behavior, update the extension.
- **New user-facing features** — if a new CLI command is added that the chat agent should be able to use (task creation, status checking, automation control), add a tool for it.

**Don't** add tools for engine-internal operations (move, step updates, logging, merge) — those are handled by the engine's own agents.

The extension has no skills — tool descriptions, `promptSnippet`, and `promptGuidelines` give the LLM everything it needs.

## Dashboard Task Creation

The dashboard provides two UI surfaces for creating tasks:

### QuickEntryBox (List View) and InlineCreateCard (Board View)

Both components provide the same task creation experience with the following options:

- **Description input** — Type the task description. Press Enter to create immediately, or use the action buttons for AI-assisted creation.
- **Deps button** — Add task dependencies before creation.
- **Models button** — Override the default AI models for this task (executor and validator).
- **Plan button** (Lightbulb icon) — Opens the AI Planning Mode modal with the current description pre-filled. This allows refining the task through an interactive Q&A before creation.
- **Subtask button** (ListTree icon) — Opens the subtask breakdown dialog with the current description pre-filled. The dialog generates 2–5 AI-suggested subtasks, lets the user edit titles, descriptions, sizes, and dependencies, and then creates all subtasks in one action.

**Behavior:**
- Both Plan and Subtask buttons are disabled when no description is entered.
- Clicking either button clears the input after triggering the action.
- Regular task creation (Enter key) works as before without AI assistance.

### Subtask Breakdown Dialog

The subtask breakdown dialog (accessed via the Subtask button) allows users to break down a task into smaller, manageable subtasks with the following features:

- **AI-generated subtasks** — The AI suggests 2–5 subtasks based on the task description. Users can edit titles, descriptions, sizes, and dependencies before creating.
- **Drag-and-drop reordering** — Each subtask row has a drag handle (grip icon) on the left. Users can drag subtasks up or down to reorder them, which affects the execution order.
- **Keyboard reordering** — Up and down arrow buttons next to each subtask provide an accessible alternative to drag-and-drop for keyboard users.
- **Dependency validation** — The dependency selector only shows subtasks that come before the current one in the list, preventing circular dependencies. First subtasks cannot have dependencies.
- **Visual feedback during drag** — Dragging a subtask shows reduced opacity on the dragged item and a highlight border on potential drop targets with a line indicator showing insertion position (before/after).

**CSS classes for drag states:**
- `.subtask-item-dragging` — Applied to the subtask being dragged (opacity: 0.5)
- `.subtask-item-drop-target` — Applied to the subtask being hovered over as a drop target
- `.subtask-item-drop-before` / `.subtask-item-drop-after` — Shows insertion line indicator
- `.subtask-drag-handle` — The grip icon container with grab/grabbing cursor states

## Dashboard badge WebSockets

GitHub PR and issue badges in the dashboard now have a dedicated real-time WebSocket channel at `/api/ws`.

### Frontend hook: `packages/dashboard/app/hooks/useBadgeWebSocket.ts`

Use `useBadgeWebSocket()` when a UI surface needs live badge snapshots for specific tasks.

- The hook uses a **shared singleton socket** so multiple `TaskCard` instances do not open duplicate WebSocket connections.
- Subscribe with `subscribeToBadge(taskId)` only when the card is visible and already has `prInfo` and/or `issueInfo`.
- Always pair subscriptions with `unsubscribeFromBadge(taskId)` on unmount or when the card leaves the viewport.
- Treat websocket payloads as **timestamped badge snapshots**. Merge them with task data using freshness comparisons so stale cached websocket data does not override newer SSE/task state.
- Preserve omitted fields on partial updates; only treat explicit `null` payloads as badge clears.

### Server-side expectations

- `/api/ws` is badge-specific; do **not** reuse it for general task updates.
- Badge broadcasts should contain only `prInfo` / `issueInfo` snapshot data, never full task objects.
- Badge updates are now **push-based via GitHub App webhooks** at `POST /api/github/webhooks`.
- The server verifies webhook signatures using `KB_GITHUB_WEBHOOK_SECRET`, fetches canonical badge state with GitHub App installation tokens, and broadcasts updates via the existing `task:updated` → `/api/ws` bridge.
- Keep the existing 5-minute refresh endpoints (`/api/tasks/:id/pr/status`, `/api/tasks/:id/issue/status`) as a fallback path when webhook delivery is unavailable.

## Git

- Commit messages: `feat(KB-XXX):`, `fix(KB-XXX):`, `test(KB-XXX):`
- One commit per step (not per file change)
- Always include the task ID prefix

## Settings

kb uses a two-tier settings hierarchy:

- **Global settings** — User preferences stored in `~/.pi/kb/settings.json`. These persist across all kb projects for the current user.
- **Project settings** — Project-specific workflow and resource settings stored in `.kb/config.json`. These control how the engine operates for a particular project.

When reading settings, project values override global values. The merged view is what the engine and dashboard use.

### Settings Hierarchy

**Global settings** (`~/.pi/kb/settings.json`):
- `themeMode` — UI theme preference (dark/light/system)
- `colorTheme` — Color theme (default/ocean/forest/etc)
- `defaultProvider` — Default AI model provider
- `defaultModelId` — Default AI model ID
- `defaultThinkingLevel` — Default thinking effort level
- `ntfyEnabled` — Enable push notifications
- `ntfyTopic` — ntfy.sh topic for notifications

**Project settings** (`~/.kb/config.json`):
- All other settings listed below (concurrency, merge, worktrees, commands, etc.)

The dashboard Settings modal shows scope indicators (🌐 global, 📁 project) in the sidebar to help users understand where each setting is stored. Saving only updates the scope matching the active section.

### API Endpoints

- `GET /api/settings` — Returns the merged view (project overrides global)
- `PUT /api/settings` — Updates project-level settings only (rejects global-only fields with 400)
- `GET /api/settings/global` — Returns global settings
- `PUT /api/settings/global` — Updates global settings
- `GET /api/settings/scopes` — Returns settings separated by scope: `{ global, project }`

The following settings are available in the kb configuration:

### `autoResolveConflicts` (default: `true`)

When enabled, the auto-merge system will intelligently resolve common merge conflict patterns without requiring manual intervention:

- **Lock files** (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`, etc.) — automatically resolved using the current branch's version ("ours")
- **Generated files** (`*.gen.ts`, `dist/*`, `coverage/*`, etc.) — automatically resolved using the branch's fresh generation ("theirs")
- **Trivial conflicts** (whitespace-only differences) — automatically resolved

When a merge encounters conflicts and the AI agent fails to resolve them on the first attempt, the system implements a 3-attempt retry logic with escalating strategies:

1. **Attempt 1**: Standard merge with AI agent using full context
2. **Attempt 2**: Auto-resolve lock/generated files, then retry AI with simplified context
3. **Attempt 3**: Use `git merge -X theirs` strategy for remaining conflicts

If all 3 attempts fail, the task remains in "in-review" for manual resolution. The per-task retry counter (`mergeRetries`) tracks how many attempts have been made.

To disable automatic conflict resolution and require manual intervention for all conflicts:

```json
{
  "settings": {
    "autoResolveConflicts": false
  }
}
```

### `smartConflictResolution` (default: `true`)

Alias for `autoResolveConflicts`. When enabled, enables automatic resolution of:
- Lock files using "ours" strategy (keep current branch's version)
- Generated files using "theirs" strategy (keep branch's fresh generation)  
- Trivial whitespace conflicts via `git diff-tree -w`

This setting is preferred for new configurations. If both settings are present, `smartConflictResolution` takes precedence.

### `requirePlanApproval` (default: `false`)

When enabled, AI-generated task specifications require manual approval before the task can move from "triage" to "todo". 

**How it works:**
- After the AI reviewer approves a specification, instead of automatically moving to "todo", the task remains in "triage" with status `"awaiting-approval"`
- Users can review the PROMPT.md in the task detail modal
- Users can click "Approve Plan" to move the task to "todo" and begin execution
- Users can click "Reject Plan" to discard the specification and trigger regeneration

To enable manual plan approval:

```json
{
  "settings": {
    "requirePlanApproval": true
  }
}
```

### `ntfyEnabled` (default: `false`)

When true, enables ntfy.sh push notifications for task completion and failures.

**Notification events:**
- Task moves to "in-review" — "Task completed — ready for review"
- Task moves to "done" — "Task merged to main"
- Task status becomes "failed" — "Task failed" (high priority)

**Configuration:**
1. Go to https://ntfy.sh and pick a unique topic name (or self-host ntfy)
2. Open dashboard Settings → Notifications
3. Enable notifications and enter your topic name
4. Install the ntfy app on your phone/desktop and subscribe to your topic

```json
{
  "settings": {
    "ntfyEnabled": true,
    "ntfyTopic": "my-kb-notifications"
  }
}
```

**Notes:**
- No authentication required for public topics (keep it simple)
- Topic must be 1–64 alphanumeric/hyphen/underscore characters
- Notifications are best-effort: failures are logged but don't block task execution

### `taskStuckTimeoutMs` (default: `undefined` — disabled)

Timeout in milliseconds for detecting stuck tasks. When a task's agent session shows no activity (no text deltas, tool calls, or progress updates) for longer than this duration, the task is considered stuck and will be terminated and retried.

**How it works:**
- The `StuckTaskDetector` polls tracked in-progress tasks every 30 seconds
- When no agent activity is detected for longer than `taskStuckTimeoutMs`, the detector:
  1. Terminates the stuck agent session
  2. Logs the event to the task log
  3. Moves the task back to "todo" (preserving current step progress)
  4. The scheduler picks it up for retry, resuming from where it left off

**Suggested value:** `600000` (10 minutes)

```json
{
  "settings": {
    "taskStuckTimeoutMs": 600000
  }
}
```

**Notes:**
- When `undefined` (default), stuck task detection is completely disabled
- Activity is tracked on text deltas, tool calls, tool results, and step status updates
- Recovery preserves step progress — the task resumes from the current step, not from scratch
- When the timeout value is changed (e.g., reduced from 30 to 10 minutes), the system immediately checks for stuck tasks under the new timer rather than waiting for the next 30-second poll cycle
- Paused tasks are automatically untracked from monitoring
- The timeout is read from settings on every poll cycle, so changes take effect immediately
- When the timeout value is changed (e.g., reduced from 30 to 10 minutes), the system immediately checks for stuck tasks under the new timer rather than waiting for the next poll cycle

### `worktreeNaming` (default: `"random"`)

Controls how worktree directory names are generated when `recycleWorktrees` is NOT enabled. This setting only affects fresh worktrees (not pooled/recycled ones).

**Valid values:**
- `"random"` — Human-friendly random names like `swift-falcon`, `calm-river` (default)
- `"task-id"` — Use the task ID as the directory name, e.g., `kb-042`
- `"task-title"` — Use a slugified version of the task title, e.g., `fix-login-bug`

**Example:**
```json
{
  "settings": {
    "worktreeNaming": "task-id"
  }
}
```

**Notes:**
- This setting has no effect when `recycleWorktrees` is enabled (pooled worktrees retain their existing names)
- Task branches are always named `kb/{task-id}` regardless of this setting
- When using `"task-title"` mode, special characters are replaced with hyphens and the result is lowercased

### `autoBackupEnabled` (default: `false`)

When true, enables automatic database backups for the kb SQLite database.

**How it works:**
- When enabled, the system creates scheduled automation to run backups on the configured schedule
- Backups are timestamped copies of `.kb/kb.db` stored in the backup directory
- Old backups are automatically cleaned up based on the retention setting
- Manual backups can still be created via CLI or dashboard even when auto-backup is disabled

**Configuration:**
```json
{
  "settings": {
    "autoBackupEnabled": true,
    "autoBackupSchedule": "0 2 * * *",
    "autoBackupRetention": 7,
    "autoBackupDir": ".kb/backups"
  }
}
```

### `autoBackupSchedule` (default: `"0 2 * * *"`)

Cron expression for automatic backup timing. The default runs daily at 2 AM.

**Common schedules:**
- `"0 2 * * *"` — Daily at 2 AM (default)
- `"0 * * * *"` — Hourly
- `"*/15 * * * *"` — Every 15 minutes
- `"0 0 * * 0"` — Weekly on Sunday

The schedule is validated when saved. Invalid cron expressions will be rejected.

### `autoBackupRetention` (default: `7`)

Number of backup files to retain. When the count exceeds this limit, the oldest backups are automatically deleted.

**Valid range:** 1–100

### `autoBackupDir` (default: `".kb/backups"`)

Directory for backup files, relative to the project root. The directory is created automatically if it doesn't exist.

**Constraints:**
- Must be a relative path (no leading `/` or `\`)
- Must not contain parent directory traversal (`..`)

### CLI Commands

Manual backup operations are available via the CLI:

```bash
kb backup --create         # Create a backup immediately
kb backup --list           # List all backups with sizes
kb backup --restore <file> # Restore database from backup
kb backup --cleanup        # Remove old backups
```

### Dashboard

The dashboard Settings modal includes a "Backups" section where you can:
- Enable/disable automatic backups
- Configure the backup schedule
- Set retention count and backup directory
- View current backup count and total size
- Create manual backups with the "Backup Now" button

## Model Presets

The kb dashboard supports reusable model presets so teams can standardize AI model choices without manually selecting executor and validator models for every task.

### How It Works

Each preset contains:
- **ID** — stable slug used for storage and size mappings (for example `budget`, `normal`, `complex`)
- **Name** — human-friendly label shown in the UI
- **Executor model** — optional provider/model pair for task execution
- **Validator model** — optional provider/model pair for code and spec review

Task creation surfaces can apply a preset, which immediately resolves to concrete per-task model overrides. The selected preset ID is also stored on the task as `modelPresetId` for reference and future auditing.

### Auto-Selection by Task Size

Settings can optionally enable automatic preset recommendation by task size:
- **Small (`S`)** → mapped preset ID
- **Medium (`M`)** → mapped preset ID
- **Large (`L`)** → mapped preset ID

When enabled, task creation UIs can preselect the configured preset for the detected task size. If no mapping exists for a given size, kb falls back to normal default-model behavior.

### Interaction with Per-Task Overrides

Presets are an alternative to manual per-task model selection, not a replacement:
- Selecting a preset fills in the task's executor and validator model overrides
- Choosing **Custom** or manually overriding models breaks out of preset mode for that task creation flow
- Existing per-task overrides on saved tasks continue to work as before
- If a preset is later edited or deleted, already-created tasks keep their resolved model settings

## Per-Task Model Overrides

The kb dashboard allows overriding the global AI model selection on a per-task basis. This enables using different models for different types of work without changing global settings.

### How It Works

Each task can optionally specify:
- **Executor Model**: The AI model used to implement the task (executor agent)
- **Validator Model**: The AI model used to review code and plans (reviewer agent)

When not specified, tasks use the global default settings (`defaultProvider`/`defaultModelId`).

### Setting Per-Task Models

In the dashboard, open any task's detail modal and click the **Model** tab. Select models from the dropdown:
- **Use default**: Uses the global default model (shown when no override is set)
- **Specific model**: Override with a chosen provider/model combination

Both provider and model ID must be selected together — selecting only one is treated as "not set" and falls back to defaults.

### Storage

Per-task model overrides are stored in the task's `task.json`:
```json
{
  "modelProvider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "validatorModelProvider": "openai",
  "validatorModelId": "gpt-4o"
}
```

To clear overrides, select "Use default" for both fields and save.

### Engine Behavior

- **Executor**: When both `modelProvider` and `modelId` are set on a task, the executor uses those instead of global settings when creating the agent session.
- **Reviewer**: When both `validatorModelProvider` and `validatorModelId` are set, the reviewer uses those instead of global settings. The validator model is passed via `ReviewOptions` to `reviewStep()`.

### Limitations

- **Planning Model**: Task specification (triage) uses the global `planningProvider`/`planningModelId` settings — there is no per-task override for planning
- Both provider and modelId must be set together; partial configuration falls back to defaults

## Model Settings Hierarchy

The system uses the following precedence for model selection:

**For Task Specification (Triage):**
1. Global `planningProvider`/`planningModelId` (if both set)
2. Global `defaultProvider`/`defaultModelId` (if both set)
3. Automatic model resolution (fallback)

**For Task Execution (Executor):**
1. Per-task `modelProvider`/`modelId` (if both set)
2. Global `defaultProvider`/`defaultModelId` (if both set)
3. Automatic model resolution (fallback)

**For Code/Spec Review (Reviewer):**
1. Per-task `validatorModelProvider`/`validatorModelId` (if both set)
2. Global `validatorProvider`/`validatorModelId` (if both set)
3. Global `defaultProvider`/`defaultModelId` (if both set)
4. Automatic model resolution (fallback)

Configure global model settings in the dashboard under **Settings > Model**.

## Archive Cleanup

Archived tasks can be cleaned up from the filesystem to reduce storage overhead while preserving the ability to restore them later.

### Storage Pattern

When a task is archived and cleaned up:
1. A compact entry is written to `.kb/archive.jsonl` (JSON Lines format)
2. The task directory (`task.json`, `PROMPT.md`, `agent.log`, attachments) is removed
3. The archive entry contains all metadata needed to restore the task

The archive log is append-only and survives TaskStore reinitialization.

### Archive Entry Format

Each line in `archive.jsonl` is a JSON object containing:
- `id`, `title`, `description`, `column` (always "archived")
- `dependencies`, `steps`, `currentStep`
- `size`, `reviewLevel`, `prInfo`, `issueInfo`
- `attachments` (metadata only, no file content)
- `log` (task log entries)
- `createdAt`, `updatedAt`, `columnMovedAt`, `archivedAt`
- Model overrides: `modelProvider`, `modelId`, `validatorModelProvider`, `validatorModelId`

**Explicitly excluded:** `agent.log` content (can be large, not needed for restoration)

### API

- `archiveTask(id, cleanup)` — Archive with optional immediate cleanup
- `archiveTaskAndCleanup(id)` — Convenience method for archive + cleanup
- `cleanupArchivedTasks()` — Bulk cleanup of all archived tasks with directories
- `readArchiveLog()` — Parse all archive entries
- `findInArchive(id)` — Find specific task in archive
- `unarchiveTask(id)` — Restore from archive if directory is missing

### Restoration Behavior

When `unarchiveTask()` is called:
1. If task directory exists: normal unarchive (column "archived" → "done")
2. If directory missing: restore from archive entry first, then unarchive
3. Restored tasks have:
   - All metadata preserved
   - `column` set to "done" (was "archived" in the log)
   - `PROMPT.md` regenerated with preserved steps
   - Empty `attachments/` directory (files intentionally lost)
   - No `agent.log` (intentionally lost during archive)
   - Log entry: "Task restored from archive"

### Cleanup Behavior

- `cleanupArchivedTasks()` iterates all "archived" column tasks
- Skips tasks already cleaned up (directory gone)
- Writes archive entry atomically before directory removal
- Can be called idempotently

## Workflow Steps

Workflow steps are reusable quality gates that run after task implementation but before the task moves to in-review. They enable post-implementation review, documentation checks, QA validation, and other automated checks.

### How It Works

1. **Define globally** — Workflow steps are defined once in the dashboard (Workflow Steps button in header) with a name, description, and agent prompt
2. **AI-assisted prompts** — Use the "Refine with AI" button to convert a rough description into a detailed agent prompt
3. **Enable per-task** — When creating a new task, check the workflow steps you want to run
4. **Automatic execution** — After the main task executor calls `task_done()`, enabled workflow steps run sequentially
5. **Review gate** — The task only moves to in-review after all workflow steps complete successfully

### Storage

Workflow step definitions are stored in `.kb/config.json`:
```json
{
  "workflowSteps": [
    {
      "id": "WS-001",
      "name": "Documentation Review",
      "description": "Verify all public APIs have documentation",
      "prompt": "Review the task changes and verify that all new public functions...",
      "enabled": true,
      "createdAt": "2026-03-31T00:00:00.000Z",
      "updatedAt": "2026-03-31T00:00:00.000Z"
    }
  ],
  "nextWorkflowStepId": 2
}
```

Tasks store their enabled workflow step IDs in `task.json`:
```json
{
  "enabledWorkflowSteps": ["WS-001", "WS-002"]
}
```

### API

- `GET /api/workflow-steps` — List all workflow step definitions
- `POST /api/workflow-steps` — Create a new workflow step
- `PATCH /api/workflow-steps/:id` — Update a workflow step
- `DELETE /api/workflow-steps/:id` — Delete (also removes from tasks)
- `POST /api/workflow-steps/:id/refine` — AI-refine the prompt from description

### Engine Behavior

- Workflow step agents use **readonly tools** (file reading only, no modifications)
- Each step runs as a separate agent session in the task's worktree
- Steps execute sequentially (not in parallel)
- If a workflow step fails, the task is marked as failed (not moved to in-review)
- Steps with empty prompts are skipped with a log entry
- All workflow step activity is logged to the task's agent log

### Viewing Results

When workflow steps run on a task, their results appear in the dashboard's task detail modal:

- **Workflow tab** — Click the "Workflow" tab in the task detail modal to see workflow step results
- **Pass/fail status** — Each step shows its status (Passed, Failed, Skipped, or Running)
- **Execution output** — The output from each workflow step agent is displayed for review
- **Timestamps** — See when each step started and how long it took to complete

The Workflow tab only appears for tasks that have workflow steps enabled or have workflow results from a previous run.

## Workflow Step Templates

Workflow step templates are pre-defined quality gates that can be added with one click instead of creating from scratch. The dashboard includes 5 built-in templates covering common quality, security, and compliance checks.

### Available Templates

| Template | Category | Description |
|----------|----------|-------------|
| **Documentation Review** | Quality | Verify all public APIs, functions, and complex logic have appropriate documentation |
| **QA Check** | Quality | Run tests and verify they pass, check for obvious bugs |
| **Security Audit** | Security | Check for common security vulnerabilities and anti-patterns |
| **Performance Review** | Quality | Check for performance anti-patterns and optimization opportunities |
| **Accessibility Check** | Quality | Verify UI changes meet accessibility standards (WCAG 2.1) |

### How to Use

1. Open the Workflow Step Manager in the dashboard (button in header)
2. Click the **Templates** tab to browse available templates
3. Click **Add** on any template to create a workflow step from it
4. The template's pre-crafted prompt is copied as an editable workflow step
5. Customize the name, description, or prompt if needed
6. Enable the step for tasks you want it to run on

### Template Prompts

Templates include high-quality agent prompts that guide the AI through specific review criteria:

- **Documentation Review** — Checks JSDoc comments, inline comments, README updates, type definitions
- **QA Check** — Runs test suites, checks for bugs, validates error handling and input validation
- **Security Audit** — Scans for injection vulnerabilities, hardcoded secrets, unsafe eval, path traversal
- **Performance Review** — Identifies algorithmic complexity issues, N+1 queries, memory leaks, unnecessary re-renders
- **Accessibility Check** — Validates keyboard navigation, ARIA labels, color contrast, focus indicators, semantic HTML

### API

- `GET /api/workflow-step-templates` — List all built-in templates
- `POST /api/workflow-step-templates/:id/create` — Create workflow step from template

### Adding Templates

When you add a template:
1. The template data is copied to a new workflow step (templates themselves are immutable)
2. The new step is enabled by default
3. You can edit the step after creation to customize the prompt
