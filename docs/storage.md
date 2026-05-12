# Fusion Dashboard Storage Audit (FN-1202)

## Task-ID allocator authority and compatibility

- `distributed_task_id_state` is the authoritative local task-ID allocator state. `nextSequence` is the active high-water mark used for local ID reservations.
- `distributed_task_id_reservations` tracks reserve/commit/abort lifecycle entries. Aborted/expired reservations are burned and never reissued.
- `config.nextId` is retained only as a deprecated legacy compatibility field and optional one-time seed source. Fusion still reads it during reconciliation, but runtime task creation and settings writes no longer mutate it.
- Startup/store-open allocator reconciliation bumps each active prefix sequence to `max(current nextSequence, max(tasks suffix)+1, max(archivedTasks suffix)+1, max(reservation sequence)+1)` so stale allocator rows self-heal before local task creation resumes.
- Create-class task persistence is intentionally non-destructive: new tasks use plain `INSERT` semantics, while `ON CONFLICT(id) DO UPDATE` remains update-only. If counters drift and a reserved ID still collides, the create fails and the existing SQLite row / task directory stays intact.

### Detecting historical task-ID overwrites

If allocator state drifted before the current guards landed, historical task records may still contain overwrite evidence. Run the audit script from the project root:

```bash
node scripts/audit-task-id-collisions.mjs [--project-root /path/to/project]
```

The script checks for:
- `task.json.history` timestamps older than the active DB row's `createdAt`
- task-title mismatches between SQLite and the first `#` heading in `PROMPT.md`
- task-title mismatches against the latest `Fusion-Task-Id` commit subject on `main`
- active tasks that share an ID with an `archivedTasks` row

Treat flagged candidates as recovery leads, not automatic truth: review the surviving task files, logs, and commit history, then file a follow-up recovery task for any confirmed overwrite.

## SQLite write-path lock recovery (FN-4042 / FN-4083)

- Every disk-backed SQLite connection that Fusion opens for project storage (`fusion.db`), the central registry (`fusion-central.db`), archives (`archive.db`), and worktree hydration explicitly sets `PRAGMA busy_timeout = 5000` and `PRAGMA journal_mode = WAL` at connection open time before write work begins.
- Project database transactions now distinguish read and write intent:
  - `Database.transaction()` uses `BEGIN` (DEFERRED) for outermost transactions so read-only callers do not reserve the writer lock up front.
  - `Database.transactionImmediate()` uses `BEGIN IMMEDIATE` for write-heavy paths that must detect writer contention before user code runs.
- The shared task mutation path `atomicWriteTaskJsonWithAudit()` uses `transactionImmediate()`, so the task-row upsert and matching `runAuditEvents` insert still commit or roll back together, while lock contention is detected before the callback mutates in-memory state.
- `CentralDatabase.transaction()` remains `BEGIN IMMEDIATE`-based because its current callers are write-oriented coordination updates; nested transactions still use SQLite `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` semantics in both databases.
- Recovery is intentionally bounded: transient `SQLITE_BUSY` / `SQLITE_LOCKED` failures on outermost `BEGIN IMMEDIATE` and `COMMIT` are retried for a short additional window with small synchronous backoff sleeps. If the lock does not clear, the original write still fails loudly.
- Concurrent-write guarantees are layered:
  - per-task mutations inside one engine process are serialized by `TaskStore.withTaskLock()`
  - cross-task writes rely on WAL mode plus `busy_timeout`
  - write-heavy transactional hot paths acquire `BEGIN IMMEDIATE` before mutating state
  - compatibility `task.json` writes still happen only after the SQLite transaction succeeds
- Direct `recordRunAuditEvent()` writes continue to execute inside the shared transaction helper so they benefit from the same lock recovery and do not duplicate rows during transient contention.

## 1) Summary

- **localStorage keys in runtime dashboard code:** **20**
- **Backend settings keys defined in `@fusion/core`:** **78** total
  - **Global settings:** 17 (`GlobalSettings`)
  - **Project settings:** 61 (`ProjectSettings`)
- **SQLite tables in project DB schema (`packages/core/src/db.ts`):** **43** (including migration-created tables)
- **Issues identified:** **9**
  - High: 2
  - Medium: 5
  - Low: 2

High-level finding: the dashboard currently uses localStorage extensively for UX state and drafts (good for responsiveness), but several keys are **not project-scoped** in a multi-project app and some data has **sync gaps** against backend persistence (notably theme settings).

---

## 2) localStorage Inventory

| Storage Key | Component/Hook | Data Type | Category | Risk Level |
|---|---|---|---|---|
| `kb-dashboard-theme-mode` | `hooks/useTheme.ts` | enum string (`dark`/`light`/`system`) | settings overlap | **Medium** |
| `kb-dashboard-color-theme` | `hooks/useTheme.ts` | enum string (color theme id) | settings overlap | **Medium** |
| `kb-dashboard-current-project` | `hooks/useCurrentProject.ts` | JSON `ProjectInfo` object (includes id/name/path/status/etc.) | project/identity | **Medium** |
| `kb-terminal-tabs` | `hooks/useTerminalSessions.ts` | JSON array of tab objects (`id`, `sessionId`, `title`, active state, timestamp) | UI preference (operational session state) | **High** |
| `fn-agent-tree-expanded` | `hooks/useAgentHierarchy.ts` | JSON string[] of expanded agent ids | UI preference | Low |
| `kb-planning-last-description` | `hooks/modalPersistence.ts` (used by `PlanningModeModal`) | free-text draft | user draft | Medium |
| `kb-subtask-last-description` | `hooks/modalPersistence.ts` (used by `SubtaskBreakdownModal`) | free-text draft | user draft | Medium |
| `kb-mission-last-goal` | `hooks/modalPersistence.ts` (used by `MissionInterviewModal`) | free-text draft | user draft | Medium |
| `kb-dashboard-view-mode` | `App.tsx` | enum string (`overview`/`project`) | UI preference | Low |
| `kb-dashboard-task-view` | `App.tsx` | enum string (`board`/`list`/`agents`) | UI preference | Low |
| `kb-dashboard-list-columns` | `components/ListView.tsx` | JSON array of visible list columns | UI preference | Low |
| `kb-dashboard-hide-done` | `components/ListView.tsx` | boolean string (`"true"`/`"false"`) | UI preference | Low |
| `kb-dashboard-list-collapsed` | `components/ListView.tsx` | JSON array of collapsed column ids | UI preference | Low |
| `kb-dashboard-selected-tasks` | `components/ListView.tsx` | JSON array of selected task IDs | UI preference | **Medium** |
| `kb-quick-entry-text` | `components/QuickEntryBox.tsx` | free-text task draft | user draft | Medium |
| `kb-quick-entry-expanded` | `components/QuickEntryBox.tsx` (legacy cleanup via `removeItem`) | legacy bool key (no longer used) | UI preference | Low |
| `kb-inline-create-text` | `components/InlineCreateCard.tsx` | free-text task draft | user draft | Medium |
| `fn-agent-view` | `components/AgentsView.tsx`, `components/AgentListModal.tsx` | enum string (`board`/`list`/`tree` in view; modal supports board/list) | UI preference | Medium |
| `kb-usage-view-mode` | `components/UsageIndicator.tsx` | enum string (`used`/`remaining`) | UI preference | Low |
| `kb-dashboard-recent-projects` | `components/ProjectOverview.tsx` | JSON array of recent project IDs | project/identity | Low |

Notes:
- Search scope: `packages/dashboard/app/**/*.ts(x)` runtime code (tests excluded).
- `useTheme.getThemeInitScript()` also reads the same theme keys before hydration.

---

## 3) Backend Settings Inventory

API endpoints reviewed:
- `GET /api/settings` (merged global + project view)
- `PUT /api/settings` (project updates)
- `GET /api/settings/global`
- `PUT /api/settings/global`
- `GET /api/settings/scopes`

### 3.1 Global settings (`~/.fusion/settings.json`)

| Setting Key | Scope | API Endpoint | Description |
|---|---|---|---|
| `themeMode` | Global | `GET/PUT /api/settings/global` (+ merged via `GET /api/settings`) | Theme mode preference |
| `colorTheme` | Global | `GET/PUT /api/settings/global` | Color/accent theme |
| `dashboardFontScalePct` | Global | `GET/PUT /api/settings/global` | Dashboard Appearance font scale percentage (85–125, default 100) applied before hydration. |
| `defaultProvider` | Global | `GET/PUT /api/settings/global` | Default model provider |
| `defaultModelId` | Global | `GET/PUT /api/settings/global` | Default model id |
| `fallbackProvider` | Global | `GET/PUT /api/settings/global` | Fallback model provider |
| `fallbackModelId` | Global | `GET/PUT /api/settings/global` | Fallback model id |
| `defaultThinkingLevel` | Global | `GET/PUT /api/settings/global` | Default reasoning effort |
| `ntfyEnabled` | Global | `GET/PUT /api/settings/global` | Notifications enabled |
| `ntfyTopic` | Global | `GET/PUT /api/settings/global` | Ntfy topic |
| `ntfyBaseUrl` | Global | `GET/PUT /api/settings/global` | Custom ntfy server base URL override |
| `ntfyAccessToken` | Global | `GET/PUT /api/settings/global` | Access token for authenticated ntfy publishes |
| `ntfyEvents` | Global | `GET/PUT /api/settings/global` | Notification event filters |
| `ntfyDashboardHost` | Global | `GET/PUT /api/settings/global` | Host for deep links |
| `defaultProjectId` | Global | `GET/PUT /api/settings/global` | CLI default project |
| `setupComplete` | Global | `GET/PUT /api/settings/global` (internal first-run use) | Setup wizard completion flag |
| `favoriteProviders` | Global | `GET/PUT /api/settings/global` | Favorited providers |
| `favoriteModels` | Global | `GET/PUT /api/settings/global` | Favorited models |
| `openrouterModelSync` | Global | `GET/PUT /api/settings/global` | Startup model sync behavior |
| `modelOnboardingComplete` | Global | `GET/PUT /api/settings/global` | Onboarding completion flag |
| `executionGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for task execution |
| `executionGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for task execution |
| `planningGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for planning |
| `planningGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for planning |
| `validatorGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for validator/reviewer |
| `validatorGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for validator/reviewer |
| `titleSummarizerGlobalProvider` | Global | `GET/PUT /api/settings/global` | Global baseline AI provider for title summarization |
| `titleSummarizerGlobalModelId` | Global | `GET/PUT /api/settings/global` | Global baseline AI model ID for title summarization |

### 3.2 Project settings (`.fusion/config.json` / `config.settings`)

| Setting Key | Scope | API Endpoint | Description |
|---|---|---|---|
| `globalPause` | Project | `GET/PUT /api/settings` | Hard stop for engine activity |
| `enginePaused` | Project | `GET/PUT /api/settings` | Soft pause for dispatch |
| `maxConcurrent` | Project | `GET/PUT /api/settings` | Max concurrent task-lane agents. Utility AI workflows bypass this limit. |
| `maxWorktrees` | Project | `GET/PUT /api/settings` | Worktree cap |
| `pollIntervalMs` | Project | `GET/PUT /api/settings` | Scheduler poll interval |
| `groupOverlappingFiles` | Project | `GET/PUT /api/settings` | Serialize overlapping file work |
| `overlapIgnorePaths` | Project | `GET/PUT /api/settings` | Project-relative file/directory paths ignored by overlap blocking |
| `autoMerge` | Project | `GET/PUT /api/settings` | Enable auto merge |
| `mergeStrategy` | Project | `GET/PUT /api/settings` | Direct vs PR merge strategy |
| `worktreeInitCommand` | Project | `GET/PUT /api/settings` | Command run on worktree init |
| `testCommand` | Project | `GET/PUT /api/settings` | Project test command |
| `buildCommand` | Project | `GET/PUT /api/settings` | Project build command |
| `recycleWorktrees` | Project | `GET/PUT /api/settings` | Worktree pool toggle |
| `worktreeNaming` | Project | `GET/PUT /api/settings` | Worktree naming strategy |
| `taskPrefix` | Project | `GET/PUT /api/settings` | Task ID prefix |
| `includeTaskIdInCommit` | Project | `GET/PUT /api/settings` | Commit scope formatting |
| `defaultProviderOverride` | Project | `GET/PUT /api/settings` | Project-level override for base default provider |
| `defaultModelIdOverride` | Project | `GET/PUT /api/settings` | Project-level override for base default model ID |
| `executionProvider` | Project | `GET/PUT /api/settings` | AI provider for task execution |
| `executionModelId` | Project | `GET/PUT /api/settings` | AI model ID for task execution |
| `planningProvider` | Project | `GET/PUT /api/settings` | Planning model provider |
| `planningModelId` | Project | `GET/PUT /api/settings` | Planning model id |
| `planningFallbackProvider` | Project | `GET/PUT /api/settings` | Planning fallback provider |
| `planningFallbackModelId` | Project | `GET/PUT /api/settings` | Planning fallback model id |
| `validatorProvider` | Project | `GET/PUT /api/settings` | Validator model provider |
| `validatorModelId` | Project | `GET/PUT /api/settings` | Validator model id |
| `validatorFallbackProvider` | Project | `GET/PUT /api/settings` | Validator fallback provider |
| `validatorFallbackModelId` | Project | `GET/PUT /api/settings` | Validator fallback model id |
| `modelPresets` | Project | `GET/PUT /api/settings` | Reusable model presets |
| `autoSelectModelPreset` | Project | `GET/PUT /api/settings` | Auto-preset by task size |
| `defaultPresetBySize` | Project | `GET/PUT /api/settings` | Size→preset mapping |
| `autoResolveConflicts` | Project | `GET/PUT /api/settings` | Smart conflict auto-resolution |
| `smartConflictResolution` | Project | `GET/PUT /api/settings` | Alias for conflict automation |
| `strictScopeEnforcement` | Project | `GET/PUT /api/settings` | Block out-of-scope file changes |
| `buildRetryCount` | Project | `GET/PUT /api/settings` | Build retry attempts |
| `buildTimeoutMs` | Project | `GET/PUT /api/settings` | Build timeout |
| `requirePlanApproval` | Project | `GET/PUT /api/settings` | Manual plan approval gate |
| `taskStuckTimeoutMs` | Project | `GET/PUT /api/settings` | Stuck task timeout |
| `autoUnpauseEnabled` | Project | `GET/PUT /api/settings` | Auto unpause on rate limits |
| `autoUnpauseBaseDelayMs` | Project | `GET/PUT /api/settings` | Base backoff delay |
| `autoUnpauseMaxDelayMs` | Project | `GET/PUT /api/settings` | Max backoff delay |
| `maxStuckKills` | Project | `GET/PUT /api/settings` | Max detector retries |
| `maxSpawnedAgentsPerParent` | Project | `GET/PUT /api/settings` | Child agents per parent |
| `maxSpawnedAgentsGlobal` | Project | `GET/PUT /api/settings` | Total spawned-agent cap |
| `maintenanceIntervalMs` | Project | `GET/PUT /api/settings` | Maintenance cadence |
| `autoUpdatePrStatus` | Project | `GET/PUT /api/settings` | PR badge polling |
| `autoCreatePr` | Project | `GET/PUT /api/settings` | Automatic PR creation |
| `autoBackupEnabled` | Project | `GET/PUT /api/settings` | Scheduled backup toggle |
| `autoBackupSchedule` | Project | `GET/PUT /api/settings` | Backup cron schedule |
| `autoBackupRetention` | Project | `GET/PUT /api/settings` | Backup retention count |
| `autoBackupDir` | Project | `GET/PUT /api/settings` | Backup directory |
| `autoSummarizeTitles` | Project | `GET/PUT /api/settings` | Auto-title generation |
| `titleSummarizerProvider` | Project | `GET/PUT /api/settings` | Title model provider |
| `titleSummarizerModelId` | Project | `GET/PUT /api/settings` | Title model id |
| `titleSummarizerFallbackProvider` | Project | `GET/PUT /api/settings` | Title fallback provider |
| `titleSummarizerFallbackModelId` | Project | `GET/PUT /api/settings` | Title fallback model id |
| `scripts` | Project | `GET/PUT /api/settings` | Named script map |
| `setupScript` | Project | `GET/PUT /api/settings` | Named setup script reference |
| `insightExtractionEnabled` | Project | `GET/PUT /api/settings` | Insight extraction toggle |
| `insightExtractionSchedule` | Project | `GET/PUT /api/settings` | Insight extraction schedule |
| `insightExtractionMinIntervalMs` | Project | `GET/PUT /api/settings` | Minimum extraction interval |
| `memoryEnabled` | Project | `GET/PUT /api/settings` | Memory system toggle |
| `tokenCap` | Project | `GET/PUT /api/settings` | Token cap for compacting |
| `runStepsInNewSessions` | Project | `GET/PUT /api/settings` | Step session isolation |
| `maxParallelSteps` | Project | `GET/PUT /api/settings` | Parallel step cap |
| `agentPrompts` | Project | `GET/PUT /api/settings` | Per-role prompt templates |

Additional backend notes:
- `githubTokenConfigured` is returned by `GET /api/settings` but is **computed server-side**, not persisted.
- Non-settings config persisted in backend include `nextId`, `workflowSteps`, and `nextWorkflowStepId` (`config` row / config JSON compatibility path).
- **`*Global*` keys are never persisted in project settings** — these belong exclusively to global settings. Conversely, project-only keys (`defaultProviderOverride`, `executionProvider`, `planningProvider`, etc.) are never persisted in global settings. The two scopes are strictly isolated.

---

## 4) SQLite Tables Inventory (`packages/core/src/db.ts`)

| Table | Purpose |
|---|---|
| `tasks` | Core task metadata and JSON-backed nested fields (priority, dependencies, steps, log, attachments, comments, model overrides, workflow results, merge details, assignment, mission linkage). |

The `tasks.githubTracking` JSON column stores per-task GitHub tracking state (`enabled`, optional `repoOverride`, linked issue metadata, and `unlinkedAt`). It is additive and default-off; imported-source issue metadata remains in `issueInfo` / `sourceIssue`. Behavior wiring (issue creation/lifecycle sync and UI surfacing) lands in FN-3870/FN-3873/FN-3874.
| `config` | Single-row project configuration (`nextId`, settings payload, workflow step counters). |
| `workflow_steps` | Workflow step definitions (`prompt`/`script`) with phase, template metadata, and model overrides. |
| `activityLog` | Per-project activity/event log with timestamp/type/task indexes. |
| `archivedTasks` | Archived task snapshots (compact JSON payload + archive timestamp). |
| `automations` | Scheduled automation definitions, run state, and run history. |
| `agents` | Agent registry/state/task assignment metadata. |
| `agentHeartbeats` | Heartbeat run events linked to agents (`agentId` FK cascade). |
| `approval_requests` | Durable approval request records: requester actor snapshot, target action payload (category/action/resource/context), lifecycle status (`pending`/`approved`/`denied`/`completed`), optional task/run context, and requested/decided/completed timestamps. |
| `approval_request_audit_events` | Append-only audit trail for approval requests. Each row stores event type (`created`/`approved`/`denied`/`completed`), immutable actor snapshot, optional note, and deterministic per-request ordering by `(createdAt, rowid)`. |
| `task_documents` | Task-scoped document metadata/content keyed by `(taskId, key)` with current revision pointer. |
| `task_document_revisions` | Immutable revision history for task documents (content snapshots by revision). |
| `__meta` | Schema version + monotonic `lastModified` change detector. |
| `missions` | Mission-level planning hierarchy root. |
| `milestones` | Milestones under missions, including dependency lists and validation state. |
| `slices` | Slices under milestones with plan-state/activation metadata. |
| `mission_features` | Features under slices with optional task linkage and execution-loop counters/state. |
| `mission_events` | Mission event log with ordered sequence numbers and metadata payloads. |
| `plugins` | Plugin registry, lifecycle state, dependency metadata, and settings blobs. |
| `routines` | Routine definitions (trigger config, steps/command, catch-up policy, run history, and persisted `agentId` ownership metadata). Legacy databases missing routine fields (including `agentId`) are backfilled during init-time compatibility migration. |
| `roadmaps` | Roadmap plugin metadata (owned/registered by `plugins/fusion-plugin-roadmap`). |
| `roadmap_milestones` | Milestones within roadmaps (`roadmapId` FK), owned/registered by roadmap plugin schema hooks. |
| `roadmap_features` | Features within roadmap milestones (`milestoneId` FK), owned/registered by roadmap plugin schema hooks. |
| `project_insights` | Extracted project insights with fingerprint-based deduplication and provenance metadata. |
| `project_insight_runs` | Insight extraction run history with durable lifecycle metadata (`lifecycle` JSON includes terminalReason/cause, failureClass, retryable flag, cancellationRequestedAt, timeoutAt, retry lineage fields). Terminal rows are immutable for state transitions. |
| `project_insight_run_events` | Append-only per-run lifecycle trail (`seq`, `type`, `message`, optional `status`/`classification`/`metadata`) used by cancel/retry/timeout auditing and API inspection. |
| `todo_lists` | Project-scoped todo list metadata (`projectId`, title, created/updated timestamps). |
| `todo_items` | Todo list items (`listId` FK) with completion state, completion timestamp, and deterministic `sortOrder`. |
| `ai_sessions` *(migration-created)* | Persisted AI interactive sessions (planning/interview/subtask) with status and conversation history. |
| `messages` *(migration-created)* | Inter-agent/user message mailbox storage. |
| `agentRatings` *(migration-created)* | Agent performance ratings (1-5), optional reviewer metadata, and run/task attribution. |
| `chat_sessions` *(migration-created)* | Chat session metadata (agent/project/model/status/title timestamps). |
| `chat_messages` *(migration-created)* | Chat message history per session (`role`, `content`, thinking output, metadata). |
| `chat_rooms` *(migration-created)* | Room metadata (`name`, `slug`, `description`, `projectId`, `createdBy`, status and timestamps). |
| `chat_room_members` *(migration-created)* | Room membership map with composite PK `(roomId, agentId)` and role (`owner`/`member`). |
| `chat_room_messages` *(migration-created)* | Room message history with `senderAgentId`, JSON `mentions`, attachments/metadata blobs, ordered by `createdAt`. |
| `runAuditEvents` *(migration-created)* | Run audit trail events across database/git/filesystem mutation domains. |
| `mission_contract_assertions` *(migration-created)* | Milestone contract assertions used by mission validator workflows. |
| `mission_feature_assertions` *(migration-created)* | Many-to-many links between mission features and contract assertions. |
| `mission_validator_runs` *(migration-created)* | Validator run records for mission feature loop execution. |
| `mission_validator_failures` *(migration-created)* | Assertion failure records captured during validator runs. |
| `mission_fix_feature_lineage` *(migration-created)* | Source↔fix feature lineage for auto-generated mission fix features. |
| `research_runs` | Research run state (query, topic, status, lifecycle, sources, results, citations, events, exports, token usage). Supports project-scoped active-run uniqueness via `(projectId, trigger, status)` index. Terminal runs are immutable. |
| `research_exports` | Persisted export records for research runs (`runId` FK cascade). Stores format, content, and optional file path. |
| `research_run_events` | Append-only event log for research run lifecycle tracking (`runId` FK cascade, ordered by `seq`). Records status transitions, phase changes, step lifecycle, and failure classifications. |
| `eval_runs` | Eval run lifecycle state (status, trigger, scope, evaluation window boundaries, evaluated task IDs/counts, aggregate scores, provenance). |
| `eval_task_results` | Per-task eval outcomes linked to runs (`runId` FK cascade), including durable task snapshots and structured score payloads. `categoryScores[]` stores canonical per-category fields (`category`, `deterministicScore`, `aiScore`, `finalScore`, `weight`, `band`, `rationale`, `evidence[]`), plus `overallScore` derived from category finals. Also stores deterministic/AI signal payloads, summary rationale, structured follow-up suggestions (`suggestionId`, `dedupeKey`, recommendation, lifecycle state, suppression fields, optional `createdTaskId` linkage), and a bounded `TaskEvaluationEvidenceBundle` (fixed source-order groups, capped entry counts, max 500-char excerpts with truncation marker) embedded in result metadata for backward-compatible persistence. |
| `eval_run_events` | Append-only eval run event trail (`runId` FK cascade, ordered by `seq`) for orchestration/debug auditing and downstream API/UI drill-down. |

### Schema self-heal on init

`Database.init()` runs versioned migrations first, then checks `__meta.schemaCompatFingerprint` against a process-local fingerprint derived from `SCHEMA_VERSION` plus the canonicalized table declarations from `SCHEMA_SQL` and `MIGRATION_ONLY_TABLE_SCHEMAS`.

- **Fingerprint match:** skip the expensive column-reconciliation walk, but still run the cheap idempotent side effects that must always happen on open (for example `CREATE INDEX IF NOT EXISTS ...` and routines NULL backfills).
- **Fingerprint absent or mismatched:** run the full schema-compatibility reconciliation pass, unioning table definitions from `SCHEMA_SQL` plus `MIGRATION_ONLY_TABLE_SCHEMAS` and backfilling missing columns on tables that already exist, then persist the new fingerprint.

Invariant: after init, every declared column for covered tables exists regardless of `__meta.schemaVersion` whenever the fingerprint is stale or missing, preventing legacy drift from causing `no such column` regressions on newly added fields while keeping unchanged-schema opens fast.

---

### Chat rooms (migration 70)

`ChatStore` now persists room chat data across three tables: `chat_rooms`, `chat_room_members`, and `chat_room_messages`.

- `chat_rooms` stores canonical room identity (`id`, normalized `name`, unique `slug` scoped by `projectId`), metadata (`description`, `createdBy`), lifecycle status, and timestamps.
- `chat_room_members` links agents to rooms via composite primary key `(roomId, agentId)` and tracks `role` plus `addedAt`.
- `chat_room_messages` stores room history with message role/content, optional `thinkingOutput`, JSON `metadata`, JSON `attachments`, optional `senderAgentId`, and JSON `mentions`.
- Foreign keys from members/messages to `chat_rooms(id)` use `ON DELETE CASCADE`, so deleting a room automatically removes memberships and room message history.

## 5) Issues Found

1. **Theme dual-storage sync gap**  
   - **Severity:** High  
   - **Affected:** `hooks/useTheme.ts`, `App.tsx`, `SettingsModal.tsx`, global settings API (`/api/settings/global`)  
   - **Problem:** Theme is persisted in both localStorage (`kb-dashboard-theme-mode`, `kb-dashboard-color-theme`) and backend global settings (`themeMode`, `colorTheme`), but app bootstrap uses localStorage-only theme hydration. If backend and browser cache diverge, cross-device consistency breaks.  
   - **Recommended fix:** Make backend global settings the source of truth (or explicitly define local cache precedence + bidirectional sync strategy and conflict resolution).

2. **Project-unscoped localStorage keys in multi-project UX state**  
   - **Severity:** High  
   - **Affected:** `App.tsx`, `ListView.tsx`, `QuickEntryBox.tsx`, `InlineCreateCard.tsx`, `AgentsView.tsx`, `useTerminalSessions.ts`, `useAgentHierarchy.ts`, `UsageIndicator.tsx`  
   - **Problem:** Many keys are global (`kb-dashboard-task-view`, `kb-dashboard-list-*`, `kb-dashboard-selected-tasks`, `kb-quick-entry-text`, `kb-inline-create-text`, `kb-terminal-tabs`, etc.) and are reused across projects. This can leak preferences/drafts/selections between projects unexpectedly.  
   - **Recommended fix:** Namespace project-specific keys with `projectId` (e.g., `kb:{projectId}:dashboard-list-columns`). Keep only true global prefs unscoped.

3. **`kb-dashboard-selected-tasks` can carry stale selections across projects**  
   - **Severity:** Medium  
   - **Affected:** `components/ListView.tsx`  
   - **Problem:** Selected task IDs persist globally. In multi-project setups with overlapping ID patterns, stale selections can reappear and affect bulk operations unexpectedly.  
   - **Recommended fix:** Project-scope this key, and/or treat selection as in-memory/session-only state.

4. **Terminal session persistence stores operational identifiers in localStorage**  
   - **Severity:** Medium  
   - **Affected:** `hooks/useTerminalSessions.ts` (`kb-terminal-tabs`)  
   - **Problem:** Session IDs and tab metadata persist client-side and are not project-scoped. This is operational state better owned by backend/session layer; stale tabs also survive cache until cleanup logic runs.  
   - **Recommended fix:** Move terminal tab/session state to server persistence (or at minimum sessionStorage + project scoping + TTL/versioning).

5. **Current project persistence stores full `ProjectInfo` object (includes filesystem path)**  
   - **Severity:** Medium  
   - **Affected:** `hooks/useCurrentProject.ts` (`kb-dashboard-current-project`)  
   - **Problem:** Storing full project objects increases drift risk and stores more data than needed (including local path).  
   - **Recommended fix:** Persist only stable `projectId`; resolve current object from backend project list each load.

6. **Draft persistence is local-only (device/browser-bound)**  
   - **Severity:** Medium  
   - **Affected:** `modalPersistence.ts`, `QuickEntryBox.tsx`, `InlineCreateCard.tsx`  
   - **Problem:** Planning/subtask/mission/task-entry drafts are lost on storage clear or browser/device switch.  
   - **Recommended fix:** Keep local quick-draft behavior, but add optional server-backed drafts (short TTL) for continuity.

7. **Settings scope key lists drift from interfaces**  
   - **Severity:** Medium  
   - **Affected:** `packages/core/src/types.ts`, `store.ts`, `routes.ts`, `SettingsModal.tsx`  
   - **Problem:** `GLOBAL_SETTINGS_KEYS` (14) omits `setupComplete`, `favoriteProviders`, `favoriteModels`; `PROJECT_SETTINGS_KEYS` (52) omits 9 project interface keys (`strictScopeEnforcement`, `buildRetryCount`, `buildTimeoutMs`, `autoUnpause*`, `maintenanceIntervalMs`, `scripts`, `setupScript`). This creates scope-classification and patch-filter inconsistencies.  
   - **Recommended fix:** Generate key lists from schema/interface source (or enforce parity tests) to prevent drift.

8. **`fn-agent-view` shared by two UIs with different supported modes**  
   - **Severity:** Low  
   - **Affected:** `AgentsView.tsx`, `AgentListModal.tsx`  
   - **Problem:** Both share the same key, but one surface supports `tree` and the modal supports only `board/list`; behavior remains valid but coupling is implicit.  
   - **Recommended fix:** Decide intentional shared behavior and document it; otherwise split keys by surface.

9. **Workflow steps still persisted in config JSON compatibility path (known in-progress work)**  
   - **Severity:** Low  
   - **Affected:** `config.settings/workflowSteps`, `db.ts` config table  
   - **Problem:** Workflow step storage is still tied to config blob structure; this is already being addressed by **FN-1201** (migration to dedicated SQLite table).  
   - **Recommended fix:** Continue and complete FN-1201; remove config-blob coupling after migration.

---

## 6) Recommendations (Prioritized)

### P0 — High impact / should do first

1. **Unify theme persistence contract**
   - Backend global settings should be canonical for multi-device consistency.
   - Keep localStorage only as startup cache, with explicit hydration/sync rules.

2. **Project-scope localStorage keys for project-specific UX state**
   - Scope at least: `kb-dashboard-task-view`, list settings (`columns`, `hide-done`, `collapsed`, `selected-tasks`), drafts, terminal tabs, agent hierarchy.
   - Preserve unscoped behavior only for truly global prefs (e.g., appearance if desired).

3. **Fix settings key parity drift (`*_SETTINGS_KEYS` vs interfaces)**
   - Add tests to fail when interface keys and key arrays diverge.
   - Prevent accidental mis-scoping and patch filtering anomalies.

### P1 — Medium impact

4. **Reduce persisted identity payloads**
   - Store only `projectId` for current project selection, not full object/path.

5. **Rework terminal tab persistence model**
   - Prefer server-managed tab/session restoration or at minimum short-lived, project-scoped client persistence with cleanup/versioning.

6. **Adjust selected-task persistence strategy**
   - Move selection to memory/session scope or project-scoped key with validation on project switch.

### P2 — Lower effort / UX polish

7. **Optional server-backed draft recovery**
   - Keep local fast drafts; add opt-in backend draft sync for cross-browser resilience.

8. **Clarify shared `fn-agent-view` semantics**
   - Either intentionally share and document, or split keys by surface.

9. **Complete FN-1201 workflow-step migration**
   - Keep as tracked in-progress storage hardening item.

---

## 7) Verification Checklist (for this audit)

- [x] All runtime localStorage keys in `packages/dashboard/app` cataloged
- [x] Theme dual-storage gap addressed
- [x] Current-project persistence behavior addressed
- [x] Planning/subtask/mission draft behavior addressed
- [x] ListView state scoping addressed
- [x] Terminal tab persistence addressed (`kb-terminal-tabs`)
- [x] QuickEntry expanded key addressed (`kb-quick-entry-expanded` legacy cleanup)
- [x] Agent hierarchy expand state addressed (`fn-agent-tree-expanded`)
- [x] Backend settings + API route inventory included
- [x] SQLite table inventory included
- [x] Known in-progress FN-1201 called out

## Per-Worktree DB Hydration

Each git worktree has its own gitignored `.fusion/` directory, so `.fusion/fusion.db` is local scratch state per worktree. That isolation created a cross-task lookup gap: executor prompts that query sibling/dependency rows directly from the worktree DB could see empty results. FN-3840 documented the manual `ATTACH`/`INSERT OR REPLACE` recovery, and FN-3832 was the breaking case that surfaced this in production.

Fusion now auto-hydrates the worktree DB during executor startup at three points:
- after fresh worktree creation (including init/setup commands),
- after pooled worktree acquire/reassignment,
- when reusing an existing on-disk worktree for resume.

Hydration copies only:
- current task row,
- transitive dependency task rows (BFS, depth cap 5, max 50 unique task IDs),
- `task_documents` rows for that same task-id set.

Implementation uses in-process SQLite streaming (`DatabaseSync`), source-side `SELECT`, destination-side `INSERT OR REPLACE` inside a destination transaction. Column lists are built from source/destination schema intersection (`PRAGMA table_info`), so schema drift degrades gracefully (dropped columns are logged once, and defaults apply on destination-only columns).

Example shape of the destination write:

```sql
INSERT OR REPLACE INTO tasks (<shared-columns...>) VALUES (<placeholders...>);
INSERT OR REPLACE INTO task_documents (<shared-columns...>) VALUES (<placeholders...>);
```

Expected executor log entry on success:

```text
Hydrated worktree DB: 4 tasks, 12 task_documents
```

A concrete recovered failure mode now covered by tests: when a worktree directory exists but its local `.fusion/` scratch state is missing, opening `DatabaseSync(<worktree>/.fusion/fusion.db)` can fail with `unable to open database file`. Hydration now performs destination bootstrap (`mkdir -p .fusion` + schema init) and retries the destination open once before degrading.

Failure policy remains strict non-blocking for genuinely unrecoverable cases: hydration warnings are logged, but worktree creation/execution continues. Examples that still intentionally degrade include source DB missing, destination write-permission failures, and irreconcilable schema/open errors after bootstrap retry. Canonical task data remains the root project TaskStore DB; if an agent needs non-hydrated rows immediately, `fn_task_show` remains the canonical fallback path.
