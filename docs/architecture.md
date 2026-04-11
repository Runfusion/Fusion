# Fusion Architecture

[← Docs index](./README.md)

This document describes the actual architecture of Fusion as implemented in this repository (`gsxdsm/fusion`). It is intended as a practical onboarding map for developers and AI agents.

---

## 1) Overview

Fusion is an AI-orchestrated task board. It takes tasks through a structured lifecycle (`triage → todo → in-progress → in-review → done → archived`) and automates triage, execution, review, merge, and operational recovery.

At a high level, Fusion is split into:
- **Core domain + persistence** (`@fusion/core`)
- **Execution engine** (`@fusion/engine`)
- **Dashboard API + SPA** (`@fusion/dashboard`)
- **CLI + Pi extension** (`@gsxdsm/fusion`)
- **Desktop shell** (`@fusion/desktop`)
- **TUI** (`@fusion/tui`)

### High-level runtime diagram

```text
                        ┌──────────────────────────────┐
                        │   Human + AI Interactions    │
                        │  (Dashboard, CLI, Pi tools)  │
                        └──────────────┬───────────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                │                      │                      │
      ┌─────────▼─────────┐  ┌─────────▼─────────┐  ┌─────────▼─────────┐
      │  Dashboard (API)  │  │ CLI `fn` router   │  │ Pi extension tools │
      │ + React SPA       │  │ (commands/*)      │  │ (extension.ts)     │
      └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
                └──────────────┬────────┴──────────────┬───────┘
                               │                       │
                      ┌────────▼───────────────────────▼───────┐
                      │            Engine Runtime               │
                      │ Scheduler / Triage / Executor / Merger │
                      │ Heartbeat / Self-healing / Autopilot   │
                      └────────┬───────────────────────┬────────┘
                               │                       │
                   ┌───────────▼──────────┐   ┌────────▼─────────────┐
                   │ @fusion/core         │   │ External systems      │
                   │ stores + types       │   │ git, GitHub, models   │
                   └───────┬──────────────┘   └───────────────────────┘
                           │
          ┌────────────────▼────────────────┐
          │ Persistence                      │
          │ - .fusion/fusion.db (SQLite/WAL)
          │ - .fusion/tasks/* (PROMPT/logs)
          │ - ~/.pi/fusion/fusion-central.db │
          └──────────────────────────────────┘
```

---

## 2) Monorepo Structure

| Package | Published | Role | Key files |
|---|---|---|---|
| `@fusion/core` | Private | Domain model, stores, SQLite adapters, settings, shared types | `packages/core/src/types.ts`, `store.ts`, `db.ts`, `central-core.ts`, `agent-store.ts` |
| `@fusion/engine` | Private | AI orchestration runtime (triage, scheduler, executor, merger, recovery) | `packages/engine/src/triage.ts`, `scheduler.ts`, `executor.ts`, `merger.ts`, `project-runtime.ts` |
| `@fusion/dashboard` | Private | Express API server + React app | `packages/dashboard/src/server.ts`, `routes.ts`, `sse.ts`, `websocket.ts`, `packages/dashboard/app/App.tsx` |
| `@gsxdsm/fusion` | **Published** | CLI binary (`fn`) + Pi extension | `packages/cli/src/bin.ts`, `commands/*`, `project-resolver.ts`, `extension.ts` |
| `@fusion/desktop` | Private | Electron shell around Fusion dashboard/client | `packages/desktop/src/main.ts`, `ipc.ts`, `preload.ts`, `scripts/build.ts` |
| `@fusion/tui` | Private | Ink-based terminal package with ScreenRouter and tab navigation | `packages/tui/src/index.tsx`, `packages/tui/src/components/screen-router.tsx` |

> Note: The workspace also contains `@fusion/mobile` (`packages/mobile`), which packages dashboard assets for Capacitor targets.

---

## 3) Package Dependencies

### Workspace dependency graph

```text
                         ┌────────────────────┐
                         │   @fusion/core     │
                         └─────────┬──────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │       @fusion/engine        │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │     @fusion/dashboard       │
                    └──────────────┬──────────────┘
                                   │
                  ┌────────────────▼────────────────┐
                  │      @gsxdsm/fusion (CLI)       │
                  │  (workspace composition + build)│
                  └────────────────┬────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      @fusion/desktop        │
                    │ (embeds dashboard client)   │
                    └──────────────────────────────┘

        @fusion/tui provides keyboard-navigable screen routing.
```

Concrete references:
- `@fusion/engine` depends on `@fusion/core` (`packages/engine/package.json`)
- `@fusion/dashboard` depends on both `@fusion/core` and `@fusion/engine`
- CLI command entrypoint (`packages/cli/src/bin.ts`) dynamically imports command modules that use core/engine/dashboard capabilities
- Desktop build script copies dashboard client output (`packages/desktop/scripts/build.ts`)

---

## 4) Core Package (`@fusion/core`)

### Responsibility
`@fusion/core` is the shared domain and persistence layer.

### Main components
- **Types and constants**: `packages/core/src/types.ts`
  - Columns: `COLUMNS`
  - Transition map: `VALID_TRANSITIONS`
  - Settings defaults: `DEFAULT_GLOBAL_SETTINGS`, `DEFAULT_PROJECT_SETTINGS`
  - Workflow types (`WorkflowStep`, `WorkflowStepPhase`, etc.)
- **TaskStore**: `packages/core/src/store.ts`
  - Main task CRUD + lifecycle store
  - Emits board events (`task:created`, `task:moved`, `task:updated`, ...)
  - Hybrid model: SQLite metadata + filesystem blobs under `.fusion/tasks/{id}`
- **Database adapter**: `packages/core/src/db.ts`
  - SQLite (`node:sqlite`) with WAL mode + foreign keys
  - JSON helpers: `toJson`, `toJsonNullable`, `fromJson`
  - Tables: `tasks`, `config`, `activityLog`, `archivedTasks`, `automations`, `agents`, `agentHeartbeats`, mission hierarchy tables, `__meta`
- **CentralCore**: `packages/core/src/central-core.ts`
  - Global project registry, health, central activity feed, global concurrency
  - Backed by `packages/core/src/central-db.ts` (`~/.pi/fusion/fusion-central.db`)
- **Specialized stores**:
  - `AgentStore` (`agent-store.ts`) — filesystem-based agent metadata + heartbeat run history
  - `MissionStore` (`mission-store.ts`) — mission/milestone/slice/feature hierarchy
  - `AutomationStore` (`automation-store.ts`) — scheduled jobs
  - `MessageStore` (`message-store.ts`) — mailbox/inbox/outbox messaging

### Shared utilities
From `packages/core/src/index.ts` exports:
- GitHub CLI wrappers: `gh-cli.ts`
- Backups: `backup.ts`
- Settings import/export: `settings-export.ts`
- AI title summarization: `ai-summarize.ts`
- Project memory helpers: `project-memory.ts`, `memory-insights.ts`
- Migration and compatibility helpers: `db-migrate.ts`, `migration.ts`

### Memory System

Fusion includes a pluggable memory backend system for storing durable project learnings:

**Two-stage memory:**
- Working memory (`memory.md`) accumulates agent learnings during task execution
- Distilled insights (`memory-insights.md`) preserve patterns, principles, pitfalls

**Pluggable backends (`memory-backend.ts`):**

| Backend | Type | Capabilities |
|---------|------|-------------|
| `FileMemoryBackend` | `file` | Read/Write, Atomic writes, Persistent |
| `ReadOnlyMemoryBackend` | `readonly` | Read only, Non-persistent |

**Backend registration:**
```typescript
import { registerMemoryBackend, resolveMemoryBackend } from "@fusion/core";

// Register custom backend
registerMemoryBackend(customBackend);

// Resolve based on settings
const backend = resolveMemoryBackend(settings);
```

**Settings integration:**
- `memoryEnabled`: Toggle controls whether memory instructions are injected into prompts
- `memoryBackendType`: Select which backend to use (`file` or `readonly`)

**Dashboard API:**
- `GET /api/memory/backend` — Returns current backend status and capabilities

See [Memory Plugin Contract](./memory-plugin-contract.md) for the full specification.

---

## 5) Engine Package (`@fusion/engine`)

`@fusion/engine` executes the autonomous workflow.

### Agent roles
- **Triage**: `TriageProcessor` (`triage.ts`) generates task specs (`PROMPT.md`)
- **Executor**: `TaskExecutor` (`executor.ts`) implements tasks in worktrees
- **Reviewer**: `reviewStep()` (`reviewer.ts`) performs plan/code reviews
- **Merger**: `aiMergeTask()` (`merger.ts`) merges approved work

### Scheduling and execution
- `Scheduler` (`scheduler.ts`)
  - Polls and event-triggers scheduling
  - Respects dependencies and concurrency/worktree limits
  - Integrates mission progression hooks
- `TaskExecutor` (`executor.ts`)
  - Creates/reuses worktrees
  - Runs model sessions via `createKbAgent()` (`pi.ts`)
  - Supports tool-calling workflow (`task_update`, `task_log`, `task_create`, `review_step`, `spawn_agent`, ...)
- `StepSessionExecutor` (`step-session-executor.ts`)
  - Optional per-step sessions (`runStepsInNewSessions`)
  - File-scope conflict analysis + parallel wave execution

### Concurrency and resiliency
- `AgentSemaphore` (`concurrency.ts`) controls slot acquisition
- `StuckTaskDetector` (`stuck-task-detector.ts`) handles inactivity/loop stalls
- `SelfHealingManager` (`self-healing.ts`) handles auto-unpause, maintenance, stuck kill budgets
- `UsageLimitPauser` (`usage-limit-detector.ts`) and retry helpers (`rate-limit-retry.ts`)

### Worktree management
- `WorktreePool` (`worktree-pool.ts`) recycles idle worktrees when enabled
- Branch naming convention in executor: `fusion/{task-id-lower}`

### Heartbeat execution
Implemented in `agent-heartbeat.ts`:
- `HeartbeatMonitor`
- `HeartbeatTriggerScheduler` (timer, assignment, on-demand triggers)
- `WakeContext` / per-agent runtime config support

### Mission automation
- `MissionAutopilot` (`mission-autopilot.ts`) watches mission progress and auto-activates slices

### Multi-runtime support + IPC
- Runtime contracts: `project-runtime.ts`
- Orchestration: `ProjectManager` and `HybridExecutor`
- Runtime implementations:
  - `runtimes/in-process-runtime.ts`
  - `runtimes/child-process-runtime.ts`
  - `runtimes/remote-node-runtime.ts`
- IPC protocol/transport:
  - `ipc/ipc-protocol.ts`
  - `ipc/ipc-host.ts`
  - `ipc/ipc-worker.ts`
  - worker entrypoint: `runtimes/child-process-worker.ts`

---

## 6) Dashboard Package (`@fusion/dashboard`)

### Server layer
- Entry exports: `packages/dashboard/src/index.ts`
- Main server factory: `createServer()` in `packages/dashboard/src/server.ts`
- API routes: `createApiRoutes()` in `packages/dashboard/src/routes.ts`

Key server capabilities:
- REST APIs for tasks, git, GitHub, agents, missions, planning, automations, settings
- Project-scoped store reuse via `project-store-resolver.ts`
- Rate limiting (`rate-limit.ts`)
- Static SPA hosting (Vite build output)

### Real-time channels
- **SSE**: `/api/events` (`sse.ts`)
  - Emits `task:*`, mission events, AI session updates
- **Badge WebSocket**: `/api/ws` (`setupBadgeWebSocket` in `server.ts`, manager in `websocket.ts`)
  - Broadcasts lightweight badge snapshots (`prInfo` / `issueInfo`)
- **Terminal WebSocket**: `/api/terminal/ws` (also in `server.ts`)

### Frontend SPA layer
- App entry: `packages/dashboard/app/main.tsx`
- Root composition: `packages/dashboard/app/App.tsx`
- Core board components: `components/Board.tsx`, `Column.tsx`, `TaskCard.tsx`, `TaskDetailModal.tsx`
- List/creation UX: `ListView.tsx`, `QuickEntryBox.tsx`, `InlineCreateCard.tsx`

### Key hooks
- `useTasks.ts` — SSE-driven task sync with reconnect + timestamp conflict handling
- `useBadgeWebSocket.ts` — shared singleton badge socket/subscriptions
- `useAgents.ts`, `useProjects.ts`, `useCurrentProject.ts`, `useTerminal.ts`

### Planning and decomposition features
- Backend planners:
  - `planning.ts`
  - `subtask-breakdown.ts`
- UI modals:
  - `PlanningModeModal.tsx`
  - `SubtaskBreakdownModal.tsx`
- Multi-task creation endpoints are wired under planning/subtask routes in `routes.ts`

---

## 7) CLI Package (`@gsxdsm/fusion`)

### Command entrypoint
- `packages/cli/src/bin.ts`
  - Bootstraps environment
  - Parses global flags (including `--project`)
  - Routes subcommands (`task`, `project`, `settings`, `git`, `backup`, `mission`, `agent`, `message`, etc.)

### Command modules
- `packages/cli/src/commands/*`
  - Task operations, settings, git wrappers, backup operations, project/node management

### Project selection
- `packages/cli/src/project-resolver.ts`
  - Resolution order: explicit `--project` → CWD detection (`.fusion`) → default/fallback logic
  - Integrates `CentralCore` and `ProjectManager`

### Pi extension
- `packages/cli/src/extension.ts`
  - Registers tool set for in-chat task/mission operations
  - Uses `TaskStore` directly for extension-side actions

### Binary identity
- Published package defines `fn` binary (`packages/cli/package.json`)

---

## 8) Storage Architecture

Fusion uses a hybrid storage model.

### Per-project storage
- **SQLite DB**: `.fusion/fusion.db`
- **Filesystem blobs** (task-local artifacts):
  - `.fusion/tasks/{TASK_ID}/PROMPT.md`
  - `.fusion/tasks/{TASK_ID}/agent.log`
  - `.fusion/tasks/{TASK_ID}/attachments/*`

SQLite schema is initialized in `packages/core/src/db.ts` and uses:
- WAL mode (`PRAGMA journal_mode = WAL`)
- Foreign keys (`PRAGMA foreign_keys = ON`)
- `__meta.lastModified` for change detection/polling

### Central storage (multi-project)
- **Central DB**: `~/.pi/fusion/fusion-central.db`
- Schema in `packages/core/src/central-db.ts`
  - `projects`, `projectHealth`, `centralActivityLog`, `globalConcurrency`, `nodes`, `__meta`

### File-based side stores
Some data remains intentionally filesystem-based:
- Agents: `.fusion/agents/*` (`AgentStore`)
- Messages: `.fusion/messages/*` (`MessageStore`)

### Migration from legacy file storage
- Detection + migration: `packages/core/src/db-migrate.ts`
- Migrates legacy task/config/log/archive/automation/agent data into SQLite
- Creates `.bak` backups (for example `task.json.bak`, `config.json.bak`, `archive.jsonl.bak`)

### Archive system
- Archived task snapshots are stored in SQLite `archivedTasks`
- `TaskStore` archive helpers:
  - `archiveTaskAndCleanup()`
  - `cleanupArchivedTasks()`
  - `readArchiveLog()` / `findInArchive()`
  - `unarchiveTask()` with restore behavior

---

## 9) Task Lifecycle

Lifecycle constants are defined in `packages/core/src/types.ts`:
- Columns: `triage`, `todo`, `in-progress`, `in-review`, `done`, `archived`
- Transition rules via `VALID_TRANSITIONS`

### Lifecycle flow

```text
triage
  │ (TriageProcessor writes PROMPT.md)
  ▼
todo
  │ (Scheduler selects task, dependencies satisfied)
  ▼
in-progress
  │ (TaskExecutor runs in worktree)
  ▼
in-review
  │ (implementation complete + pre-merge workflow steps)
  ▼
done
  │
  └──────────────▶ archived
```

### Execution detail
- **Triage phase**: `TriageProcessor` generates executable spec
- **Execution phase**: `TaskExecutor` performs implementation, tool calls, tests/build commands
- **Review phase**: optional `reviewStep()` workflow depending on prompt review level
- **Merge phase**: `aiMergeTask()` handles merge strategy and post-merge workflow steps

### Step status model
Task steps use statuses: `pending`, `in-progress`, `done`, `skipped`.

### Workflow steps
- Defined in project config as `WorkflowStep`
- **Pre-merge** steps run in executor (`runWorkflowSteps()`)
- **Post-merge** steps run in merger (`runPostMergeWorkflowSteps()`)

---

## 10) Agent System

Fusion has two complementary agent models:

1. **Task pipeline agents** (triage/executor/reviewer/merger) managed by engine runtime
2. **Persistent registered agents** managed by `AgentStore`

### Persistent agent storage
`packages/core/src/agent-store.ts` persists to:
- `.fusion/agents/{id}.json`
- `.fusion/agents/{id}-heartbeats.jsonl`
- `.fusion/agents/{id}-keys.jsonl`
- `.fusion/agents/{id}-revisions.jsonl`

### Agent spawning from executor
`TaskExecutor` supports hierarchical child agents via:
- `createSpawnAgentTool()`
- `runSpawnedChild()`
- `terminateChildAgent()` / `terminateAllChildren()`

Limits are controlled by project settings (`maxSpawnedAgentsPerParent`, `maxSpawnedAgentsGlobal`).

### Heartbeat monitoring and triggers
`agent-heartbeat.ts` provides:
- Health monitoring and run tracking (`HeartbeatMonitor`)
- Trigger scheduling (`HeartbeatTriggerScheduler`) for:
  - timer
  - task assignment
  - on-demand runs

### Custom instructions
`packages/engine/src/agent-instructions.ts` resolves per-agent instruction text/path with path-traversal and extension validation.

---

## 11) Multi-Project Architecture

Multi-project orchestration spans core + engine.

### Core control plane
- `CentralCore` (`packages/core/src/central-core.ts`) maintains:
  - Project registry
  - Health metrics
  - Unified central activity feed
  - Global concurrency state
  - Node registry (`local` / `remote`)

### Engine orchestration
- `HybridExecutor` (`packages/engine/src/hybrid-executor.ts`) is the top-level orchestrator
- `ProjectManager` instantiates per-project runtimes and forwards events with project attribution

### Runtime abstraction
Defined in `project-runtime.ts`:
- `ProjectRuntime` interface
- `RuntimeStatus` and `RuntimeMetrics`

Implementations:
- `InProcessRuntime`
- `ChildProcessRuntime`
- `RemoteNodeRuntime`

### IPC protocol (child-process mode)
In `packages/engine/src/ipc/ipc-protocol.ts`:
- Host commands: `START_RUNTIME`, `STOP_RUNTIME`, `GET_STATUS`, `GET_METRICS`, `PING`
- Worker events: `TASK_CREATED`, `TASK_MOVED`, `TASK_UPDATED`, `ERROR_EVENT`, `HEALTH_CHANGED`

### Multi-project runtime diagram

```text
                   HybridExecutor
                        │
                ┌───────┴────────┐
                │   ProjectManager│
                └───┬─────────┬───┘
                    │         │
        ┌───────────▼───┐  ┌──▼──────────────┐
        │InProcessRuntime│  │ChildProcessRuntime│
        │(local process) │  │(fork + IPC host)  │
        └──────┬─────────┘  └──┬───────────────┘
               │                │
          TaskStore/Scheduler   │
                                ▼
                        child-process-worker
                        + InProcessRuntime
```

---

## 12) Settings Hierarchy

Settings are split by scope.

### Global scope
- File: `~/.pi/fusion/settings.json`
- Managed by `GlobalSettingsStore` (`packages/core/src/global-settings.ts`)
- Examples: `themeMode`, `colorTheme`, default model/provider, notification preferences

### Project scope
- Stored in per-project config (`config` table + compatibility file `.fusion/config.json`)
- Includes engine/runtime controls (`maxConcurrent`, `autoMerge`, worktree and workflow behavior, etc.)

### Merged view
- `Settings` combines global + project values
- Defaults in `DEFAULT_GLOBAL_SETTINGS` and `DEFAULT_PROJECT_SETTINGS`
- Scope key lists in `GLOBAL_SETTINGS_KEYS` and `PROJECT_SETTINGS_KEYS`

### Model controls
- Per-task model overrides on task fields:
  - `modelProvider` / `modelId`
  - `validatorModelProvider` / `validatorModelId`
  - `planningModelProvider` / `planningModelId`
  - `thinkingLevel`
- Reusable presets via `ModelPreset`
- Agent prompt template overrides via `agentPrompts`

---

## 13) Git Integration

Git behavior is implemented primarily in engine executor/merger + dashboard/CLI git APIs.

### Worktree model
- Each active task runs in isolated worktree under `.worktrees/*`
- Executor creates branches like `fusion/{task-id}` (`executor.ts`)
- `WorktreePool` can recycle idle worktrees when enabled

### Merge strategies
- Setting type: `MergeStrategy = "direct" | "pull-request"` (`types.ts`)
- `aiMergeTask()` in `merger.ts` performs merge flow
- Supports workflow-step execution after merge (post-merge phase)

### Conflict handling
`merger.ts` includes conflict classification and auto-resolution helpers:
- lock files (`LOCKFILE_PATTERNS`)
- generated files (`GENERATED_PATTERNS`)
- whitespace-trivial conflicts

### PR and badge integration
- Engine PR monitor: `pr-monitor.ts` and `pr-comment-handler.ts`
- Dashboard GitHub APIs + webhook route in `routes.ts`
- Badge snapshots are streamed via `/api/ws` and `useBadgeWebSocket.ts`

---

## 14) Key Design Decisions

1. **SQLite + WAL for local-first reliability**
   - Chosen for simple deployment and strong transactional behavior
   - WAL mode enables concurrent readers/writers with low ops overhead

2. **Hybrid persistence (DB + filesystem blobs)**
   - Structured metadata in SQLite, large text/artifacts in task directories
   - Keeps DB efficient while preserving inspectable task artifacts

3. **Git worktree isolation as core execution primitive**
   - Prevents cross-task interference
   - Makes concurrent task execution safer
   - Enables deterministic cleanup/retry/recovery

4. **Agent-as-tool-caller pattern**
   - Engine tools (`task_update`, `task_log`, `review_step`, `spawn_agent`, etc.) create explicit, auditable state transitions
   - Prompts are role-specific (`TRIAGE_SYSTEM_PROMPT`, `EXECUTOR_SYSTEM_PROMPT`, etc.)

5. **Separation of real-time channels by concern**
   - SSE for broad board/missions/session state updates (`/api/events`)
   - Dedicated badge WebSocket (`/api/ws`) for lightweight PR/issue badge snapshots

6. **Multi-project control plane with runtime abstraction**
   - `CentralCore` decouples registry/health/concurrency from per-project execution
   - `ProjectRuntime` interface allows multiple isolation strategies (in-process, child-process, remote node)

---

## Source Map (quick navigation)

- **Core exports:** `packages/core/src/index.ts`
- **Engine exports:** `packages/engine/src/index.ts`
- **Dashboard exports:** `packages/dashboard/src/index.ts`
- **CLI entry:** `packages/cli/src/bin.ts`
- **Pi extension:** `packages/cli/src/extension.ts`
- **Runtime abstraction:** `packages/engine/src/project-runtime.ts`
- **Multi-project orchestrator:** `packages/engine/src/hybrid-executor.ts`
