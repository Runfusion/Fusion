# Fusion Architecture

[← Docs index](./README.md)

This document describes the actual architecture of Fusion as implemented in this repository (`gsxdsm/fusion`). It is intended as a practical onboarding map for developers and AI agents.

---

## 1) Overview

Fusion is an AI-orchestrated task board. It takes tasks through a structured lifecycle (`planning → todo → in-progress → in-review → done → archived`) and automates planning, execution, review, merge, and operational recovery.

At a high level, Fusion is split into:
- **Core domain + persistence** (`@fusion/core`)
- **Execution engine** (`@fusion/engine`)
- **Dashboard API + SPA** (`@fusion/dashboard`)
- **CLI + Pi extension** (`@runfusion/fusion`)
- **Desktop shell** (`@fusion/desktop`)
- **Mobile shell** (`@fusion/mobile`)
- **Terminal dashboard** (part of `@runfusion/fusion` — see `packages/cli/src/commands/dashboard-tui/`)

Native shells expose a shared host-neutral bridge at `window.fusionShell` for first-run shell onboarding, connection profile persistence, and active shell mode/profile state. The dashboard consumes `window.fusionShell` when present and degrades cleanly in plain web/PWA mode.

The dashboard also has a canonical host-context bootstrap layer (`packages/dashboard/app/shell-host.ts`) that normalizes launch metadata into one discriminated union:
- `{ kind: "browser" }`
- `{ kind: "desktop-shell", mode?, connectionId?, serverUrl?, canOpenConnectionManager? }`
- `{ kind: "mobile-shell", mode?, connectionId?, serverUrl?, canOpenConnectionManager? }`

Detection priority is deterministic: explicit bootstrapped global from shell handoff → shell handoff query params → desktop fallback via `window.fusionAPI` presence → browser fallback. Shell-only query params are stripped at bootstrap via `history.replaceState`.

React consumers read this through `ShellHostProvider` / `useShellHostContext` (`packages/dashboard/app/context/ShellHostContext.tsx`). Do not add ad-hoc host checks in components.

Dashboard chrome now resolves connection-management capabilities through `packages/dashboard/app/shell-native.ts` (`getShellConnectionNativeResult`) and renders status/actions via `ShellConnectionStatus`. Components should receive derived props from App-level wiring, not read `window.fusionAPI`/`window.fusionShell` directly.

Important distinction: `NodeContext.isRemote` indicates browsing a remote mesh node inside the current dashboard instance; shell host `mode: "remote"` indicates how native desktop/mobile launched into this dashboard server. These are separate axes and must not be conflated in UI or routing logic.

### `window.fusionShell` bridge contract

Canonical dashboard-side types live in `packages/dashboard/app/types/native-shell.d.ts`.

Shared bridge methods used by dashboard/mobile/desktop flows:
- `getState()`
- `listProfiles()`
- `saveProfile(profile)`
- `deleteProfile(profileId)`
- `setActiveProfile(profileId)`
- `setDesktopMode(mode)`
- `startQrScan()`
- `openConnectionManager()`
- `subscribe(listener)`

Shared shell state contract (`ShellConnectionState`):
- `host` (`"web" | "mobile-shell" | "desktop-shell"`)
- `desktopMode` (`"local" | "remote"`, optional)
- `activeProfileId`
- `profiles`
- `localServer` (`status`, optional `port`, optional `error`)

Desktop-specific bootstrap extension:
- Electron preload also exposes `getDesktopModeState()` for first-run desktop mode selection (`{ isFirstRun, desktopMode }`).
- Electron preload exposes `window.fusionAPI.openConnectionManager()` as the renderer-safe desktop entry point for opening native connection management.
- The dashboard itself does **not** depend on that preload-only helper for steady-state rendering; it consumes shared shell state via `ShellContext` (`packages/dashboard/app/context/ShellContext.tsx`).

Persistence ownership by host:
- **Mobile shell** persists connection profiles + active profile with Capacitor Preferences (`packages/mobile/src/plugins/connection-profiles.ts`).
- **Desktop shell** persists shell settings in app-owned JSON at `app.getPath("userData")/shell-connections.json` (`packages/desktop/src/shell-settings.ts`).

These are shell-owned persistence layers, intentionally separate from Fusion project/global settings.

### Shell contract regression matrix (FN-3409)

Cross-package automated tests now lock:
- **Mobile shell**: first-run remote onboarding inputs (QR/manual + optional token), saved-profile edit/switch, and restore-on-reinit persistence.
- **Desktop shell**: first-run/last-used mode restore, local-vs-remote startup behavior, and preload bridge channel compatibility for connection management.
- **Dashboard shell awareness**: canonical per-viewport connection-manager entry placement, browser-safe fallback (no shell-only controls), and host-context/native-helper resolution without ad-hoc window bridge access.
- **Sensitive data handling**: dashboard-facing native status surfaces expose profile label/origin metadata only; auth tokens are not surfaced.

### High-level runtime diagram

```text
                        ┌──────────────────────────────┐
                        │   Human + AI Interactions    │
                        │ (Dashboard SPA, CLI, Pi)     │
                        └──────────────┬───────────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                │                      │                      │
      ┌─────────▼─────────┐  ┌─────────▼─────────┐  ┌─────────▼─────────┐
      │  Dashboard (API)  │  │ CLI `fn` router   │  │ Pi extension tools │
      │ + React SPA       │  │ + TUI component   │  │ (extension.ts)     │
      │ (lazy-loaded)     │  │ (commands/*)      │  │                    │
      └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
                └──────────────┬────────┴──────────────┬───────┘
                               │                       │
                      ┌────────▼───────────────────────▼───────┐
                      │            Engine Runtime               │
                      │ Scheduler / Planning / Executor / Merger │
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
| `@fusion/engine` | Private | AI orchestration runtime (planning, scheduler, executor, merger, recovery) | planning processor, `scheduler.ts`, `executor.ts`, `merger.ts`, `project-runtime.ts` |
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
  - Core schema tables include: `tasks`, `config`, `workflow_steps`, `activityLog`, `archivedTasks`, `automations`, `agents`, `agentHeartbeats`, approval tables (`approval_requests`, `approval_request_audit_events`), `task_documents`, `task_document_revisions`, mission hierarchy tables (`missions`, `milestones`, `slices`, `mission_features`, `mission_events`), plugin/routine tables (`plugins`, `routines`), roadmap tables (`roadmaps`, `roadmap_milestones`, `roadmap_features`), insight tables (`project_insights`, `project_insight_runs`), research tables (`research_runs`, `research_exports`, `research_run_events`), eval tables (`eval_runs`, `eval_task_results`, `eval_run_events`), todo tables (`todo_lists`, `todo_items`), `__meta`
  - Migration-created tables include: `ai_sessions`, `messages`, `agentRatings`, `chat_sessions`, `chat_messages`, `runAuditEvents`, `mission_contract_assertions`, `mission_feature_assertions`, `mission_validator_runs`, `mission_validator_failures`, `mission_fix_feature_lineage`
  - `ai_sessions.status` lifecycle includes `draft` (pre-start planning session), then `generating`, `awaiting_input`, terminal `complete` / `error`
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
  - `MessageStore` (`message-store.ts`) — SQLite-backed mailbox/inbox/outbox messaging
  - `ApprovalRequestStore` (`approval-request-store.ts`) — durable approval request lifecycle + append-only audit events
  - `ChatStore` (`chat-store.ts`) — session/message persistence for agent chat
  - `InsightStore` (`insight-store.ts`) — project insight persistence + dedupe/run tracking
  - `ReflectionStore` (`reflection-store.ts`) — agent reflection records and performance snapshots
  - `PluginStore` (`plugin-store.ts`) — plugin registry/state/settings persistence
  - `RoutineStore` (`routine-store.ts`) — recurring routine definitions and run history
  - `RoadmapStore` (`roadmap-store.ts`) — standalone roadmap CRUD with deterministic ordering and atomic reorder/move operations
  - `TodoStore` (`todo-store.ts`) — project-scoped todo lists/items with completion, reorder, and composite list+items queries
  - `EvalStore` (`eval-store.ts`) — eval run persistence, per-task eval results with durable snapshots, and append-only run event trails

### Approval request system (`ApprovalRequestStore`)

Schema (migration 68 in `db.ts`) adds two tables:

- `approval_requests`
  - Identity/lifecycle: `id`, `status`, `requestedAt`, `decidedAt`, `completedAt`, `createdAt`, `updatedAt`
  - Requester snapshot: `requesterActorId`, `requesterActorType`, `requesterActorName`
  - Target action payload: `targetActionCategory`, `targetActionOperation`, `targetActionSummary`, `targetResourceType`, `targetResourceId`, `targetContext` (JSON text)
  - Optional runtime linkage: `taskId`, `runId`
  - Indexes: `idxApprovalRequestsStatusCreatedAt (status, createdAt)`, `idxApprovalRequestsRequesterCreatedAt (requesterActorId, createdAt)`, `idxApprovalRequestsTaskCreatedAt (taskId, createdAt)`
- `approval_request_audit_events`
  - `id`, `requestId`, `eventType`, actor snapshot (`actorId`, `actorType`, `actorName`), optional `note`, `createdAt`
  - `requestId` is a foreign key to `approval_requests(id)` with `ON DELETE CASCADE`
  - Index: `idxApprovalRequestAuditRequestCreatedAt (requestId, createdAt, id)`

Store API (`packages/core/src/approval-request-store.ts`):

- `create(input: ApprovalRequestCreateInput)` — inserts a `pending` request and appends a `created` audit event
- `get(id)` — returns one request or `null`
- `list(input?: ApprovalRequestListInput)` — filters by `status`, `requesterActorId`, `taskId`, `runId`; ordered `createdAt DESC, id DESC`; paginated by `limit`/`offset`
- `decide(requestId, status, input: ApprovalRequestDecisionInput)` — applies `pending -> approved|denied`, stamps `decidedAt`, appends `approved`/`denied` audit event
- `markCompleted(requestId, input: ApprovalRequestCompletionInput)` — applies `approved -> completed`, stamps `completedAt`, appends `completed` audit event
- `getAuditHistory(requestId)` — returns append-only audit rows ordered `createdAt ASC, rowid ASC`

Lifecycle contract (`types.ts` `isValidApprovalRequestTransition`):

- Primary forward paths: `pending -> approved -> completed` and `pending -> denied`
- Direct `pending -> completed` and all transitions from `denied`/`completed` (except no-op self-transition) are rejected
- Same-state transitions (`from === to`) are treated as valid by the helper even though the intended lifecycle is forward-only

### Shared mesh-state snapshot helpers

`packages/core/src/shared-mesh-state.ts` defines a common snapshot envelope for non-task mesh state export/apply:
- Envelope fields: `version`, `exportedAt`, `checksum`, `payload`
- Checksum rule: `sha256(JSON.stringify(payloadWithoutChecksum))`
- Payload families:
  - `TaskMetadataSnapshot` (`tasks` structured metadata only)
  - `MissionHierarchySnapshot` (`missions`, `milestones`, `slices`, `features`, `missionEvents`, `assertions`, `featureAssertionLinks`)
  - `AgentSnapshot` (`agents`, `blockedStates`)
  - `AgentRunSnapshot` (`runs`)
  - `ActivityLogSnapshot` (`entries`)
  - `RunAuditSnapshot` (`entries`)
  - `ProjectSettingsSnapshot` (`global`, `projects`)
  - `AuthMaterialSnapshot` (`providerAuth`)

Intentional exclusions from shared snapshots:
- Task/agent blob contents (`PROMPT.md`, task document bodies, attachment bytes, JSONL run logs)
- Instruction-bundle file contents
- Node-local runtime handles and paths (for example worktree/session-file handles)

### Chat System

- `ChatStore` (`packages/core/src/chat-store.ts`) and `chat-types.ts` provide session-oriented chat state (`chat_sessions`, `chat_messages` tables)
- Dashboard chat UX lives in `packages/dashboard/app/components/ChatView.tsx` and hooks `useChat.ts` / `useQuickChat.ts`
- Main `useChat` session restore/recovery must not reset the active thread during session-list refresh or `chat:session:updated` metadata churn while a response is in flight.
- When the active session is still generating after reload/reconnect (`isGenerating: true`), `useChat` keeps recovery streaming state alive ("Connecting…") until the assistant output is observed via SSE or reloaded from messages.
- Chat message submission uses SSE streaming responses from dashboard chat routes.
- Main-chat optimistic user sends are reconciled against persisted SSE user echoes by content + temp-id replacement, so one user send cannot survive as a duplicate history entry after stream completion.
- `streamChatResponse()` must flush trailing buffered SSE data on EOF even without a final newline, so terminal `done`/`error` events are not dropped at chunk boundaries.
- Chat generation ownership is isolated by `generationId` (`ChatManager.beginGeneration` + `ChatStreamManager` subscription filters + route preallocation), preventing stale generation terminal events from leaking into a newer active request.

### Agent Companies

- Import/export utilities: `agent-companies-parser.ts`, `agent-companies-exporter.ts`, `agent-companies-types.ts`
- Supports YAML-frontmatter manifests for company/team/agent/project/task/skill definitions
- Includes conversion helpers from parsed manifests to `AgentCreateInput` and export helpers for directory bundles

### Project Insights

- `InsightStore` (`insight-store.ts`, `insight-types.ts`) persists extracted project learnings
- Uses fingerprint-based deduplication and run tracking
- Run lifecycle is hardened through `insight-run-executor.ts` + `InsightStore` transition guards:
  - single active run per `projectId + trigger` (`pending|running` conflict)
  - terminal-state immutability for run rows
  - persisted failure classification (`cancelled`, `timed_out`, `retryable_transient`, `non_retryable`) and retry lineage metadata
  - append-only durable event trail in `project_insight_run_events`
- Dashboard routes (`insights-routes.ts`) consume the core executor/store APIs for run start, cancel, retry, and event inspection (`/api/insights/runs/:id/events`)
- `POST /api/insights/:id/create-task` remains a draft-payload endpoint (returns `suggestedTitle`/`suggestedDescription`); the dashboard `InsightsView` now uses that payload to create a real task through the normal app task-creation path (`column: triage`, `sourceType: dashboard_ui`, source metadata indicating insights origin)
- Backed by `project_insights`, `project_insight_runs`, and `project_insight_run_events`

### Research Runs

- `ResearchStore` (`research-store.ts`, `research-types.ts`, `research-settings.ts`) persists bounded research runs, sources/events, exports, lifecycle metadata, and retry/cancel state transitions.
- Backed by `research_runs`, `research_exports`, and `research_run_events`.
- Engine orchestration is implemented in `packages/engine/src/research-orchestrator.ts` + `research-step-runner.ts`.
- Dashboard/API surface is implemented under `/api/research` (`packages/dashboard/src/research-routes.ts`) with `ResearchView.tsx` in the app.
- CLI surface is implemented in `packages/cli/src/commands/research.ts` with six subcommands (create, list, show, export, cancel, retry).
- Agent tool surface is exposed via `packages/cli/src/extension.ts` (`fn_research_run`, `fn_research_list`, `fn_research_get`, `fn_research_cancel`, `fn_research_retry`).
- **Boundary contract (FN-3292):**
  - `ResearchStore` owns persistence and lifecycle writes (status transitions, lifecycle event log rows, sources/results snapshots).
  - `ResearchStepRunner` owns provider I/O concerns only (provider selection, timeout/abort/provider-error classification, synthesis call execution); it does not read/write run state.
  - `ResearchOrchestrator` owns sequencing and failure policy (phase progression, provider fallback, partial-step continuation, terminal status choice) and interacts with store only through public store methods.
  - Provider substitution must remain data-driven: source metadata can carry provider identity, and fetching should resolve providers per source rather than relying on provider ordering.
- **Boundary note:** research and insights are parallel subsystems sharing host infrastructure, not one table/store family.

### Task Evaluations

- `EvalStore` (`eval-store.ts`, `eval-types.ts`) persists eval runs and task-level eval outcomes.
- Dashboard/API surface is implemented under `/api/evals` (`packages/dashboard/src/evals-routes.ts`) with `EvalsView.tsx` in the app.
- Backed by `eval_runs`, `eval_task_results`, and `eval_run_events`.
- Data model stores structured scoring/evidence/signal payloads plus durable `taskSnapshot` metadata so historical eval results remain readable even if the live task row later changes or is removed.
- Lifecycle safeguards mirror other core stores: deterministic list ordering, transition guards, terminal immutability for run rows, and active-run conflict protection for scheduled/task-completion triggers.
- `eval_task_results` enforces one row per `(runId, taskId)` via a unique index; store writes use upsert semantics to keep reruns idempotent.
- Canonical scoring contract is documented in `docs/evals.md`; authoritative score computation is centralized in `packages/core/src/eval-scoring.ts`.

Scoring authority boundary:
- Authoritative fields: `categoryScores[].finalScore`, `categoryScores[].band`, `categoryScores[].weight`, and `overallScore` (derived by `computeOverallScore`).
- Advisory/model-authored fields: category `aiScore`, category `rationale`, category `evidence`, and `overallRationale` text.
- Evaluator code (`packages/engine/src/evaluator.ts`) may provide AI category inputs, but must route final score computation through core helpers (`normalizeCategoryScore`, `computeOverallScore`) and must not persist AI-provided overall numbers as source of truth.

Hybrid evaluator pipeline (FN-3389/FN-3391):
- **Batch selection:** `runScheduledEvalBatch` in core computes a deterministic completed-task window (`windowStartExclusive` → `windowEndInclusive`) from the last completed scheduled run.
- **Signal summary:** `collectDeterministicSignals` (`eval-signal-collector.ts`) normalizes timing/workflow/review/log/commit summaries with stable fallbacks for missing metadata.
- **Evidence harvesting:** `collectTaskEvaluationEvidence` (`packages/engine/src/evaluator-evidence.ts`) reads existing task-store/git surfaces (`workflowStepResults`, documents, task activity log, agent logs, run-audit events, merge/PR metadata) and emits a bounded `TaskEvaluationEvidenceBundle` with fixed source-group ordering.
- **AI review:** `HybridEvaluatorService` (`packages/engine/src/evaluator.ts`) injects deterministic signals plus a dedicated `## Evidence` bundle section into a strict JSON prompt, runs a read-only AI session, validates the JSON payload, and merges AI advisory fields into persisted eval output while preserving core score authority.
- **Follow-up policy engine:** `packages/engine/src/eval-followups.ts` normalizes raw evaluator drafts into canonical follow-up suggestions, applies deterministic suppression/dedupe rules, and (policy permitting) materializes triage tasks through `TaskStore.createTask()` with source provenance back to the parent task and eval run/suggestion IDs.
- **Persistence boundary:** eval rows persist normalized evidence refs plus bounded excerpts/IDs (not full raw logs or unbounded command output) and structured follow-up lifecycle state (`suggested`/`suppressed`/`created`) including suppression reason or created task linkage. Source drill-down stays in original task/agent/run-audit stores and git history.
- **Model resolution (temporary):** evaluator model selection first uses an explicit run override pair (`provider` + `modelId` together only), then falls back to the existing validator lane (`resolveValidatorSettingsModel`) until FN-3393 introduces dedicated evaluator settings.
- **Scheduled execution wiring:** CronRunner intercepts the sentinel command `fn eval --scheduled-batch` and executes in-process, invoking `runScheduledEvalBatch` with `HybridEvaluatorService`; `ProjectEngine` syncs scheduled eval automation on startup and on relevant settings changes.

### Plugin System

- `PluginStore` (`plugin-store.ts`) is a facade over two persistence scopes:
  - **Global install metadata** in central DB table `plugin_installs` (`~/.fusion/fusion-central.db`) including manifest/path/settings/schema/dependencies
  - **Per-project runtime state** in central DB table `project_plugin_states` keyed by normalized project path (`enabled`, `state`, `error`)
- Legacy project-local `plugins` rows in `.fusion/fusion.db` are migrated lazily on plugin-store init/read; migration is idempotent and keeps newest `updatedAt` install metadata as global canonical data while preserving per-project enablement rows
- Post-FN-3722, the project-local `plugins` table is legacy read-only migration input; any new install writer targeting it is a bug
- `TaskStore.getPluginStore()` now propagates the configured `globalSettingsDir`/central directory so all CLI and dashboard install paths resolve the same central DB
- `PluginLoader` (`plugin-loader.ts`) loads/unloads plugin modules using the effective per-project plugin state
- Plugin contributions now include both embedded `uiSlots` and top-level `dashboardViews`
- Discovery endpoints:
  - `GET /api/plugins/ui-slots`
  - `GET /api/plugins/dashboard-views`
- Dashboard management routes are implemented in `packages/dashboard/src/plugin-routes.ts`

### Prompt Overrides

- `prompt-overrides.ts` defines prompt key catalogs and per-role override validation
- Provides override resolution/validation helpers (`resolvePrompt`, `resolveRolePrompts`, `assertValidPromptOverrideMap`)

### Plugin Prompt Contributions

- Plugin prompt contributions are filtered per surface through `PluginRunner.getPromptContributionsForSurface(surface)`.
- Prompt assembly uses `buildPluginPromptSection(surface, pluginRunner)` in `packages/engine/src/agent-instructions.ts`.
- Supported prompt surfaces:
  - `executor-system`
  - `executor-task`
  - `triage`
  - `reviewer`
  - `heartbeat`
- Integration points append the built plugin section to the role-specific system/task prompt only when contributions exist, preserving existing prompts when no plugins contribute.

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

### Docker Node Provisioning

Fusion has a managed Docker node provisioning subsystem spanning `@fusion/core` services and dashboard routes.

**Core services:**
- `DockerClientService` (`packages/core/src/docker-client.ts`)
  - Creates Dockerode clients from host settings.
  - Supports default local daemon, named Docker `context`, or explicit `host` with optional TLS fields.
  - Host/TLS inputs: `context`, `host`, `tlsVerify`, `tlsCaPath`, `tlsCertPath`, `tlsKeyPath`.
- `DockerProvisioningService` (`packages/core/src/docker-provisioning.ts`)
  - Handles initial container lifecycle actions (provision/deprovision/start/stop/restart/status).
  - Provisioning creates and starts a container first, then route-level orchestration registers metadata/node records.
- `MeshConfigGenerator` (`packages/core/src/mesh-config-generator.ts`)
  - Generates mesh env/config, applies config by recreating the container, registers the node into mesh state, then health-checks until online or timeout.

**Route boundary (dashboard):**
- `register-docker-provisioning-routes.ts` owns initial container lifecycle endpoints (`/api/docker/provision`, `/api/docker/deprovision`, and per-container start/stop/restart/status).
- `register-docker-node-routes.ts` owns managed-node metadata + mesh configuration endpoints (for example `/api/docker/nodes/:managedId/apply-mesh-config` and mesh-status checks) after a container is provisioned.

**Provisioning lifecycle (implemented flow):**
1. **Container provisioning**: dashboard provisioning route calls `DockerProvisioningService.provision()` to create/start a managed container.
2. **Mesh config generation**: `MeshConfigGenerator.generateConfig()` resolves API key, reachable URL, and mesh env vars.
3. **Mesh config application**: `MeshConfigGenerator.applyConfig()` calls `DockerClientService.recreateContainer()` so env vars are applied to a recreated container.
4. **Node registration**: `MeshConfigGenerator.registerInMesh()` creates/links a remote `NodeConfig` entry.
5. **Health check**: mesh registration flow polls `checkNodeHealth()` until online or timeout.

**Port convention:**
- Managed Docker mesh-node containers default to **`4041`** (`DEFAULT_CONTAINER_PORT` in `mesh-config-generator.ts`).
- **`4040` remains reserved** for the production dashboard and should not be documented as the managed mesh-node default.

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

QMD-backed memory behavior also applies to agent-private memory workspaces under `.fusion/agent-memory/{agentId}/`:
- Agent memory search normalizes QMD hit paths (including `qmd://...`, absolute paths, and relative filenames) into canonical readable workspace paths (`MEMORY.md`, `DREAMS.md`, `YYYY-MM-DD.md`) so results can be passed directly into `fn_memory_get`.
- Agent-memory writes from tool and non-tool paths (including `processAgentMemoryDreams()`) schedule agent-specific QMD refreshes so new dreams/long-term updates remain discoverable without manual reindexing.

**Dashboard API:**
- `GET /api/memory/backend` — Returns current backend status and capabilities

See [Memory Plugin Contract](./memory-plugin-contract.md) for the full plan.

---

## 5) Engine Package (`@fusion/engine`)

`@fusion/engine` executes the autonomous workflow.

### Agent roles
- **Planning**: the planning processor generates task plans (`PROMPT.md`) and selects eligible planning tasks by priority first, then FIFO (`createdAt` ascending) within each priority tier.
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
- `AgentActionGate` (`agent-action-gate.ts`) — permanent-agent runtime action classification + policy disposition decisions (shared classification source: `packages/engine/src/gating-classifications.ts`)

Runtime action-gate flow (v1):
- Tool execution wrappers in `pi.ts` compose `wrapToolsWithBoundary()` and `wrapToolsWithActionGate()`.
- Non-ephemeral agents receive `AgentActionGateContext` from executor/heartbeat session creation.
- `block` and `require-approval` dispositions intercept before tool side effects.
- `require-approval` persists durable requests via `ApprovalRequestStore`, reusing pending requests by dedupe key in `targetAction.context.approvalDedupeKey`.

### Concurrency, recovery, and resiliency
- `AgentSemaphore` (`concurrency.ts`) — slot acquisition
- `RecoveryPolicy` (`recovery-policy.ts`) — retry/recovery decision policy
- `StuckTaskDetector` (`stuck-task-detector.ts`) — inactivity/loop stall detection
- `GridlockDetector` (`gridlock-detector.ts`) — detects all-blocked todo pipelines and emits notification events (plus explicit clear signals when gridlock resolves)
- `TransientErrorDetector` (`transient-error-detector.ts`) — retriable error classification
- `SelfHealingManager` (`self-healing.ts`) — auto-unpause/maintenance recovery actions
  - `recoverGhostReviewTasks()` is a fallback only for idle, non-terminal `in-review` states. Terminal/actionable states (notably `status: "failed"`) are preserved and **not** auto-kicked back to `todo`.
  - `recoverMergeableReviewTasks()` only re-enqueues truly eligible tasks; retry-exhausted review tasks are skipped to avoid re-enqueue/no-op loops that keep refreshing `updatedAt`.
  - Merge commit attribution is ownership-aware: a `mergeDetails.commitSha` is trusted only when reachable from `HEAD` **and** attributable to the task via `Fusion-Task-Id` trailer or task-ID-bearing subject. Reachable-but-unowned SHAs are rejected to prevent sibling done tasks from sharing misleading merge metadata.
- `ProjectEngine` settings lifecycle handlers (`project-engine.ts`) treat `enginePaused` as a soft pause: clearing it dispatches runtime resume and, when `autoMerge` is enabled, performs an `in-review` eligibility sweep to requeue mergeable review tasks.
- `UsageLimitPauser` (`usage-limit-detector.ts`) and `withRateLimitRetry` (`rate-limit-retry.ts`)

### Worktree and naming helpers
- `WorktreePool` (`worktree-pool.ts`) — idle worktree reuse
- `WorktreeNames` (`worktree-names.ts`) — deterministic worktree/branch naming

### Observability and reflection
- `AgentLogger` (`agent-logger.ts`) — structured per-agent run logging
- `RunAudit` (`run-audit.ts`) — mutation audit tracking (DB/git/filesystem)
- `Notifier` (`notifier.ts`) — legacy ntfy compatibility shim (`NtfyNotifier`) plus shared ntfy helpers
  - Runtime ownership: `NtfyNotifier` no longer owns an independent task-lifecycle listener graph; `ProjectEngine` injects the canonical `NotificationService` instance so task lifecycle notifications (`task:moved`, `task:updated`, `task:merged`) are emitted through a single path.
  - Merge dedup safety: `ProjectEngine.start()` is idempotent, so repeated start calls do not wire a second `NotificationService`/`NtfyNotifier` pair. A successful merge therefore emits exactly one canonical `merged` ntfy lifecycle notification per task.
  - Compatibility scope: `NtfyNotifier` remains responsible for gridlock-only compatibility notifications (`notifyGridlock`) and legacy helper APIs.
  - Legacy gridlock ntfy delivery is cooldown-throttled: first detection notifies immediately, subsequent detections are suppressed for 15 minutes (even if blocked-task membership changes), and the cooldown resets as soon as gridlock fully clears.
- `NotificationService` (`notification/notification-service.ts`) — provider lifecycle + event dispatch orchestration
  - Subscribes to task lifecycle events plus non-task memory events. Manual `POST /api/memory/dream` processing emits `store.emit("memory:dreams-processed", payload)` when new DREAMS content is written, and `NotificationService` dispatches that as the `memory-dreams-processed` notification event to ntfy/webhook providers (event-filter controlled, no task deep link required).
- `NotificationProvider` interface (`@fusion/core` `notification/provider.ts`) — pluggable provider contract
- Built-in providers: `NtfyNotificationProvider` (`notification/ntfy-provider.ts`), `WebhookNotificationProvider` (`notification/webhook-provider.ts`)
- `AgentReflection` (`agent-reflection.ts`) — reflection extraction and persistence

### Heartbeat execution
Implemented in `agent-heartbeat.ts`:
- `HeartbeatMonitor`
- `HeartbeatTriggerScheduler` (timer, assignment, on-demand triggers)
- `WakeContext` / per-agent runtime config support

### Node/mesh runtime services
- `NodeHealthMonitor` (`node-health-monitor.ts`) — remote node liveness/metrics checks
- `PeerExchangeService` (`peer-exchange-service.ts`) — peer sync orchestration
- Canonical replication/write-coordination contract: [`docs/shared-mesh-protocol.md`](./shared-mesh-protocol.md)
  - Defines protocol versioning, write classes, quorum/ack semantics, lease epochs/fencing, offline queue/replay, reconciliation outcomes, restart recovery hooks, and degraded-read staleness metadata.
  - Existing `/api/mesh/sync` and settings-sync payloads remain the active exchange primitives while follow-on runtime tasks implement full v1 coordinator/quorum behavior.
- Distributed task-ID allocation (`packages/core/src/distributed-task-id.ts`) is the first mesh-aware coordinated write primitive.
  - Durable state lives in SQLite tables `distributed_task_id_state` (prefix sequence + authoritative committed count) and `distributed_task_id_reservations` (reservation lifecycle rows).
  - Reserve/commit/abort execute under a process-local lock and a single SQLite transaction. Lazy reservation expiry cleanup runs inside those same transactions.
  - Default reservation TTL is `15 * 60 * 1000` ms (15 minutes). Expired/aborted reservations are **burned IDs** and are never reissued.
  - `committedClusterTaskCount` from allocator state is the only authoritative cluster-wide committed-task count. Local task-row counts and ID suffix math are not authoritative.
  - Mesh allocator write routes (`/api/mesh/task-ids/reserve|commit|abort`) return `503` when the coordinator node is unreachable; they never fall back to local-only cluster ID issuance.
- Cluster task creation now uses a strong-write reserve → create → replicate → commit/abort sequence.
  - `POST /api/tasks` reserves a distributed ID, creates the authoritative local task with that reserved ID, then POSTs authenticated replication payloads to peer nodes.
  - Creation self-heals stale ID overlap state: if a reserved `FN-*` collides with an existing task (`Task ID already exists...` or replicated-create collision), the route aborts that reservation, cleans up partial local state, reserves the next ID, and retries up to a bounded limit.
  - Replica apply uses `TaskStore.applyReplicatedTaskCreate(...)`, which is idempotent by task ID: replaying the same payload returns the existing task without creating duplicates.
  - If an incoming replicated payload conflicts with a different existing task record for the same ID, the apply path returns a deterministic collision error instead of overwriting data.
  - Any replication/coordinator failure aborts the reservation and returns write failure (`503`), so this path does not report success for local-only partial writes.
- Process lifecycle ownership:
  - `fn serve` / `fn dashboard` start a single process-level `PeerExchangeService` and stop it during shutdown.
  - `CentralCore.startDiscovery()` is invoked from CLI startup only after HTTP bind completes so discovery advertises the actual listening port.
  - `InProcessRuntime` stays project-scoped and intentionally does not own mesh startup/shutdown.

### Remote access runtime

Operator setup + troubleshooting guide: **[Remote Access runbook](./remote-access.md)**.
- `remote-access/tunnel-process-manager.ts` owns tunnel lifecycle orchestration with `spawn`-based, non-blocking process supervision.
- `remote-access/types.ts` defines the runtime contract used by downstream API/TUI/headless layers:
  - Providers: `"tailscale" | "cloudflare"`
  - Lifecycle states: `"stopped" | "starting" | "running" | "stopping" | "failed"`
  - Error codes: `invalid_config`, `start_failed`, `stop_failed`, `switch_failed`, `readiness_timeout`, `process_exit`, etc.
- `remote-access/provider-adapters.ts` provides provider-specific command composition + readiness parsing while enforcing config validation.
- Cloudflare has two command variants:
  - Named tunnel mode: `cloudflared tunnel --no-autoupdate run <tunnelName>` (token from env)
  - Quick tunnel mode: `cloudflared tunnel --url http://localhost:<dashboardPort>` (ephemeral `trycloudflare.com` URL, no token)
- Credential inputs are reference-based (`tokenEnvVar`, `credentialsPath`) and validated without logging raw secret values.
- Redaction is applied to command previews and emitted log lines before publishing status/log events.
- Deterministic stop semantics: graceful shutdown (`SIGTERM`) first, bounded wait, then force-kill fallback (`SIGKILL`).
- Safe provider switching is stop-first: active provider fully stops before target start is attempted; failed starts emit `switch_failed` terminal status.
- `ProjectEngine.start()` instantiates a per-project tunnel manager and applies startup restore policy from `remoteAccess.lifecycle`:
  - restore is attempted only when `rememberLastRunning` is true, a prior-running marker exists, provider config is valid, and runtime prerequisites are available.
  - restore skips/failures are non-fatal to engine startup and clear stale running markers to avoid restart loops.
- Manual lifecycle remains explicit: only `startRemoteTunnel()` / `stopRemoteTunnel()` transitions mutate runtime state; provider/settings updates do not auto-start tunnels.
- `ProjectEngine` exposes restore diagnostics via `getRemoteTunnelRestoreDiagnostics()` (`applied|skipped|failed` + machine-readable reason).

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
- System stats snapshot and vitest process controls APIs (`GET /api/system-stats`, `POST /api/kill-vitest`) exposing dashboard process/system telemetry (including app CPU percentage and host memory rendered as numeric values with visual usage bars in the System Stats modal), task/agent aggregates, and manual vitest process termination
- Remote access APIs (`/api/remote/*`) for provider config, activation, tunnel lifecycle, status, token issuance, authenticated URL generation, and QR payload generation
  - Operational runbook (prereqs/security/troubleshooting): [`docs/remote-access.md`](./remote-access.md)
  - `/api/remote/tunnel/start`, `/api/remote/tunnel/stop`, and `/api/remote/tunnel/kill-external` cover tunnel lifecycle and external funnel cleanup.
  - `/api/remote/status` includes tunnel status, external funnel detection (`externalTunnel` when managed tunnel is stopped), plus restore diagnostics (`restore.outcome` + `restore.reason`) with parity between dashboard and headless `fn serve` runtimes.
- Remote auth handoff endpoints:
  - `POST /api/remote-access/auth/login-url` (daemon-auth protected) issues a tokenized phone-login URL for either `persistent` or `short-lived` mode.
  - `GET /remote-login?rt=<token>` (public) validates remote token strategy and redirects to dashboard auth handoff (`/?token=<daemonToken>` when daemon auth is enabled, otherwise `/`).
  - Invalid/missing/expired remote tokens return `401` JSON with deterministic codes: `remote_token_invalid`, `remote_token_missing`, `remote_token_expired`.
- Chat APIs (`/api/chat/*`) with streaming response support (`routes.ts`, `chat.ts`)
- Dev-server lifecycle + persistence APIs (`/api/dev-server/*`) backed by:
  - `dev-server-routes.ts` (router factory + per-project runtime registry)
  - `dev-server-process.ts` (`DevServerProcessManager` for spawn/stop/restart/url-detection)
  - `dev-server-store.ts` (durable `.fusion/dev-server.json` state + log ring buffer)
  - `dev-server-detect.ts` (project/workspace script auto-detection + confidence scoring)
  - Note: this **hyphenated `dev-server-*` family is the canonical runtime owner** today; see `docs/dev-server-module-boundary-audit.md` for the FN-2212 boundary/consolidation audit covering parallel `devserver-*` modules.
- Plugin management routes (`plugin-routes.ts`)
- Insights routes (`insights-routes.ts`)
- Evals routes (`evals-routes.ts`) — `/api/evals` read surface for eval result listing/filtering, drill-down detail, and eval run metadata
- Research routes (`research-routes.ts`) — `/api/research` surface for runs, details, cancel/retry, exports, create-task, and attach-task actions; supports graceful degradation envelopes via availability payloads when capabilities are unavailable
- Roadmap routes (`roadmap-routes.ts`)
- Project-scoped store reuse via `project-store-resolver.ts`
- Rate limiting (`rate-limit.ts`)
- Static SPA hosting (Vite build output)

### Runtime diagnostics logging contract
- Dashboard/server runtime diagnostics use the shared `RuntimeLogger` contract (`packages/dashboard/src/runtime-logger.ts`) instead of ad hoc `console.*` calls.
- `createServer()` accepts `ServerOptions.runtimeLogger`; when omitted it defaults to a console-backed logger, preserving readable output in non-TTY/headless modes.
- CLI TTY dashboard sessions inject a logger backed by `DashboardLogSink`, so runtime diagnostics from server/routes are captured in the TUI log buffer.
- Sensitive remote-auth material is never logged raw; route/UI responses mask persistent token values unless explicitly requested by token-generation actions.
- Short-lived remote auth tokens are runtime-ephemeral (in-memory only, cleared on process restart) and TTL-enforced server-side against persisted `remoteAccess.tokenStrategy.shortLived.ttlMs` plus issued expiry metadata.
- Remote login links carry auth material in query params (`rt` then `token` on redirect). Treat links/QR screenshots as secrets: they can leak through history, screenshots, and chat logs; prefer short-lived mode for sharing.
- Intentional startup/banner text in `fn dashboard` and `fn serve` remains direct plain output for readability and backward-compatible scripting behavior.

### Real-time channels
- **SSE**: `/api/events` (`sse.ts`)
  - Emits `task:*`, mission events, AI session updates, automation schedule events (`schedule:created`, `schedule:updated`, `schedule:deleted`, `schedule:run`), and research run lifecycle events (`research:run:created`, `research:run:updated`, `research:run:completed`, `research:run:failed`, `research:run:cancelled`) when available
  - Project-scoped: resolves project context from query param or engine manager
  - Canonical maintainer contract (ownership/lifecycle/scoping/pitfalls and shared-vs-dedicated stream boundaries): [`docs/dashboard-realtime.md`](./dashboard-realtime.md)
- **Chat streaming**: `/api/chat/sessions/:id/messages` (`routes.ts` + `chat.ts`)
  - Streams assistant responses as SSE events for chat sessions
  - `done` events include the authoritative persisted assistant message snapshot (`message`) so clients can render final output even when incremental `text` deltas are absent
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
- Core board components: `Board.tsx`, `Column.tsx`, `TaskCard.tsx`, `TaskDetailModal.tsx`, `ListView.tsx`
- **Board column ordering (board view only)**: `todo` cards mirror scheduler pickup order (priority descending, then `createdAt` ascending/FIFO within each priority tier, then task ID ascending). `triage`, `in-progress`, and `archived` use priority descending then task ID ascending, with missing/invalid priority normalized to `normal`. `done` is completion-recency ordered (`columnMovedAt`, then `updatedAt`, then `createdAt`, newest first). In `in-review`, merge-active tasks (`status === "merging"`, `"merging-pr"`, or `"merging-fix"`) are pinned above non-merging tasks, with priority-then-ID ordering within each group.
- Task detail surface is shared through `TaskDetailContent` (exported from `TaskDetailModal.tsx`): desktop/tablet `ListView` renders it inline in the split right pane, while mobile and non-list entry points continue using `TaskDetailModal`.
- In desktop split mode, `ListView` now uses a compact sidebar-first control layout (count/actions/summary chips + collapsible "View options" panel) to keep list controls dense alongside the inline detail pane; mobile keeps the card-first flow with a toolbar "View options" entry point for the same visibility/filter toggles.
- Chat system UI: `ChatView.tsx`, `QuickChatFAB.tsx`
- Planning/roadmap/insight UI: `MissionManager.tsx`, `RoadmapsView.tsx`, `TodoView.tsx`, `InsightsView.tsx`, `DocumentsView.tsx`
- Dev server UI: `DevServerView.tsx` (controls + status/log panel + embedded preview with iframe fallback messaging)

### CSS Architecture

The dashboard's CSS is split between a consolidated global stylesheet and modular per-component files:

- **Global stylesheet** (`packages/dashboard/app/styles.css`, ~4,500 lines)
  - Design tokens (spacing, colors, shadows, transitions, fonts)
  - Primitive component classes (`.btn`, `.card`, `.modal`, `.form-input`)
  - Cross-component `@media` overrides and breakpoint definitions
- **Per-component stylesheets** (56+ files in `packages/dashboard/app/components/`)
  - Each component has a co-located `ComponentName.css` file
  - Each `ComponentName.tsx` imports its stylesheet: `import "./ComponentName.css";`
  - Component-specific CSS rules live in the component's `.css` file, not in the root stylesheet

**Lazy-loaded views** (bundle size optimization):
The following 15 views are lazy-loaded via `React.lazy()` with `<Suspense fallback={null}>`:
- `AgentsView`, `RoadmapsView`, `TodoView`, `NodesView`, `ChatView`, `MemoryView`, `ResearchView`
- `DevServerView`, `InsightsView`, `DocumentsView`, `SkillsView`
- `SetupWizardModal`, `PluginManager`, `PiExtensionsManager`, `AgentDetailView

A `prefetchLazyViews()` function runs once on mount via `requestIdleCallback` to warm chunks. Do not make these views eager — bundle size is carefully managed.

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

### Custom Provider endpoints

Custom-provider settings routes are registered in `register-custom-provider-routes.ts`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/custom-providers` | List configured custom providers from global settings with API keys masked in the response payload. |
| POST | `/api/custom-providers` | Create a custom provider (`name`, `apiType`, `baseUrl`, optional `apiKey` and `models`) and return the new provider with masked API key. |
| PUT | `/api/custom-providers/:id` | Update an existing custom provider by ID (partial updates supported) and return the sanitized provider payload. |
| DELETE | `/api/custom-providers/:id` | Delete a custom provider by ID and return a success envelope. |

### Project/node path-mapping endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/path-mappings` | List persisted per-node absolute paths for a project (`projectNodePathMappings` rows keyed by `projectId` + `nodeId`). |
| GET | `/api/projects/:id/path-mappings/:nodeId` | Fetch one project↔node mapping row. |
| PUT | `/api/projects/:id/path-mappings/:nodeId` | Upsert one mapping row (`path` body field must be absolute). |
| DELETE | `/api/projects/:id/path-mappings/:nodeId` | Delete one mapping row if present. |
| GET | `/api/nodes/:id/path-mappings` | List all project mappings known for a node. |

This API surface is intentionally separate from `projects.nodeId` (runtime host placement metadata) and from task-level routing defaults (`defaultNodeId` / `Task.nodeId`).

Dashboard node onboarding (`AddNodeModal` → `useNodes.register`) uses a two-phase flow:
1. Register node metadata first via `POST /api/nodes`.
2. Persist selected project↔node path mappings with per-project `PUT /api/projects/:id/path-mappings/:nodeId` upserts.

The client treats mapping persistence as part of onboarding success. If mapping writes fail after node creation, onboarding attempts rollback via `DELETE /api/nodes/:id` and refreshes node state to avoid a silent half-configured node.

### Node settings sync and update-check endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/nodes/:id/settings` | Fetch settings from a remote node. |
| POST | `/api/nodes/:id/settings/push` | Push local settings to a remote node. |
| POST | `/api/nodes/:id/settings/pull` | Pull settings from a remote node. |
| GET | `/api/nodes/:id/settings/sync-status` | Get sync status and diff summary. |
| POST | `/api/nodes/:id/auth/sync` | Sync model auth credentials. |
| POST | `/api/settings/sync-receive` | Receive pushed settings (inbound). |
| POST | `/api/settings/auth-receive` | Receive auth credentials (inbound). |
| GET | `/api/settings/auth-export` | Export local auth credentials. |
| GET | `/api/update-check` | Read cached/TTL-guarded npm update status for `@runfusion/fusion` (respects `updateCheckEnabled`). |
| POST | `/api/update-check/refresh` | Clear cached update data and force a fresh npm update check. |
| GET | `/api/updates/check` | Perform an on-demand npm registry check for the latest `@runfusion/fusion` version (no cache). |

### Docker provisioning endpoints

Initial container provisioning and lifecycle routes are registered by `register-docker-provisioning-routes.ts`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/docker/provision` | Provision and start a managed Docker container. |
| POST | `/api/docker/deprovision` | Stop/remove a managed Docker container. |
| POST | `/api/docker/containers/:containerId/start` | Start an existing container. |
| POST | `/api/docker/containers/:containerId/stop` | Stop a running container. |
| POST | `/api/docker/containers/:containerId/restart` | Restart a container. |
| GET | `/api/docker/containers/:containerId/status` | Read runtime status for a container. |

Mesh configuration and post-provision managed-node operations are registered separately in `register-docker-node-routes.ts` (for example `/api/docker/nodes/:managedId/apply-mesh-config` and `/api/docker/nodes/:managedId/mesh-status`).

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
  - **TUI component** (`packages/cli/src/commands/dashboard-tui/`)
    - Ink-based terminal UI (status panel, logs, cursor visibility, tail-follow)
    - Merged from former `@fusion/tui` package
    - Invoked as part of the `fn` command (no separate package or `pnpm tui` command)

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
- Running `fn` with no arguments defaults to dashboard (web UI by default)

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
  - `projects`, `projectHealth`, `centralActivityLog`, `globalConcurrency`, `nodes`, `peerNodes`, `projectNodePathMappings`, `settingsSyncState`, `__meta`

### Memory files
- OpenClaw-style memory workspace:
  - `.fusion/memory/MEMORY.md`
  - `.fusion/memory/YYYY-MM-DD.md`
  - `.fusion/memory/DREAMS.md`
- The legacy top-level memory file is migration-compatibility only (seed/alias behavior) and is not canonical storage.

### File-based side stores
Some data remains intentionally filesystem-based:
- Agent instruction bundles and heartbeat markdown: `.fusion/agents/*` (`AgentStore`)

Agent/message/approval metadata and history now persist in SQLite tables.

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
- Columns: `planning`, `todo`, `in-progress`, `in-review`, `done`, `archived`
- Transition rules via `VALID_TRANSITIONS`

### Lifecycle flow

```text
planning
  │ (Planning processor writes PROMPT.md)
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
- **Planning phase**: the planning processor generates an executable plan
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

1. **Task pipeline agents** (planning/executor/reviewer/merger) managed by engine runtime
2. **Persistent registered agents** managed by `AgentStore`

### Persistent agent storage
`packages/core/src/agent-store.ts` persists to:
- `.fusion/agents/{id}.json`
- `.fusion/agents/{id}-heartbeats.jsonl`
- `.fusion/agents/{id}-keys.jsonl`
- `.fusion/agents/{id}-revisions.jsonl`
- `.fusion/agents/{id}/avatar.{ext}` (uploaded avatar image file, served via `/api/agents/:id/avatar`)

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
  - Per-project/per-node working-directory mappings (`projectNodePathMappings`)

### Engine orchestration
- `HybridExecutor` (`packages/engine/src/hybrid-executor.ts`) is the top-level orchestrator
- `ProjectManager` instantiates per-project runtimes and forwards events with project attribution
- Runtime startup/update resolves `ProjectRuntimeConfig.workingDirectory` through `CentralCore.resolveLocalProjectWorkingDirectory()` / `resolveProjectWorkingDirectory(projectId,nodeId)` using exact `projectNodePathMappings` rows for the active node; missing mappings are hard failures (no fallback to `RegisteredProject.path`).

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

## Task Routing Architecture

Task dispatch routing is resolved in two layers:

1. **Task routing resolution** (`packages/engine/src/effective-node.ts`)
   - `resolveEffectiveNode(task, settings)` applies precedence:
     1. `Task.nodeId` → `task-override`
     2. `ProjectSettings.defaultNodeId` → `project-default`
     3. no node set → `local`
2. **Runtime selection** (`packages/engine/src/project-manager.ts`)
   - `child-process` isolation always uses `ChildProcessRuntime`
   - `in-process` isolation uses `RemoteNodeRuntime` when the registered project host node is remote
   - otherwise uses `InProcessRuntime`

### Dispatch flow in scheduler

Within `Scheduler.schedule()` dispatch for `todo` tasks now runs node gates in this order:

1. `resolveEffectiveNode()` chooses routing source (`task-override`, `project-default`, `local`).
2. If a node is selected, `validateNodeDispatch` checks for a persisted `(projectId, nodeId)` working-directory mapping (`CentralCore.getProjectNodePath`).
3. Missing/blank mappings block dispatch (task stays in `todo`) and log `Execution blocked: project has no path mapping for node <id>`.
4. Only after mapping validation passes does `applyUnavailableNodePolicy()` evaluate node health and optional `fallback-local` behavior.

This preserves a clear separation between configuration correctness (mapping exists) and runtime health/failover policy.

### Unavailable-node policy

`unavailableNodePolicy` is a validated/stored project setting (`block` default, `fallback-local` allowed) and is enforced during scheduler dispatch when both conditions are true:
- effective routing selected a remote node, and
- `SchedulerOptions.nodeHealthMonitor` is configured.

Behavior summary:
- **`block`** (default): unhealthy node status (`offline`, `error`, `connecting`) blocks dispatch for that poll cycle and keeps the task in `todo`.
- **`fallback-local`**: unhealthy remote node reroutes dispatch to local execution (`effectiveNodeId: null`, `effectiveNodeSource: "local"`).
- unknown node health (`undefined`) is treated as allow/continue.

### Active-task node-override guard

`packages/core/src/node-override-guard.ts` enforces immutable routing overrides for active tasks:
- `validateNodeOverrideChange()` blocks node override updates while task column is `in-progress`
- returns reason `task-in-progress`

`TaskStore.updateTask()` applies this guard before persisting `nodeId` changes.

### Task branch field plumbing (`branch` + `baseBranch`)

Task create/update now preserves both branch fields end-to-end:
- **Request validation/normalization (dashboard route layer):** `packages/dashboard/src/routes/register-task-workflow-routes.ts`
  - `POST /api/tasks` accepts `branch` and `baseBranch` as string values.
  - `PATCH /api/tasks/:id` accepts `branch` and `baseBranch` as `string | null` for PATCH-style updates, trims string inputs, and treats empty strings as clears (`null`).
  - Route handlers reject non-string/non-null payloads with `400`.
- **Durable persistence (core store layer):** `packages/core/src/store.ts`
  - `TaskStore.createTask()` persists both `branch` and `baseBranch` on task creation.
  - `TaskStore.updateTask()` preserves existing PATCH semantics where explicit `null` clears either field.
  - Fields round-trip through JSON and SQLite persistence via the shared task contract in `packages/core/src/types.ts`.

### Routing activity visibility

Routing decisions are visible in task activity/log entries and in task metadata (`effectiveNodeId`, `effectiveNodeSource`), and surfaced in dashboard routing UI + `fn task show` output.

See also:
- [Settings Reference → Node Routing settings](./settings-reference.md#node-routing-settings-project-scope)
- [Task Management → Node Routing](./task-management.md#node-routing)
- [Multi-Project → Node Routing](./multi-project.md#node-routing)

---

## 12) Settings Hierarchy

Settings are split by scope.

### Global scope
- File: `~/.fusion/settings.json`
- Managed by `GlobalSettingsStore` (`packages/core/src/global-settings.ts`)
- Examples: `themeMode`, `colorTheme`, default model/provider, notification preferences (`ntfy*` legacy fields and `notificationProviders`)

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

### Git REST API endpoints

Git dashboard routes are registered in `register-git-github.ts`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/git/remotes` | List GitHub remotes parsed from `git remote -v` output. |
| GET | `/api/git/remotes/detailed` | List all remotes with fetch/push URLs. |
| POST | `/api/git/remotes` | Add a new remote (`name`, `url`). |
| DELETE | `/api/git/remotes/:name` | Remove an existing remote by name. |
| PATCH | `/api/git/remotes/:name` | Rename a remote (`newName`). |
| PUT | `/api/git/remotes/:name/url` | Update a remote URL. |
| GET | `/api/git/status` | Return branch, short commit, dirty state, and ahead/behind counts. |
| GET | `/api/git/commits` | Return recent commits (`?limit=` capped at 100). |
| GET | `/api/git/commits/:hash/diff` | Return commit stat + patch for a validated commit hash. |
| GET | `/api/git/commits/ahead` | Return local commits ahead of upstream (empty when upstream is not configured). |
| GET | `/api/git/remotes/:name/commits` | Return commits for a remote ref (`?ref=` optional, `?limit=` max 50, with remote HEAD/main/master fallback resolution). |
| GET | `/api/git/branches` | List local branches with current/tracking metadata and last commit date. |
| GET | `/api/git/branches/:name/commits` | Return commits for a branch (`?limit=` default 10, max 100). |
| GET | `/api/git/worktrees` | List worktrees with branch/path metadata and task association when available. |
| POST | `/api/git/branches` | Create a branch from HEAD or an optional base ref. |
| POST | `/api/git/branches/:name/checkout` | Checkout an existing branch. |
| DELETE | `/api/git/branches/:name` | Delete a branch (`?force=true` allows deleting unmerged branches). |
| POST | `/api/git/fetch` | Fetch from a remote (`remote` defaults to `origin`). |
| POST | `/api/git/pull` | Pull the current branch (`rebase` boolean optional) and return structured conflict metadata on merge/rebase conflicts. |
| POST | `/api/git/push` | Push the current branch. |
| GET | `/api/git/stashes` | List stash entries. |
| GET | `/api/git/stashes/:index/diff` | Return stash stat + patch for a validated stash index (404 when missing). |
| POST | `/api/git/stashes` | Create a stash with an optional message. |
| POST | `/api/git/stashes/:index/apply` | Apply a stash by index (optionally drop after apply via `drop: true`). |
| DELETE | `/api/git/stashes/:index` | Drop a stash by index. |
| GET | `/api/git/diff` | Return unstaged working-tree diff text. |
| GET | `/api/git/diff/file` | Return staged or unstaged diff for one file (`path` + `staged=true|false` query required). |
| GET | `/api/git/changes` | Return staged and unstaged file change summary. |
| POST | `/api/git/stage` | Stage specified files. |
| POST | `/api/git/unstage` | Unstage specified files. |
| POST | `/api/git/commit` | Create a commit from staged changes with a required message. |
| POST | `/api/git/discard` | Discard working-tree changes for specified files. |

### Worktree model
- Each active task runs in isolated worktree under `.worktrees/*`
- Executor creates branches like `fusion/{task-id}` (`executor.ts`)
- `WorktreePool` can recycle idle worktrees when enabled

### Merge strategies
- Setting type: `MergeStrategy = "direct" | "pull-request"` (`types.ts`)
- `aiMergeTask()` in `merger.ts` performs merge flow
- `merger.ts` also exposes a test-only `__test__` helper object for internal merger unit/integration coverage (for example autostash orphan cleanup behavior)
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
- **Task routing resolver:** `packages/engine/src/effective-node.ts`
- **Node override guard:** `packages/core/src/node-override-guard.ts`

### PR-backed Review tab state and same-task revision flow

Pull-request auto-merge tasks persist structured review metadata on the task as `reviewState`.

- `reviewState.source`: `"pull-request"` or `"reviewer-agent"`
- `reviewState.summary`: review decision, reviewer states, required checks, and blocking reasons
- `reviewState.items`: normalized per-review/per-comment records keyed by stable GitHub IDs
- `reviewState.addressing`: per-item lifecycle records (`queued`, `in-progress`, `addressed`, `failed`) with timestamps and optional `stale`

API flow:

1. `GET /api/tasks/:id/review` returns cached `reviewState` for modal load.
2. `POST /api/tasks/:id/review/refresh` fetches latest GitHub PR review/review-comment state, updates `reviewState`, and preserves addressing history (items that disappear are retained as `stale: true`).
3. `POST /api/tasks/:id/review/address` records selected review items as queued, appends a deterministic `**PR Review Revision Request**` steering comment payload, clears transient failure/session state, and requeues the same task to `todo` for same-task revision.

UI contract boundary:

- `PrSection` owns branch/PR lifecycle metadata and automation status.
- `TaskReviewTab` owns review decisions, detailed review items, selection, and addressing progress.
- `TaskComments` remains separate for general discussion.
