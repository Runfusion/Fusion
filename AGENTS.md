# Project Guidelines

## Finalizing changes

When making changes that affect published packages, create a changeset file:

```bash
cat > .changeset/<short-description>.md << 'EOF'
---
"@gsxdsm/fusion": patch
---

Short description of the change.
EOF
```

Bump types:

- **patch**: bug fixes, internal changes
- **minor**: new features, new CLI commands, new tools
- **major**: breaking changes

Include the changeset file in the same commit as the code change. The filename should be a short kebab-case description (e.g. `fix-merge-conflict.md`, `add-retry-button.md`).

Only create changesets for changes that affect the published `@gsxdsm/fusion` package — user-facing features, bug fixes, CLI changes, tool changes. Do NOT create changesets for internal docs (AGENTS.md, README), CI config, or refactors that don't change behavior.

## Package Structure

- `@fusion/core` — domain model, task store (private, not published)
- `@fusion/dashboard` — web UI + API server (private, not published)
- `@fusion/engine` — AI agents: triage, executor, reviewer, merger, scheduler (private, not published)
- `@gsxdsm/fusion` — CLI + pi extension (published to npm)

Only `@gsxdsm/fusion` is published. The others are internal workspace packages.

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

### Test Optimization Patterns

When writing tests, follow these patterns to keep the test suite fast:

- **Use fake timers** (`vi.useFakeTimers()`, `vi.setSystemTime()`) instead of real `setTimeout` for timestamp-dependent tests. See `packages/core/src/backup.test.ts` for an example.
- **Default to `fileParallelism: true`** in vitest configs; use `test.sequential()` for specific tests that truly need isolation
- **Avoid real delays** — Never use `setTimeout`, `sleep`, or waiting for actual time to pass in tests. Use Vitest's timer mocks instead.
- **Use unique temp directories** — Each test should use isolated temp directories (e.g., `mkdtempSync`) to avoid conflicts in parallel execution

## Multi-Project Architecture / Central Core

kb supports multi-project coordination through a central infrastructure that provides:

- **Project Registry** — Track all registered projects with metadata and settings
- **Unified Activity Feed** — Centralized activity log spanning all projects  
- **Global Concurrency Management** — System-wide agent slot limits across projects
- **Project Health Tracking** — Monitor active tasks, agents, and completion metrics

### Central Database Location

The central database is stored at `~/.pi/kb/kb-central.db` (global user directory):

| Table | Purpose |
|-------|---------|
| `projects` | Project registry with path, status, isolation mode |
| `projectHealth` | Mutable health metrics (active tasks, agent counts, totals) |
| `centralActivityLog` | Unified activity feed across all projects |
| `globalConcurrency` | Singleton row with global limits and current usage |

### CentralCore API

The `CentralCore` class is the main entry point for central operations:

```typescript
import { CentralCore } from "@fusion/core";

const central = new CentralCore();
await central.init();

// Register a project
const project = await central.registerProject({
  name: "My Project",
  path: "/absolute/path/to/project"
});

// Log activity
await central.logActivity({
  type: "task:created",
  projectId: project.id,
  projectName: project.name,
  timestamp: new Date().toISOString(),
  details: "Task FN-001 created"
});

// Get recent activity across all projects
const activity = await central.getRecentActivity({ limit: 50 });

// Update project health
await central.updateProjectHealth(project.id, {
  activeTaskCount: 5,
  inFlightAgentCount: 2,
  status: "active"
});

// Manage global concurrency
await central.updateGlobalConcurrency({ globalMaxConcurrent: 4 });
const acquired = await central.acquireGlobalSlot(project.id);
if (acquired) {
  // Run agent work...
  await central.releaseGlobalSlot(project.id);
}

// Get statistics
const stats = await central.getStats();
console.log(`${stats.projectCount} projects, ${stats.totalTasksCompleted} tasks completed`);

await central.close();
```

### Events

CentralCore emits events for reactive updates:

| Event | Payload | Description |
|-------|---------|-------------|
| `project:registered` | `RegisteredProject` | New project registered |
| `project:unregistered` | `string` (projectId) | Project removed |
| `project:updated` | `RegisteredProject` | Project metadata changed |
| `project:health:changed` | `ProjectHealth` | Health metrics updated |
| `activity:logged` | `CentralActivityLogEntry` | New activity entry |
| `concurrency:changed` | `GlobalConcurrencyState` | Concurrency state changed |

### Isolation Modes

Projects can run in different isolation modes:

- **`in-process`** (default) — Tasks run in the main process
- **`child-process`** — Tasks run in isolated child processes (future)

### Project Status

Projects have one of these statuses:

- **`initializing`** — Project just registered, not fully set up
- **`active`** — Project is operational and accepting tasks
- **`paused`** — Project temporarily suspended
- **`errored`** — Project has encountered errors

### Unified vs Per-Project Activity Logs

kb has two activity log systems:

1. **Per-project activity log** (`.kb/kb.db` → `activityLog` table)
   - Contains events for a single project
   - Used by the dashboard for project-specific views
   
2. **Unified central activity log** (`~/.pi/kb/kb-central.db` → `centralActivityLog` table)
   - Contains events from all projects
   - Used for global dashboards and cross-project reporting
   - Includes `projectId` and `projectName` for attribution

### Security Considerations

- Project paths must be absolute and validated before registration
- Duplicate paths are rejected
- Path traversal attacks are prevented through absolute path validation
- Cascade deletes ensure no orphaned data when projects are unregistered
- Foreign key constraints maintain referential integrity

## Multi-Project Runtime Architecture

kb's multi-project support is built on a runtime abstraction layer that enables task execution across multiple projects with configurable isolation modes. This architecture provides both efficiency (in-process) and security (child-process isolation) options.

### Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     HybridExecutor                                │
│                    (Multi-Project Orchestrator)                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              ProjectManager (internal)                       │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │ │
│  │  │   Project A  │  │   Project B  │  │    Project C    │  │ │
│  │  │ (in-process) │  │(child-process│  │  (in-process)   │  │ │
│  │  └──────────────┘  └──────────────┘  └─────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
              ┌──────────┐          ┌──────────┐
              │CentralCore│         │ Scheduler │
              │ (registry)│         │ (per proj) │
              └──────────┘          └──────────┘
```

### ProjectRuntime Interface

The `ProjectRuntime` interface is the core abstraction for multi-project execution:

```typescript
interface ProjectRuntime extends EventEmitter<ProjectRuntimeEvents> {
  start(): Promise<void>;           // Initialize and start the runtime
  stop(): Promise<void>;            // Graceful shutdown
  getStatus(): RuntimeStatus;        // Current runtime status
  getTaskStore(): TaskStore;         // Access project task store
  getScheduler(): Scheduler;         // Access project scheduler
  getMetrics(): RuntimeMetrics;      // Get current metrics
}
```

**RuntimeStatus values:** `starting` → `active` → `stopping` → `stopped`, or `paused`/`errored` for exceptional states.

### Runtime Implementations

#### 1. InProcessRuntime

Runs a project within the main Node.js process:

- **Pros:** Low overhead, fast startup (~0ms), shared memory, direct component access
- **Cons:** No isolation - crashes or resource leaks affect all projects
- **Use for:** Trusted projects, development, single-project deployments

```typescript
const runtime = new InProcessRuntime(config, centralCore);
await runtime.start();

// Direct access to components
const taskStore = runtime.getTaskStore();
const scheduler = runtime.getScheduler();
```

#### 2. ChildProcessRuntime

Runs a project in an isolated child process via `fork()`:

- **Pros:** Strong isolation, independent memory space, crash containment
- **Cons:** Higher overhead (~100-300ms startup), IPC communication overhead
- **Use for:** Untrusted projects, resource-intensive work, multi-tenant deployments

```typescript
const runtime = new ChildProcessRuntime(config, centralCore);
await runtime.start();

// Access via IPC only (getTaskStore/getScheduler throw)
const metrics = runtime.getMetrics();
```

### IPC Protocol

The IPC protocol enables communication between the host (HybridExecutor) and child process runtimes:

**Command Types (Host → Worker):**
- `START_RUNTIME` - Initialize and start the in-process runtime inside the child
- `STOP_RUNTIME` - Graceful shutdown with timeout
- `GET_STATUS` - Query runtime status
- `GET_METRICS` - Query runtime metrics
- `PING` - Health check

**Event Types (Worker → Host, unsolicited):**
- `TASK_CREATED` - Forwarded from TaskStore
- `TASK_MOVED` - Forwarded from TaskStore  
- `TASK_UPDATED` - Forwarded from TaskStore
- `ERROR_EVENT` - Runtime errors
- `HEALTH_CHANGED` - Status transitions

### HybridExecutor

The `HybridExecutor` is the main entry point for multi-project task execution:

```typescript
const central = new CentralCore();
await central.init();

const executor = new HybridExecutor(central);
await executor.initialize();

// Add a project runtime
await executor.addProject({
  projectId: "proj_abc123",
  workingDirectory: "/path/to/project",
  isolationMode: "in-process", // or "child-process"
  maxConcurrent: 2,
  maxWorktrees: 4,
});

// Listen for events across all projects
executor.on("task:completed", ({ projectId, taskId }) => {
  console.log(`Task ${taskId} completed in ${projectId}`);
});

// Graceful shutdown
await executor.shutdown();
```

**Key Features:**
- Automatic loading of registered projects on initialization
- Event forwarding with project attribution
- Global concurrency limit enforcement via CentralCore
- Runtime mode switching (can change isolation mode)
- Health monitoring with automatic restart (child-process mode)

### Child Process Worker

The `child-process-worker.ts` entry point runs inside forked child processes:

1. Creates an `InProcessRuntime` internally
2. Sets up `IpcWorker` to handle commands from the host
3. Forwards all runtime events to the host via IPC
4. Handles graceful shutdown on SIGTERM
5. Self-terminates if parent disconnects unexpectedly

### Isolation Mode Selection

Choose isolation mode based on your requirements:

| Factor | In-Process | Child-Process |
|--------|-----------|---------------|
| Startup time | ~0ms | ~100-300ms |
| Memory isolation | No | Yes |
| Crash containment | No | Yes |
| IPC overhead | None | Minimal |
| Use case | Trusted/single | Multi-tenant/isolated |

### Security Considerations

- Child process spawn validates `projectPath` exists and is absolute before forking
- IPC message validation rejects malformed/unknown message types
- No credentials passed over IPC - credentials stay in parent
- Child process `cwd` is restricted to project path only
- Terminate child on parent exit (prevent orphaned processes)
- Input validation on all IPC message payloads
- Path traversal prevention in project path resolution

### Error Handling & Recovery

**Child Process Runtime:**
- Health monitoring via heartbeat every 5 seconds
- Automatic restart on crash with exponential backoff (1s, 5s, 15s delays)
- Max 3 restart attempts before transitioning to `errored` state
- Graceful shutdown timeout: 30 seconds (SIGTERM → SIGKILL after 5s)

**In-Process Runtime:**
- Errors are emitted as `error` events
- Status transitions to `errored` on fatal errors
- Manual intervention required to restart

## Multi-Project CLI Usage

The kb CLI supports managing multiple projects through the `kb project` subcommand and the `--project` global flag.

### Project Subcommands

```bash
# List all registered projects
kb project list

# Register a new project
kb project add my-app /path/to/app

# Unregister a project (data is preserved)
kb project remove my-app [--force]

# Show project details
kb project show my-app

# Set default project for CLI operations
kb project set-default my-app

# Detect which project you're currently in
kb project detect
```

### Global --project Flag

All task commands accept a `--project` (or `-P`) flag to target a specific project:

```bash
# Create a task in a specific project
kb task create "Fix login bug" --project my-app

# List tasks from a specific project
kb task list --project my-app

# Show task details from a project
kb task show KB-001 --project my-app

# Move a task to a different column
kb task move KB-001 done --project my-app

# Archive a completed task
kb task archive KB-001 --project my-app

# Delete a task
kb task delete KB-001 --force --project my-app

# Attach a file to a task
kb task attach KB-001 screenshot.png --project my-app

# Pause/unpause a task
kb task pause KB-001 --project my-app
kb task unpause KB-001 --project my-app

# Retry a failed task
kb task retry KB-001 --project my-app

# Create a PR for a task
kb task pr-create KB-001 --project my-app

# Import GitHub issues as tasks
kb task import owner/repo --project my-app

# Show and update settings for a project
kb settings --project my-app
kb settings set maxConcurrent 4 --project my-app

# Git operations in a project
kb git status --project my-app
kb git pull --project my-app
kb git push --project my-app

# Backup operations for a project
kb backup --create --project my-app
kb backup --list --project my-app
```

### Project Resolution Order

When you run a kb command without `--project`, the CLI resolves the project in this order:

1. **Explicit `--project` flag** — Uses the specified project
2. **Default project** — Uses the project set via `kb project set-default`
3. **CWD auto-detection** — Walks up the directory tree looking for `.fusion/kb.db`

If no project is found, the CLI exits with an error:
```
No kb project found in current directory. Use --project or run from a project directory.
```

### Common Workflows

**Cross-project operations without changing directories:**
```bash
# Create tasks in different projects from the same shell
kb task create "Backend API endpoint" --project api-service
kb task create "Frontend component" --project web-ui
kb task create "Documentation update" --project docs

# Check status of all projects
kb project list

# Archive completed tasks across projects
kb task archive API-042 --project api-service
kb task archive WEB-123 --project web-ui
```

**Setting up a default project:**
```bash
# Register your main project
kb project add main ~/projects/my-app

# Set it as default
kb project set-default main

# Now all commands use the default project without --project
kb task list
kb task create "New feature"
kb git status
```

**Switching between projects:**
```bash
# Quick switch with shell aliases
alias kb-api='kb --project api-service'
alias kb-web='kb --project web-ui'

# Or use the explicit flag
kb task list --project api-service
kb task list --project web-ui
```

## Multi-Project Dashboard

The kb dashboard provides a visual interface for managing multiple projects simultaneously. When multiple projects are registered, the dashboard shows a Project Overview page as the home view, with drill-down capability into individual project task boards.

### Project Overview Page

The Project Overview (`ProjectOverview` component) displays all registered projects in a responsive grid:

- **Quick Stats Header**: Total projects, active projects, active tasks across all projects, total tasks
- **Filter & Sort**: Filter by status (all, active, paused, errored, initializing); sort by name, last activity, or status
- **Project Cards**: Each card shows:
  - Project name and truncated path
  - Status badge (color-coded: green=active, yellow=paused, red=errored, blue=initializing)
  - Health metrics: active task count, running agents, completed tasks
  - Last activity timestamp (relative, e.g., "5m ago")
  - Actions: Open, Pause/Resume, Remove

**Empty State**: When no projects exist, shows a welcome prompt to add the first project or run the setup wizard.

### Project Selector

The `ProjectSelector` component appears in the header when 2+ projects exist:

- **Trigger Button**: Shows current project name with status dot indicator
- **Dropdown Menu** (desktop ≥769px): 
  - "All Projects" option to return to overview
  - Project list sorted by status (active first) then alphabetically
  - Status badges next to each project name
  - "Add Project..." and "Manage Projects..." shortcuts
- **Mobile Bottom Sheet** (mobile ≤768px):
  - Compact trigger with truncated project name (max 8 chars) and status dot
  - Full-screen bottom sheet with slide-up animation
  - Swipe-down gesture to close
  - Backdrop tap to close
  - Touch-friendly project items (min 44px height)
- **Keyboard Navigation**: Arrow keys, Enter to select, Escape to close

**Single-Project Mode**: When only one project exists, the selector is hidden for a cleaner UI.

### Project Drill-Down

Clicking a project card opens that project's task view:

- **Context Preservation**: The Board or ListView shows only that project's tasks
- **Back Navigation**: "Back to All Projects" button returns to overview
- **View Preference**: Board vs List preference is persisted per project in localStorage
- **Project Context**: TaskDetailModal shows project breadcrumb in header

### Setup Wizard

The `SetupWizardModal` provides a first-run experience for new users:

**Flow**:
1. **Welcome**: Introduction to multi-project mode
2. **Auto-detect**: Scans home directory for `.fusion/kb.db` files
3. **Review**: Shows detected projects with checkboxes for selection, editable names
4. **Manual**: Option to add project by path if auto-detect finds nothing
5. **Complete**: Summary of registered projects

**Features**:
- Auto-opens when `fetchFirstRunStatus()` returns `hasProjects: false`
- Persists state to localStorage (`kb-setup-wizard-state`) for resume capability
- Bulk registration of selected detected projects
- Already-registered projects shown as disabled in review list

### Project Health Indicators

Project health is polled every 10 seconds when the overview is visible:

| Indicator | Meaning |
|-----------|---------|
| **Active Tasks** | Tasks currently in non-terminal columns (todo, in-progress, in-review) |
| **Agents** | Currently running executor/reviewer agents for this project |
| **Completed** | Cumulative count of tasks moved to "done" |
| **Last Activity** | Timestamp of last task movement, creation, or update |
| **Status Badge** | Project state: active (healthy), paused (suspended), errored (failed), initializing (starting up) |

Health data comes from `useProjectHealth(projectId)` hook which calls `/api/projects/:id/health`.

### Global Activity Feed

The Activity Log (`ActivityLogModal`) shows events across all projects when viewing from the overview:

- **Project Badges**: Each entry shows a folder icon with project name when viewing global activity
- **Project Filter**: Dropdown to filter by specific project (only shown when 2+ projects)
- **Event Types**: Same events as single-project mode (task:created, task:moved, etc.)

When viewing a specific project's task board, the activity log is automatically filtered to that project.

## Pi Extension (`packages/cli/src/extension.ts`)

The pi extension provides tools and a `/kb` command for interacting with kb from within a pi session. It ships as part of `@gsxdsm/fusion` — one `pi install` gives you both the CLI and the extension.

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
- The server verifies webhook signatures using `FUSION_GITHUB_WEBHOOK_SECRET`, fetches canonical badge state with GitHub App installation tokens, and broadcasts updates via the existing `task:updated` → `/api/ws` bridge.
- Keep the existing 5-minute refresh endpoints (`/api/tasks/:id/pr/status`, `/api/tasks/:id/issue/status`) as a fallback path when webhook delivery is unavailable.

## Git

- Commit messages: `feat(FN-XXX):`, `fix(FN-XXX):`, `test(FN-XXX):`
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
- Notifications include the task title when available, or fall back to a truncated task description snippet (first 200 characters) prefixed with the task ID when no title is set
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

### `autoSummarizeTitles` (default: `false`)

When enabled, tasks created without titles but with descriptions longer than 140 characters will automatically receive an AI-generated title (max 60 characters).

**How it works:**
- When a task is created without a title and the description exceeds 140 characters, the system calls the AI summarization service
- The AI generates a concise title (≤60 characters) that captures the essence of the task
- The generated title is stored in the task and appears in the PROMPT.md heading
- If the AI service is unavailable or returns an error, the task is still created without a title (no blocking)

**Configuration:**
```json
{
  "settings": {
    "autoSummarizeTitles": true,
    "titleSummarizerProvider": "anthropic",
    "titleSummarizerModelId": "claude-sonnet-4-5"
  }
}
```

### `titleSummarizerProvider` (optional)

AI model provider for title summarization when `autoSummarizeTitles` is enabled. Must be set together with `titleSummarizerModelId`.

**Model selection hierarchy:**
When generating titles, the system uses the first available model from this priority list:
1. `titleSummarizerProvider` + `titleSummarizerModelId` (if both configured)
2. `planningProvider` + `planningModelId` (if both configured)
3. `defaultProvider` + `defaultModelId` (if both configured)
4. Automatic model resolution (fallback)

### `titleSummarizerModelId` (optional)

AI model ID for title summarization when `autoSummarizeTitles` is enabled. Must be set together with `titleSummarizerProvider`.

**Rate limiting:**
The `/api/ai/summarize-title` endpoint is rate-limited to 10 requests per hour per IP to prevent abuse.

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

## Multi-Project Dashboard

The kb dashboard supports managing multiple projects simultaneously. This enables teams to track tasks across multiple repositories from a single dashboard view.

### Overview

The multi-project dashboard provides:
- **Project Overview page** — Responsive grid showing all registered projects with health status
- **Project Selector** — Quick context switching between projects via header dropdown
- **Project Drill-down** — Click any project to view its tasks in board or list view
- **Setup Wizard** — First-run experience for registering projects
- **Global Activity Feed** — Cross-project activity with project attribution

### Project Status

Projects have one of these statuses:
- **`active`** — Project is operational and accepting tasks (green badge)
- **`paused`** — Project temporarily suspended (yellow badge)
- **`errored`** — Project has encountered errors (red badge)
- **`initializing`** — Project just registered, not fully set up (blue badge)

### Navigation

**View all projects:**
- Navigate to the Project Overview page showing all registered projects in a responsive grid (1→2→3 columns based on screen size)
- Filter by status: All, Active, Paused, Errored
- Sort by: Name, Last Activity, Status

**Switch projects:**
- Use the Project Selector in the header (visible when 2+ projects registered)
- Shows current project name with dropdown menu
- Displays project status icons for quick health assessment
- "View All Projects" option in dropdown returns to overview

**Back to overview:**
- "Back to All Projects" button appears in header when viewing a specific project
- Clicking returns to Project Overview page

### First-Run Experience

When no projects are registered:
1. Setup wizard automatically opens on dashboard load
2. Manually enter project path and name
3. Or auto-detect projects in a base directory
4. Select projects to register from detection results
5. Projects are initialized with `in-process` execution mode by default

### Project Health

Each project card shows:
- **Active Tasks** — Number of tasks in non-terminal columns
- **Agents** — Currently running agents for this project
- **Completed** — Total tasks completed (from health metrics)
- **Last activity** — Relative timestamp of last project activity

Health is polled every 10 seconds while Project Overview is visible.

### Activity Log

The global activity feed shows events from all projects:
- Project name badge on each entry
- Filter dropdown to show only specific project
- Filter by event type (same options as single-project view)
- Cross-project task linking (opens task detail if task exists in current view)

### Storage

Projects are registered in the central database (`~/.pi/kb/kb-central.db`):
- `projects` table — Project registry with path, status, isolation mode
- `projectHealth` — Mutable health metrics (active tasks, agent counts, totals)
- `centralActivityLog` — Unified activity feed across all projects

### View Preferences

View state is persisted per scope:
- **Overview vs Project mode** — `kb-dashboard-view-mode` in localStorage
- **Board/List/Agents view** — `kb-dashboard-task-view` in localStorage
- **Recently accessed projects** — Last 3 projects stored for quick selector access

### API Integration

Multi-project components use these APIs:
- `GET /api/projects` — List all registered projects
- `POST /api/projects` — Register new project
- `PATCH /api/projects/:id` — Update project status/name
- `DELETE /api/projects/:id` — Unregister project
- `GET /api/projects/:id/health` — Fetch project health metrics
- `GET /api/activity-feed` — Global activity (supports `?projectId=` filter)

### Backward Compatibility

Single-project mode is automatically maintained:
- With only 1 project, Project Selector is hidden
- Dashboard behaves like existing single-project mode
- View preference falls back to "project" mode automatically

## Multi-Project Migration

kb supports migrating from single-project mode to multi-project mode seamlessly. When you upgrade to a multi-project capable version, the system automatically detects existing projects and registers them in the central project registry.

### Auto-Migration Behavior

On first run after upgrade, kb will:
1. **Detect** existing `.kb/kb.db` files in the current directory tree
2. **Register** the discovered project in the central database at `~/.pi/kb/kb-central.db`
3. **Preserve** all existing data — nothing is moved or deleted
4. **Report** the auto-registration via console output

This process is:
- **Idempotent** — Re-running migration is a no-op for already-registered projects
- **Safe** — Original `.kb/` directories are never modified
- **Reversible** — Deleting `~/.pi/kb/kb-central.db` reverts to single-project mode

### Backward Compatibility

Single-project workflows continue working without changes:
- No `--project` flag required when only one project is registered
- Existing CLI commands work exactly as before
- Dashboard opens directly to the project overview

When multiple projects are registered, explicit project selection is required:
```bash
fn task list --project my-frontend
fn dashboard --project my-backend
```

### Manual Project Registration

To initialize a new project or register an existing project manually:

```bash
# Initialize new project (creates .kb/ and registers in central)
fn init

# Initialize with custom name
fn init --name "My Custom Project"

# Register existing project at specific directory
fn project add /path/to/project --name "Existing Project"
```

### Rollback Procedure

If the central database causes issues:

1. **Delete the central database**:
   ```bash
   rm ~/.pi/kb/kb-central.db
   ```
   This only removes the project registry. All per-project data in `.kb/kb.db` remains intact.

2. **kb falls back to single-project legacy mode** automatically

3. **Re-register projects** if needed:
   ```bash
   fn init
   # or
   fn project add /path/to/project
   ```

4. **Emergency bypass** (disable auto-migration):
   ```bash
   KB_SKIP_MIGRATION=1 fn task list
   ```

### Dashboard First-Run Experience

The dashboard provides setup endpoints for the first-run wizard:

- `GET /api/setup-state` — Returns migration state (`fresh-install`, `needs-migration`, `setup-wizard`, `normal-operation`) and detected projects
- `POST /api/complete-setup` — Registers selected projects from the wizard

When the dashboard detects `needs-migration` or `setup-wizard` states, it shows appropriate prompts to guide users through initial setup.

### Migration API

Core migration functions are available in `@fusion/core`:

```typescript
import { 
  FirstRunDetector, 
  MigrationCoordinator, 
  BackwardCompat,
  needsCentralMigration,
  autoMigrateToCentral 
} from "@fusion/core";

// Detect first-run state
const detector = new FirstRunDetector();
const state = await detector.detectFirstRunState(); // "fresh-install" | "needs-migration" | "setup-wizard" | "normal-operation"

// Coordinate migration
const coordinator = new MigrationCoordinator(central);
const result = await coordinator.registerSingleProject("/path/to/project");

// Backward compatibility resolution
const compat = new BackwardCompat(central);
const context = await compat.resolveProjectContext("/cwd"); // Auto-resolves single project
```
