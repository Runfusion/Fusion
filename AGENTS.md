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

Fusion uses a hybrid storage architecture: structured metadata lives in SQLite while large blob files remain on the filesystem.

### Database Location

- **Project database:** `.fusion/fusion.db` — SQLite database with WAL mode enabled
- **Blob files:** `.fusion/tasks/{ID}/PROMPT.md`, `agent.log`, `attachments/` — remain on filesystem
- **Global settings:** `~/.pi/fusion/settings.json` — remains file-based (not in SQLite)

### Tables

| Table | Purpose |
|-------|---------|
| `tasks` | Task metadata with JSON columns for nested arrays/objects |
| `config` | Single-row project config (nextId, settings) |
| `activityLog` | Activity log entries with indexed timestamp/type/taskId |
| `archivedTasks` | Compact archived task entries (full metadata as JSON) |
| `automations` | Scheduled automation definitions |
| `agents` | Agent state and metadata |
| `agentHeartbeats` | Agent heartbeat events (FK cascade from agents) |
| `__meta` | Schema version and change detection timestamp |

### WAL Mode & Concurrency

The database runs in WAL (Write-Ahead Logging) mode for concurrent reader/writer access. Foreign keys are enforced per connection. Change detection uses a monotonic `lastModified` timestamp in the `__meta` table.

### Auto-Migration from Legacy Storage

On first run, if legacy file-based data exists (`.fusion/tasks/`, `.fusion/config.json`, etc.) but no `.fusion/fusion.db`, the system automatically migrates all data to SQLite:

1. Config, tasks, activity log, archive, automations, and agents are migrated
2. Original files are backed up (`.bak` suffix)
3. Blob files (PROMPT.md, agent.log, attachments) remain in place
4. Individual `task.json` files are renamed to `task.json.bak`
5. Migration is idempotent — re-running with an existing database is a no-op

### Multi-Project Migration

When upgrading to multi-project mode, existing single-project users are automatically migrated:

**Auto-Migration Behavior:**
- On first run after upgrade, the system detects existing `.fusion/fusion.db` files
- Projects are automatically registered in the central database at `~/.pi/fusion/fusion-central.db`
- Project names are derived from git remote URL (fallback: directory name)
- Existing single-project workflows continue working without `--project` flags

**First-Run States:**
- `fresh-install` — No central DB, no existing projects (show setup wizard)
- `needs-migration` — Central DB missing, but `.fusion/fusion.db` found (auto-migrate)
- `setup-wizard` — Central DB exists but empty (show setup wizard)
- `normal-operation` — Central DB with projects (show overview)

**Backward Compatibility:**
- Single project: Commands work without `--project` flag
- Multiple projects: `--project` flag required for explicit selection
- Legacy mode: Falls back to single-project behavior if central DB unavailable

**Rollback from Multi-Project Migration:**

If the central database causes issues:
1. Delete `~/.pi/fusion/fusion-central.db` (this only removes the project registry)
2. Your per-project `.fusion/fusion.db` files remain intact with all data
3. fn will fall back to single-project legacy mode
4. Re-run `fn init` in your project to re-register if needed

**Safety Features:**
- Auto-migration runs once; no repeated scanning
- Only valid projects with `.fusion/fusion.db` are registered
- Path validation prevents path traversal attacks
- Idempotent: safe to re-run without side effects

### Recovery

If something goes wrong after migration:
- Backup files (`.bak`) contain the original data
- Delete `.fusion/fusion.db` and rename `.bak` files back to restore legacy storage
- The system will re-migrate on next startup

### JSON Columns

Nested data (arrays, objects) is stored as JSON text in SQLite columns:
- Array columns: `dependencies`, `steps`, `log`, `attachments`, `steeringComments`, etc.
- Nullable object columns: `prInfo`, `issueInfo`, `lastRunResult`
- Use `toJson()` for array columns, `toJsonNullable()` for nullable object columns
- Use `fromJson<T>()` to parse JSON columns back to TypeScript types

### `listTasks()` performance contract

`store.listTasks()` returns full Task rows by default, including `log`,
`comments`, `steps`, and `workflowStepResults`. On busy boards the `log`
column alone can exceed 60 MB, so a naive call from a hot path will stall
the dashboard. Always pass the narrowest option set the caller actually
needs:

- `{ slim: true }` — board-style listing; drops heavy fields and returns empty
  arrays for them. Detail data must be fetched per-task via `getTask(id)`.
- `{ column: "in-review" }` — column-scoped scans (e.g. the auto-merge sweep).
  Filtering happens in SQL, not in JS, so a 1200-row board collapses to
  whatever the column actually holds.
- `{ includeArchived: false }` — exclude the archived column from the result
  set. The board view uses this; archived tasks are loaded lazily when the
  user expands that column.

The board path is wired this way already: `GET /api/tasks` uses
`{ slim: true, includeArchived: <query> }`, and `archiveStaleDoneTasks` /
the auto-merge sweeps in `dashboard.ts` use `slim`/`column`. New callers in
hot paths (engine maintenance, schedulers, SSE side-effects) MUST pick one
of these options — full `listTasks()` is reserved for tooling and tests.

### `TaskStore.watch()` polling

`watch()` populates an in-memory cache from `listTasks()` and starts a 1s
poll loop (`checkForChanges`) that emits `task:created`/`updated`/`moved`/
`deleted` events to SSE subscribers. The poll filters on `updatedAt /
columnMovedAt > lastPollTime` — and `lastPollTime` MUST be initialized to
"now" inside `watch()` itself. If it is left null, the first poll cycle
runs an unfiltered `SELECT *` and emits `task:updated` for every cached
task, causing tens of MB of SSE traffic and a frontend setState storm at
dashboard startup. Direct `UPDATE`s against `tasks` (e.g. bulk archive
sweeps) will also be observed by the next poll cycle and re-emitted as
events, which is fine in small numbers but should be batched if a sweep
touches hundreds of rows at once.

## Testing

```bash
pnpm test          # run all tests
pnpm build         # build all packages
```

Tests are required. Typechecks and manual verification are not substitutes for real tests with assertions.

## Multi-Project Architecture / Central Core

fn supports multi-project coordination through a central infrastructure that provides:

- **Project Registry** — Track all registered projects with metadata and settings
- **Unified Activity Feed** — Centralized activity log spanning all projects  
- **Global Concurrency Management** — System-wide agent slot limits across projects
- **Project Health Tracking** — Monitor active tasks, agents, and completion metrics

### Central Database Location

The central database is stored at `~/.pi/fusion/fusion-central.db` (global user directory):

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

fn has two activity log systems:

1. **Per-project activity log** (`.fusion/fusion.db` → `activityLog` table)
   - Contains events for a single project
   - Used by the dashboard for project-specific views
   
2. **Unified central activity log** (`~/.pi/fusion/fusion-central.db` → `centralActivityLog` table)
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

fn's multi-project support is built on a runtime abstraction layer that enables task execution across multiple projects with configurable isolation modes. This architecture provides both efficiency (in-process) and security (child-process isolation) options.

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

The fn CLI supports managing multiple projects through the `fn project` subcommand and the `--project` global flag.

### Project Subcommands

```bash
# List all registered projects
fn project list

# Register a new project
fn project add my-app /path/to/app

# Unregister a project (data is preserved)
fn project remove my-app [--force]

# Show project details
fn project show my-app

# Set default project for CLI operations
fn project set-default my-app

# Detect which project you're currently in
fn project detect
```

### Global --project Flag

All task commands accept a `--project` (or `-P`) flag to target a specific project:

```bash
# Create a task in a specific project
fn task create "Fix login bug" --project my-app

# List tasks from a specific project
fn task list --project my-app

# Show task details from a project
fn task show FN-001 --project my-app

# Move a task to a different column
fn task move FN-001 done --project my-app

# Archive a completed task
fn task archive FN-001 --project my-app

# Delete a task
fn task delete FN-001 --force --project my-app

# Attach a file to a task
fn task attach FN-001 screenshot.png --project my-app

# Pause/unpause a task
fn task pause FN-001 --project my-app
fn task unpause FN-001 --project my-app

# Retry a failed task
fn task retry FN-001 --project my-app

# Create a PR for a task
fn task pr-create FN-001 --project my-app

# Import GitHub issues as tasks
fn task import owner/repo --project my-app

# Show and update settings for a project
fn settings --project my-app
fn settings set maxConcurrent 4 --project my-app

# Git operations in a project
fn git status --project my-app
fn git pull --project my-app
fn git push --project my-app

# Backup operations for a project
fn backup --create --project my-app
fn backup --list --project my-app
```

### Project Resolution Order

When you run an fn command without `--project`, the CLI resolves the project in this order:

1. **Explicit `--project` flag** — Uses the specified project
2. **Default project** — Uses the project set via `fn project set-default`
3. **CWD auto-detection** — Walks up the directory tree looking for `.fusion/fusion.db`

If no project is found, the CLI exits with an error:
```
No fn project found in current directory. Use --project or run from a project directory.
```

### Common Workflows

**Cross-project operations without changing directories:**
```bash
# Create tasks in different projects from the same shell
fn task create "Backend API endpoint" --project api-service
fn task create "Frontend component" --project web-ui
fn task create "Documentation update" --project docs

# Check status of all projects
fn project list

# Archive completed tasks across projects
fn task archive API-042 --project api-service
fn task archive WEB-123 --project web-ui
```

**Setting up a default project:**
```bash
# Register your main project
fn project add main ~/projects/my-app

# Set it as default
fn project set-default main

# Now all commands use the default project without --project
fn task list
fn task create "New feature"
fn git status
```

**Switching between projects:**
```bash
# Quick switch with shell aliases
alias fn-api='fn --project api-service'
alias fn-web='fn --project web-ui'

# Or use the explicit flag
fn task list --project api-service
fn task list --project web-ui
```

## Node Dashboard

The fn dashboard includes a Node Dashboard view for managing the node mesh network. It visualizes connected nodes, shows their status and system metrics, and allows operators to connect to remote nodes.

### Dashboard Components

| Component | File | Description |
|----------|------|-------------|
| `NodesView` | `app/components/NodesView.tsx` | Main mesh dashboard page with header, stats, and node grid |
| `NodeCard` | `app/components/NodeCard.tsx` | Individual node card with status, metrics, and actions |
| `AddNodeModal` | `app/components/AddNodeModal.tsx` | Modal form to add/register new remote nodes |
| `NodeDetailModal` | `app/components/NodeDetailModal.tsx` | Detail view for editing node configuration |
| `MeshTopology` | `app/components/MeshTopology.tsx` | SVG-based visual representation of node connections |

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/nodes` | GET | List all registered nodes |
| `/api/nodes` | POST | Register a new remote node |
| `/api/nodes/:id` | GET | Get single node detail |
| `/api/nodes/:id` | PATCH | Update node configuration |
| `/api/nodes/:id` | DELETE | Unregister a node |
| `/api/nodes/:id/metrics` | GET | Get node runtime metrics |
| `/api/nodes/:id/health-check` | POST | Trigger node health check |
| `/api/mesh/state` | GET | Full mesh topology state with peer connections |

### Frontend Hooks

- **`useNodes`** (`app/hooks/useNodes.ts`) — Data-fetching hook with 10-second polling for live node metrics. Exposes `nodes`, `loading`, `error`, `refresh`, `register`, `update`, `unregister`, `healthCheck`.

### CSS Classes

- `.nodes-view` — Main container
- `.nodes-view-header` — Header with title and actions
- `.nodes-view-stats` — Stats row (total, online, offline, remote counts)
- `.nodes-view-grid` — Grid of node cards
- `.node-card` — Individual node card
- `.mesh-topology` — SVG mesh visualization

## Pi Extension (`packages/cli/src/extension.ts`)

The pi extension provides tools and a `/fn` command for interacting with fn from within a pi session. It ships as part of `@gsxdsm/fusion` — one `pi install` gives you both the CLI and the extension.

Update it when:

- **CLI commands change** — if `fn task create`, `fn task list`, `fn task show`, `fn task attach`, `fn task pause`, or `fn task unpause` change their behavior, flags, or output, update the corresponding tool in `packages/cli/src/extension.ts`.
- **Task store API changes** — the extension calls `TaskStore` directly (`createTask`, `listTasks`, `getTask`, `addAttachment`, `pauseTask`). If these methods change signature or behavior, update the extension.
- **New user-facing features** — if a new CLI command is added that the chat agent should be able to use (task creation, status checking, automation control), add a tool for it.

**Don't** add tools for engine-internal operations (move, step updates, logging, merge) — those are handled by the engine's own agents.

The extension has no skills — tool descriptions, `promptSnippet`, and `promptGuidelines` give the LLM everything it needs.

## Agent Spawning (`spawn_agent` tool)

The executor agent has a `spawn_agent` tool that enables hierarchical agent spawning. Parent agents can create and delegate work to child agents that run in parallel.

### How It Works

Each spawned child agent:
1. Runs in its own git worktree (branched from the parent's worktree)
2. Receives a task prompt describing what to do
3. Executes autonomously until completion or termination
4. Reports status back to the parent via AgentStore

### Usage

```javascript
spawn_agent({
  name: "researcher",
  role: "engineer",
  task: "Research best practices for authentication in React applications"
})
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Name for the child agent |
| `role` | `string` | Role: `"triage"`, `"executor"`, `"reviewer"`, `"merger"`, `"engineer"`, or `"custom"` |
| `task` | `string` | Task description for the child agent to execute |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `maxSpawnedAgentsPerParent` | `5` | Maximum children per parent agent |
| `maxSpawnedAgentsGlobal` | `20` | Maximum total spawned agents per executor instance |

### Lifecycle

- Child agents are tracked in `AgentStore` with `reportsTo` set to the parent task ID
- When the parent session ends (via `task_done()` or error), all spawned children are terminated
- Child agent state transitions: `idle` → `active` → `running` → `active` (success) or `error` (failure)
- Terminated children transition to `terminated` state

### Error Handling

- If no `AgentStore` is configured, spawning returns an error
- Per-parent and global limits are enforced with descriptive error messages
- Failures during agent creation or worktree setup return error results
- State update failures are non-blocking (logged but don't prevent execution)

### Implementation

- **File:** `packages/engine/src/executor.ts`
- **Tool:** `createSpawnAgentTool()` method
- **Child execution:** `runSpawnedChild()` method
- **Cleanup:** `terminateAllChildren()` / `terminateChildAgent()` methods
- **Settings:** `packages/core/src/types.ts` (`ProjectSettings` interface)

## Per-Agent Heartbeat Configuration

Each agent can override the global heartbeat monitoring settings via `runtimeConfig`. The `AgentHeartbeatConfig` interface (exported from `@fusion/core`) defines the available keys:

| Key | Default | Min | Description |
|-----|---------|-----|-------------|
| `enabled` | true | — | Whether heartbeat triggers are enabled for this agent |
| `heartbeatIntervalMs` | 30000 | 1000 | How often heartbeats are checked / timer trigger interval |
| `heartbeatTimeoutMs` | 60000 | 5000 | Time without heartbeat before agent is considered unresponsive |
| `maxConcurrentRuns` | 1 | 1 | Max concurrent heartbeat runs per agent |

### How It Works

1. `HeartbeatMonitor` reads per-agent config from `AgentStore.getCachedAgent()` (synchronous file read)
2. Values from `agent.runtimeConfig` are validated and clamped to minimums
3. Missing or invalid values fall back to the monitor-level constructor defaults
4. Both `isAgentHealthy()` and `checkMissedHeartbeats()` use the per-agent timeout
5. The dashboard health status indicator reads `runtimeConfig.heartbeatTimeoutMs` for display

### Dashboard Configuration

The agent detail ConfigTab includes a "Heartbeat Settings" section where users can configure interval and timeout per agent. Values are stored in `agent.runtimeConfig` and persisted via `PATCH /api/agents/:id` with `runtimeConfig` in the request body.

The ConfigTab also includes a "Budget Settings" section for per-agent token budget configuration:

- **Token Budget** — Total token cap (input + output). Leave empty for no limit.
- **Usage Threshold (%)** — Warning threshold percentage. Triggers warning when usage reaches this level. Stored as fraction (0-1), displayed as percentage (0-100).
- **Budget Period** — How often the budget counter resets: lifetime, daily, weekly, or monthly.
- **Reset Day** — Day for reset (weekly: 0=Sunday to 6=Saturday, monthly: 1-31). Optional.

Values are stored in `agent.runtimeConfig.budgetConfig` and persisted via `PATCH /api/agents/:id`.

### API

- `HeartbeatMonitor.getAgentHeartbeatConfig(agentId)` — Returns the resolved config for an agent
- `AgentStore.getCachedAgent(agentId)` — Synchronous agent read for hot paths
## Budget Governance

Per-agent token budget tracking, threshold warnings, and enforcement by the engine's heartbeat execution path.

### Overview

Budget governance allows teams to set token consumption limits on agents to control costs and prevent runaway AI spending. The system tracks cumulative token usage (input + output), warns when approaching limits, and can automatically pause agents when budgets are exhausted.

### AgentBudgetConfig

Configuration for an agent's token budget. Stored in `agent.runtimeConfig.budgetConfig`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tokenBudget` | `number` | — | Total token cap (input + output). When undefined, no budget limit is enforced. |
| `usageThreshold` | `number` | `0.8` | Warning threshold as a fraction (0–1). Triggers `isOverThreshold` when `usagePercent >= thresholdPercent * 100`. |
| `budgetPeriod` | `string` | `"lifetime"` | Budget accumulation period: `"daily"`, `"weekly"`, `"monthly"`, or `"lifetime"`. |
| `resetDay` | `number` | — | Day for period reset. For weekly: 0=Sunday to 6=Saturday. For monthly: 1–31. Optional. |

### AgentBudgetStatus

Computed budget status for an agent at a point in time.

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `string` | The agent this status belongs to |
| `currentUsage` | `number` | Total tokens consumed (input + output) |
| `budgetLimit` | `number \| null` | Token cap from config, or null when no budget is configured |
| `usagePercent` | `number \| null` | Usage as a percentage of budget (0–100), or null when no budget |
| `thresholdPercent` | `number \| null` | The configured threshold percentage, or null when no budget |
| `isOverBudget` | `boolean` | Whether `currentUsage >= budgetLimit` |
| `isOverThreshold` | `boolean` | Whether `usagePercent >= thresholdPercent * 100` |
| `lastResetAt` | `string \| null` | ISO-8601 timestamp of the last budget reset, or null |
| `nextResetAt` | `string \| null` | ISO-8601 timestamp of the next scheduled reset, or null for lifetime/no budget |

### Engine Behavior

The heartbeat system enforces budgets at multiple points:

**HeartbeatMonitor.executeHeartbeat()**
- Checks agent budget status before creating any agent session
- If `isOverBudget: true` → skips heartbeat, returns `{ reason: "budget_exhausted" }`
- If `isOverThreshold: true` and source is `"timer"` → skips heartbeat, returns `{ reason: "budget_threshold" }`
- Assignment and on-demand triggers bypass the threshold gate (still respect budget exhaustion)
- After `completeRun()`: updates agent token counters and transitions agent state on exhaustion

**HeartbeatTriggerScheduler.onTimerTick()**
- Before triggering timer heartbeat, checks budget status
- Timer ticks are skipped when `isOverThreshold: true` or `isOverBudget: true`
- Assignment and on-demand triggers still fire even above threshold (only timer triggers are gated)
- Budget checks run before the `maxConcurrentRuns` check

**WakeContext.budgetStatus**
- Heartbeat execution propagates `budgetStatus` in the run's `contextSnapshot`
- Enables downstream systems to access current budget state

### AgentStore API

```typescript
// Get computed budget status for an agent
getBudgetStatus(agentId: string): Promise<AgentBudgetStatus>
// Throws if agent not found

// Reset token counters and update budgetResetAt timestamp
resetBudgetUsage(agentId: string): Promise<void>
// Sets totalInputTokens = 0, totalOutputTokens = 0, runtimeConfig.budgetResetAt = now()
// Throws if agent not found
// Emits "agent:updated" event after reset
```

### Budget Reset

Calling `resetBudgetUsage()`:
1. Zeros `totalInputTokens` and `totalOutputTokens` on the agent
2. Sets `runtimeConfig.budgetResetAt` to the current ISO-8601 timestamp
3. Writes the updated agent to storage
4. Emits `agent:updated` event

For period-based budgets, `nextResetAt` is computed as follows:
- **daily**: Next midnight UTC
- **weekly**: Next occurrence of `resetDay` (0=Sunday) at midnight UTC
- **monthly**: Next occurrence of `resetDay` in the month at midnight UTC
- **lifetime**: `null` (no automatic reset)

After a reset, `isOverBudget` and `isOverThreshold` become `false`, allowing heartbeats to resume.

### Dashboard Configuration

The agent detail ConfigTab includes a "Budget Settings" section where users can configure:

- **Token Budget** — Total token cap (input + output). Leave empty for no limit.
- **Usage Threshold (%)** — Warning threshold percentage. Triggers warning when usage reaches this level.
- **Budget Period** — How often the budget counter resets: lifetime, daily, weekly, or monthly.
- **Reset Day** — Day for reset (weekly: 0=Sunday to 6=Saturday, monthly: 1-31). Optional.

Values are stored in `agent.runtimeConfig.budgetConfig` and persisted via `PATCH /api/agents/:id`.

The ConfigTab also displays:
- Current usage as a progress bar (green → yellow → red based on threshold)
- Budget status indicators (under budget, over threshold, over budget)
- Last reset timestamp and next scheduled reset

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/:id/budget` | Get budget status for an agent |
| `POST` | `/api/agents/:id/budget/reset` | Reset budget usage counters |

**GET /api/agents/:id/budget**
- Response 200: `AgentBudgetStatus` — Current budget computation
- Response 404: `{ error: "Agent not found" }`

**POST /api/agents/:id/budget/reset**
- Response 200: `{ success: true }`
- Response 404: `{ error: "Agent not found" }`

Note: Budget configuration is stored via the existing `PATCH /api/agents/:id` endpoint with `runtimeConfig.budgetConfig` in the request body.


## Budget Governance

Per-agent token budget tracking, threshold warnings, and enforcement by the engine's heartbeat execution path.

### Overview

Budget governance allows teams to set token consumption limits on agents to control costs and prevent runaway AI spending. The system tracks cumulative token usage (input + output), warns when approaching limits, and can automatically pause agents when budgets are exhausted.

### AgentBudgetConfig

Configuration for an agent's token budget. Stored in `agent.runtimeConfig.budgetConfig`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tokenBudget` | `number` | — | Total token cap (input + output). When undefined, no budget limit is enforced. |
| `usageThreshold` | `number` | `0.8` | Warning threshold as a fraction (0–1). Triggers `isOverThreshold` when `usagePercent >= thresholdPercent * 100`. |
| `budgetPeriod` | `string` | `"lifetime"` | Budget accumulation period: `"daily"`, `"weekly"`, `"monthly"`, or `"lifetime"`. |
| `resetDay` | `number` | — | Day for period reset. For weekly: 0=Sunday to 6=Saturday. For monthly: 1–31. Optional. |

### AgentBudgetStatus

Computed budget status for an agent at a point in time.

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `string` | The agent this status belongs to |
| `currentUsage` | `number` | Total tokens consumed (input + output) |
| `budgetLimit` | `number \| null` | Token cap from config, or null when no budget is configured |
| `usagePercent` | `number \| null` | Usage as a percentage of budget (0–100), or null when no budget |
| `thresholdPercent` | `number \| null` | The configured threshold percentage, or null when no budget |
| `isOverBudget` | `boolean` | Whether `currentUsage >= budgetLimit` |
| `isOverThreshold` | `boolean` | Whether `usagePercent >= thresholdPercent * 100` |
| `lastResetAt` | `string \| null` | ISO-8601 timestamp of the last budget reset, or null |
| `nextResetAt` | `string \| null` | ISO-8601 timestamp of the next scheduled reset, or null for lifetime/no budget |

### Engine Behavior

The heartbeat system enforces budgets at multiple points:

**HeartbeatMonitor.executeHeartbeat()**
- Checks agent budget status before creating any agent session
- If `isOverBudget: true` → skips heartbeat, returns `{ reason: "budget_exhausted" }`
- If `isOverThreshold: true` and source is `"timer"` → skips heartbeat, returns `{ reason: "budget_threshold" }`
- Assignment and on-demand triggers bypass the threshold gate (still respect budget exhaustion)
- After `completeRun()`: updates agent token counters and transitions agent state on exhaustion

**HeartbeatTriggerScheduler.onTimerTick()**
- Before triggering timer heartbeat, checks budget status
- Timer ticks are skipped when `isOverThreshold: true` or `isOverBudget: true`
- Assignment and on-demand triggers still fire even above threshold (only timer triggers are gated)
- Budget checks run before the `maxConcurrentRuns` check

**WakeContext.budgetStatus**
- Heartbeat execution propagates `budgetStatus` in the run's `contextSnapshot`
- Enables downstream systems to access current budget state

### AgentStore API

```typescript
// Get computed budget status for an agent
getBudgetStatus(agentId: string): Promise<AgentBudgetStatus>
// Throws if agent not found

// Reset token counters and update budgetResetAt timestamp
resetBudgetUsage(agentId: string): Promise<void>
// Sets totalInputTokens = 0, totalOutputTokens = 0, runtimeConfig.budgetResetAt = now()
// Throws if agent not found
// Emits "agent:updated" event after reset
```

### Budget Reset

Calling `resetBudgetUsage()`:
1. Zeros `totalInputTokens` and `totalOutputTokens` on the agent
2. Sets `runtimeConfig.budgetResetAt` to the current ISO-8601 timestamp
3. Writes the updated agent to storage
4. Emits `agent:updated` event

For period-based budgets, `nextResetAt` is computed as follows:
- **daily**: Next midnight UTC
- **weekly**: Next occurrence of `resetDay` (0=Sunday) at midnight UTC
- **monthly**: Next occurrence of `resetDay` in the month at midnight UTC
- **lifetime**: `null` (no automatic reset)

After a reset, `isOverBudget` and `isOverThreshold` become `false`, allowing heartbeats to resume.

### Dashboard Configuration

The agent detail ConfigTab includes a "Budget Settings" section where users can configure:

- **Token Budget** — Total token cap (input + output). Leave empty for no limit.
- **Usage Threshold (%)** — Warning threshold percentage. Triggers warning when usage reaches this level.
- **Budget Period** — How often the budget counter resets: lifetime, daily, weekly, or monthly.
- **Reset Day** — Day for reset (weekly: 0=Sunday to 6=Saturday, monthly: 1-31). Optional.

Values are stored in `agent.runtimeConfig.budgetConfig` and persisted via `PATCH /api/agents/:id`.

The ConfigTab also displays:
- Current usage as a progress bar (green → yellow → red based on threshold)
- Budget status indicators (under budget, over threshold, over budget)
- Last reset timestamp and next scheduled reset

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/:id/budget` | Get budget status for an agent |
| `POST` | `/api/agents/:id/budget/reset` | Reset budget usage counters |

**GET /api/agents/:id/budget**
- Response 200: `AgentBudgetStatus` — Current budget computation
- Response 404: `{ error: "Agent not found" }`

**POST /api/agents/:id/budget/reset**
- Response 200: `{ success: true }`
- Response 404: `{ error: "Agent not found" }`

Note: Budget configuration is stored via the existing `PATCH /api/agents/:id` endpoint with `runtimeConfig.budgetConfig` in the request body.

## Heartbeat Trigger Scheduling

The `HeartbeatTriggerScheduler` class (exported from `@fusion/engine`) manages three trigger mechanisms that wake agents via heartbeat runs:

### Trigger Types

| Trigger | Source | Description |
|---------|--------|-------------|
| **Timer** | `"timer"` | Periodic wakeup based on `AgentHeartbeatConfig.heartbeatIntervalMs` |
| **Assignment** | `"assignment"` | Automatic wakeup when a task is assigned to the agent |
| **On-demand** | `"on_demand"` | Manual trigger via `POST /api/agents/:id/runs` |

### WakeContext

Each trigger passes a structured `WakeContext` to the execution path:

```typescript
interface WakeContext {
  taskId?: string;       // Optional task ID (present for assignment triggers)
  wakeReason: string;    // Why the agent was woken
  triggerDetail: string; // Detail about the specific trigger
  [key: string]: unknown; // Additional context
}
```

### How It Works

1. `HeartbeatTriggerScheduler` is created and started by `InProcessRuntime` during initialization
2. Timer triggers: Agents with `heartbeatIntervalMs` configured get periodic `setInterval`-based wakeups
3. Assignment triggers: The scheduler subscribes to `agent:assigned` events from `AgentStore`
4. On-demand triggers: The `POST /api/agents/:id/runs` route creates runs with wake context
5. All triggers respect budget gating — timer triggers are skipped when `isOverThreshold` or `isOverBudget`; assignment and on-demand triggers bypass the threshold gate but still block when `isOverBudget`
6. All triggers respect `maxConcurrentRuns` — skipped if the agent already has an active run (budget checks run before this check)
7. On runtime stop, all timers are cleared and event listeners are removed

### AgentStore Events

- `"agent:assigned"` — Emitted by `AgentStore.assignTask()` when a non-empty taskId is assigned. Signature: `(agent: Agent, taskId: string) => void`

### InProcessRuntime Integration

- `InProcessRuntime.start()` creates the trigger scheduler, starts it, and registers existing agents with heartbeat configs
- `InProcessRuntime.stop()` stops the trigger scheduler before stopping the HeartbeatMonitor
- `InProcessRuntime.getTriggerScheduler()` — Returns the scheduler instance for testing access

## Agent Performance Ratings

Agent performance ratings allow users and agents to provide feedback on task execution quality, which influences future agent behavior through system prompt injection.

### Overview

- **Users** can rate agents via the Performance tab in the agent detail modal
- **Agents** can rate peer agents (via their own system prompts) after task completion
- **Ratings** are stored in the `agentRatings` table with score (1–5), category, and optional comments
- **Trend analysis** computes improving/declining/stable patterns to help identify agent health
- **System prompt injection** adds performance feedback section to agent instructions when ratings exist

### Type Interfaces

```typescript
interface AgentRating {
  id: string;
  agentId: string;
  raterType: "user" | "agent" | "system";
  raterId?: string;
  score: number;           // 1-5
  category?: string;
  comment?: string;
  runId?: string;
  taskId?: string;
  createdAt: string;       // ISO-8601
}

interface AgentRatingSummary {
  agentId: string;
  averageScore: number;
  totalRatings: number;
  categoryAverages: Record<string, number>;
  recentRatings: AgentRating[];
  trend: "improving" | "declining" | "stable" | "insufficient-data";
}

interface AgentRatingInput {
  raterType: "user" | "agent" | "system";
  raterId?: string;
  score: number;           // 1-5
  category?: string;
  comment?: string;
  runId?: string;
  taskId?: string;
}
```

### Rating Categories

Categories are optional labels for organizing ratings by aspect:
- Examples: `"code-quality"`, `"communication"`, `"speed"`, `"accuracy"`, `"problem-solving"`
- Category averages are computed in the rating summary
- Categories can be any string — no predefined enumeration

### Score Scale

Ratings use a 1–5 integer scale:
- **1** — Poor performance
- **2** — Below expectations
- **3** — Meets expectations
- **4** — Exceeds expectations
- **5** — Outstanding performance

The SQLite column enforces `CHECK(score BETWEEN 1 AND 5)` at the database level.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/:id/ratings` | Fetch ratings for an agent |
| `POST` | `/api/agents/:id/ratings` | Add a rating for an agent |
| `GET` | `/api/agents/:id/ratings/summary` | Fetch aggregated rating summary |
| `DELETE` | `/api/agents/:id/ratings/:ratingId` | Delete a specific rating |

**GET /api/agents/:id/ratings**
- Query params: `limit` (number, default 50), `category` (string, optional)
- Response 200: `AgentRating[]`

**POST /api/agents/:id/ratings**
- Body: `{ score, category?, comment?, runId?, taskId?, raterType? }`
- Response 201: `AgentRating` — The created rating
- Response 400: `{ error: "score is required" }` or `{ error: "score must be a number between 1 and 5" }`

**GET /api/agents/:id/ratings/summary**
- Response 200: `AgentRatingSummary`

**DELETE /api/agents/:id/ratings/:ratingId**
- Response 204: No Content

### AgentStore Methods

```typescript
addRating(agentId: string, input: AgentRatingInput): Promise<AgentRating>
// Validates score 1-5, creates rating with generated ID and timestamp

getRatings(agentId: string, options?: { limit?: number; category?: string }): Promise<AgentRating[]>
// Returns ratings ordered by createdAt DESC

getRatingSummary(agentId: string): Promise<AgentRatingSummary>
// Computes average, categoryAverages, recentRatings (last 10), and trend

deleteRating(ratingId: string): Promise<void>
// Removes rating by ID
```

### Agent Behavior Influence

The executor injects performance feedback into agent system prompts via `resolveAgentInstructions()` in `packages/engine/src/agent-instructions.ts`. When a rating summary exists for an agent:

1. **Performance feedback section** is appended to the agent's instructions
2. Section includes average score, trend indicator, category breakdown, and recent comments
3. Trend uses emoji labels: 📈 improving, 📉 declining, ➡️ stable, ❓ insufficient-data
4. The injected section appears in the agent's system prompt, influencing its behavior

```typescript
export async function resolveAgentInstructions(
  agent: Agent | null | undefined,
  rootDir: string,
  ratingSummary?: AgentRatingSummary,  // Optional injection
): Promise<string>
```

### Trend Computation

The trend is computed by comparing recent ratings against historical ratings:
- **insufficient-data** — Fewer than 3 total ratings
- **improving** — Recent average is at least 0.5 higher than historical average
- **declining** — Recent average is at least 0.5 lower than historical average
- **stable** — Recent and historical averages are within 0.5 of each other

Recent = last 50% of ratings (or last 10, whichever is smaller). Historical = older ratings.

### Database Schema

```sql
CREATE TABLE agentRatings (
  id          TEXT PRIMARY KEY,
  agentId     TEXT NOT NULL,
  raterType   TEXT NOT NULL,        -- "user" | "agent" | "system"
  raterId     TEXT,
  score       INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  category    TEXT,
  comment     TEXT,
  runId       TEXT,
  taskId      TEXT,
  createdAt   TEXT NOT NULL         -- ISO-8601
)

CREATE INDEX idxAgentRatingsAgentId ON agentRatings(agentId)
CREATE INDEX idxAgentRatingsCreatedAt ON agentRatings(createdAt)
```

### Dashboard UI

The Performance tab in the agent detail modal (`AgentDetailView.tsx`) provides:

- **Summary card** showing average score, total ratings, trend indicator, and category breakdown
- **Rating form** to submit new ratings (score selector, category input, comment textarea)
- **Recent ratings list** showing last 50 ratings with score, category, comment, and timestamp
- **Delete action** on each rating (with confirmation)

## Checkout Leasing

Task ownership now supports explicit checkout leases modeled after Paperclip's checkout/release flow.

### Pattern

- Acquire ownership with `POST /api/tasks/:id/checkout` using `{ agentId }`
- Release ownership with `POST /api/tasks/:id/release` using `{ agentId }`
- Admin override with `POST /api/tasks/:id/force-release`
- Read current lease state with `GET /api/tasks/:id/checkout`

`AgentStore` exposes matching methods:
- `checkoutTask(agentId, taskId)`
- `releaseTask(agentId, taskId)`
- `forceReleaseTask(taskId)`
- `getCheckedOutBy(taskId)`

### Conflict Semantics

- Checkout conflicts return **409 Conflict** when another agent already holds the lease
- Response shape: `{ error: "Task is already checked out", currentHolder, taskId }`
- Clients **must not retry 409 automatically** — this is ownership contention, not a transient failure

### Heartbeat Enforcement

`HeartbeatMonitor.executeHeartbeat()` validates checkout before work begins:
- If `task.checkedOutBy` is set to another agent, the run exits gracefully with `reason: "checkout_conflict"`
- Heartbeat execution is **read-only with respect to lease ownership** — it does not auto-checkout
- Scheduler/API callers are responsible for obtaining checkout before starting work

### API Reference

- `POST /api/tasks/:id/checkout` — Acquire lease (`{ agentId }`)
- `POST /api/tasks/:id/release` — Release lease (`{ agentId }`)
- `POST /api/tasks/:id/force-release` — Force release lease
- `GET /api/tasks/:id/checkout` — Read lease state (`{ checkedOutBy, checkedOutAt }`)

## Dashboard Task Creation

The dashboard provides two UI surfaces for creating tasks:

### QuickEntryBox (List View) and InlineCreateCard (Board View)

Both components provide the same task creation experience. The chevron toggle is the single disclosure mechanism: collapsed = textarea only, expanded = all options visible in the controls panel.

**QuickEntryBox controls (all in expanded panel):**
- **Description input** — Type the task description. Press Enter to create immediately, or use the action buttons for AI-assisted creation.
- **Plan button** (Lightbulb icon) — Opens the AI Planning Mode modal with the current description pre-filled. This allows refining the task through an interactive Q&A before creation.
- **Subtask button** (ListTree icon) — Opens the subtask breakdown dialog with the current description pre-filled. The dialog generates 2–5 AI-suggested subtasks, lets the user edit titles, descriptions, sizes, and dependencies, and then creates all subtasks in one action.
- **Refine button** (Sparkles icon) — Opens a dropdown with Clarify, Add details, Expand, and Simplify options to refine the description with AI.
- **Deps button** (Link icon) — Opens the dependency picker to add task dependencies before creation.
- **Attach button** (Paperclip icon) — Attaches image files to the task.
- **Models button** (Brain icon) — Opens a nested menu with Plan, Executor, and Validator roles; each role opens a submenu with a model dropdown for per-task overrides.
- **Agent button** (Bot icon) — Opens the agent picker to assign the task to a specific agent.
- **Save button** (Save icon) — Manually creates/saves the task (alternative to pressing Enter).

**InlineCreateCard controls (all in expanded footer):**
- **Description input** — Type the task description. Press Enter to create immediately.
- **Plan button** (Lightbulb icon) — Opens the AI Planning Mode modal with the current description pre-filled.
- **Subtask button** (ListTree icon) — Opens the subtask breakdown dialog with the current description pre-filled.
- **Deps button** (Link icon) — Opens the dependency picker to add task dependencies before creation.
- **Agent button** (Bot icon) — Opens the agent picker to assign the task to a specific agent.
- **Browser Verify button** — Toggles the browser verification workflow step.
- **Preset button** (Zap icon) — Opens a dropdown to select a model preset or use custom models.
- **Models button** (Brain icon) — Opens the ModelSelectionModal for per-task model overrides.
- **Save button** — In the footer actions area (right-aligned). Manually creates/saves the task.

**Behavior:**
- Both Plan and Subtask buttons are disabled when no description is entered.
- Clicking either button clears the input after triggering the action.
- Regular task creation (Enter key) works as before without AI assistance.
- Escape dismisses overlays in order: model submenu → model menu → agent picker → deps popover → refine menu → input clear/collapse.

### New Task Modal

The New Task modal provides a full-featured task creation form with agent assignment support. It is opened from the board or list header and includes all task creation options.

**Agent Assignment:**
- The modal includes an "Assign Agent" dropdown below the TaskForm
- Clicking the agent button loads available agents via `fetchAgents` (excludes terminated agents)
- Selecting an agent includes `assignedAgentId` in the create payload
- Clearing the selection removes the assignment
- Agent selection is tracked in dirty state, triggering confirmation on close attempts

**Form Controls:**
- Description textarea with AI refinement options
- Plan and Subtask buttons for AI-assisted creation
- Attachments, Dependencies, and Model Configuration in "More options"
- Workflow step selection
- Agent assignment picker

**Payload:**
- `assignedAgentId` is included only when an agent is explicitly selected
- All other task creation fields (description, dependencies, model overrides, workflow steps) follow the same semantics as QuickEntryBox/InlineCreateCard

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

### Planning Mode Multi-Task Creation

The Planning Mode modal now offers two creation options after the AI-assisted planning conversation completes:

- **Create Task** — Creates a single task from the planning summary (existing behavior)
- **Break into Tasks** — Generates multiple tasks from the planning summary's key deliverables, with automatic dependencies

**How it works:**
1. User completes the AI planning conversation and sees the summary view
2. Summary view shows two buttons: "Create Task" (single) and "Break into Tasks" (multi)
3. Clicking "Break into Tasks" calls `POST /planning/start-breakdown` which generates subtasks from the planning summary's `keyDeliverables`
4. Each key deliverable becomes a separate subtask with sequential dependencies
5. If no key deliverables exist, 3 fallback subtasks are generated: "Define implementation approach", "Implement core changes", "Verify and polish"
6. User can edit subtasks (titles, descriptions, sizes, dependencies) using the same drag-and-drop UI as the Subtask Breakdown Dialog
7. Clicking "Create Tasks" calls `POST /planning/create-tasks` which creates all tasks with resolved dependencies
8. Each created task is logged with "Created via Planning Mode (multi-task)"

**API Endpoints:**
- `POST /planning/start-breakdown` — Generate subtasks from a completed planning session (returns `{ sessionId, subtasks }`)
- `POST /planning/create-tasks` — Create multiple tasks with resolved dependencies from edited subtasks (returns `{ tasks }`)

**Frontend Functions:**
- `startPlanningBreakdown(sessionId, projectId)` — Start subtask breakdown from planning
- `createTasksFromPlanning(planningSessionId, subtasks, projectId)` — Create tasks from edited subtasks

**Component Props:**
- `PlanningModeModal` now accepts `onTasksCreated: (tasks: Task[]) => void` callback for multi-task creation notifications

### Planning Mode Multi-Task Creation

The Planning Mode modal now offers two creation options after the AI-assisted planning conversation completes:

- **Create Task** — Creates a single task from the planning summary (existing behavior)
- **Break into Tasks** — Generates multiple tasks from the planning summary's key deliverables, with automatic dependencies

**How it works:**
1. User completes the AI planning conversation and sees the summary view
2. Summary view shows two buttons: "Create Task" (single) and "Break into Tasks" (multi)
3. Clicking "Break into Tasks" calls `POST /planning/start-breakdown` which generates subtasks from the planning summary's `keyDeliverables`
4. Each key deliverable becomes a separate subtask with sequential dependencies
5. If no key deliverables exist, 3 fallback subtasks are generated: "Define implementation approach", "Implement core changes", "Verify and polish"
6. User can edit subtasks (titles, descriptions, sizes, dependencies) using the same drag-and-drop UI as the Subtask Breakdown Dialog
7. Clicking "Create Tasks" calls `POST /planning/create-tasks` which creates all tasks with resolved dependencies
8. Each created task is logged with "Created via Planning Mode (multi-task)"

**API Endpoints:**
- `POST /planning/start-breakdown` — Generate subtasks from a completed planning session (returns `{ sessionId, subtasks }`)
- `POST /planning/create-tasks` — Create multiple tasks with resolved dependencies from edited subtasks (returns `{ tasks }`)

**Frontend Functions:**
- `startPlanningBreakdown(sessionId, projectId)` — Start subtask breakdown from planning
- `createTasksFromPlanning(planningSessionId, subtasks, projectId)` — Create tasks from edited subtasks

**Component Props:**
- `PlanningModeModal` now accepts `onTasksCreated: (tasks: Task[]) => void` callback for multi-task creation notifications

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

## Engine Diagnostic Logging

The task executor, scheduler, and related subsystems use structured logging via `createLogger()` from `packages/engine/src/logger.ts`. All log lines are prefixed with the subsystem name (e.g., `[executor]`, `[scheduler]`, `[stuck-detector]`, `[pi]`).

### Key Diagnostic Points

When debugging agent execution issues (agents stuck on "starting"), check these log points:

1. **`[executor] TaskExecutor constructed`** — Confirms the executor initialized with expected options (semaphore, stuck detector)
2. **`[executor] [event:task:moved] FN-XXX → in-progress`** — Confirms the scheduler moved the task and the executor received the event
3. **`[executor] execute() called for FN-XXX`** — Confirms execute() was entered (includes executing guard status)
4. **`[executor] FN-XXX: worktree ready at ...`** — Confirms worktree creation
5. **`[executor] FN-XXX: creating agent session`** — Confirms model resolution and session creation started
6. **`[pi] createKbAgent called`** — Confirms the agent factory was invoked with correct parameters
7. **`[pi] Session created successfully`** — Confirms the AI session was created
8. **`[executor] FN-XXX: calling promptWithFallback()...`** — Confirms the prompt was sent to the agent
9. **`[stuck-detector] Tracking task FN-XXX`** — Confirms heartbeat monitoring started

### Semaphore Resilience

The `AgentSemaphore` (`packages/engine/src/concurrency.ts`) has defensive guards against invalid `maxConcurrent` settings:
- `limit` getter returns minimum 1 (prevents indefinite blocking)
- `availableCount` returns 0 for invalid limits (NaN, Infinity, ≤0)
- If agents are stuck and logs show no `execute()` calls, check if the semaphore is blocking

## Git

- Commit messages: `feat(FN-XXX):`, `fix(FN-XXX):`, `test(FN-XXX):`
- One commit per step (not per file change)
- Always include the task ID prefix

## Headless Node Mode (`fn serve`)

The `fn serve` command starts Fusion as a **headless node**: API server + AI engine, with no frontend UI. Use it to run Fusion on remote machines or in Docker containers so they can participate as nodes in the mesh. Remote Fusion instances connect to the node API to submit tasks, stream events, and check health.

### Usage

```bash
fn serve [--port <port>] [--host <host>] [--paused]
fn serve --interactive
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port`, `-p` | `4040` | Port for the API server |
| `--host` | `0.0.0.0` | Host to bind (all interfaces, unlike `fn dashboard` which binds `localhost`) |
| `--paused` | — | Start with engine paused (automation disabled) |
| `--interactive` | — | Interactive port selection |

### Key Differences from `fn dashboard`

- `fn serve` binds to `0.0.0.0` by default (not `localhost`), so it is reachable remotely.
- `fn serve` uses `createServer(store, { headless: true })`, so it skips frontend static file serving and the `index.html` SPA fallback.
- `fn serve` still runs the full AI engine stack: triage, scheduler, executor, merge, cron, stuck detection, self-healing, mission autopilot, and ntfy notifications.
- `fn serve` prints a node-oriented startup banner instead of opening a browser.

### Startup Banner

```text
  Fusion Node
  ────────────────────────
  → http://0.0.0.0:4040

  Health:     GET /api/health
  API:        /api/*
  AI engine:  ✓ active
  Press Ctrl+C to stop
```

### Local Node Registration Lifecycle

- On startup, `runServe()` initializes `CentralCore`, finds the existing local node (created during `CentralCore.init()`), and sets it to `status: "online"`.
- On shutdown (`SIGINT`/`SIGTERM`), it sets that local node to `status: "offline"` before closing.
- If CentralCore is unavailable, `fn serve` continues starting and logs a warning (best-effort node status updates).

### Shutdown Behavior

`SIGINT`/`SIGTERM` triggers graceful shutdown. `runServe()` stops, in order:

- self-healing manager
- stuck task detector
- mission autopilot
- triage processor
- scheduler
- cron runner
- ntfy notifier

Then it updates local node status to `"offline"` (if available), closes the HTTP server, closes the `TaskStore`, and exits.

### Implementation Notes

- **File:** `packages/cli/src/commands/serve.ts` (`runServe()`)
- **Server option:** `createServer(store, { headless: true })` in `packages/dashboard/src/server.ts` (skips frontend serving/fallback)
- **Health endpoint:** `GET /api/health` returns `{ status: "ok", version: string, uptime: number }` without authentication

### `/api/health` Endpoint

- **Method:** `GET /api/health`
- **Auth:** None (intended for liveness/readiness probes and load balancers)
- **Response:** `{ status: "ok", version: string, uptime: number }`
- Available in both `fn dashboard` and `fn serve` because it is defined in the shared server.

### Common Workflows

```bash
# Start a headless node on a remote machine
fn serve --port 4040 --host 0.0.0.0

# Start in Docker (expose port)
docker run -p 4040:4040 my-fusion-image fn serve

# Start with paused engine for initial setup
fn serve --paused

# Check if a remote node is healthy
curl http://remote-host:4040/api/health
```

## Settings

fn uses a two-tier settings hierarchy:

- **Global settings** — User preferences stored in `~/.pi/fusion/settings.json`. These persist across all fn projects for the current user.
- **Project settings** — Project-specific workflow and resource settings stored in `.fusion/config.json`. These control how the engine operates for a particular project.

When reading settings, project values override global values. The merged view is what the engine and dashboard use.

### Settings Hierarchy

**Global settings** (`~/.pi/fusion/settings.json`):
- `themeMode` — UI theme preference (dark/light/system)
- `colorTheme` — Color theme (default/ocean/forest/etc)
- `defaultProvider` — Default AI model provider
- `defaultModelId` — Default AI model ID
- `defaultThinkingLevel` — Default thinking effort level
- `ntfyEnabled` — Enable push notifications
- `ntfyTopic` — ntfy.sh topic for notifications
- `modelOnboardingComplete` — Whether first-run model/provider onboarding has been completed

**Project settings** (`~/.fusion/config.json`):
- All other settings listed below (concurrency, merge, worktrees, commands, etc.)

The dashboard Settings modal shows scope indicators (🌐 global, 📁 project) in the sidebar to help users understand where each setting is stored. Saving only updates the scope matching the active section.

### API Endpoints

- `GET /api/settings` — Returns the merged view (project overrides global)
- `PUT /api/settings` — Updates project-level settings only (rejects global-only fields with 400)
- `GET /api/settings/global` — Returns global settings
- `PUT /api/settings/global` — Updates global settings
- `GET /api/settings/scopes` — Returns settings separated by scope: `{ global, project }`

The following settings are available in the fn configuration:

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

When true, enables ntfy.sh push notifications for task completion, failures, and plan approval requests.

**Notification events:**
- Task moves to "in-review" — "Task completed — ready for review"
- Task moves to "done" — "Task merged to main"
- Task status becomes "failed" — "Task failed" (high priority)
- Task status becomes "awaiting-approval" — "Plan needs approval for {taskId}" (high priority)

**Configuration:**
1. Go to https://ntfy.sh and pick a unique topic name (or self-host ntfy)
2. Open dashboard Settings → Notifications
3. Enable notifications and enter your topic name
4. Install the ntfy app on your phone/desktop and subscribe to your topic

```json
{
  "settings": {
    "ntfyEnabled": true,
    "ntfyTopic": "my-kb-notifications",
    "ntfyEvents": ["in-review", "merged", "failed", "awaiting-approval"]
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
- Paused tasks are automatically untracked from monitoring — when an in-progress task is paused, the executor terminates the agent session and moves the task to `todo` (the stuck-task detector is not involved in pause recovery)
- The timeout is read from settings on every poll cycle, so changes take effect immediately
- When the timeout value is changed (e.g., reduced from 30 to 10 minutes), the system immediately checks for stuck tasks under the new timer rather than waiting for the next poll cycle

### `aiSessionTtlMs` (default: `604800000` / 7 days)

TTL in milliseconds for persisted AI planning, subtask breakdown, and mission interview sessions stored in `ai_sessions`.

**How it works:**
- `AiSessionStore.cleanupOld(ttlMs)` treats sessions older than this value as expired
- Expired `generating`/`awaiting_input` sessions are first marked as `error` with "Session expired", then removed
- Expired `complete`/`error` sessions are removed directly
- In-memory session maps in planning/subtask/mission modules use the same 7-day TTL to avoid memory/SQLite mismatch

**Valid range:** `600000` (10 minutes) to `2592000000` (30 days)

**Configuration:**
```json
{
  "settings": {
    "aiSessionTtlMs": 604800000
  }
}
```

**Notes:**
- Lower values clean up stale sessions faster but reduce how long users can resume old planning flows
- Higher values preserve session recovery longer at the cost of more rows in `ai_sessions`

### `aiSessionCleanupIntervalMs` (default: `3600000` / 1 hour)

Interval in milliseconds for scheduled SQLite-backed cleanup sweeps of `ai_sessions`.

**How it works:**
- On server startup, `createServer()` reads this setting and starts `AiSessionStore.startScheduledCleanup(interval, ttl)`
- Each sweep runs `cleanupOld(aiSessionTtlMs)` using the configured TTL
- Cleanup is stopped on server shutdown via `AiSessionStore.stopScheduledCleanup()`

**Valid range:** `60000` (1 minute) to `86400000` (24 hours)

**Configuration:**
```json
{
  "settings": {
    "aiSessionCleanupIntervalMs": 3600000
  }
}
```

**Notes:**
- Shorter intervals reduce stale-row buildup but increase cleanup query frequency
- Longer intervals reduce background work but allow expired rows to linger until the next sweep

### `runStepsInNewSessions` (default: `false`)

When enabled, each task step runs in its own fresh agent session via `StepSessionExecutor` instead of a single monolithic session. This enables per-step error recovery with retry semantics and optional parallel execution for non-conflicting steps.

**How it works:**
- Each step gets its own agent session, providing isolation and independent retry logic
- Failed steps can be retried without re-running previously completed steps
- Step progress is tracked in the task store, updating step status to "in-progress" when starting and "done"/"skipped" on completion
- The dashboard step progress bar reflects real-time status during execution

**Configuration:**
```json
{
  "settings": {
    "runStepsInNewSessions": true,
    "maxParallelSteps": 2
  }
}
```

**Notes:**
- When disabled (default), all steps run in a single agent session (existing behavior)
- Step status updates are best-effort and do not block execution if they fail

### `maxParallelSteps` (default: `2`)

Maximum number of steps to run in parallel when `runStepsInNewSessions` is enabled. Steps execute in isolated git worktrees to avoid conflicts.

**Valid range:** 1–4

**Configuration:**
```json
{
  "settings": {
    "runStepsInNewSessions": true,
    "maxParallelSteps": 3
  }
}
```

**Notes:**
- This setting has no effect when `runStepsInNewSessions` is false
- Each parallel step requires its own worktree, so ensure `maxWorktrees` is sufficiently high
- Setting to `1` runs steps sequentially (still in separate sessions)

### `worktreeNaming` (default: `"random"`)

Controls how worktree directory names are generated when `recycleWorktrees` is NOT enabled. This setting only affects fresh worktrees (not pooled/recycled ones).

**Valid values:**
- `"random"` — Human-friendly random names like `swift-falcon`, `calm-river` (default)
- `"task-id"` — Use the task ID as the directory name, e.g., `fn-042`
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
- Task branches are always named `fusion/{task-id}` regardless of this setting
- When using `"task-title"` mode, special characters are replaced with hyphens and the result is lowercased

### `autoBackupEnabled` (default: `false`)

When true, enables automatic database backups for the fn SQLite database.

**How it works:**
- When enabled, the system creates scheduled automation to run backups on the configured schedule
- Backups are timestamped copies of `.fusion/fusion.db` stored in the backup directory
- Old backups are automatically cleaned up based on the retention setting
- Manual backups can still be created via CLI or dashboard even when auto-backup is disabled

**Configuration:**
```json
{
  "settings": {
    "autoBackupEnabled": true,
    "autoBackupSchedule": "0 2 * * *",
    "autoBackupRetention": 7,
    "autoBackupDir": ".fusion/backups"
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

### `autoBackupDir` (default: `".fusion/backups"`)

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
fn backup --create         # Create a backup immediately
fn backup --list           # List all backups with sizes
fn backup --restore <file> # Restore database from backup
fn backup --cleanup        # Remove old backups
```

### Dashboard

The dashboard Settings modal includes a "Backups" section where you can:
- Enable/disable automatic backups
- Configure the backup schedule
- Set retention count and backup directory
- View current backup count and total size
- Create manual backups with the "Backup Now" button

### `agentPrompts` (default: `undefined`)

Configurable agent role prompt templates and assignments. When set, allows per-project customization of system prompts for different agent roles (executor, triage, reviewer, merger).

**Configuration:**
```json
{
  "settings": {
    "agentPrompts": {
      "templates": [
        {
          "id": "my-custom-executor",
          "name": "My Custom Executor",
          "description": "A custom executor with specific behavioral guidelines",
          "role": "executor",
          "prompt": "You are a custom task execution agent..."
        }
      ],
      "roleAssignments": {
        "executor": "my-custom-executor",
        "reviewer": "strict-reviewer"
      }
    }
  }
}
```

**Built-in Templates:**

| Template ID | Role | Description |
|-------------|------|-------------|
| `default-executor` | executor | Standard task execution agent with full tooling and review support |
| `default-triage` | triage | Standard task specification agent producing detailed PROMPT.md files |
| `default-reviewer` | reviewer | Standard independent code and plan reviewer with balanced criteria |
| `default-merger` | merger | Standard merge agent for squash merges with conflict resolution |
| `senior-engineer` | executor | Autonomous executor with architectural awareness, performance focus, and minimal hand-holding |
| `strict-reviewer` | reviewer | Rigorous reviewer with stricter criteria for security, edge cases, backward compatibility, and type safety |
| `concise-triage` | triage | Shorter, more focused specification format with minimal prose |

**How It Works:**
- Set `roleAssignments` to map an agent role to a template ID (built-in or custom)
- Custom templates can override built-in templates by using the same ID
- When no assignment is configured for a role, the default built-in prompt is used (identical to pre-feature behavior)
- The merger prompt is used as a base — commit format instructions and build verification steps are always appended dynamically

**Notes:**
- Workflow step prompts and child agent prompts are NOT affected by this configuration (they are context-specific)
- The built-in prompt texts are derived from the engine's hardcoded prompts and should be kept in sync
- When `agentPrompts` is `undefined` (default), behavior is identical to before this feature existed

## Model Presets

The fn dashboard supports reusable model presets so teams can standardize AI model choices without manually selecting executor and validator models for every task.

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

When enabled, task creation UIs can preselect the configured preset for the detected task size. If no mapping exists for a given size, fn falls back to normal default-model behavior.

### Interaction with Per-Task Overrides

Presets are an alternative to manual per-task model selection, not a replacement:
- Selecting a preset fills in the task's executor and validator model overrides
- Choosing **Custom** or manually overriding models breaks out of preset mode for that task creation flow
- Existing per-task overrides on saved tasks continue to work as before
- If a preset is later edited or deleted, already-created tasks keep their resolved model settings

## Per-Task Model Overrides

The fn dashboard allows overriding the global AI model selection on a per-task basis. This enables using different models for different types of work without changing global settings.

### How It Works

Each task can optionally specify:
- **Executor Model**: The AI model used to implement the task (executor agent)
- **Validator Model**: The AI model used to review code and plans (reviewer agent)
- **Planning Model**: The AI model used for task specification (triage agent)

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
  "validatorModelId": "gpt-4o",
  "planningModelProvider": "google",
  "planningModelId": "gemini-2.5-pro",
  "thinkingLevel": "high"
}
```

To clear overrides, select "Use default" for both fields and save. To reset thinking level, select "Off (default)".

### Engine Behavior

- **Executor**: When both `modelProvider` and `modelId` are set on a task, the executor uses those instead of global settings when creating the agent session. In single-session execution mode, changing these fields on an in-progress task hot-swaps the active session model immediately (no pause/resume required). In step-session mode (`runStepsInNewSessions`), currently-running steps are not hot-swapped; changes apply when the next step session is created.
- **Reviewer**: When both `validatorModelProvider` and `validatorModelId` are set, the reviewer uses those instead of global settings. The validator model is passed via `ReviewOptions` to `reviewStep()`.
- **Planning**: When both `planningModelProvider` and `planningModelId` are set, the triage agent uses those instead of global settings for task specification.
- **Thinking Level**: When `thinkingLevel` is set to a value other than `"off"`, the executor uses that reasoning effort level instead of the global default. Configurable from the Model tab in the task detail modal and during task creation. Valid values: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`.

### Limitations

- Both provider and modelId must be set together; partial configuration falls back to defaults

## Model Settings Hierarchy

The system uses the following precedence for model selection:

**For Task Specification (Triage):**
1. Per-task `planningModelProvider`/`planningModelId` (if both set)
2. Global `planningProvider`/`planningModelId` (if both set)
3. Global `defaultProvider`/`defaultModelId` (if both set)
4. Automatic model resolution (fallback)

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
1. A compact entry is written to `.fusion/archive.jsonl` (JSON Lines format)
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
- Model overrides: `modelProvider`, `modelId`, `validatorModelProvider`, `validatorModelId`, `planningModelProvider`, `planningModelId`

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

## Mission Autopilot

Missions can run in **autopilot mode** for autonomous progression through slices and milestones without manual intervention. When enabled, the autopilot system watches task completion events and automatically activates the next slice when the current one finishes.

### How It Works

1. **User enables autopilot** on a mission via the dashboard UI (the only control needed)
2. The `MissionAutopilot` class starts watching the mission
3. As tasks complete, the scheduler notifies the autopilot
4. Autopilot checks if the current slice is complete
5. If complete, autopilot activates the next pending slice via the scheduler
6. When all milestones are done, autopilot marks the mission as complete

### Autopilot State Machine

| State | Description |
|-------|-------------|
| `inactive` | Dormant — autopilot not watching |
| `watching` | Monitoring task completion events |
| `activating` | Progressing to the next slice |
| `completing` | Wrapping up the mission |

### autopilotEnabled

The `autopilotEnabled` flag is the sole control for autopilot behavior. When enabled:

- Autopilot automatically watches the mission and monitors task completion
- When a slice completes, autopilot auto-advances to the next pending slice
- The autopilot toggle in the mission edit form is the only control needed

**Note:** The `autoAdvance` field is deprecated and superseded by `autopilotEnabled`. It is kept for backward compatibility with existing mission data but is no longer user-facing.

### Key Implementation

- **File:** `packages/engine/src/mission-autopilot.ts` — `MissionAutopilot` class
- **Integration:** Scheduler calls `missionAutopilot.handleTaskCompletion()` after feature status updates
- **Storage:** `autopilotEnabled`, `autopilotState`, and `lastAutopilotActivityAt` columns in missions table
- **Background poll:** Every 60 seconds checks that enabled missions are being watched and stale missions are flagged
- **Failure recovery:** Slice activation retries up to 3 times with exponential backoff

### API Endpoints

- `GET /api/missions/:missionId/autopilot` — Returns autopilot status
- `PATCH /api/missions/:missionId/autopilot` — Enable/disable autopilot (`{ enabled: boolean }`)
- `POST /api/missions/:missionId/autopilot/start` — Manually start watching (programmatic access)
- `POST /api/missions/:missionId/autopilot/stop` — Manually stop watching (programmatic access)

## Mission Planning Context

The mission planning context system enables AI-guided planning at multiple levels of the mission hierarchy. When features are triaged to tasks, they receive enriched descriptions containing full mission context, helping AI agents make informed decisions during implementation.

### Architecture Overview

The planning system operates at three levels:

1. **Mission-level interview** — Produces the overall mission specification (via existing `MissionInterviewModal`)
2. **Per-milestone interviews** — Refine scope and produce `planningNotes` and `verification` criteria
3. **Per-slice interviews** — Further refine scope and produce `planningNotes`, `verification`, and set `planState`

When features are triaged to tasks via `triageFeature()`, the system automatically enriches task descriptions with the full hierarchy context (mission → milestone → slice → feature), giving implementation agents comprehensive context.

### Data Model

**New fields on `Milestone`:**

| Field | Type | Description |
|-------|------|-------------|
| `planningNotes` | `string?` | Optional text field for storing interview/planning output |
| `verification` | `string?` | Optional text field for storing verification criteria |

**New fields on `Slice`:**

| Field | Type | Description |
|-------|------|-------------|
| `planningNotes` | `string?` | Optional text field for storing interview/planning output |
| `verification` | `string?` | Optional text field for storing verification criteria |
| `planState` | `SlicePlanState` | Tracks whether per-slice planning has been done: `"not_started"` \| `"planned"` \| `"needs_update"` |

**Existing fields enhanced for planning:**

| Field | Type | Description |
|-------|------|-------------|
| `Milestone.interviewState` | `InterviewState` | `"not_started"` \| `"in_progress"` \| `"completed"` \| `"needs_update"` — tracks milestone interview state |
| `Slice.status` | `SliceStatus` | `"pending"` \| `"active"` \| `"complete"` — lifecycle status (separate from `planState`) |

### Interview Flow

The `MilestoneSliceInterviewModal` component provides the UI for milestone and slice interviews:

1. User clicks the **Plan** button on a milestone or slice in MissionManager
2. Dashboard opens the `MilestoneSliceInterviewModal`
3. User chooses from three options:
   - **Start Interview** — Begins AI-guided Q&A to refine scope
   - **Use Mission Context** — Skips interview, applies mission-level context directly
   - **Cancel** — Dismisses without changes

For AI interviews:
4. Session created via `createTargetInterviewSession()`
5. AI asks clarifying questions via `submitTargetInterviewResponse()`
6. User reviews summary and clicks **Apply** to persist results
7. Results stored via `applyTargetInterview()`:
   - Milestone: `planningNotes`, `verification`, `interviewState: "completed"`
   - Slice: `planningNotes`, `verification`, `planState: "planned"`

For skip flow:
4. `skipTargetInterview()` called directly
5. Planning notes populated with mission context message
6. State set: `interviewState: "completed"` (milestone) or `planState: "planned"` (slice)

### Triage Enrichment

The `MissionStore.buildEnrichedDescription()` method assembles structured markdown task descriptions:

```
## Mission: Authentication System
Build a complete auth system

## Milestone: Core Auth
**Description:** Implement core authentication
**Verification:** Users can log in and log out
**Planning Notes:** Decided on JWT strategy

## Slice: Login Page
**Description:** Build the login UI
**Verification:** Login form accepts valid credentials
**Planning Notes:** Use existing design system

## Feature: Login Form
Standard login form with email/password

**Acceptance Criteria:**
Form validates input and shows errors
```

**Key behaviors:**
- Only non-empty fields are included in the output
- Custom description overrides bypass enrichment entirely
- Enrichment reads current state at triage time (historical tasks keep original context)

### API Endpoints

**Milestone Interview:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/missions/milestones/:milestoneId/interview/start` | Start milestone interview session |
| `POST` | `/api/missions/milestones/:milestoneId/interview/respond` | Submit responses to interview questions |
| `GET` | `/api/missions/milestones/:milestoneId/interview/stream` | SSE stream for real-time interview updates |
| `POST` | `/api/missions/milestones/:milestoneId/interview/apply` | Apply interview results to milestone |
| `POST` | `/api/missions/milestones/:milestoneId/interview/skip` | Skip interview, use mission-level context |

**Slice Interview:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/missions/slices/:sliceId/interview/start` | Start slice interview session |
| `POST` | `/api/missions/slices/:sliceId/interview/respond` | Submit responses to interview questions |
| `GET` | `/api/missions/slices/:sliceId/interview/stream` | SSE stream for real-time interview updates |
| `POST` | `/api/missions/slices/:sliceId/interview/apply` | Apply interview results to slice |
| `POST` | `/api/missions/slices/:sliceId/interview/skip` | Skip interview, use mission-level context |

### Database Schema

Migration version 21 adds the new planning fields to the schema:

```sql
-- milestones table additions
ALTER TABLE milestones ADD COLUMN planningNotes TEXT;
ALTER TABLE milestones ADD COLUMN verification TEXT;

-- slices table additions
ALTER TABLE slices ADD COLUMN planningNotes TEXT;
ALTER TABLE slices ADD COLUMN verification TEXT;
ALTER TABLE slices ADD COLUMN planState TEXT NOT NULL DEFAULT 'not_started';
```

### Key Implementation Files

- `packages/core/src/mission-types.ts` — Type definitions for `SlicePlanState`, `SLICE_PLAN_STATES`, updated `Milestone` and `Slice` interfaces
- `packages/core/src/mission-store.ts` — `buildEnrichedDescription()`, `triageFeature()` with enrichment, `updateMilestone()` and `updateSlice()` with new fields
- `packages/dashboard/src/milestone-slice-interview.ts` — Interview engine: `createTargetInterviewSession()`, `applyTargetInterview()`, `skipTargetInterview()`
- `packages/dashboard/app/components/MilestoneSliceInterviewModal.tsx` — React component for the interview UI
- `packages/dashboard/app/components/MissionManager.tsx` — Plan buttons and planning state indicators

### Dashboard UI Elements

**Plan Buttons:**
- Appear next to non-complete milestones and slices
- Hidden for completed items
- Trigger `MilestoneSliceInterviewModal` on click

**Planning State Indicators:**
- Visual badges showing interview/plan state
- Color-coded: grey (not started), green (completed), amber (needs update)

**Triage Preview:**
- Shows enriched description before creating task
- Allows user to preview context that will be injected
- "Create Task" confirms triage, "Cancel" dismisses

## Workflow Steps

Workflow steps are reusable quality gates that run at configurable lifecycle phases. Each step can be configured to run as **pre-merge** (after implementation, before merge — can block) or **post-merge** (after merge success — informational only). They enable post-implementation review, documentation checks, QA validation, deployment notifications, and other automated checks.

### Execution Phases

| Phase | When | Failure behavior |
|-------|------|-----------------|
| **Pre-merge** (default) | After task implementation, before merge | Blocks merge — task stays in in-review |
| **Post-merge** | After successful merge to main | Logged only — does not block or rollback |

Legacy workflow steps without an explicit `phase` field are treated as **pre-merge** for backward compatibility.

### How It Works

1. **Define globally** — Workflow steps are defined once in the dashboard (Workflow Steps button in header) with a name, description, mode, and phase
2. **AI-assisted prompts** — Use the "Refine with AI" button to convert a rough description into a detailed agent prompt
3. **Enable per-task** — When creating a new task, check the workflow steps you want to run
4. **Automatic execution** — Pre-merge steps run after the main task executor calls `task_done()`; post-merge steps run after the merger completes a successful merge
5. **Review gate** — Only pre-merge steps must pass before the task moves to in-review; post-merge failures are logged but non-blocking

### Storage

Workflow step definitions are stored in the SQLite `workflow_steps` table, while the ID counter remains in the `config` row (`nextWorkflowStepId`):

```sql
-- workflow_steps
id: "WS-001"
templateId: null
name: "Documentation Review"
description: "Verify all public APIs have documentation"
mode: "prompt"
phase: "pre-merge"
prompt: "Review the task changes and verify that all new public functions..."
enabled: 1
defaultOn: 0
createdAt: "2026-03-31T00:00:00.000Z"
updatedAt: "2026-03-31T00:00:00.000Z"

-- config (single row)
nextWorkflowStepId: 2
```

Tasks store their enabled workflow step IDs in `task.json`:
```json
{
  "enabledWorkflowSteps": ["WS-001", "WS-002"]
}
```

The order of IDs in `enabledWorkflowSteps` determines execution order — the engine iterates the array sequentially. Users can reorder steps in the task create/edit form using ▲/▼ controls when two or more steps are selected.

### API

- `GET /api/workflow-steps` — List all workflow step definitions
- `POST /api/workflow-steps` — Create a new workflow step
- `PATCH /api/workflow-steps/:id` — Update a workflow step
- `DELETE /api/workflow-steps/:id` — Delete (also removes from tasks)
- `POST /api/workflow-steps/:id/refine` — AI-refine the prompt from description

### Engine Behavior

- **Prompt mode** steps use readonly agent tools (file reading only, no modifications); **script mode** steps execute a named command from project settings (`settings.scripts`) in the task worktree
- Each prompt-mode step runs as a separate agent session; script-mode steps run via `execSync` with a 2-minute timeout
- **Model override:** Prompt-mode steps can specify a `modelProvider` + `modelId` pair. When both are set, the executor uses that model instead of global defaults. When either is missing, the executor falls back to `defaultProvider`/`defaultModelId`
- Steps execute sequentially within their phase (pre-merge steps first, then post-merge steps after merge)
- Pre-merge steps run in the executor; post-merge steps run in the merger after successful merge
- If a pre-merge workflow step fails (agent reports issues or script exits non-zero), the task is marked as failed and stays in in-review for manual inspection
- Post-merge step failures are logged to the task's workflow results but do not block the merge or rollback git state
- Steps with empty prompts (prompt mode) or missing script names (script mode) are skipped with a log entry
- All workflow step activity is logged to the task's agent log

### Viewing Results

When workflow steps run on a task, their results appear in the dashboard's task detail modal:

- **Workflow tab** — Click the "Workflow" tab in the task detail modal to see workflow step results
- **Pass/fail status** — Each step shows its status (Passed, Failed, Skipped, or Running)
- **Execution output** — The output from each workflow step agent is displayed for review
- **Timestamps** — See when each step started and how long it took to complete

The Workflow tab only appears for tasks that have workflow steps enabled or have workflow results from a previous run.

## Workflow Step Templates

Workflow step templates are pre-defined quality gates that can be added with one click instead of creating from scratch. The dashboard includes 6 built-in templates covering common quality, security, and compliance checks.

### Available Templates

| Template | Category | Description |
|----------|----------|-------------|
| **Documentation Review** | Quality | Verify all public APIs, functions, and complex logic have appropriate documentation |
| **QA Check** | Quality | Run tests and verify they pass, check for obvious bugs |
| **Security Audit** | Security | Check for common security vulnerabilities and anti-patterns |
| **Performance Review** | Quality | Check for performance anti-patterns and optimization opportunities |
| **Accessibility Check** | Quality | Verify UI changes meet accessibility standards (WCAG 2.1) |
| **Browser Verification** | Quality | Verify end-to-end web behavior using browser automation and interaction checks |

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
- **Browser Verification** — Uses browser automation to validate user flows, page interactions, and visual regressions

### API

- `GET /api/workflow-step-templates` — List all built-in templates
- `POST /api/workflow-step-templates/:id/create` — Create workflow step from template

### Adding Templates

When you add a template:
1. The template data is copied to a new workflow step (templates themselves are immutable)
2. The new step is enabled by default
3. You can edit the step after creation to customize the prompt
