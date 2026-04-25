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
- **CLI + Pi extension** (`@runfusion/fusion`)
- **Desktop shell** (`@fusion/desktop`)
- **Terminal dashboard** (part of `@runfusion/fusion` — see `packages/cli/src/commands/dashboard-tui/`)

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
          │ - ~/.fusion/fusion-central.db │
          └──────────────────────────────────┘
```

---

## 2) Monorepo Structure

| Package | Published | Role | Key files |
|---|---|---|---|
| `@fusion/core` | Private | Domain model, stores, SQLite adapters, settings, shared types | `packages/core/src/types.ts`, `store.ts`, `db.ts`, `central-core.ts`, `agent-store.ts` |
| `@fusion/engine` | Private | AI orchestration runtime (triage, scheduler, executor, merger, recovery) | `packages/engine/src/triage.ts`, `scheduler.ts`, `executor.ts`, `merger.ts`, `project-runtime.ts` |
| `@fusion/dashboard` | Private | Express API server + React app | `packages/dashboard/src/server.ts`, `routes.ts`, `sse.ts`, `websocket.ts`, `packages/dashboard/app/App.tsx` |
| `@runfusion/fusion` | **Published** | CLI binary (`fn`) + Pi extension | `packages/cli/src/bin.ts`, `commands/*`, `project-resolver.ts`, `extension.ts` |
| `@fusion/desktop` | Private | Electron shell around Fusion dashboard/client | `packages/desktop/src/main.ts`, `ipc.ts`, `preload.ts`, `scripts/build.ts` |
| `@fusion/mobile` | Private | Capacitor + PWA mobile packaging of dashboard assets | `packages/mobile/capacitor.config.ts`, `packages/mobile/src/*` |
| `@fusion/plugin-sdk` | Private | Plugin SDK for building Fusion extensions | `packages/plugin-sdk/src/*` |

---

## 3) Package Dependencies

### Workspace dependency graph

`A ──▶ B` means **A depends on B**.

```text
@fusion/engine ───────────────▶ @fusion/core
@fusion/dashboard ────────────▶ @fusion/core
@fusion/dashboard ────────────▶ @fusion/engine
@runfusion/fusion (CLI) ─────────▶ @fusion/core
@runfusion/fusion (CLI) ─────────▶ @fusion/engine
@runfusion/fusion (CLI) ─────────▶ @fusion/dashboard
@fusion/plugin-sdk (peerDep) ─▶ @fusion/core

@fusion/desktop: no workspace package dependencies
@fusion/mobile:  no workspace package dependencies
```

Concrete references:
- `@fusion/engine` has a workspace dependency on `@fusion/core` (`packages/engine/package.json`)
- `@fusion/dashboard` has workspace dependencies on `@fusion/core` and `@fusion/engine` (`packages/dashboard/package.json`)
- `@runfusion/fusion` has workspace development dependencies on `@fusion/core`, `@fusion/engine`, and `@fusion/dashboard` for composition/build packaging (`packages/cli/package.json`)
- `@fusion/plugin-sdk` declares a peer dependency on `@fusion/core` (`packages/plugin-sdk/package.json`)
- `@fusion/desktop` embeds dashboard assets at build time via script (`packages/desktop/scripts/build.ts`) but does not declare workspace deps in `package.json`
- `@fusion/mobile` triggers dashboard build/sync via scripts (`packages/mobile/package.json`) but does not declare workspace deps in `package.json`

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
  - Core schema tables include: `tasks`, `config`, `workflow_steps`, `activityLog`, `archivedTasks`, `automations`, `agents`, `agentHeartbeats`, `task_documents`, `task_document_revisions`, mission hierarchy tables (`missions`, `milestones`, `slices`, `mission_features`, `mission_events`), plugin/routine tables (`plugins`, `routines`), roadmap tables (`roadmaps`, `roadmap_milestones`, `roadmap_features`), insight tables (`project_insights`, `project_insight_runs`), `__meta`
  - Migration-created tables include: `ai_sessions`, `messages`, `agentRatings`, `chat_sessions`, `chat_messages`, `runAuditEvents`, `mission_contract_assertions`, `mission_feature_assertions`, `mission_validator_runs`, `mission_validator_failures`, `mission_fix_feature_lineage`
- **Standalone roadmap model**: `packages/core/src/roadmap-types.ts`, `roadmap-ordering.ts`, `roadmap-store.ts`
  - Roadmap-first entity types (`Roadmap`, `RoadmapMilestone`, `RoadmapFeature`)
  - Pure ordering helpers for contiguous 0-based milestone/feature order and deterministic cross-milestone feature moves
  - `RoadmapStore` for CRUD operations, deterministic ordering, and atomic reorder/move operations
  - Dashboard API routes in `packages/dashboard/src/roadmap-routes.ts`
  - Exported from `@fusion/core` for downstream persistence/API/UI work
- **CentralCore**: `packages/core/src/central-core.ts`
  - Global project registry, health, central activity feed, global concurrency
  - Backed by `packages/core/src/central-db.ts` (`~/.fusion/fusion-central.db`)
- **Specialized stores**:
  - `AgentStore` (`agent-store.ts`) — filesystem-based agent metadata + heartbeat run history
  - `MissionStore` (`mission-store.ts`) — mission/milestone/slice/feature hierarchy
  - `AutomationStore` (`automation-store.ts`) — scheduled jobs with global/project scope isolation
  - `MessageStore` (`message-store.ts`) — mailbox/inbox/outbox messaging
  - `ChatStore` (`chat-store.ts`) — session/message persistence for agent chat
  - `InsightStore` (`insight-store.ts`) — project insight persistence + dedupe/run tracking
  - `ReflectionStore` (`reflection-store.ts`) — agent reflection records and performance snapshots
  - `PluginStore` (`plugin-store.ts`) — plugin registry/state/settings persistence
  - `RoutineStore` (`routine-store.ts`) — recurring routine definitions and run history
  - `RoadmapStore` (`roadmap-store.ts`) — standalone roadmap CRUD with deterministic ordering and atomic reorder/move operations

### Chat System

- `ChatStore` (`packages/core/src/chat-store.ts`) and `chat-types.ts` provide session-oriented chat state (`chat_sessions`, `chat_messages` tables)
- Dashboard chat UX lives in `packages/dashboard/app/components/ChatView.tsx` and hooks `useChat.ts` / `useQuickChat.ts`
- Chat message submission uses SSE streaming responses from dashboard chat routes

### Agent Companies

- Import/export utilities: `agent-companies-parser.ts`, `agent-companies-exporter.ts`, `agent-companies-types.ts`
- Supports YAML-frontmatter manifests for company/team/agent/project/task/skill definitions
- Includes conversion helpers from parsed manifests to `AgentCreateInput` and export helpers for directory bundles

### Project Insights

- `InsightStore` (`insight-store.ts`, `insight-types.ts`) persists extracted project learnings
- Uses fingerprint-based deduplication and run tracking
- Backed by `project_insights` and `project_insight_runs`

### Plugin System

- `PluginStore` (`plugin-store.ts`) stores plugin installation state and settings (`plugins` table)
- `PluginLoader` (`plugin-loader.ts`) loads/unloads plugin modules and emits lifecycle events
- Dashboard management routes are implemented in `packages/dashboard/src/plugin-routes.ts`

### Prompt Overrides

- `prompt-overrides.ts` defines prompt key catalogs and per-role override validation
- Provides override resolution/validation helpers (`resolvePrompt`, `resolveRolePrompts`, `assertValidPromptOverrideMap`)

### Agent Permissions

- `agent-permissions.ts` normalizes permissions and computes effective access state
- Core helpers: `normalizePermissions`, `computeAccessState`, `ROLE_DEFAULT_PERMISSIONS`

### Standalone roadmap model

Fusion now has two planning models in core:

- **Roadmap hierarchy** — `Roadmap → RoadmapMilestone → RoadmapFeature`
- **Mission hierarchy** — `Mission → Milestone → Slice → Feature → Task`

The roadmap model is intentionally lightweight and independent from `MissionStore`/mission lifecycle semantics. It is meant for standalone planning, ordering, drag-and-drop moves, and future conversion flows into missions or tasks without coupling roadmap data to slice activation, autopilot, or mission status rollups.

**Roadmap persistence (FN-1690/FN-1691):**
- `RoadmapStore` provides CRUD operations with atomic reorder/move semantics
- All list queries use deterministic ordering: `ORDER BY orderIndex ASC, createdAt ASC, id ASC`
- Covering indexes ensure efficient ordered reads without temp B-tree sorts
- Cross-milestone feature moves atomically renumber both source and destination milestone scopes
- FK cascade integrity: deleting a roadmap removes milestones and features
- Export/handoff DTO methods for integration with downstream systems:
  - `getRoadmapExport()` → `RoadmapExportBundle` (flat export payload)
  - `getMissionPlanningHandoff()` → `RoadmapMissionPlanningHandoff` (mission conversion)
  - `listFeatureTaskPlanningHandoffs()` → `RoadmapFeatureTaskPlanningHandoff[]` (all features as task handoffs)
  - `getRoadmapFeatureHandoff()` → `RoadmapFeatureTaskPlanningHandoff` (single feature task handoff)
- Pure handoff mapping helpers in `roadmap-handoff.ts` for read-only transformations

**Roadmap handoff contract boundary (FN-1674):**
- Handoffs are **read-only** transformations — no mission/task records are created
- Source lineage is preserved on every emitted item (roadmapId, milestoneId, featureId, titles, order indices)
- Ordering is deterministic using `normalizeRoadmapMilestoneOrder` and `normalizeRoadmapFeatureOrder`
- Not-found semantics: store handoff methods throw when roadmapId is unknown; routes map to HTTP 404
- The combined handoff endpoint (`GET /:roadmapId/handoff`) returns both mission and task handoffs

Key roadmap invariants:
- milestone ordering is scoped to a single roadmap and must remain contiguous + 0-based
- feature ordering is scoped to a single milestone and must remain contiguous + 0-based
- repair/normalization uses deterministic tie-breakers: `orderIndex ASC`, `createdAt ASC`, `id ASC`
- cross-milestone feature moves must renumber both the source and destination milestone deterministically

**Roadmap REST API endpoints (`/api/roadmaps`):**
- Roadmaps: `GET /`, `POST /`, `GET /:roadmapId`, `PATCH /:roadmapId`, `DELETE /:roadmapId`
- Milestones: `GET /:roadmapId/milestones`, `POST /:roadmapId/milestones`, `PATCH /milestones/:milestoneId`, `DELETE /milestones/:milestoneId`, `POST /:roadmapId/milestones/reorder`
- Features: `GET /milestones/:milestoneId/features`, `POST /milestones/:milestoneId/features`, `PATCH /features/:featureId`, `DELETE /features/:featureId`, `POST /milestones/:milestoneId/features/reorder`, `POST /features/:featureId/move`
- Export/Handoff: `GET /:roadmapId/export`, `GET /:roadmapId/handoff`, `GET /:roadmapId/handoff/mission`, `GET /:roadmapId/milestones/:milestoneId/features/:featureId/handoff/task`

**Database schema:**
- `roadmaps` — roadmap metadata (id, title, description, timestamps)
- `roadmap_milestones` — milestone data with `roadmapId` FK
- `roadmap_features` — feature data with `milestoneId` FK
- `idxRoadmapMilestonesRoadmapOrder` — covering index for deterministic milestone ordering
- `idxRoadmapFeaturesMilestoneOrder` — covering index for deterministic feature ordering

### Shared utilities
From `packages/core/src/index.ts` exports (selected high-impact modules):
- **Memory + knowledge**: `memory-backend.ts`, `memory-compaction.ts`, `memory-dreams.ts`, `project-memory.ts`, `memory-insights.ts`, `insight-store.ts`, `insight-types.ts`
- **Stores and plugin/routine helpers**: `chat-store.ts`, `routine-store.ts`, `plugin-store.ts`, `plugin-loader.ts`, `reflection-store.ts`
- **Execution/runtime helpers**: `run-command.ts`, `board.ts`, `task-merge.ts`, `archive-db.ts`
- **Settings + prompts + permissions**: `settings-schema.ts`, `prompt-overrides.ts`, `agent-permissions.ts`, `agent-prompts.ts`
- **Node/system infrastructure**: `node-connection.ts`, `node-discovery.ts`, `system-metrics.ts`, `migration-orchestrator.ts`
- **Identity/version/extensions**: `daemon-token.ts`, `app-version.ts`, `pi-extensions.ts`
- **Agent companies import/export**: `agent-companies-parser.ts`, `agent-companies-exporter.ts`, `agent-companies-types.ts`

### Memory System

Fusion uses OpenClaw-style project memory files and separates memory into two responsibilities:

1. **Layered backend runtime memory** (`memory-backend.ts`, `project-memory.ts`)
   - canonical long-term + layered memory access used by agents and dashboard APIs
2. **Insight extraction automation** (`memory-insights.ts`, `InsightStore`)
   - scheduled extraction/pruning workflows over project memory plus insight/audit artifacts

Both systems currently use `.fusion/memory/MEMORY.md` as the canonical working source-of-truth.

**Primary memory files:**
- Long-term: `.fusion/memory/MEMORY.md`
- Daily notes: `.fusion/memory/YYYY-MM-DD.md`
- Dream processing: `.fusion/memory/DREAMS.md`

**Memory subsystems:**
- `memory-backend.ts` — backend contracts + file/readonly/qmd implementations
- `memory-compaction.ts` — summarization/compaction automation
- `memory-dreams.ts` — background dream processing for agent and project memory
- `memory-insights.ts` + `InsightStore` — extracted insight synthesis and persistent insight/run storage

**Pluggable backends (`memory-backend.ts`):**

| Backend | Type | Capabilities |
|---------|------|-------------|
| `FileMemoryBackend` | `file` | Read/Write, Atomic writes, Persistent |
| `ReadOnlyMemoryBackend` | `readonly` | Read only, Non-persistent |
| `QmdMemoryBackend` | `qmd` | Read/Write, Persistent, CLI-based with file fallback |

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
- `memoryBackendType`: Select which backend to use (`file`, `readonly`, `qmd`, or custom). Unknown types are accepted and persisted verbatim; runtime resolution falls back to `DEFAULT_MEMORY_BACKEND` (`qmd`).

**QMD Backend Behavior:**
The QMD backend (`qmd`) delegates read/write I/O to the file backend and schedules background QMD index refreshes. For search, it attempts QMD query first and falls back to local `.fusion/memory/` file search when QMD is unavailable, errors, or returns no matches.

**Dashboard API:**
- `GET /api/memory/backend` — Returns current backend status and capabilities

See [Memory Plugin Contract](./memory-plugin-contract.md) for the full specification.

---

## 5) Engine Package (`@fusion/engine`)

`@fusion/engine` executes the autonomous workflow.

### Agent roles
- **Triage**: `TriageProcessor` (`triage.ts`) generates task specs (`PROMPT.md`) and selects eligible triage tasks by priority first, then FIFO (`createdAt` ascending) within each priority tier.
- **Executor**: `TaskExecutor` (`executor.ts`) implements tasks in worktrees
- **Reviewer**: `reviewStep()` (`reviewer.ts`) performs plan/code reviews
- **Merger**: `aiMergeTask()` (`merger.ts`) merges approved work

### Scheduling and execution
- `Scheduler` (`scheduler.ts`) — dependency-aware task scheduling that dispatches eligible todo tasks by priority first, then FIFO (`createdAt` ascending) within each priority tier.
- `StepSessionExecutor` (`step-session-executor.ts`) — per-step sessions + parallel wave execution
- `TaskCompletion` (`task-completion.ts`) — completion gate helpers
- `SpecStaleness` (`spec-staleness.ts`) — stale spec detection utilities
- `MissionExecutionLoop` (`mission-execution-loop.ts`) — validator/fix loop orchestration
- `MissionFeatureSync` (`mission-feature-sync.ts`) — feature↔task status synchronization
- `MissionAutopilot` (`mission-autopilot.ts`) — mission slice auto-progression

### Routine + cron automation
- `RoutineRunner` (`routine-runner.ts`) — executes routine steps
- `RoutineScheduler` (`routine-scheduler.ts`) — schedules due routines
- `CronRunner` (`cron-runner.ts`) — cron-based AI/script jobs

### Execution context + skills
- `SkillResolver` (`skill-resolver.ts`) — resolves active skill sets for sessions
- `SessionSkillContext` (`session-skill-context.ts`) — skill context materialization per run
- `ContextLimitDetector` (`context-limit-detector.ts`) — context-window pressure checks
- `TokenCapDetector` (`token-cap-detector.ts`) — token-cap enforcement checks
- `PluginRunner` (`plugin-runner.ts`) — runtime plugin callback execution
- `AgentRuntime` (`agent-runtime.ts`) — runtime adapter interface contract
- `RuntimeResolution` (`runtime-resolution.ts`) — runtime selection and fallback logic
- `AgentSessionHelpers` (`agent-session-helpers.ts`) — runtime-aware session creation helpers

### Concurrency, recovery, and resiliency
- `AgentSemaphore` (`concurrency.ts`) — slot acquisition
- `RecoveryPolicy` (`recovery-policy.ts`) — retry/recovery decision policy
- `StuckTaskDetector` (`stuck-task-detector.ts`) — inactivity/loop stall detection
- `TransientErrorDetector` (`transient-error-detector.ts`) — retriable error classification
- `SelfHealingManager` (`self-healing.ts`) — auto-unpause/maintenance recovery actions
- `UsageLimitPauser` (`usage-limit-detector.ts`) and `withRateLimitRetry` (`rate-limit-retry.ts`)

### Worktree and naming helpers
- `WorktreePool` (`worktree-pool.ts`) — idle worktree reuse
- `WorktreeNames` (`worktree-names.ts`) — deterministic worktree/branch naming

### Observability and reflection
- `AgentLogger` (`agent-logger.ts`) — structured per-agent run logging
- `RunAudit` (`run-audit.ts`) — mutation audit tracking (DB/git/filesystem)
- `Notifier` (`notifier.ts`) — notification delivery (`NtfyNotifier`)
- `AgentReflection` (`agent-reflection.ts`) — reflection extraction and persistence

### Heartbeat execution
Implemented in `agent-heartbeat.ts`:
- `HeartbeatMonitor`
- `HeartbeatTriggerScheduler` (timer, assignment, on-demand triggers)
- `WakeContext` / per-agent runtime config support

### Node/mesh runtime services
- `NodeHealthMonitor` (`node-health-monitor.ts`) — remote node liveness/metrics checks
- `PeerExchangeService` (`peer-exchange-service.ts`) — peer sync orchestration

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
- Primary API router: `createApiRoutes()` in `packages/dashboard/src/routes.ts`

Key server capabilities:
- REST APIs for tasks, git, GitHub, agents, missions, planning, automations/routines, settings
- Chat APIs (`/api/chat/*`) with streaming response support (`routes.ts`, `chat.ts`)
- Dev-server lifecycle + persistence APIs (`/api/dev-server/*`) backed by:
  - `dev-server-routes.ts` (router factory + per-project runtime registry)
  - `dev-server-process.ts` (`DevServerProcessManager` for spawn/stop/restart/url-detection)
  - `dev-server-store.ts` (durable `.fusion/dev-server.json` state + log ring buffer)
  - `dev-server-detect.ts` (project/workspace script auto-detection + confidence scoring)
  - Note: this **hyphenated `dev-server-*` family is the canonical runtime owner** today; see `docs/dev-server-module-boundary-audit.md` for the FN-2212 boundary/consolidation audit covering parallel `devserver-*` modules.
- Plugin management routes (`plugin-routes.ts`)
- Insights routes (`insights-routes.ts`)
- Roadmap routes (`roadmap-routes.ts`)
- Project-scoped store reuse via `project-store-resolver.ts`
- Rate limiting (`rate-limit.ts`)
- Static SPA hosting (Vite build output)

### Runtime diagnostics logging contract
- Dashboard/server runtime diagnostics use the shared `RuntimeLogger` contract (`packages/dashboard/src/runtime-logger.ts`) instead of ad hoc `console.*` calls.
- `createServer()` accepts `ServerOptions.runtimeLogger`; when omitted it defaults to a console-backed logger, preserving readable output in non-TTY/headless modes.
- CLI TTY dashboard sessions inject a logger backed by `DashboardLogSink`, so runtime diagnostics from server/routes are captured in the TUI log buffer.
- Intentional startup/banner text in `fn dashboard` and `fn serve` remains direct plain output for readability and backward-compatible scripting behavior.

### Real-time channels
- **SSE**: `/api/events` (`sse.ts`)
  - Emits `task:*`, mission events, AI session updates
  - Project-scoped: resolves project context from query param or engine manager
- **Chat streaming**: `/api/chat/sessions/:id/messages` (`routes.ts` + `chat.ts`)
  - Streams assistant responses as SSE events for chat sessions
- **Chat session queries**: `/api/chat/sessions` (`routes.ts`)
  - Existing list behavior is unchanged (`status=active|archived|all` returns an array)
  - Quick Chat resume uses targeted lookup params: `agentId`, optional `modelProvider` + `modelId`, plus `resume=1`
  - Validation requires `modelProvider` and `modelId` together; partial model pairs return `400`
  - Targeted lookup returns only the newest matching active session (or `null`) to avoid scanning every active session client-side
- **Task log stream**: `/api/tasks/:id/logs/stream` (`server.ts`)
  - SSE endpoint for live task log streaming with project scope resolution
- **Dev-server stream**: `/api/dev-server/logs/stream` (`dev-server-routes.ts`)
  - SSE stream emits `history`, `log`, `stopped`, and `failed` events
  - initial connection replays persisted `logHistory` and then follows live process output
  - companion endpoints: `/api/dev-server/detect`, `/config`, `/status`, `/start`, `/stop`, `/restart`, `/preview-url`
- **Badge WebSocket**: `/api/ws` (`server.ts`, `websocket.ts`)
  - Scope-keyed channels (`badge:{scopeKey}:{taskId}`) prevent cross-project collisions
- **Terminal WebSocket**: `/api/terminal/ws` (`server.ts`, `terminal-service.ts`)
  - Project-scoped terminal session validation + safe unscoped fallback

### Frontend SPA layer
- App entry: `packages/dashboard/app/main.tsx`
- Root composition: `packages/dashboard/app/App.tsx`
- Core board components: `Board.tsx`, `Column.tsx`, `TaskCard.tsx`, `TaskDetailModal.tsx`
- Chat system UI: `ChatView.tsx`, `QuickChatFAB.tsx`
- Planning/roadmap/insight UI: `MissionManager.tsx`, `RoadmapsView.tsx`, `InsightsView.tsx`, `DocumentsView.tsx`
- Dev server UI: `DevServerView.tsx` (controls + status/log panel + embedded preview with iframe fallback messaging)

### Key hooks
- Task + realtime: `useTasks.ts`, `useBadgeWebSocket.ts`, `useAiSessionSync.ts`
- Chat: `useChat.ts`, `useQuickChat.ts`
- Documents/insights/memory: `useDocuments.ts`, `useInsights.ts`, `useMemoryBackendStatus.ts`, `useMemoryData.ts`
- Planning/roadmaps: `useRoadmaps.ts`
- Dev server: `useDevServer.ts` (status hydration, command controls, reconnect stream handling, project-scope reset)
- Project/agents/setup: `useProjects.ts`, `useCurrentProject.ts`, `useAgents.ts`, `useSetupReadiness.ts`
- UX/platform helpers: `useFavorites.ts`, `useAuthOnboarding.ts`, `useDeepLink.ts`, `useTerminal.ts`

### Planning and decomposition features
- Backend planners: `planning.ts`, `subtask-breakdown.ts`, `roadmap-suggestions.ts`
- UI modals: `PlanningModeModal.tsx`, `SubtaskBreakdownModal.tsx`, milestone interview flows
- Multi-task creation endpoints are wired under planning/subtask routes in `routes.ts`

### Health and monitoring endpoints
- **Health check**: `GET /api/health`
  - Returns liveness status for load balancers and monitoring
  - Response: `{ status: "ok", version: string, uptime: number }`
  - No authentication required

### Run Audit API
The run-audit system records every mutation performed by the engine across three domains:
- **Database** — task:create, task:update, task:move, etc.
- **Git** — worktree:create, commit:create, merge:resolve, etc.
- **Filesystem** — file:write, prompt:write, attachment:create, etc.

Events are tied to specific run IDs for end-to-end traceability.

**Run audit endpoint:**
- `GET /api/agents/:id/runs/:runId/audit` — Returns audit trail for a specific agent run
  - Query params: `?domain=database|git|filesystem` for filtering
  - Requires agent ownership or admin access

---

## 7) CLI Package (`@runfusion/fusion`)

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
- **Central DB**: `~/.fusion/fusion-central.db`
- Schema in `packages/core/src/central-db.ts`
  - `projects`, `projectHealth`, `centralActivityLog`, `globalConcurrency`, `nodes`, `peerNodes`, `settingsSyncState`, `__meta`

### Memory files
- OpenClaw-style memory workspace:
  - `.fusion/memory/MEMORY.md`
  - `.fusion/memory/YYYY-MM-DD.md`
  - `.fusion/memory/DREAMS.md`
- The legacy top-level memory file is migration-compatibility only (seed/alias behavior) and is not canonical storage.

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
- **Review phase**: optional `reviewStep()` workflow depending on prompt review level (bypassed in fast mode)
- **Merge phase**: `aiMergeTask()` handles merge strategy and post-merge workflow steps

> **Fast Mode:** Tasks with `executionMode: "fast"` bypass the `review_step` tool injection and pre-merge workflow steps. Completion blockers (tests, build, typecheck from PROMPT.md) and post-merge workflow steps remain enforced.

### Step status model
Task steps use statuses: `pending`, `in-progress`, `done`, `skipped`.

### Workflow steps
- Defined in project config as `WorkflowStep`
- **Pre-merge** steps run in executor (`runWorkflowSteps()`) — bypassed in fast mode
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
- File: `~/.fusion/settings.json`
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
