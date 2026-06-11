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

The workflow-owned merge runtime is documented in
[`workflow-owned-merge-runtime.md`](./workflow-owned-merge-runtime.md). It covers
the durable work-item store, merge/retry/recovery node capabilities, and cutover
guards that keep scheduler/project-engine/self-healing policy out of the new
workflow-owned path.

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
  - Core schema tables include: `tasks`, `config`, `workflow_steps`, `activityLog`, `archivedTasks`, `automations`, `agents`, `agentHeartbeats`, approval tables (`approval_requests`, `approval_request_audit_events`), `task_documents`, `task_document_revisions`, mission hierarchy tables (`missions`, `milestones`, `slices`, `mission_features`, `mission_events`), goals table (`goals`), plugin/routine tables (`plugins`, `routines`), roadmap tables (`roadmaps`, `roadmap_milestones`, `roadmap_features`), insight tables (`project_insights`, `project_insight_runs`), research tables (`research_runs`, `research_exports`, `research_run_events`), eval tables (`eval_runs`, `eval_task_results`, `eval_run_events`), todo tables (`todo_lists`, `todo_items`), `__meta`
  - Migration-created tables include: `ai_sessions`, `messages`, `agentRatings`, `chat_sessions`, `chat_messages`, `runAuditEvents`, `mission_contract_assertions`, `mission_feature_assertions`, `mission_validator_runs`, `mission_validator_failures`, `mission_fix_feature_lineage`
  - `ai_sessions.status` lifecycle includes `draft` (pre-start planning session), then `generating`, `awaiting_input`, terminal `complete` / `error`
- **Roadmap feature ownership**: roadmap contracts, ordering/handoff helpers, persistence, routes, and dashboard UI live in `plugins/fusion-plugin-roadmap` (package `@fusion-plugin-examples/roadmap`, plugin id `fusion-plugin-roadmap`) rather than dashboard/core ownership.
- **CentralCore**: `packages/core/src/central-core.ts`
  - Global project registry, health, central activity feed, global concurrency
  - Backed by `packages/core/src/central-db.ts` (`~/.fusion/fusion-central.db`)
- **Specialized stores**:
  - `AgentStore` (`agent-store.ts`) — filesystem-based agent metadata + heartbeat run history
  - `MissionStore` (`mission-store.ts`) — mission/milestone/slice/feature hierarchy
  - `GoalStore` (`goal-store.ts`) — strategic goal CRUD with server-enforced 5-active-goal cap
  - `AutomationStore` (`automation-store.ts`) — scheduled jobs with global/project scope isolation
  - `MessageStore` (`message-store.ts`) — SQLite-backed mailbox/inbox/outbox messaging
  - `ApprovalRequestStore` (`approval-request-store.ts`) — durable approval request lifecycle + append-only audit events
  - `ChatStore` (`chat-store.ts`) — session/message persistence for agent chat
  - `InsightStore` (`insight-store.ts`) — project insight persistence + dedupe/run tracking
  - `ReflectionStore` (`reflection-store.ts`) — agent reflection records and performance snapshots
  - `PluginStore` (`plugin-store.ts`) — plugin registry/state/settings persistence
  - `RoutineStore` (`routine-store.ts`) — recurring routine definitions and run history
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

Dashboard approval endpoints (`packages/dashboard/src/routes/register-approval-routes.ts`):
- `GET /api/approvals`
- `GET /api/approvals/:id`
- `POST /api/approvals/:id/decision`

Runtime flow: engine action gate creates/reuses request → pauses task/agent with `pauseReason="awaiting-approval"` → approver calls decision endpoint (`decision: approve|deny`) → request transitions (`pending→approved|denied`) → route resumes matching paused task/agent best-effort → next tool retry consumes `approved` exactly once (then `completed`) or returns structured denial.

Provisioning note: durable `fn_agent_create` / `fn_agent_delete` approvals use `agent_provisioning` policy handling on this same decision route; `fn_spawn_agent` stays under action-gate `task_agent_mutation` because spawned children are ephemeral runtime workers.

- `create(input: ApprovalRequestCreateInput)` — inserts a `pending` request and appends a `created` audit event
- `get(id)` — returns one request or `null`
- `list(input?: ApprovalRequestListInput)` — filters by `status`, `requesterActorId`, `taskId`, `runId`; ordered `createdAt DESC, id DESC`; paginated by `limit`/`offset`
- `getPendingCountsByActor()` — single-pass SQL aggregate (`status='pending'` grouped by `requesterActorId`) used by `/api/agents` pending-approval counters without materializing full request rows
- `decide(requestId, status, input: ApprovalRequestDecisionInput)` — applies `pending -> approved|denied`, stamps `decidedAt`, appends `approved`/`denied` audit event
- `markCompleted(requestId, input: ApprovalRequestCompletionInput)` — applies `approved -> completed`, stamps `completedAt`, appends `completed` audit event
- `getAuditHistory(requestId)` — returns append-only audit rows ordered `createdAt ASC, rowid ASC`

Lifecycle contract (`types.ts` `isValidApprovalRequestTransition`):

- Primary forward paths: `pending -> approved -> completed` and `pending -> denied`
- Direct `pending -> completed` and all transitions from `denied`/`completed` (except no-op self-transition) are rejected
- Same-state transitions (`from === to`) are treated as valid by the helper even though the intended lifecycle is forward-only

### Secrets Store (`SecretsStore`)

`SecretsStore` (`packages/core/src/secrets-store.ts`) provides encrypted key-value secret persistence for tasks/agents (FN-4791). It is designed so plaintext values are only available at explicit reveal time and are never persisted or logged in plaintext.

Scope model:
- `project` scope stores rows in `secrets` inside `.fusion/fusion.db` (project database, FN-4788).
- `global` scope stores rows in `secrets_global` inside `~/.fusion/fusion-central.db` (central database, FN-4788).

Encryption model:
- Uses `createSecretCipher` from `packages/core/src/secrets-crypto.ts` (FN-4790).
- Cipher is AES-256-GCM with a fresh random nonce per row encryption.
- Key material comes from a `MasterKeyProvider`; resolver flow prefers OS keychain and falls back to `~/.fusion/master.key` when keychain storage is unavailable (FN-4789).

Per-secret policy/metadata:
- `SecretAccessPolicy` is a per-row union: `"auto" | "prompt" | "deny"`.
  - `auto`: policy layer allows direct reads for trusted callers.
  - `prompt`: reads are expected to be approval-gated through the approvals flow.
  - `deny`: programmatic reveal is disallowed by policy.
- Environment materialization metadata is stored on each secret:
  - `envExportable: boolean`
  - `envExportKey: string | null`
  - Engine worktree acquisition now materializes managed env files when `ProjectSettings.secretsEnv.enabled` is true (see `packages/engine/src/worktree-acquisition.ts:345-483` and `packages/engine/src/secrets-env-writer.ts`).
- Read provenance is captured on reveal via `lastReadAt` and `lastReadBy`.

Error contract:
- `SecretsStoreError` with `code` in `"duplicate-key" | "not-found" | "invalid-policy" | "invalid-key" | "decrypt-failed"`.

Public API surface:
- `listSecrets(scope?: SecretScope): SecretRecord[]`
- `getSecretMetadata(id, scope): SecretRecord | null`
- `createSecret({ scope, key, plaintextValue, description?, accessPolicy?, envExportable?, envExportKey? }): Promise<SecretRecord>`
- `updateSecret(id, scope, patch): Promise<SecretRecord>` (`plaintextValue` updates re-encrypt and rotate nonce)
- `deleteSecret(id, scope): void`
- `revealSecret(id, scope, { agentId?, userId? }): Promise<{ key, plaintextValue }>` (the only decrypting method; updates read provenance)

Settings boundary:
- Global default policy: `GlobalSettings.secretsAccessPolicy` (used by `resolveSecretAccessPolicy`).
- Project-level secrets settings: `ProjectSettings.secretsEnv`. Cross-node sync passphrase state surfaces read-only via `GlobalSettings.secretsSyncPassphraseConfigured` (derived from `hasSyncPassphraseConfigured(secretsStore)` against the reserved `__sync_passphrase__` row in `secrets_global`).
- Agent secret reads are exposed via `fn_secret_get` (`packages/cli/src/extension.ts:1542-1629`).
- Cross-node sync routes ship at `/api/nodes/:id/secrets/push`, `/api/nodes/:id/secrets/pull`, `/api/secrets/sync-receive`, `/api/secrets/sync-export` with inbound Bearer apiKey validation (`packages/dashboard/src/routes/register-secrets-sync-inbound-routes.ts:99-114`, `:181-196`).

### Mesh state read path for dashboard topology

- `GET /api/mesh/state` in `packages/dashboard/src/routes/register-mesh-routes.ts` is the authoritative dashboard/API read path for topology.
- Default behavior aggregates a deduped cluster snapshot from the local node plus reachable peers (`includeRemote !== false`) while preserving node-local last-known entries when peers are unreachable.
- `includeRemote=false` is the non-recursive local-only path used for peer fan-out, so cross-node aggregation never recursively calls remote aggregated endpoints.
- Route registration reuses the shared `options?.centralCore` instance when available instead of creating per-request `CentralCore` instances, preserving shared mesh state continuity.
- Nodes UI topology consumes a dedicated `useMeshState` hook that unwraps the `/api/mesh/state` snapshot into `NodeMeshState[]`; `MeshTopology` renders peer relationships directly from each node's `knownPeers` (including remote↔remote links) without fabricating local-star fallback edges.

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
  - `AuthMaterialSnapshot` (`providerAuth`, with API-key and OAuth credential shapes)

Intentional exclusions from shared snapshots:
- Task/agent blob contents (`PROMPT.md`, task document bodies, attachment bytes, JSONL run logs)
- Instruction-bundle file contents
- Node-local runtime handles and paths (for example worktree/session-file handles)

### Chat System

- `ChatStore` (`packages/core/src/chat-store.ts`) and `chat-types.ts` provide session-oriented chat state (`chat_sessions`, `chat_messages` tables)
- Dashboard chat UX lives in `packages/dashboard/app/components/ChatView.tsx` and hooks `useChat.ts` / `useQuickChat.ts`
- Main `useChat` session restore/recovery must not reset the active thread during session-list refresh or `chat:session:updated` metadata churn while a response is in flight.
- `chat_sessions.inFlightGeneration` stores a durable JSON snapshot while generation is active: latest streamed text/thinking, tool-call state, and `replayFromEventId` for SSE resume.
- `ChatManager.sendMessage()` updates that snapshot during streaming (debounced) and clears it on done/error/cancel so stale partial state does not survive completion.
- When the active session is still generating after reload/reconnect (`isGenerating: true`), `useChat`/`useQuickChat` hydrate the UI from `inFlightGeneration` immediately, then reconnect `/api/chat/sessions/:id/stream` with `Last-Event-ID = replayFromEventId` to avoid re-appending already-known deltas.
- Hooks also auto-reattach if a stale cached session is selected and a later refresh (or session re-fetch) flips `isGenerating` to true with an `inFlightGeneration` snapshot; dedupe is guarded by a last-attached `(sessionId, replayFromEventId)` ref so snapshot checkpoint bumps do not open duplicate SSE streams.
- Chat message submission uses SSE streaming responses from dashboard chat routes.
- Direct-chat terminal failures now persist as a distinct assistant message with `metadata.failureInfo` (`summary`, optional `errorClass`, optional `code`, optional `detail`, optional reference metadata) so the chat thread remains the durable primary failure surface after reload/reconnect.
- `ChatManager.sendMessage()` preserves any interrupted partial assistant output as its own message, then appends a separate persisted failure bubble instead of overwriting the partial reply.
- Main-chat optimistic user sends are reconciled against persisted SSE user echoes by content + temp-id replacement, so one user send cannot survive as a duplicate history entry after stream completion.
- `useChat.loadMessages()`/session restore map persisted `metadata.failureInfo` back into `ChatMessageInfo.failureInfo`, and live stream failures append the same assistant-style bubble client-side unless the error is classified as a tab-suspension false positive.
- `ChatView` renders failure bubbles inline with shared error-surface tokens; mailbox references deep-link into the mailbox view, while other failure references keep an inline "View failure details" affordance so reload/reconnect does not strand users in agent logs.
- `ChatView` renders those failure bubbles with inline assistant attribution even for model-only `__fn_agent__` chats, so provider/model failures still read as a response from the active model instead of an anonymous system alert.
- `streamChatResponse()` must flush trailing buffered SSE data on EOF even without a final newline, so terminal `done`/`error` events are not dropped at chunk boundaries.
- Chat generation ownership is isolated by `generationId` (`ChatManager.beginGeneration` + `ChatStreamManager` subscription filters + route preallocation), preventing stale generation terminal events from leaking into a newer active request.

#### Chat Rooms (Dashboard)

- The Rooms tab in `packages/dashboard/app/components/ChatView.tsx` is wired through `useChatRooms` (`packages/dashboard/app/hooks/useChatRooms.ts`).
- `useChatRooms` owns room list fetch/sort, active-room selection, member+message hydration, room creation/deletion, and room message sends.
- The hook subscribes to `/api/events` and consumes `chat:room:created`, `chat:room:updated`, `chat:room:deleted`, `chat:room:member:added`, `chat:room:member:removed`, `chat:room:message:added`, `chat:room:message:updated`, and `chat:room:message:deleted` to keep UI state in sync.
- Room messages persist through `POST /api/chat/rooms/:id/messages`; the route persists the user message first, then calls `ChatManager.sendRoomMessage(...)` to orchestrate room-member responders and persist assistant room replies with `chatStore.addRoomMessage(...)` (including `senderAgentId` for each responder).
- `sendRoomMessage(...)` uses existing room-member + mention resolution rules: mentioned members are direct responders, non-mentioned members are ambient responders (capped by `ROOM_AMBIENT_MAX_RESPONDERS`), and non-member mentions are handled explicitly by the manager instead of silently disappearing.
- Room responder prompt context is compacted deterministically: the newest 12 room messages stay verbatim, while older fetched history is summarized into a structured header (span, participants, and ranked highlights) before prompt size caps are enforced.
- Room-reply generation is now non-silent on failure: if a room has members but no active responders can be resolved, or all responder generations fail/return empty output, `sendRoomMessage(...)` throws `RoomReplyGenerationError` and the route surfaces HTTP 502 instead of returning a silent user-only success.
- `useChatRooms.sendRoomMessage()` now follows direct-chat style optimistic UX: append a temporary local user room message before `POST /api/chat/rooms/:id/messages`, reconcile that temp entry to the persisted user message on success, then refresh authoritative transcript state while continuing `chat:room:message:*` live SSE updates.
- On failures, `useChatRooms.sendRoomMessage()` performs state reconciliation (rollback temp entry or replace with persisted transcript when POST partially succeeded) and rethrows; `ChatView` clears the composer immediately when dispatching a room send, restores the exact prior text only if the send rejects, and owns the single user-facing error toast.
- Mention UI in rooms keeps direct-chat behavior unchanged while adding room affordances:
  - `AgentMentionPopup` receives room membership context and shows members first with a `status-dot` member indicator (`aria-label="Room member"`).
  - With an empty mention filter in room mode, only room members are listed; a hint row prompts the user to type to search non-members.
  - Mention chips rendered in room messages (`ChatView` and `QuickChatFAB`) mark non-members via `chat-mention-chip--non-member`, including `title`/`aria-label` text (`Not a member of {roomName}`) and muted warning-token styling.

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
- `POST /api/insights/run` preserves the single-active-run guarantee while adding orphan recovery for stale `pending|running` rows:
  - a conflicting active row is only auto-recovered when there is no in-memory controller ownership (`activeRunControllers` has no entry) **and** run age (`startedAt ?? createdAt`) exceeds the grace window (`ORPHAN_GRACE_MS = 30_000`)
  - recovered rows are durably marked `failed` with lifecycle terminal metadata (`terminalReason=failed`, `terminalCause=orphaned_active_run_recovered`, `failureClass=non_retryable`, `retryable=false`) and warning/status events appended to `project_insight_run_events`
  - true live conflicts continue returning HTTP 409 with structured payload details `{ code: "ACTIVE_RUN_CONFLICT", activeRunId, activeRunStatus, trigger }` so the dashboard can hydrate and display the existing active run instead of surfacing a raw backend exception
- `POST /api/insights/:id/create-task` remains a draft-payload endpoint (returns `suggestedTitle`/`suggestedDescription`); the dashboard `InsightsView` now uses that payload to create a real task through the normal app task-creation path (`column: triage`, `sourceType: dashboard_ui`, source metadata indicating insights origin)
- Backed by `project_insights`, `project_insight_runs`, and `project_insight_run_events`
- **Architecture invariant:** stale `pending`/`running` insight runs auto-recover at dashboard startup and on periodic/drive-by sweeps; active-row conflicts must be evaluated by age plus live `activeRunControllers` ownership instead of assuming all active rows block forever.

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
- Executor runtime contributions can be provided via `executorRuntimeEnv(taskCtx, ctx)`; see the canonical plugin-authoring contract in [`docs/PLUGIN_AUTHORING.md` §4 "`executorRuntimeEnv`: task-scoped executor subprocess environment"](./PLUGIN_AUTHORING.md#executorruntimeenv-task-scoped-executor-subprocess-environment). The engine applies these task-scoped overlays only to executor-spawned user commands, never to git plumbing subprocesses.
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
- Executor, heartbeat, and planning (triage) system prompts inject a shared `goalContext` dynamic layer via the canonical `resolveAndEmitGoalContext(...)` seam (which uses `buildGoalContextSection(...)`); when no active goals exist, no goal section is emitted.

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

**Roadmap frontend API contract (plugin namespace):**
- Canonical frontend namespace: `/api/plugins/fusion-plugin-roadmap/roadmaps`
- Roadmaps: `GET /`, `POST /`, `GET /:roadmapId`, `PATCH /:roadmapId`, `DELETE /:roadmapId`
- Milestones: `GET /:roadmapId/milestones`, `POST /:roadmapId/milestones`, `PATCH /milestones/:milestoneId`, `DELETE /milestones/:milestoneId`, `POST /:roadmapId/milestones/reorder`
- Features: `GET /milestones/:milestoneId/features`, `POST /milestones/:milestoneId/features`, `PATCH /features/:featureId`, `DELETE /features/:featureId`, `POST /milestones/:milestoneId/features/reorder`, `POST /features/:featureId/move`
- Export/Handoff: `GET /:roadmapId/export`, `GET /:roadmapId/handoff`, `GET /:roadmapId/handoff/mission`, `GET /:roadmapId/milestones/:milestoneId/features/:featureId/handoff/task`
- Canonical roadmap REST namespace is plugin-scoped (`/api/plugins/fusion-plugin-roadmap/...`), while dashboard maintains a temporary `/api/roadmaps` compatibility mount that delegates to plugin-owned handlers during migration.

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
- **Reviewer**: `reviewStep()` (`reviewer.ts`) performs plan/code/spec reviews
- **Merger**: `aiMergeTask()` (`merger.ts`) merges approved work

#### Reviewer verdict recovery contract (FN-4092)
- Reviewer verdicts are `APPROVE`, `REVISE`, `RETHINK`, or `UNAVAILABLE`.
- For non-pause `UNAVAILABLE` or non-context reviewer prompt errors, `reviewStep()` retries once:
  - Prefer configured validator fallback model (`validatorFallbackProvider` + `validatorFallbackModelId`, including project overrides), or
  - Retry once on the same model with stricter `Verdict:` output instructions when no fallback model is configured.
- Pause/engine-pause short-circuits still return `UNAVAILABLE` immediately and do not spawn/retry reviewer sessions.
- Executor handling in `createReviewStepTool()` is now explicit:
  - `plan`/`spec` `UNAVAILABLE` is advisory after retry exhaustion (`UNAVAILABLE (advisory)`), and execution proceeds.
  - `code` `UNAVAILABLE` remains blocking; step completion must wait for a usable review verdict.
  - Advisory and blocking paths are both logged to task logs for operator visibility.

### Scheduling and execution
- `Scheduler` (`scheduler.ts`) — dependency-aware task scheduling that dispatches eligible todo tasks by priority first, then dependency-unblock fanout within the same priority class (FN-4969), then FIFO (`createdAt` ascending) with task-id fallback. `urgent` always stays ahead of lower priorities, and overlap/file-scope blockers are excluded from fanout weighting.
  - `blockedBy` invariant (FN-3924/FN-4091): the field is only durable when it references a current unresolved explicit dependency (or, for dependency-free tasks, an active overlap blocker). Completion gating now validates `blockedBy` through live task resolution: missing blockers and blockers already in `done`/`archived` are treated as stale, while only still-active blockers continue to prevent `fn_task_done`. If no current blocker remains, scheduler/event reconciliation clears `blockedBy` to `null` and re-evaluates from live task state.
  - Dependency-cycle invariant (FN-5256): task dependency graphs are acyclic at write time (`DependencyCycleError` in `TaskStore` for `createTask`, `createTaskWithReservedId`, `updateTask`, and `applyReplicatedTaskCreate`) with `task:dependency-cycle-rejected` audit evidence. Self-healing batch 2 adds `reconcileDependencyCycles`, which emits `task:dependency-cycle-detected`, auto-repairs only bounded umbrella-back-edge loops via `task:auto-reconciled-dependency-cycle`, and leaves ambiguous cycles untouched with `task:dependency-cycle-unrepaired` for operator inspection.

#### BlockedBy stamping invariants
- Scheduler writes overlap-based `blockedBy` only when overlap gating is active and there is a live overlapping active scope; otherwise overlap logic does not stamp blockers.
- Active overlap scopes exclude permanently-failed `in-review` tasks (`status === "failed"`, typically produced by `checkStuckBudget()` after `stuckKillCount > maxStuckKills`) so superseding re-implementation tasks are not indefinitely queued behind work that will never merge. (FN-4200)
- Stamping is sticky when valid (FN-3899): if a todo task is already `queued` behind a blocker that is still active and still overlaps, the scheduler preserves that blocker and skips rewrites.
- When the blocker must change, selection is deterministic: active overlap candidates are ordered by task ID and the first overlapping task is chosen, removing tick-order churn.
- Writes are idempotent: scheduler updates `status/blockedBy` only when values change, reducing per-tick churn and audit noise.
- Self-healing remains responsible for terminal/missing blocker cleanup (`clearStaleBlockedBy()`), while scheduler overlap stamping now focuses on stable active-overlap attribution.
- `StepSessionExecutor` (`step-session-executor.ts`) — per-step sessions + parallel wave execution
- `createTaskUpdateTool()` (`executor.ts`) emits a diagnostic warning when an agent marks step N `in-progress` while another step on the same task is already `in-progress`; the update still proceeds so operators get evidence without changing task semantics.
- `TaskCompletion` (`task-completion.ts`) — completion gate helpers
- `SpecStaleness` (`spec-staleness.ts`) — stale spec detection utilities
- `MissionExecutionLoop` (`mission-execution-loop.ts`) — validator/fix loop orchestration
- `MissionFeatureSync` (`mission-feature-sync.ts`) — feature↔task status synchronization
- `MissionAutopilot` (`mission-autopilot.ts`) — mission slice auto-progression

### Routine + cron automation
- `RoutineRunner` (`routine-runner.ts`) — executes routine steps
- `RoutineScheduler` (`routine-scheduler.ts`) — schedules due routines
- `CronRunner` (`cron-runner.ts`) — cron-based AI/script jobs

### Sandbox backend seam (FN-4636)
- Engine user-configured command runners now route through `packages/engine/src/sandbox/` via a shared `SandboxBackend` abstraction (`resolveSandboxBackend()`), currently implemented only by the transparent `NativeSandboxBackend` passthrough (no behavior change).
- The seam now covers both exec-shaped commands (`run`) and spawn-shaped verification commands (`runStreaming`), with `packages/engine/src/verification-utils.ts` delegating `runVerificationCommand`/`execWithProcessGroup` through `runStreaming`.
- Follow-up chain: FN-4637 (bubblewrap), FN-4638 (sandbox-exec), FN-4639 (settings selection), FN-4640 (run-audit telemetry), FN-4641 (action-gate), FN-4642 (container backends).
- FN-4641 adds dedicated `sandbox_provisioning` approval-gate plumbing for first-time backend bootstrap. Backends call `requireSandboxProvisioningApproval()` (`packages/engine/src/sandbox/provisioning-gate.ts`) from `prepare()` when prerequisites are missing, and policy is resolved via `resolveSandboxProvisioningPolicy()` (`packages/core/src/sandbox-provisioning-policy.ts`). Initial callers land in FN-4637/FN-4638/FN-4642.
- FN-4642 adds an experimental `ContainerSandboxBackend` (Podman-first, Docker-compatible) plus `buildContainerArgv()` for rootless container runs. It is opt-in only via explicit `resolveSandboxBackend({ backendId: "podman" | "docker" })` and is not wired through settings yet; known prototype limits are no SELinux `:Z` relabel on bind mounts, no filesystem policy beyond cwd bind-mounting, and a fixed default image (`docker.io/library/alpine:3.20`) with override via `FUSION_SANDBOX_CONTAINER_IMAGE`.

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
  - Batch 1 maintenance now includes one `fts-maintenance` step for both search indexes. The live `tasks_fts` branch still runs `merge` every tick, `optimize` every 4th tick, and `rebuild` above `32 MiB` or `1 MiB × live task count`. The archive `archived_tasks_fts` branch is lighter because archive writes are mostly append-only: `merge` every 8th tick, `optimize` every 24th tick, and `rebuild` above `64 MiB` or `512 KiB × archived row count`. Each branch is independently guarded by `fts5Available` and emits `task:fts-maintenance` run-audit telemetry with distinct `target` values (`tasks_fts` vs `archived_tasks_fts`).
  - `recoverGhostReviewTasks()` is a fallback only for idle, non-terminal `in-review` states. Terminal/actionable states (notably `status: "failed"`) are preserved and **not** auto-kicked back to `todo`.
  - Mission validation has a dedicated stale-run reaper: startup recovery and Batch 2 maintenance call `reapStaleMissionValidatorRuns()` when wired by the runtime, using `VALIDATOR_RUN_STALE_MAX_AGE_MS` (currently 6 hours). The sweep terminates ownerless `mission_validator_runs.status='running'` rows as `error`, writes the reap reason into `summary`, leaves `lastValidatorRunId` pointing at the now-terminal run, and emits run-audit telemetry with `mutationType: "mission:validator-run-reaped"` plus `runId`/`featureId`/`missionId`/`triggerType`/`elapsedMs` metadata. Active mission features move to `loopState="needs_fix"` + `lastValidatorStatus="error"` unless their parent mission is already `complete`/`archived`.

#### Stuck-loop exhaustion terminal contract
When stuck-kill retries are exhausted, `checkStuckBudget()` marks the task `status: "failed"`, moves it to `in-review`, and writes an error that starts with `STUCK_LOOP_EXHAUSTED:`. The error and final task-log line both include the kill count/max and last stuck reason (`loop` or `inactivity`). `StuckTaskDetector` also untracks the task and refuses to re-track it while that failed terminal error remains, preventing further automatic kill/requeue churn. The final log line explicitly states that no further automatic retries will run and directs operators to manually retry, pause, or move the task back to triage to resume work.
  - `recoverMissingWorktreeReviewFailures()` is a narrow failed-review recovery: only `status: "failed"` `in-review` tasks with the explicit session-start signature `Refusing to start coding agent in missing worktree:` (from `assertValidWorktreeSession()`) are requeued. Recovery clears stale session metadata (`worktree`, `branch`, `sessionFile`, transient failure state), preserves valid step progress/retry counters, logs the auto-recovery reason, and moves the task back to `todo` for a clean retry.
  - `recoverMergeableReviewTasks()` only re-enqueues truly eligible tasks; retry-exhausted review tasks are skipped to avoid re-enqueue/no-op loops that keep refreshing `updatedAt`.
  - `recoverAlreadyMergedReviewTasks()` auto-finalizes retry-exhausted `in-review` tasks when self-healing can prove their work already landed on the merge target. On this landed-content path it clears soft blockers (`paused`, stale `status: "failed"`, and residual `error`) before moving to `done`; true hard blockers (for example incomplete steps, awaiting-user-review, or failed pre-merge workflow steps) still park the task in stable `in-review/failed` state with a blocker error instead of entering an auto-finalize loop.
  - `reconcileTaskWorktreeMetadata()` (FN-4962) reconciles stale `task.worktree`/`task.branch` rows against authoritative `git worktree list --porcelain` branch mappings during startup recovery, periodic maintenance, and completion fan-out. The stage must run before `reclaim-stale-active-branches`: stale rows rebound to live `fusion/<id>` worktrees emit `task:auto-recover-worktree-metadata-rebound`; stale rows with no live branch mapping are nulled (`worktree=null`, `branch=null`, `baseCommitSha` unchanged) and emit `task:auto-recover-worktree-metadata-cleared`.
  - `recoverInProgressLimbo()` (FN-5219) is the safety net for stranded executor rows: reset/requeue paths must never leave a task in `in-progress` without a runnable execution context. After metadata reconcile, stale `in-progress` tasks with null branch, missing/cleared worktree metadata, no live executor claim, and all-pending steps are audited and moved back to `todo`.

##### Orphan-only scope-violation auto-recovery
`recoverOrphanOnlyScopeViolations()` handles the narrow FN-4350 shape without weakening the file-scope invariant: it runs only when all of these predicates hold — task is `column === "in-review"`; task is failed (`status === "failed"`, with engine/global pause both off); error evidence is a FileScopeViolation (`tool_error` agent-log payload from `formatFileScopeViolationAgentLog`, with `task.error` prefix fallback); `task.scopeOverride !== true`; task is not actively executing and `mergeDetails.mergeConfirmed !== true`. It then verifies the task's specific work is already on `main` using `findAlreadyMergedTaskCommit` (Fusion-Task-Id trailer / ancestry / patch-id / tree-equality proof). Only when staged files are orphan-only (no declared-scope overlap after excluding `.changeset/*`) and main-branch proof is positive does it finalize as a no-op (`resolutionStrategy: "orphan-discard-no-op"`), append an explicit auto-recovery log line, and tear down the task worktree so orphan staging is discarded.

Guardrails: this routine does **not** retry merges, does **not** apply to mixed/non-orphan staging, and does **not** run when no landed-work proof exists (FN-4280 class protection).
  - FN-4285 decision: add a follow-up for a tree-equality recovery strategy (`rev-parse <base>^{tree}` == `<task-branch>^{tree}`) in `findAlreadyMergedTaskCommit`. This closes stranded already-merged branches that evade trailer/ancestry/patch-id matching, with guardrails limited to retry-exhausted review tasks to avoid false positives during transient post-rebase parity windows.
  - No-`fn_task_done` recovery classification is normalized across executor, restart recovery, and self-healing: detection keys on executor-emitted `"without calling fn_task_done"` strings (while still tolerating legacy `task_done` wording), then applies the bounded ladder deterministically (in-session retries → bounded todo requeues with preserved progress when appropriate → terminal surfaced failure when budget is exhausted).
  - `clearStaleBlockedBy()` clears `blockedBy` (and transient `status`) on todo tasks when their blocker is missing, done, archived, paused in-review, or failed in-review with merge retries exhausted. FN-3924 extends this with a dependency-integrity guard: if a task has explicit dependencies and `blockedBy` is not one of the currently unresolved deps, the stale marker is cleared. FN-4091 broadens the sweep to active `in-progress` and un-paused `in-review` tasks as well, but those repairs only null `blockedBy` (they do not rewrite scheduler-owned queued state). FN-5488 adds two fast paths: (1) failed in-review blockers at/above `MAX_AUTO_MERGE_RETRIES` always fan out unblock recovery with explicit reason codes, and (2) `status="merging"|"merging-pr"` blockers with no active merger owner are treated as unbacked after a short grace window (`unbackedMergingFanoutGraceMs`, default 60s) so manual retry/unpause `updatedAt` refreshes cannot deadlock downstream todos indefinitely. Recovery logs now use `Auto-recovered (FN-5488): ... reason=<code>` for auditability while preserving FN-4538 overlap-blocking invariants.
  - FN-5624 suppresses transient worktree-local `.fusion/tasks/<id>/task.json` ENOENT session-start failures. When the missing file path is under `task.worktree`, executor routes through unusable-worktree auto-recovery, skips persisting `status: "failed"`/`error` on the task row, and emits `[transient-task-json-suppressed] ... reason=missing-task-json-under-worktree`. The corresponding self-healing `Auto-recovered:` log entry keeps notification suppression aligned with the existing `/^Auto-recovered:/` grace-window rule.
  - `inspectBranchConflict()` now treats self-owned zero-attribution collisions as reclaimable (instead of foreign) when ownership is proven by task/worktree identity, so stranded self-branches do not enter unrecoverable loops.
  - `reclaimSelfOwnedBranchConflicts()` includes paused `branch-conflict-unrecoverable` tasks (not just todo/in-progress), clearing paused/error state in one update and requeueing only when parked in `in-review`.
  - Together, `recoverAlreadyMergedReviewTasks()`, `clearStaleBlockedBy()`, and paused-aware in-review scheduling prevent merge-deadlock loops by finalizing already-landed work, clearing stale dependency blockers, reclaiming self-owned conflicts, and avoiding paused review cards re-blocking overlap dispatch.
  - Merge commit attribution is ownership-aware: a `mergeDetails.commitSha` is trusted only when reachable from `HEAD` **and** attributable to the task via `Fusion-Task-Id` trailer or task-ID-bearing subject. Reachable-but-unowned SHAs are rejected to prevent sibling done tasks from sharing misleading merge metadata.
  - FN-4948 adds a task-worktree pre-commit branch-identity guard: provisioning paths (`NativeWorktreeBackend.create`, executor branch creation, and `StepSessionExecutor.createStepWorktree`) install a `pre-commit` hook plus `fusion-task-id` metadata under the worktree's git-path. Commits are refused unless HEAD matches `fusion/<task-id>` or the allowlist (`fusion/step-<n>-<slug>` by default).
  - FN-5089 adds an optional task-worktree `commit-msg` hook (default enabled via `commitMsgHookEnabled`) installed by the same provisioning path; when enabled it appends the configured task attribution trailer (defaults to `Fusion-Task-Id: <task-id>`) without duplicating existing trailers. Attribution remains branch/subject resilient when the hook is disabled.
  - FN-4948 extends contamination auto-recovery with an `obviously-misrouted` bucket: foreign-attributed commits are auto-dropped only when attribution resolves to another task and every changed path is inside `.changeset/fn-<foreign-id>-*.md`. Any shared/non-namespaced path stays in the unique bucket and escalates to human adjudication. The single-attempt contamination invariant is unchanged.
- `ProjectEngine` settings lifecycle handlers (`project-engine.ts`) treat `enginePaused` as a soft pause: clearing it dispatches runtime resume and, when `autoMerge` is enabled, performs an `in-review` eligibility sweep to requeue mergeable review tasks.
- `UsageLimitPauser` (`usage-limit-detector.ts`) and `withRateLimitRetry` (`rate-limit-retry.ts`)

### Worktree and naming helpers
- `WorktreePool` (`worktree-pool.ts`) — idle worktree reuse
- `WorktreeBackend` (`worktree-backend.ts`) — abstraction for worktree operations used by `acquireTaskWorktree`. `native` (default) preserves existing `git worktree` behavior (including sibling-branch retry semantics), while `resolveWorktreeBackend(settings)` selects [worktrunk](https://github.com/max-sixty/worktrunk) when `settings.worktrunk?.enabled === true`.
  - Worktrunk path delegates five decisions with per-op timeouts: `create` (120s), `sync` (180s), `prune` (60s), `remove` (60s), and layout resolution (5s).
  - Direct worktrunk CLI delegates: `create` → `wt switch --create ... --no-hooks --no-cd`, `remove` → `wt remove --foreground`.
  - Fusion probes the canonical `wt` binary on `$PATH`; explicit `worktrunk.binaryPath` overrides still win when operators pin a different location.
  - Worktrunk-aware fallback implementations where worktrunk lacks a dedicated primitive: `sync` uses git fetch+rebase semantics, and `prune` uses `git worktree list --porcelain` plus per-branch `remove` calls.
  - Layout precedence: when `worktrunk.enabled=true`, `resolveTaskWorktreePathForBackend(...)` defers to backend `resolveWorktreePath(...)` (using `wt config show --format json` template data with default `{{ repo_path }}/.worktrees/{{ branch | sanitize }}` fallback); otherwise it remains byte-identical to FN-4606 `resolveTaskWorktreePath(...)` behavior.
  - Auto-install remains fail-closed while the pinned release manifest is `upstream-pending-verification`: the pre-approved install path now rejects missing asset URLs/checksums instead of fabricating a local binary. This preserves the FN-4704/FN-4705 disabled-install contract until a human verifies a real upstream release manifest.
  - FN-5321 generalized this contract into `packages/engine/src/external-integrations/manifest.ts` (`validateExternalIntegrationManifest`) plus `KNOWN_EXTERNAL_INTEGRATIONS`; `packages/engine/src/__tests__/external-integrations-registry.test.ts` enforces that every registered integration manifest validates, avoids duplicate-segment GitHub hallucinations, and carries canonical binary/upstream metadata.
  - `worktrunk.onFailure` controls fail-hard vs fallback-native create behavior and emits `worktree:worktrunk-*` run-audit events for create/fallback paths.
- `WorktreeNames` (`worktree-names.ts`) — deterministic worktree/branch naming

### Observability and reflection
- `AgentLogger` (`agent-logger.ts`) — structured per-agent run logging
- `RunAudit` (`run-audit.ts`) — mutation audit tracking (DB/git/filesystem)
  - FN-4956: Layer 3 merge-conflict arbitration now scope-partitions conflicted files before AI resolution. Out-of-scope conflicts are deterministically resolved to the integration branch (`git checkout --ours`) and unstaged, while only in-scope conflicts flow to AI. Integration branch defaults are resolved via `resolveIntegrationBranch(rootDir, settings)`. Audit events: `merge:layer3:foreign-file-skipped` and `merge:layer3:scope-override-bypass`.
  - FN-5655 goal anchoring observability adds `database`-domain mutation types `goal:injection-applied`, `goal:injection-skipped`, and `goal:retrieval-invoked` so Slice 2 cite-rate tracking has a prompt-independent signal. Metadata uses counts/IDs only (`count`, `lane`, `toolName`, optional `truncated`/`reason`/`notFound`) and never stores prompt bodies or goal titles/descriptions. These events surface through `GET /api/agents/:id/runs/:runId/audit` and support the existing `startTime`/`endTime` filters.

#### Key diagnostic points (log subsystem tags)
- `[self-healing]` — startup/maintenance recovery pass outcomes.
- `[worktree-metadata-reconcile]` — FN-4962 stale `task.worktree`/`task.branch` rebind-or-clear decisions and audit emission failures.
- `[scheduler]`, `[executor]`, `[merger]` — core execution/dispatch/merge lanes.
- `[insight-sweeper]` — startup/periodic/drive-by stale insight-run recovery outcomes and fail-soft sweep errors.
- `Notifier` (`notifier.ts`) — legacy ntfy compatibility shim (`NtfyNotifier`) plus shared ntfy helpers
  - Runtime ownership: `NtfyNotifier` no longer owns an independent task-lifecycle listener graph; `ProjectEngine` injects the canonical `NotificationService` instance so task lifecycle notifications (`task:created`, `task:moved`, `task:updated`, `task:merged`) are emitted through a single path.
  - Merge dedup safety: all merge-success → done code paths (direct merger completion, owned/no-op auto-finalize, mergeConfirmed fast-path, PR-strategy finalize, and merge-success self-healing finalizers) emit `store.emit("task:merged", result)` with a merged `MergeResult`. `NotificationService.notifiedEvents` remains the single dedup source of truth, so duplicate upstream emits still produce exactly one canonical `merged` ntfy lifecycle notification per task.
  - Compatibility scope: `NtfyNotifier` remains responsible for gridlock-only compatibility notifications (`notifyGridlock`) and legacy helper APIs.
  - Legacy gridlock ntfy delivery is cooldown-throttled: first detection notifies immediately, subsequent detections are suppressed for 15 minutes (even if blocked-task membership changes), and the cooldown resets as soon as gridlock fully clears.
- `NotificationService` (`notification/notification-service.ts`) — provider lifecycle + event dispatch orchestration
  - Subscribes to task lifecycle events plus mailbox and memory events. `task:created` dispatches `task-created` only when `task.sourceAgentId` is present (agent-created tasks, including fn task-create calls made by agents). `message:sent` dispatches `message:agent-to-user` and `message:agent-to-agent` notification events (with message metadata for deep-links), and manual `POST /api/memory/dream` processing emits `store.emit("memory:dreams-processed", payload)` when new DREAMS content is written.
  - `failed` task notifications are deferred behind a grace window (default 60s) and suppressed when recovery signals arrive (`column=done`, `mergeDetails.mergeConfirmed=true`, or status clear with an `Auto-recovered:` log). Persistent failures still emit exactly once after the window.
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
- `MeshLeaseManager` (`mesh-lease-manager.ts`) — canonical abandoned-lease detection + recovery path

### Outage ownership boundaries (degraded reads + queued write replay)
- `CentralCore` owns durable outage state in central persistence (`meshSharedSnapshots` + `meshWriteQueue`) and exposes stable assertion methods: `recordMeshSnapshot`, `getLatestMeshSnapshot`, `enqueueMeshWrite`, `listPendingMeshWrites`, `markMeshWriteReplayStarted`, `markMeshWriteApplied`, `markMeshWriteFailed`, and `getMeshDegradedReadState`.
- `PeerExchangeService` owns retryability classification for sync/apply failures, queue insertion for retryable failures, replay execution (`replayPendingWritesForNode(targetNodeId)`), and observable sync results (`queuedWriteId`, `replaySummary`) for partition/replay assertions.
- `NodeHealthMonitor` provides liveness transitions as replay hints only via deterministic recovery callback `onNodeRecovered(nodeId, previousStatus)`; `online` is a trigger to attempt replay, not proof that replay succeeded.
- Dashboard mesh routes (`register-mesh-routes.ts`) preserve `GET /api/mesh/state` array shape and attach per-node degraded `readState` metadata so stale fallback data is explicit during partitions.

### Mesh task lease ownership and recovery

Task ownership is persisted in shared task metadata so all nodes agree on one canonical lease view. The persisted lease fields are:

- `checkedOutBy` — owning agent id (compatibility field)
- `checkedOutAt` — lease acquisition timestamp (compatibility field)
- `checkoutNodeId` — owning node id
- `checkoutRunId` — active owning heartbeat/executor run id when known
- `checkoutLeaseRenewedAt` — last successful lease renewal timestamp
- `checkoutLeaseEpoch` — monotonic fencing generation used to reject stale owners after recovery

`AgentStore.checkoutTask()` remains the compatibility entrypoint for ownership claims, but lease replacement is fenced by epoch semantics: only the same live owner can renew idempotently, and stale owner replacement is performed only through the recovery path.

`MeshLeaseManager.recoverAbandonedLease(taskId, reason, context)` is the single canonical abandoned-work path used by scheduler/self-healing/runtime orchestration. Recovery validates staleness, bumps `checkoutLeaseEpoch`, clears active-owner fields, logs the reason, and re-queues work for scheduler visibility.

A lease is recoverable only when there is **no active local executor session for that task** and either:

1. the owning node is `offline` or `error`, or
2. the owner heartbeat/run age exceeds `max(agentHeartbeatTimeoutMs * 2, 120_000)` measured against the most recent lease renewal timestamp.
- Canonical replication/write-coordination contract: [`docs/shared-mesh-protocol.md`](./shared-mesh-protocol.md)
  - Defines protocol versioning, write classes, quorum/ack semantics, lease epochs/fencing, offline queue/replay, reconciliation outcomes, restart recovery hooks, and degraded-read staleness metadata.
  - Existing `/api/mesh/sync` and settings-sync payloads remain the active exchange primitives while follow-on runtime tasks implement full v1 coordinator/quorum behavior.
- Distributed task-ID allocation (`packages/core/src/distributed-task-id.ts`) is the first mesh-aware coordinated write primitive.
  - Durable state lives in SQLite tables `distributed_task_id_state` (prefix sequence + authoritative committed count) and `distributed_task_id_reservations` (reservation lifecycle rows).
  - Reserve/commit/abort execute under a process-local lock and a single SQLite transaction. Lazy reservation expiry cleanup runs inside those same transactions.
  - Default reservation TTL is `15 * 60 * 1000` ms (15 minutes). Expired/aborted reservations are **burned IDs** and are never reissued.
  - `committedClusterTaskCount` from allocator state is the only authoritative cluster-wide committed-task count. Local task-row counts and ID suffix math are not authoritative.
  - Store open reconciles every known prefix in `distributed_task_id_state` to `max(current nextSequence, max(tasks suffix)+1, max(archivedTasks suffix)+1, max(reservation sequence)+1)`. This self-heals stale counters before ordinary task creation resumes.
  - Mesh allocator write routes (`/api/mesh/task-ids/reserve|commit|abort`) return `503` when the coordinator node is unreachable; they never fall back to local-only cluster ID issuance.
- Cluster task creation now uses a strong-write reserve → create → replicate → commit/abort sequence.
  - Ordinary local task creation (`TaskStore.createTask()`, duplicate, and refine flows) now allocates IDs through the same distributed reserve/commit/abort lifecycle owned by `TaskStore`.
  - `POST /api/tasks` uses the store-owned allocator path for local creates rather than maintaining a separate route-local allocator implementation.
  - `POST /api/tasks` reserves a distributed ID, creates the authoritative local task with that reserved ID, then POSTs authenticated replication payloads to peer nodes.
  - All create-class writes now use conflict-raising inserts, not SQLite `ON CONFLICT ... DO UPDATE`. Existing task rows and `.fusion/tasks/{id}` contents always win over stale counters or colliding reservations.
  - Local create paths perform a final active+archived existence check immediately before insert. If a reserved `FN-*` still collides, the reservation is aborted/burned and the create fails loudly instead of rewriting the existing task.
  - Creation self-heals stale overlap state at the route layer: if a reserved `FN-*` collides with an existing task (`Task ID already exists...` or replicated-create collision), the route aborts that reservation, cleans up partial local state, reserves the next ID, and retries up to a bounded limit.
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
- Plugin-defined roadmap routes under `plugin-routes.ts` dispatch (`/api/plugins/fusion-plugin-roadmap/...`)
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

### Headless Node Mode (`fn serve` / `fn daemon`)
- Headless runtimes auto-register the current working directory as a project when it is missing from central registry metadata, then continue normal engine startup.
- First-run auto-bootstrap logs one line: `[serve] Auto-registered project "<name>" at <cwd>` (or `[daemon] ...`).
- Primary engine binding order is: `--project <id|name>` → central `defaultProjectId` → cwd project (if registered/started) → first started engine in registry iteration order.
- This enables startup from arbitrary launch directories (systemd, Docker, parent directories, symlinked paths) without requiring cwd to be a registered project.
- `--no-auto-register` still disables cwd registration, but startup only exits when zero engines start across the registry.

### Real-time channels
- **SSE**: `/api/events` (`sse.ts`)
  - Emits `task:*`, mission events, AI session updates, automation schedule events (`schedule:created`, `schedule:updated`, `schedule:deleted`, `schedule:run`), and research run lifecycle events (`research:run:created`, `research:run:updated`, `research:run:completed`, `research:run:failed`, `research:run:cancelled`) when available
  - Project-scoped: resolves project context from query param or engine manager
  - Canonical maintainer contract (ownership/lifecycle/scoping/pitfalls and shared-vs-dedicated stream boundaries): [`docs/dashboard-realtime.md`](./dashboard-realtime.md)
- **Chat streaming**: `/api/chat/sessions/:id/messages` (`routes.ts` + `chat.ts`)
  - Streams assistant responses as SSE events for chat sessions
  - `done` events include the authoritative persisted assistant message snapshot (`message`) so clients can render final output even when incremental `text` deltas are absent
  - `error` events now allow either the legacy string payload or a structured failure payload matching persisted `metadata.failureInfo`; direct-chat clients normalize both shapes and render failures inline in the thread
- **Chat session queries**: `/api/chat/sessions` (`routes.ts`)
  - Existing list behavior is unchanged (`status=active|archived|all` returns an array)
  - Quick Chat resume uses targeted lookup params: `agentId`, optional `modelProvider` + `modelId`, plus `resume=1`
  - Validation requires `modelProvider` and `modelId` together; partial model pairs return `400`
  - Targeted lookup returns only the newest matching active session (or `null`) to avoid scanning every active session client-side
- **Chat Room API**: `/api/chat/rooms*` (`register-chat-room-routes.ts`)
  - `GET /api/chat/rooms` → `200 { rooms }`; query supports `projectId`, `status`, and `agentId`
  - `POST /api/chat/rooms` → `201 { room, members }`; validates `name`, returns `409` on slug collisions
  - `GET/PATCH/DELETE /api/chat/rooms/:id` → room read/update/delete (`404` for unknown room)
  - `GET/POST/DELETE /api/chat/rooms/:id/members[/:agentId]` → member list/add/remove (`400` for invalid body, `404` for unknown room/member)
  - `GET /api/chat/rooms/:id/messages` + `POST /api/chat/rooms/:id/messages` + `DELETE /api/chat/rooms/:id/messages` + `DELETE /api/chat/rooms/:id/messages/:messageId`
    - Room message POST persists the user room message (`201 { message }`), rejects non-null `senderAgentId` for user submissions, then triggers server-side room responder execution that persists assistant room replies via `chatStore.addRoomMessage(...)`
  - `POST /api/chat/rooms/:id/attachments` uploads a room-scoped attachment file and returns `{ attachment }` metadata (`400` invalid mime/size, `404` missing room)
  - `GET /api/chat/rooms/:id/attachments/:filename` streams uploaded room attachments with path-traversal protection
  - `POST /api/chat/rooms/:id/messages/:messageId/attachments` records attachment metadata on an existing room message
  - Error contract follows existing API patterns: `400` validation failures, `404` missing resources, `409` duplicate-slug conflicts, `503` when chat store is unavailable
  - SSE fan-out on `/api/events` now includes: `chat:room:created`, `chat:room:updated`, `chat:room:deleted`, `chat:room:member:added`, `chat:room:member:removed`, `chat:room:message:added`, `chat:room:message:updated`, `chat:room:message:deleted`
  - **Room test coverage (planned):** FN-3812 tracks the contract-first test matrix for room creation/switching, persisted history, mention routing, and hybrid responder behavior. See `.fusion/tasks/FN-3812/test-plan.md` plus scaffold files: `packages/core/src/__tests__/chat-store.rooms.test.ts`, `packages/dashboard/src/__tests__/chat.rooms.test.ts`, `packages/dashboard/src/__tests__/chat-routes.rooms.test.ts`, and `packages/dashboard/app/components/__tests__/ChatView.rooms.test.tsx`.
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

#### Refinement task routing

- `fn_task_refine` creates child tasks in `column: "triage"` with `sourceType: "task_refine"` and a dependency on the source task. Refinements are never routed directly to `todo`.
- Refinements still require normal triage specification (PROMPT.md with valid `File Scope`) before execution routing.
- To prevent starvation under large same-priority planning backlogs (FN-4647 pattern), triage polling now prefers `task_refine` rows over non-refinement rows as an ordering tiebreaker within the same priority band.
- **Starved refinement self-healing sweep (Lane B):** `SelfHealingManager.recoverStarvedRefinementTriageTasks()` runs in startup + maintenance sweeps and targets `sourceType: "task_refine"` tasks still in `triage` (`status` `null|planning`) that are unpaused, not actively planning, older than `STARVED_REFINEMENT_RECOVERY_GRACE_MS` (10m), and have observed peer board progress (`STARVED_PEER_PROGRESS_THRESHOLD=3` non-refinement tasks advanced to `todo` after the refinement was created). Remediation is a bounded one-step priority nudge (no direct move-to-`todo`) with cooldown idempotency (`STARVED_REFINEMENT_ESCALATION_COOLDOWN_MS = grace*4`) and run-audit emission `task:auto-recover-starved-refinement` including `{ taskId, ageMs, peerProgressCount, escalation }` metadata.
- Approval semantics are unchanged: with `requirePlanApproval=true`, refinements stop at `status: "awaiting-approval"`; otherwise they move to `todo` after spec finalization.
- Regression coverage lives in `packages/engine/src/__tests__/triage-refinement-routing.test.ts` and locks four guarantees: bounded promotion under backlog pressure, approval-gate preservation, PROMPT-before-`todo` invariant, and unchanged baseline ordering for non-refinement-only triage sets.
- Task detail surface is shared through `TaskDetailContent` (exported from `TaskDetailModal.tsx`): desktop/tablet `ListView` renders it inline in the split right pane, while mobile and non-list entry points continue using `TaskDetailModal`.
- In desktop split mode, `ListView` now uses a compact sidebar-first control layout (count/actions/summary chips + collapsible "View options" panel) to keep list controls dense alongside the inline detail pane; mobile keeps the card-first flow with a toolbar "View options" entry point for the same visibility/filter toggles.
- Chat system UI: `ChatView.tsx`, `QuickChatFAB.tsx`
- Planning/insight UI: `MissionManager.tsx`, `TodoView.tsx`, `InsightsView.tsx`, `DocumentsView.tsx` (roadmap view is plugin-owned)
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
- `AgentsView`, `TodoView`, `NodesView`, `ChatView`, `MemoryView`, `ResearchView`
- `DevServerView`, `InsightsView`, `DocumentsView`, `SkillsView`
- `SetupWizardModal`, `PluginManager`, `PiExtensionsManager`, `AgentDetailView

A `prefetchLazyViews()` function runs once on mount via `requestIdleCallback` to warm chunks. Do not make these views eager — bundle size is carefully managed.

### Key hooks
- Task + realtime: `useTasks.ts`, `useBadgeWebSocket.ts`, `useAiSessionSync.ts`
- Chat: `useChat.ts`, `useQuickChat.ts`
- Documents/insights/memory: `useDocuments.ts`, `useInsights.ts`, `useMemoryBackendStatus.ts`, `useMemoryData.ts`
- Plugin roadmap state/hooks: owned by `plugins/fusion-plugin-roadmap/src/dashboard/*`
- Dev server: `useDevServer.ts` (status hydration, command controls, reconnect stream handling, project-scope reset)
- Project/agents/setup: `useProjects.ts`, `useCurrentProject.ts`, `useAgents.ts`, `useSetupReadiness.ts`
- UX/platform helpers: `useFavorites.ts`, `useAuthOnboarding.ts`, `useDeepLink.ts`, `useTerminal.ts`

### Planning and decomposition features
- Backend planners: `planning.ts`, `subtask-breakdown.ts` (roadmap suggestion generation is plugin-owned)
- UI modals: `PlanningModeModal.tsx`, `SubtaskBreakdownModal.tsx`, milestone interview flows
- Multi-task creation endpoints are wired under planning/subtask routes in `routes.ts`

### Health and monitoring endpoints
- **Health check**: `GET /api/health`
  - Returns liveness status for load balancers and monitoring
  - Response: `{ status: "ok" | "degraded", version: string, uptime: number, database: { healthy: boolean, corruptionDetected: boolean, corruptionErrors: string[], isRunning: boolean, lastCheckedAt: string | null }, taskIdIntegrity: { status: "ok" | "anomaly", checkedAt: string | null, anomalies: [...], recommendedAction: string | null } }`
  - Startup does not block on full `PRAGMA integrity_check(100)`; Fusion schedules it in the background shortly after boot.
  - Background integrity checks are deduplicated process-wide per on-disk SQLite path: multiple `Database` instances sharing the same `fusion.db` join one shared run, and each instance still updates the underlying integrity state (`integrityCheckPending`, `integrityCheckLastRunAt`, `corruptionDetected`, `integrityCheckErrors`) that maps to `database.isRunning`, `database.lastCheckedAt`, `database.healthy`, `database.corruptionDetected`, and `database.corruptionErrors`.
  - Self-healing watches `store.getDatabaseHealth()` during maintenance. Each fresh corruption detection emits a `task:auto-db-corruption-detected` run-audit database event and attempts a `db-corruption-detected` notification through the active notification service (or the ntfy fallback) with a one-hour cooldown between repeats until the health state clears.
  - `POST /api/health/refresh` recomputes the task-ID integrity section on demand and returns the same top-level shape, including the current database corruption fields.
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
| GET | `/api/nodes/:id/settings/sync-status` | Get sync status and diff summary (includes `actionableDenialReason` when remote probe fails). |
| POST | `/api/nodes/:id/auth/sync` | Sync model auth snapshots (push/pull, checksum/version validated). |
| POST | `/api/nodes/:id/secrets/push` | Push local secrets snapshot to a remote node. |
| POST | `/api/nodes/:id/secrets/pull` | Pull secrets snapshot from a remote node. |
| POST | `/api/settings/sync-receive` | Receive pushed settings (inbound). |
| POST | `/api/settings/auth-receive` | Receive `AuthMaterialSnapshot` and persist via auth storage. |
| POST | `/api/secrets/sync-receive` | Receive pushed secrets payload (inbound). |
| GET | `/api/secrets/sync-export` | Export local secrets sync envelope for remote pull flows. |
| GET | `/api/settings/auth-export` | Export local `AuthMaterialSnapshot`. |
| GET | `/api/update-check` | Read cached/TTL-guarded npm update status for `@runfusion/fusion` (respects `updateCheckEnabled`). |
| POST | `/api/update-check/refresh` | Clear cached update data and force a fresh npm update check. |
| GET | `/api/updates/check` | Perform an on-demand npm registry check for the latest `@runfusion/fusion` version (no cache). |

When adding a new node settings/auth sync endpoint, add it to the `ENDPOINTS` catalog in `packages/dashboard/src/__tests__/routes-nodes-sync-contract.test.ts` so the auth/error/payload parity matrix covers it. Inbound sync endpoints (including `/api/secrets/sync-receive` and `/api/secrets/sync-export`) must validate `Authorization: Bearer <apiKey>` against the local node API key.

### Agent stats endpoint

| Method | Path | Description |
|---|---|---|
| GET | `/api/agents/stats` | Aggregate agent/task stats used by operator summaries and capacity-risk signaling. Returns `activeCount`, `assignedTaskCount`, `completedRuns`, `failedRuns`, `successRate`, plus `idleNonEphemeralCount` (idle agents excluding ephemeral/runtime workers via `isEphemeralAgent`) and `todoTaskCount` (tasks currently in Todo). |

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
The run-audit system records every mutation performed by the engine across four domains:
- **Database** — task:create, task:update, task:move, etc. Node handoff/recovery emits structured events: `node:handoff:parked` (handoff denied/parked), `node:handoff:reassign-local` (local takeover approved), `node:handoff:reassign-any` (any-healthy takeover approved), and `node:lease:recovered` (abandoned lease cleared and task requeued). Scheduler dispatch contention also emits `scheduler:dispatch-queued-concurrency` with transition-only cadence: emit once when a task first hits a stable limiter signature (`bindingGates`), suppress while unchanged, clear the memo when the task leaves that queued-concurrency state, and emit again only after the limiter signature changes or reappears. Metadata includes `bindingGates` (`maxConcurrent`/`maxWorktrees`/`semaphore`), per-gate `{ used, limit, slack }`, `holders`, and computed `available`.
- **Git** — worktree:create, commit:create, merge:resolve, merge:audit-failure, `worktree:reanchored`, and worktrunk lifecycle events (`worktree:worktrunk-install|create|sync|prune|remove`, plus `worktree:worktrunk-fallback`, `worktree:worktrunk-failure`, and `worktree:worktrunk-fallback-native`). Worktrunk events share metadata `{ op, binaryPath?, worktreePath?, durationMs?, exitCode?, stderrPreview?, installSource?, prunedCount? }` with `installSource` (`"release-binary" | "cargo"`) limited to successful `worktree:worktrunk-install` events and `prunedCount` limited to successful prune events when known. `worktree:worktrunk-install` is emitted only for true install actions; cache hits, configured `worktrunk.binaryPath` overrides, and `$PATH` resolutions intentionally remain silent. Dirty post-merge audit outcomes emit `merge:audit-failure` with metadata `{ mode, strategy, action, reason, issueCount, duplicateSubjectCount, touchedFileOverlapCount, verificationPassed, auditTargetLabel }`. FN-5279 adds `merge:reuse-handoff-acquired`, `merge:reuse-handoff-refused`, `merge:reuse-handoff-released`, and `merge:reuse-handoff-deferred-to-worktrunk` for task-worktree auto-merge handoff visibility. FN-5351 adds `merge:integration-worktree-state` (pre-handoff checkout/dirty snapshot for resolved integration branch), `merge:cwd-integration-fallback-refused` (terminal refusal park event), and `merge:integration-ref-advance` (integration ref advance outcome telemetry).
- **Git / `merge:file-scope-violation`** — emitted by the merger when `FileScopeViolationError` aborts a squash. `target` is the task ID; metadata includes `stagedFiles`, `declaredScope`, `resetLabel`, `stagedFileCount`, and `declaredScopeCount`. Consumed by `fileScopeInvariantFailuresPerDay` in `GET /api/health/reliability` (FN-4360).
- **Git / `merge:no-op-attribution-mismatch`** — emitted by the rebase landed-files attribution guard (FN-5304) when `<rebaseBaseSha>..HEAD` has zero attributable own commits but the source `fusion/<id>` tip still carries attributable own commits. `target` is the task ID; metadata includes `recordedSha`, `rebaseMergeBaseSha`, `sourceBranchRef`, `sourceBranchOwnCommitCount`, and `sourceBranchOwnCommitShas`.
- **Git / `merge:no-op-attribution-mismatch-skipped`** — emitted when the FN-5304 source-tip guard cannot run because the source branch ref is unavailable (for example already pruned). `target` is the task ID; metadata includes `reason` (`"source-ref-unavailable"`).
- **Database / `task:auto-recover-misrouted-foreign-commit`** — emitted per dropped misrouted commit during FN-4948 contamination recovery. `target` is the recovering task; metadata carries `{ droppedSha, foreignTaskId, paths }`.
- **Database / `task:orphan-detected-no-action`** — emitted by `recoverOrphanedExecutions` (FN-5337) when row metadata looks orphaned after grace windows; annotation-only event with no lifecycle mutation (`in-progress` task stays put).
- **Database / `task:soft-delete-column-reconciled`** — emitted by `reconcileSoftDeletedColumnDrift` (FN-5566, re-land FN-5446) when a soft-deleted row (`deletedAt IS NOT NULL`) is found with legacy `column != 'archived'`; rewrites only `column` (no resurrection), with metadata `{ previousColumn }`.
- **Database / `session:runtime-resolved`** — emitted once per `createResolvedAgentSession` call with metadata `{ sessionPurpose, runtimeId, wasConfigured, provider, modelId, mockProviderActive, testModeActive, runtimeHint? }` for per-lane runtime/provider attribution.
- **Database / `task:*-no-action` backward-move family (FN-5335)** — backward self-healing sweeps now emit annotation-only events when triple proof fails instead of mutating lifecycle state. New mutation types: `task:reclaim-pr-conflict-no-action`, `task:reclaim-self-owned-branch-conflict-no-action`, `task:auto-rebound-scope-decay-no-action`, `task:finalize-no-op-review-no-action`, `task:stale-incomplete-review-no-action`, `task:ghost-review-no-action`, `task:stuck-merge-deadlock-no-action`, `task:no-progress-no-task-done-no-action`, `task:missing-worktree-review-no-action`, `task:partial-progress-no-task-done-no-action`. See `docs/self-healing-backward-move-audit.md` for per-stage disposition.
- **Filesystem** — file:write, prompt:write, attachment:create, etc.
- **Sandbox** — backend lifecycle events from `SandboxBackend` wiring in executor/merger/routine-runner (`sandbox:prepare`, `sandbox:run`, `sandbox:failure`, `sandbox:fallback`) introduced after FN-4636.

Events are tied to specific run IDs for end-to-end traceability.

For scheduler concurrency diagnostics, the queued reason now names the active limiter(s) and usage (for example `gate=maxConcurrent ...`). Read `metadata.bindingGates` first to identify the limiter. `holders.maxConcurrent` and `holders.maxWorktrees` are current `in-progress` task IDs; `holders.semaphore` mirrors that set but semaphore slots can also be consumed by triage/merge agents outside `in-progress`. So if `semaphore.used` exceeds the visible holder list, that usually indicates non-execution agents are legitimately consuming shared capacity (not stale accounting). These events are transition-only: a newly emitted line/event indicates the limiter signature changed or the condition cleared and later reappeared, not that a poll loop simply observed the same blocked state again.

**Run audit endpoints:**
- `GET /api/agents/:id/runs/:runId/audit` — Returns audit trail for a specific agent run
  - Query params: `?domain=database|git|filesystem|sandbox` for filtering
  - Requires agent ownership or admin access
- `GET /api/health/reliability` — Aggregates rolling reliability metrics from run-audit and task activity signals.
  - Query params: `?windowDays=<1..30>` (default `7`)
  - Response shape: `{ windowDays, generatedAt, headline, perDay, duration, mergeAttempts }` where missing instrumentation/samples surface as `null` with a `reason` field.

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

### User cancel via move-to-todo
- `TaskStore.moveTask()` accepts `moveSource: "user" | "engine"` (default `"engine"`) and emits `task:moved` with `source` so listeners can distinguish manual moves from engine rebounds.
- Manual `in-progress → todo` moves (dashboard route `/tasks/:id/move` with `moveSource: "user"`) atomically set `task.userPaused = true`; engine/default rebounds do not.
- Any move to `in-progress` clears `task.userPaused` in the same store write so explicit redispatch resumes normally.
- `TaskExecutor` treats manual `in-progress → todo` as hard cancel: it marks the task as user-canceled, aborts active session types before dispose/termination, and suppresses preserve-resume auto-bounces while logging `Execution canceled by user — leaving task in todo`.
- Scheduler dispatch loop skips `todo` tasks with `userPaused === true` (queues with a user-paused reason) until a user explicitly moves the task back to `in-progress`.

---

### Stalled review detection

`@fusion/core` computes a heuristic `task.stalledReview` signal during task hydration (both slim board listings and full/detail reads in `TaskStore`) by scanning recent task log activity.

Current heuristics (see `packages/core/src/stalled-review-detector.ts`):
- **Reenqueue churn** (`heuristic: "reenqueue-churn"`): at least `STALLED_REVIEW_REENQUEUE_THRESHOLD` (`3`) matches of `STALLED_REVIEW_REENQUEUE_PATTERN` within `STALLED_REVIEW_WINDOW_MS` (`60 minutes`).
- **Invalid-transition loop** (`heuristic: "invalid-transition-loop"`): at least `STALLED_REVIEW_INVALID_TRANSITION_THRESHOLD` (`2`) matches of `STALLED_REVIEW_INVALID_TRANSITION_PATTERN` in log `action`/`outcome` within the same window.

Detection is visibility-only: no scheduler/self-healing actions are triggered by this field. The dashboard `TaskCard` renders a `Stalled` badge for `in-review` tasks when `task.stalledReview` is present, with the heuristic reason in the tooltip.

Tune sensitivity by adjusting the exported constants in `stalled-review-detector.ts`. Increase thresholds to reduce noise; decrease thresholds only with incident evidence, because lower values can over-flag transient recovery bursts.

---

### Workflow-defined columns & traits (`experimentalFeatures.workflowColumns`)

*Behind the `workflowColumns` flag (accessor: `packages/core/src/workflow-columns-settings.ts`). With the flag off the legacy pipeline above is authoritative and untouched. The flag default-flips only when the graduation report (below) shows zero drift — a field decision, not yet taken.*

**Engine as substrate, workflows as policy.** The flag inverts the architecture: the engine becomes a **capability substrate** (worktree/git/session mechanics, persistence, crash recovery, audit, machine resource ceilings — non-configurable) and **workflows carry the operating logic** as composable column traits. The mechanism/policy line (KTD-4):

- **Substrate (engine-owned, never workflow-configurable):** `AgentSemaphore`, checkout leases, worktree/git/session ops, SQLite + WAL, the crash-recovery machinery, the audit trail, the global max-sessions cap, and the three non-configurable lost-work merge guards (no sibling `fusion/fn-*` target, line-anchored attribution, no `modifiedFiles` clear on a no-op finalize).
- **Policy (workflow/trait-owned):** transition validity, WIP/capacity, hold/release, drag meaning, retries, merge strategy, squash posture, file-scope enforcement mode.

**Transition authority.** `moveTaskInternal` remains the single transition authority. Flag-on, it swaps the `VALID_TRANSITIONS` lookup for workflow-resolved column-graph validation (`resolveAllowedColumns`/`workflowHasColumn` in `workflow-transitions.ts`) plus sync trait guards run in-lock; rejections are typed `TransitionRejection`s. `VALID_TRANSITIONS` and the closed `Column`/`COLUMNS` helpers in `types.ts` are `@deprecated` while the flag exists — retained as the flag-off authority and the parity oracle, not yet removed.

**Trait model.** A trait is declarative flags + optional lifecycle hooks (`guard`, `gate`, `onEnter`, `onExit`, `releaseCondition`), resolved through one registry (`trait-registry.ts`, built-ins in `builtin-traits.ts`). Sync `guard` and the `complete`/`archived` flags are built-in-only; plugin traits (KTD-7) get async hook points only and route through the prompt-session/script machinery. Composition conflicts are rejected at save both in the editor and server-side (`assertColumnTraitsValid` in `createWorkflowDefinition`/`updateWorkflowDefinition`, surfaced as a 400). Capacity is enforced in-txn (KTD-10), never bypassable — not a guard. Enter/exit effects run post-commit, idempotent, guarded by the `transitionPending` marker; a throwing/missing plugin hook degrades (audit) and never strands the card or wedges the lock.

**Graduation.** The flag default-flip is gated by `computeWorkflowColumnsGraduationReport()` (`workflow-parity.ts`; store method `TaskStore.computeWorkflowColumnsGraduationReport`), aggregating: five-invariant dual-observe parity, default-workflow transition parity vs `VALID_TRANSITIONS` (`checkTransitionParity`), and the U6 dual-accept marker/column disagreement count. `ready` is true only when all gates pass over a non-empty observation window. The report is the gate; it does not flip the flag.

### Step inversion: steps as workflow-modelable nodes (`experimentalFeatures.workflowGraphExecutor`)

The columns/traits track moved *board* policy (transitions, capacity, hold, merge orchestration) onto the substrate/policy line. The **step-inversion** track extends the same inversion to *task steps* and to the *task shape itself*, riding the existing `workflowGraphExecutor` flag (orthogonal to `workflowColumns`). With the flag off — and for the default coding workflow always — step policy stays exactly as it is today (the monolithic `execute` seam, PROMPT.md `### Step N:` parsing, in-session `fn_review_step` verdicts, RETHINK git-reset/session-rewind). The default workflow is the byte-identical parity oracle; inversion is opt-in via custom workflows and a built-in stepwise coding workflow.

**One new substrate seam pair.** The substrate gains exactly one new capability, expressed as two methods: `runTaskStep(task, stepIndex)` (run exactly one step inside the task's session and observe its `complete Step N` commit) and `resetStepToBaseline(task, stepIndex, baselineSha, checkpointId?)` (the RETHINK mechanics — git reset + session rewind + `updateStep(...,"pending")`). Both delegate to existing code (extracted from `StepSessionExecutor` and the legacy RETHINK block); neither reimplements step physics or authors commits. The substrate owns *how* a step runs and resets; the graph owns *when*. Baseline/checkpoint state, previously fragile in-memory Maps lost on restart, moves into persisted instance run-state (`workflow_run_step_instances`, schema v108).

**Everything else becomes authored graph structure (policy).** Step granularity, per-step plan/code review, the verdict→action mapping, rework/escalation routing, parallelism, and even the existence of PROMPT.md stop being engine law:

- A `parse-steps` node reads a workflow-declared **artifact** (PROMPT.md is just the default workflow's declared `step-source` artifact) and runs a registry **parser** (`step-headings`, `json-steps`, or a plugin-contributed parser) to write `Task.steps[]`. It is the only graph-side step-list writer and must dominate any `foreach`. Parsers fail closed to a routable `outcome:parse-error`.
- A `foreach(source:"task-steps")` node instantiates an inline template subgraph once per planned step, with `mode` (sequential/parallel) and `isolation` (shared/worktree) as explicit axes and per-instance run-state pinned + persisted for crash-safe resume.
- A `step-review` node surfaces reviewer verdicts (APPROVE/REVISE/RETHINK/UNAVAILABLE) as outcome edges; `rework` edges (the only legal graph cycles, bounded per instance) route REVISE/RETHINK back to `step-execute`, with RETHINK traversal triggering the reset seam.
- A `code` node runs sandboxed TypeScript (esbuild + child process, clamped timeout, no store handle) for arbitrary computed routing/field logic — the same trust tier as project-local script steps.

**`Task.steps[]` stays the physical projection sink.** Instance lifecycle transitions write *through* `store.updateStep` with explicit indices (projection-first ordering closes the merge-blocker race), so every existing consumer — the merge-blocker, dashboard/TUI step display, `reconcileStepsFromGitHistory`, lost-work reset — keeps working unchanged. Git reconcile remains authoritative over the instance rows (rows are corrected to match git, never the reverse).

**Task shape recast.** The task model reduces to core fields (title, description) + standard metadata + **workflow-defined custom fields** (typed, enum options, render hints; values in `tasks.customFields`, validated through one store authority with typed rejections). Field-schema edits orphan rather than destroy values. This round ships the field *system*; recasting existing built-in fields (priority, labels) onto it is a deferred, additive follow-up.

**Invariant bar.** The five lifecycle invariants (FN-5147 terminal-until-merged, hard-cancel, in-review stall, file-scope, squash) plus the lost-work guard trio remain the non-configurable correctness bar on the stepwise path. The v108 migration is additive; instance rows are prunable; flag-off rollback mid-task converges via the existing fell-back + git-reconcile recovery (the projection is always git-reconcilable).

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

`InProcessRuntime.stop()` now performs a two-layer executor shutdown: it first aborts detached bash subprocess trees (`abortAllSessionBash()`), then immediately aborts/disposes in-flight AI task sessions (`abortAllInFlight("engine stop")`) before entering the drain wait. The post-abort drain window is intentionally short by default (`runtimeStopDrainMs`, default `2000` ms) and can be set to `0` to skip drain polling in test/CI paths.

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

### Task commit-association API (`GET /api/tasks/:id/commit-associations`)

Dashboard session-diff route registration (`packages/dashboard/src/routes/register-session-diff-routes.ts`) now exposes lineage commit associations for task detail views:

- **Route:** `GET /api/tasks/:id/commit-associations`
- **Project scoping:** uses `getProjectContext(req)` so reads are project-aware like adjacent task diff endpoints.
- **404 behavior:** returns `{ error: "Task not found" }` for unknown task ids.
- **Response contract:**

```json
{
  "taskId": "FN-1234",
  "lineageId": "uuid-or-null",
  "associations": [
    {
      "commitSha": "abc123...",
      "commitSubject": "feat(FN-1234): ...",
      "authoredAt": "2026-05-11T02:00:00.000Z",
      "matchedBy": "canonical-lineage-trailer | legacy-task-id-trailer | legacy-subject | manual-reconciliation",
      "confidence": "canonical | legacy | ambiguous",
      "taskIdSnapshot": "FN-1234",
      "note": "optional reconciliation note"
    }
  ]
}
```

`confidence` is a consumer-facing interpretation aid:
- `canonical` = immutable lineage trailer match (highest confidence)
- `legacy` = recovered via legacy task-id/subject matching
- `ambiguous` = manual reconciliation where historical task-id attribution could be misleading

### Done-task files-changed sources of truth

Done-task file-count surfaces intentionally distinguish three data sources:

1. **`/api/tasks/:id/diff` (lineage union, authoritative landed diff)**
   - This route aggregates the task's landed lineage and returns `stats.filesChanged` plus the file list used by the Changes tab.
   - Done-task cards and diff views should treat this as the canonical "files changed" source.
2. **`task.mergeDetails.filesChanged` / `insertions` / `deletions` (final-commit shortstat)**
   - These fields describe only the recorded final merge/squash commit shortstat.
   - On done cards, `mergeDetails.filesChanged` is only a transient loading placeholder until `/api/tasks/:id/diff` resolves.
3. **`task.mergeDetails.landedFiles` (recorded committed file list)**
   - When live diff stats are unavailable, done-task cards may fall back to the recorded landed file list length.
   - This remains committed-diff metadata; transient executor worktree captures are not surfaced as a done-card files chip.
4. **`task.modifiedFiles` (execution-time worktree snapshot)**
   - Captured in the executor worktree during implementation (`git diff <base>..HEAD` snapshot), before final merge outcomes are known.
   - Can include transient/superset paths that did not land; done-task cards must not use it for the files-changed chip.

**FN-4647 decision:** `mergeDetails` shortstat fields remain commit-level metadata. No additional persisted lineage-level summary field is introduced at this time; done-task landed totals continue to be served live via `/api/tasks/:id/diff`.

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

### Stranded refinement affordance (Lane C)

Fusion adds an operator-first API surface to diagnose and expedite refinement tasks that remain in Planning (`triage`) without bypassing plan/approval gates from FN-4657.

| Method | Path | Description |
|---|---|---|
| GET | `/api/tasks/stranded-refinements` | List stranded refinement diagnostics (`sourceType=task_refine`, `column=triage`, `paused!=true`) with reasons and recommendation. Supports `?freshnessMinutes=` (1-1440). |
| GET | `/api/tasks/:id/stranded-refinement` | Return one refinement diagnostic row plus PROMPT.md presence and dependency-resolution status. |
| POST | `/api/tasks/:id/expedite-refinement` | Request bounded expedite for a triage refinement. Clears `nextRecoveryAt` for stale/backoff rows; returns `requiresOperatorAction` for `awaiting-approval`/`failed`/`stuck-killed` without mutating status. |

Stranded reasons are: `untriaged-stale`, `awaiting-approval`, `failed`, `stuck-killed`, and `recovery-backoff`.

Non-bypass guarantees:
- Expedite never moves a task directly to `todo`.
- Expedite never fabricates/writes `PROMPT.md`.
- Expedite never clears `awaiting-approval` (or failed/stuck statuses).
- `POST /api/tasks/:id/approve-plan` remains the only route that clears `awaiting-approval` and promotes approved plans.

This complements FN-4657's durable triage routing fix; it does not replace triage specification or plan-approval policy.

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

### GitHub tracking lifecycle (task creation + existing-task edits)

Fusion attempts GitHub issue creation when per-task tracking is explicitly enabled (`task.githubTracking.enabled === true`) and the task is currently unlinked. This runs via a **universal post-create hook** registered at process startup by dashboard/CLI entrypoints (including engine startup paths) — so it fires for every task-creation path: HTTP routes, pi extension tools (`fn_task_create`, `fn_task_import_github*`, `fn_delegate_task`), CLI commands (`fn task add`, `fn task duplicate`, `fn task refine`), mission/feature triage, automation `create-task` steps, agent-driven delegation, and routine/cron-created tasks. The hook is best-effort and failures are swallowed with a warning, so task creation is never blocked by GitHub availability. The existing inline `maybeCreateTrackingIssue` calls in route handlers remain as redundant safety nets and are idempotent (`issue_already_linked`).

When Fusion does create a tracking issue, it formats the title as `[FN-XXXX] Task title` and sends a short plain-text body prefixed with `Fusion task: FN-XXXX`. The body is a bounded summary snippet (not full task prompt content), and Fusion does not include any hyperlink back to the local dashboard. Manual unlink requests (`githubTracking.issue: null`) do not recreate an issue in that same PATCH request, and disable updates do not create issues. Auth resolution remains strict-mode (`token` vs `gh-cli`) but now defensively accepts merged settings shapes where auth keys may appear in global-merged payloads.

When a tracked task later moves to `in-progress` or `done`, Fusion posts one short lifecycle comment on the linked tracking issue. These comments always include the Fusion task ID as plain text (`Fusion task: FN-XXXX`) and never link back to the Fusion app. The `in-progress` comment stays plain-text; the `done` comment can additionally include GitHub commit/PR markdown links plus branch, file-change, and merge-timestamp details when that merge context is available on the task. No comment is posted for any other transition.

When a tracked task transitions into `done`, Fusion closes the linked GitHub issue with `state_reason: completed`. When a task transitions out of `done` into any active column (`triage`, `todo`, `in-progress`, `in-review`), Fusion reopens it with `state_reason: reopened`. When a tracked task is permanently deleted, Fusion closes the linked GitHub issue with `state_reason: not_planned` (or deletes it when explicitly requested). Delete-path outcomes emit a `github-issue:action` store event payload (`{ taskId, action, owner, repo, number, outcome, error? }`) so success/failure remains observable even after the task row is gone and task activity logs are unwritable. Moves from `done` to `archived` leave the issue closed. Tasks without `githubTracking.enabled` or without a linked issue are unaffected, and GitHub failures are logged to task activity without blocking the move.

The GitHub tracking state listener now attaches to every registered project store (including projects registered after startup), and each store gets a one-time asynchronous startup reconciliation sweep. That sweep scans bounded done tasks with tracking enabled and closes any linked GitHub issue still open, so missed/momentary failures are caught up without blocking server boot. Source-imported GitHub issues can also be auto-closed when `githubCloseSourceIssueOnDone === true`: `GitHubSourceIssueCloseService` listens for `task:moved` transitions into `done` and closes open `task.sourceIssue` links, while `GitHubTrackingReconciler.reconcileSourceIssues` performs a parallel startup sweep over done tasks with GitHub source metadata to close any source issues still open.

### Worktree model
- Each active task runs in isolated worktree under `.worktrees/*`
- Executor creates branches like `fusion/{task-id}` (`executor.ts`)
- `WorktreePool` can recycle idle worktrees when enabled

#### WorktreeBackend abstraction
- Backend contract: `WorktreeBackend` (`packages/engine/src/worktree-backend.ts`, re-exported via `packages/engine/src/worktree-pool.ts`).
- Implementations: `NativeWorktreeBackend` (Fusion-managed `git worktree` flow) and `WorktrunkWorktreeBackend` (delegates to the external `wt` CLI from [max-sixty/worktrunk](https://github.com/max-sixty/worktrunk)).
- Backend selection is driven by `worktrunk.enabled`; when enabled, worktrunk-managed layout overrides `worktreesDir` for delegated operations.
- Worktrunk layout is authoritative on create: after `wt switch --create`, Fusion resolves the actual registered worktree path via `git worktree list --porcelain` and uses that path (instead of assuming `resolveTaskWorktreePath` alignment).
- Delegated operation surface in the interface: `create`, `sync`, `prune`, `remove` (plus backend path resolution via `resolveWorktreePath`).
- Executor acquisition paths (`worktree-acquisition.ts`) resolve backend selection centrally, so create flow stays backend-agnostic above the pool/acquisition layer.
- Worktree removal is backend-mediated across merger, self-healing, worktree-pool, executor, and step-session cleanup paths via `removeWorktree(...)` (`WorktreeBackend.remove()`).
- Self-healing is worktrunk-aware for failure recovery: tasks paused with `pausedReason: "worktrunk_operation_failed"` are explicitly skipped in reclaim sweeps (`self-healing.ts`) until operator intervention.
- Failure contract: delegated worktrunk errors preserve stderr context (`WorktrunkOperationError`) and are handled by `worktrunk.onFailure` — `"fail"` pauses the task, while `"fallback-native"` retries on the native backend and emits one-shot fallback telemetry.
- Install contract: Fusion only auto-installs from a source-of-truth manifest. The shipped placeholder manifest intentionally stays in `upstream-pending-verification` until a human verifies upstream asset URLs and checksums, so install attempts fail closed rather than guessing release metadata.

#### Stale `index.lock` recovery on worktree create
- Native worktree create paths now classify `git worktree add` failures containing `.../index.lock: File exists` before falling back to generic branch-conflict handling.
- Classifier gates are deterministic: the lock must exist, be older than the stale threshold (default 30s), not be owned by a live `activeSessionRegistry` session, and resolve to a normalized lock/worktree path.
- If classified `stale`, Fusion removes the lock and retries create exactly once.
- If staleness cannot be proven, lock removal is refused and the flow raises `StaleWorktreeIndexLockError` so task failure messaging can escalate with manual remediation guidance.
- Run-audit events emitted by the create path: `worktree:stale-lock-detected`, `worktree:stale-lock-recovered`, `worktree:stale-lock-recovery-failed`, `worktree:stale-lock-refused`, `worktree:stale-registration-detected`, `worktree:stale-registration-recovered`, `worktree:stale-registration-recovery-failed`.

#### Branch-conflict inspection and auto-reclaim
- `inspectBranchConflict` classifies branch collisions as `stale`, `stale-resolved`, `reclaimable`, or `live-foreign`.
- Dispatch preflight (`acquireTaskWorktree`/executor) now auto-reclaims `reclaimable` self-owned conflicts and emits `branch:auto-reclaim` run-audit events with task/branch/worktree/tip/stranded-commit metadata.
- Self-healing also runs `reclaimSelfOwnedBranchConflicts()` across idle `todo` + `in-progress` tasks; successful reclaim keeps stranded commits intact and failed reclaim escalates to `in-review`/`failed` with `branch-conflict-unrecoverable`.
- Cross-task collisions (`live-foreign`) remain manual by design; operators resolve conflicting branches/worktrees with standard git tooling, then retry the task.

### Merge strategies
- Setting type: `MergeStrategy = "direct" | "pull-request"` (`types.ts`)
- `aiMergeTask()` in `merger.ts` performs merge flow
- FN-5782 wires branch-group routing into merge target resolution: tasks with `branchContext.assignmentMode === "shared"` and a resolvable `branch_groups` row merge onto `branch_groups.branchName` (`mergeTarget.source = "branch-group-integration"`) instead of the project default branch; ungrouped and `per-task-derived` tasks keep the existing direct-to-default path unchanged. Merge emits `merge:branch-group-routed` audit telemetry for routed members. FN-5846 extends the same contract to deterministic/self-healing finalize paths (`recoverAlreadyMergedReviewTasks`, interrupted/deadlock/misbound finalizers, and the `mergeConfirmed` fast path): a resolvable shared member is re-routed to the group branch before reachability checks, `mergeTargetSource`/`mergeTargetBranch` are stamped by the finalizer, `recordBranchGroupMemberLanded` is called, and a defensive audit event is emitted if a path would otherwise evaluate the member against the project default branch. FN-5788 adds a callable promotion-decision hook (`evaluateBranchGroupPromotion`) and `merge:branch-group-promotion-gated` telemetry; FN-5830 lands the completion gate + promotion machinery via `evaluateBranchGroupCompletion` and idempotent `promoteBranchGroup` (single shared→default merge/PR with finalized status and PR tracking persistence).
- FN-5279 adds `mergeIntegrationWorktree` for auto-merge only. Default `reuse-task-worktree` hands merger ownership from executor to the merger inside the task worktree after five gates (clean tree, expected branch, no live executor session, canonical branch/worktree binding, lease handoff). Refusals emit `merge:reuse-handoff-refused`, leave the task in `in-review`, and do **not** silently fall back to project-root merge mode. `cwd-integration-branch` is the explicit opt-in project-root path; `cwd-main` is a deprecated alias normalized to `cwd-integration-branch`. Integration-branch defaults across merger and self-healing flows are resolved dynamically via `resolveIntegrationBranch(rootDir, settings)` (`integrationBranch` → `baseBranch` → `origin/HEAD` → `main`). When `worktrunk.enabled=true`, worktrunk-managed merge/worktree behavior still wins and the handoff path emits a defer event instead of taking over. FN-5363 tightens this path: `acquireMergeQueueLease({ targetTaskId })` is strict (no queue-head fallback), merge queue rows are enqueue/lease-gated to `in-review` tasks, and stale non-review rows are auto-cleaned (including on `in-review` column exit when leases are absent or expired). FN-5353 extends the same contract: merger self-enqueues the target before strict target leasing, null target leases are surfaced as `merge:reuse-handoff-refused` with `reason: "target-not-queued"`, `acquireReuseHandoff` hard-refuses `reason: "worktree-equals-project-root"`, and `resolveMergeIntegrationRoot` returns a missing-worktree sentinel (`rootDir: ""`) so reacquire executes before any reuse gate can misroute against project root. FN-5351 adds a production verification trail for integration-branch invariants: `merge:integration-worktree-state`, `merge:cwd-integration-fallback-refused`, and `merge:integration-ref-advance`.
- `merger.ts` also exposes a test-only `__test__` helper object for internal merger unit/integration coverage (for example autostash orphan cleanup behavior)
- Supports workflow-step execution after merge (post-merge phase)
- Deterministic verification now runs a bootstrap preamble (`node scripts/ensure-test-artifacts.mjs`) before configured `testCommand`/`buildCommand`, then self-heals Vite `Failed to resolve entry for package "@fusion/..."` workspace-entry faults by rebuilding the missing package once and retrying the failed command. If that retry still reports the same missing-entry fault, merger raises a typed environment fault and `ProjectEngine` leaves the task in-review (no verificationFailureCount increment or in-progress bounce) so the next recovery sweep can retry after other runs rebuild artifacts.
- FN-4232/FN-4605 extends that bootstrap to cover stale dist consumers comprehensively: `@fusion/{core,dashboard,engine,plugin-sdk}` and `@fusion-plugin-examples/{dependency-graph,hermes-runtime,openclaw-runtime,paperclip-runtime}` are checked for missing/stale artifacts (staleness compares newest `src/` mtime against the oldest required `dist/` artifact mtime for configured packages). Package-level `pretest` hooks in `@fusion/dashboard` and `@fusion-plugin-examples/dependency-graph` invoke the same bootstrap for filtered test runs.
- When stale or missing artifacts are found, the preamble logs `[test-bootstrap] rebuilding workspace dist artifacts (missing or stale): ...`; if rebuild fails, remediation now prints exact artifact-path diagnostics (`[test-bootstrap] missing: ...` / `[test-bootstrap] stale (src newer than dist): ...`) plus the FN-4232/FN-4605 reference and recovery commands.

#### Finalize integrity gate
- Finalize-to-done now runs an ownership classifier with three outcomes: `owned-commit` (task trailer/subject commit proven landed on merge target), `proven-no-op` (zero-ahead branch plus start point reachable from target), and `unproven` (missing ownership evidence, including foreign start-point inheritance).
- `owned-commit` and `proven-no-op` can finalize. `proven-no-op` explicitly reconciles metadata by clearing stale `task.modifiedFiles` and stamping `mergeDetails.noOpMerge=true` with `landedFiles: []`.
- `unproven` no longer silently completes as done; merger/self-healing emit `task:finalize-unproven-blocked` audit events and auto-retry by requeuing to `todo` for a fresh execution pass.
- Historical cleanup is additive: `reconcileDoneTaskIntegrity()` scans done tasks missing `mergeDetails.commitSha` but still carrying `modifiedFiles`, then either recovers owned commit metadata, clears no-op stale files, or emits `task:integrity-warning` without regressing done tasks back to review. `task:integrity-warning` is transition-only on the persisted warning reason: first warning emits once, repeated sweeps with the same `mergeDetails.integrityWarning.reason` stay silent, and a new warning reason emits again.
- This integrity gate complements FN-4646 landed-file capture (metadata truth source) and FN-4647 dashboard labeling (UI presentation); gate enforcement is in merger/self-healing, while display semantics remain UI-owned.

#### Autostash lifecycle
- Before destructive merge prep, `stashUnrelatedRootDirChanges()` snapshots dirty root-dir edits into `fusion-merger-autostash:<taskId>:<ts>` (plus optional `race-rescue-*` stashes for late writes).
- During verification-fix finalize fallback, `commitOrAmendMergeWithFixes()` now snapshots any still-dirty root-dir state into `fusion-merger-autostash:<taskId>:finalize-reset:<ts>` *before* its hard reset/clean recovery path, preventing silent mixed-worktree leftovers from being discarded.
- In `aiMergeTask` cleanup, `restoreUnrelatedRootDirChanges()` attempts restore; then `dropAutostashHandle()` runs on every terminal path and drops primary + race-rescue stashes when restoration succeeded or content is no longer live.
- If restore fails with unresolved developer work (`failed`/`conflict-needs-manual`), cleanup uses a keep-if-live rule so still-live stashes are preserved for manual recovery.
- `sweepAutostashOrphans()` keeps its subsumed/live classification for prior-run leftovers, and `sweepStaleAutostashes()` adds an age-based backstop that drops `fusion-merger-autostash:*` entries older than the configured threshold (default 24h).

#### Stash Recovery surface
- Orphans are typically residual `fusion-merger-autostash:*` entries from older merge runs where restore could not safely complete.
- Existing task-scoped surfacing remains: merger warnings still log to `mergerLog.warn` and `store.logEntry` for the active merge task.
- New global surfacing adds `merger:autostashOrphans` TaskStore events, engine helpers (`listAutostashOrphans`, `getAutostashDiff`, `applyAutostashBySha`, `dropAutostashBySha`), and dashboard API endpoints under `/api/stash-recovery/*`.
- `merger:autostashOrphans` records now include provenance fields (`sourcePhase`, `detectedByTaskId`, `detectedAt`) so operators can attribute leftovers to the merge phase and surfacing task/session.
- `ProjectEngine` consumes the orphan event stream and auto-creates deduplicated `sourceType: "recovery"` follow-up tasks for live leftovers, so repeated detections do not spam the board.
- Dashboard operators can inspect orphan counts, review diffs, apply stashes, and explicitly drop entries with confirmation.
- Decision: recovery stays user-gated. Auto-apply was rejected because clean-tree checks are racy, stash placement is ambiguous after source task merge, and apply conflicts can produce hard-to-untangle state. `sweepAutostashOrphans` continues to auto-drop only subsumed entries while preserving live developer work.

#### Automated follow-up dedup (FN-5232)
- Engine-side automated follow-up creation now routes through `packages/engine/src/verification-followup-dedup.ts` instead of calling `TaskStore.createTask()` directly from recovery/eval/PR-comment paths.
- Verification-style follow-ups stamp `sourceMetadata.verificationFailureSignature`, a deterministic SHA-256 digest over `{ lane, sorted failing test basenames }` (or `lane|no-files` when no files can be parsed). Open matches reuse the existing task and append at most one `[verification recurrence]` log entry per hour; closed/done/archived matches within 24 hours create a fresh task with `sourceMetadata.supersedesTaskId` pointing at the prior task.
- Non-verification automated follow-ups can supply `extraMatchKeys` (for example eval `suggestionId` or PR `prNumber`) so dedup stays deterministic even when no test-file signature exists.
- This layer composes with FN-4892 same-agent intake dedup in `@fusion/core`: engine dedup prevents repeated automated recovery spam up front, while store-side same-agent dedup still archives newly-created near-duplicates when `sourceAgentId` is present.
- Run-audit emits `verification:followup-created` and `verification:followup-deduped` database events with hashed signature metadata only; no raw stdout/stderr or secret material is persisted in the audit payload.

### Conflict handling
`merger.ts` includes conflict classification and auto-resolution helpers:
- lock files (`LOCKFILE_PATTERNS`)
- generated files (`GENERATED_PATTERNS`)
- whitespace-trivial conflicts

### PR and badge integration
- Engine PR monitor: `pr-monitor.ts` and `pr-comment-handler.ts`
- Dashboard GitHub APIs + webhook route in `routes.ts`
- Badge snapshots are streamed via `/api/ws` and `useBadgeWebSocket.ts`

#### PR checks API
- Tasks now support multiple linked PRs via `Task.prInfos` (canonical list). `Task.prInfo` remains as a back-compat primary mirror and should be treated as `prInfos[0]` when present.
- `GET /api/tasks/:id/pr/checks` returns live PR check data for the task PR:
  - `checks: PrCheckStatus[]` (required and non-required checks)
  - `rollup: "success" | "pending" | "failure" | "unknown"` derived from **required checks only** (merge-readiness semantics)
  - `lastCheckedAt: string` timestamp for the fetch
- Route behavior matches PR refresh safeguards:
  - `404` when the task has no associated PR
  - `429` when `githubRateLimiter` denies the repo request window, including `retryAfter`/`resetAt` details

#### PR review ingestion and auto-transition
- `POST /api/tasks/:id/pr/refresh` and background `refreshPrInBackground()` refresh every linked PR (`prInfos`) in bounded batches, return a primary entry plus `all` entries, then sync review data into task comments with idempotency on `(source, externalId)`.
- Synced comment sources are `github-review` and `github-review-comment`; refinement auto-creation is skipped for these external comments.
- `GET /api/tasks/:id/pr/reviews` returns the live GitHub review snapshot plus the Fusion-threaded stored review comments for the task.
- `POST /api/tasks/:id/pr/:number/unlink` removes only the task↔PR link (does not close the PR) and returns the updated `prInfos` list.
- When review decision transitions to `CHANGES_REQUESTED` while the task is in `in-review`, Fusion auto-moves the task back to `todo` with `preserveProgress` and `preserveWorktree`, writes a `review-feedback` task document, and records run-audit mutation `pr:changes-requested-auto-move`.

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

1. `GET /api/tasks/:id/review` returns canonical `TaskReviewData` (`mode`, `refreshable`, `fetchedAt`, `summary`, `items[]`) for modal load.
2. `POST /api/tasks/:id/review/refresh` returns the same `TaskReviewData` shape after re-fetching source data (GitHub PR mode or reviewer-agent direct mode).
3. `POST /api/tasks/:id/review/address` records selected review items as queued, appends a deterministic `**PR Review Revision Request**` steering comment payload, clears transient failure/session state, and requeues the same task to `todo` for same-task revision.

UI contract boundary:

- `PrPanel` owns branch/PR lifecycle metadata and automation status.
- `TaskReviewTab` owns review decisions, detailed review items, selection, and addressing progress.
- `TaskComments` remains separate for general discussion.

## Retry observability

Fusion derives a per-task `retrySummary` at read time by aggregating retry counters (stuck-kill, recovery, task_done, workflow-step, verification, post-review-fix, merge-conflict bounce, branch-conflict recovery, reviewer context retry, reviewer fallback retry). The engine emits a structured `retry-burned` log channel with `{ taskId, agentId, role, category, attempt, total, breakdown }` so token-cost telemetry can correlate retry burn with spend.

Project settings expose per-category caps (`maxBranchConflictRecoveries`, `maxReviewerContextRetries`, `maxReviewerFallbackRetries`) plus a master cap (`maxTotalRetriesBeforeFail`). When a cap is exceeded, engine code throws `RetryStormError`; executor terminal failure handling serializes this into `task.error` so dashboard surfaces can render structured failure details.

## Lifecycle invariants

This section preserves the detailed lifecycle/self-healing contracts that were formerly in `AGENTS.md`.

- **Orphan `fusion/*` branches**: branches with zero unique commits vs `main` are pruned by `cleanupOrphanedBranches` (`branch:orphan-prune`). Branches with unique commits are not auto-rescued; operators inspect and clean them manually via standard git tooling (`git branch -D`, `git worktree remove`, etc.).
- **Stale active branches**: self-healing's `reclaim-stale-active-branches` stage prunes a `fusion/<task-id>` branch with zero unique commits when no usable worktree mapping exists, then clears `task.branch`/`task.worktree`/`task.baseCommitSha`. It must defer reclaim (emit `branch:stale-active-reclaim-deferred`) when the task worktree is in `activeSessionRegistry`, when `executionStartedAt` is within `STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS` (10 minutes), or when the mapped worktree has uncommitted changes.
- **Worktree metadata reconcile ordering (FN-4962)**: `reconcile-task-worktree-metadata` must run before `reclaim-stale-active-branches`; stale `task.worktree` metadata is rebound to live `fusion/<task-id>` worktrees when present (`task:auto-recover-worktree-metadata-rebound`) or cleared (`task:auto-recover-worktree-metadata-cleared`) when absent.
- **Completion fan-out is synchronous**: `SelfHealingManager.reconcileCompletedTask()` runs on `in-review → done`. Downstream stale `blockedBy` links and residual `fusion/<task-id>` branch/worktree artifacts are reconciled immediately, not on a periodic sweep.
- **In-review stall deadlock**: identical stalls (same code + reason) repeated past `inReviewStallDeadlockThreshold` (default 3) auto-pause with `pausedReason: "in-review-stall-deadlock"` and `status: "failed"`. User-initiated retry paths (dashboard retry, `fn_task_retry`, and CLI `task retry`) clear that automatic deadlock pause so the retry can execute, but they never override explicit/manual pauses or unrelated automatic pause reasons.
- **Restart recovery**: `RestartRecoveryCoordinator` classifies interrupted `in-progress` runs. Unusable-worktree session-start failures (`missing`, `incomplete`, `unregistered git worktree`) are recoverable; retries are capped at `MAX_WORKTREE_SESSION_RETRIES=3` before escalating.
- **Executor pre-session liveness gate (FN-4935)**: the gate now skips for fresh acquisitions (`acquisition.source === "fresh"`), emits structured `not_usable_task_worktree:<classification>` diagnostics (including canonicalized registered-path snapshots) and a `worktree:incomplete-detected` audit event with `source: "executor-liveness-gate"`, while preserving the existing `taskDoneRetryCount` / `MAX_TASK_DONE_REQUEUE_RETRIES` requeue contract. FN-5772 adds a bounded nested-root self-heal: when `task.worktree` points at a strict descendant of a registered worktree root inside the configured worktrees dir, executor re-anchors `task.worktree` to the git top-level, emits `worktree:reanchored` (`fromPath`, `toPath`, `source`), and proceeds; repo-root/outside-dir/unregistered top-level mismatches still fail. FN-4651 `worktreeSessionRetryCount` remains scoped to the in-review/session-start recovery path.
- **Stale self-owned active-session reconcile on conflict cleanup (FN-4973)**: when executor worktree-conflict cleanup finds only a same-task stale `activeSessionRegistry` entry and no live in-memory `activeWorktrees` binding for that task/path, it must unregister the stale entry before `removeWorktree` (plus one-shot backstop reconcile on same-task `ActiveSessionWorktreeRemovalError` races). Foreign-task entries remain protected by FN-4811 and must never be reconciled by the requesting task.
- **Same-task stale removal canonical helper (FN-5346)**: executor same-task cleanup paths now route pre-removal reconciliation through `reconcileSelfOwnedActiveSessionForRemoval` (via executor helper wiring), so stale self-owned `activeSessionRegistry` residues are cleared only when no live in-memory binding exists, while FN-4811 foreign-owner refusals and live-owner protections remain intact.
- **Task title/ID drift (FN-4898)**: active and archived title writes normalize foreign embedded `FN-NNN` tokens via `packages/core/src/task-title-id-drift.ts`. Empty placeholder groups (`()`, `[]`, `{}`) left behind by token stripping are also removed in both `normalizeTitleForTaskId` and `sanitizeTitle` (FN-4978). Lineage is preserved in `sourceParentTaskId` / description markers, not title embeds. FN-5077 extends drift normalization to reject dangling-connector fragments (`"Close as duplicate of"`) so token-stripped residuals never persist as task titles.
- **PR-conflict reclaim wiring (FN-4763)**: GitHub PR refresh now persists normalized `prInfo.mergeable` conflict state and, when conflicting, funnels tasks into self-healing’s existing reclaim machinery (`reclaimPrConflictForTask` / `reclaim-pr-conflicts` stage) so branch-conflict handling stays centralized with existing `inspectBranchConflict` outcomes and unrecoverable pause semantics. PR refresh also captures `prInfo.conflictDiagnostics` (conflicting files + suggested local recovery commands) for dashboard surfacing.
- **Worktrunk-managed lifecycles**: when `worktrunk.enabled`, self-healing defers prune/idle/worktree-cap sweeps to the worktrunk backend; branch-level stale/ conflict reclaim stays native. Orphan `fusion/*` branches are operator-managed via standard git tooling (no auto-rescue task filing).
- **Post-finalize verification no-op (FN-4944)**: when auto-merge receives a delayed `VerificationError` after a task is already `done` with `mergeDetails.mergeConfirmed === true` (already-on-main fast-path), it must log one `[verification] ... no action` diagnostic and must not bounce the task back to `in-progress` / `merging-fix`. Defense-in-depth now re-checks the done+mergeConfirmed condition immediately before each verification-failure status write site, and emits `task:post-finalize-verification-no-op` database audit events with failure metadata for forensics.
- **Transient auto-merge retry classification (FN-5697)**: non-conflict auto-merge errors now run through `isTransientError(...)` before terminal parking. Transient provider/network failures (for example `This operation was aborted`, `socket hang up`, and `server_error` payloads) are retried with bounded exponential backoff (`5s/10s/20s`) and `status=null` for both direct and pull-request merge strategies; once `MAX_AUTO_MERGE_TRANSIENT_RETRIES` is exhausted, tasks are parked `in-review/failed` with explicit transient-exhaustion logs.
- **Worktree pool exclusivity (FN-4954)**: `WorktreePool.acquire(taskId)` / `release(path, taskId?)` track a `leased` map so every pooled path is either idle or leased, never both. Cross-task double-lease detection throws `PoolDoubleLeaseError` and emits `worktree:pool-double-lease-detected`; merger Step 8 now detaches HEAD and clears `task.worktree` / `task.branch` before releasing paths back to the pool.
- **Stale registration recovery (FN-5056)**: `NativeWorktreeBackend.create` and `executor.tryCreateWorktree` detect `missing but already registered worktree` failures, run `git worktree prune` (plus `remove --force` / `add -f` fallbacks) before retrying, and emit `worktree:stale-registration-{detected,recovered,recovery-failed}` audit events.
- **Raw worktree deletion must be paired with prune (FN-5058)**: any direct filesystem deletion of a worktree directory (`rm -rf` / `rmSync`) must be followed by best-effort `git worktree prune` via `pruneWorktreeAdminEntries` so `.git/worktrees/*` admin entries are not stranded in a missing-but-registered state (FN-5056 class).
- **Meta-task auto-archive safety guards (FN-5064)**: `auto-archive-meta-resolved`/`auto-archive-meta-stalled` must skip archival (with `task:auto-archive-meta-*-skipped` audits) whenever guard checks detect substantive work signals such as unique branch commits, recent executor activity, pending `taskDoneRetryCount`, merge-in-progress state, or active worktree session. The corresponding `task:auto-archive-meta-resolved-skipped` and `task:auto-archive-meta-stalled-skipped` run-audit rows are transition-only per task+guard-reason signature: emit once on first skip, suppress repeated sweeps while the same reasons persist, clear when the skip no longer applies, and re-emit if a different reason later blocks archival.
- **Scheduler fanout tiebreaker (FN-4969)**: within the same priority class, scheduler dispatch prefers runnable `todo` tasks with the highest active dependency-dependent fanout; `urgent` always outranks lower priorities regardless of fanout, and `overlapBlockedBy`/file-scope overlap blockers are excluded from unblock weight.
- **Scheduler overlap priority/age guard (FN-5325)**: with `groupOverlappingFiles=true`, scheduler now defers a lower-priority (or younger same-priority) candidate when an overlapping queued todo task exists, preserving priority→age→task-id order for overlap serialization without preempting in-progress work. If the inversion is against an already-running lower-priority blocker, scheduler still defers and emits `scheduler:overlap-priority-inversion` on state transition only: once per `(candidate, blocker)` pairing while blocked, silent on repeated polls with the same blocker, cleared when the overlap condition resolves, and emitted again if a different blocker takes over or the same blocker reappears later.
- **Empty-commit refusal + early empty-own-diff finalize (FN-5345/FN-5377)**: Fusion task worktrees install a `prepare-commit-msg` hook that refuses `git commit --allow-empty` and other zero-staged-diff commits, preventing verification-only tasks from manufacturing empty handoff commits that defeat the merger's no-op classifier. The hook allows legitimate empty-tree paths (amend, merge, squash, cherry-pick, revert, rebase). Amend detection tokenizes the parent process command line (`ps -o args=` with `/proc/$PPID/cmdline` fallback for Alpine/busybox) and stops at the first message-supplying flag (`-m`/`-F`/`--message`/`--file`) so a commit message containing the substring `--amend` cannot bypass the guard. In `aiMergeTask`, an early empty-own-diff fast-path runs BEFORE any reuse-handoff acquisition: when integration mode is `reuse-task-worktree`, the branch exists, `git rev-list --count <mergeTarget>..<branch>` is > 0, and `git diff --quiet <mergeBase>..<branch>` exits 0, the task auto-finalizes as no-op with `mergeDetails.noOpMerge: true` and emits `task:auto-recover-finalize-already-on-main` with `reason: "empty-own-diff-early-fast-path"`. The fast-path best-effort removes the stranded worktree (FN-4811 same-task/foreign-owner guard) and deletes the `fusion/<id>` branch so empty-own-diff residuals do not accumulate. This unsticks tasks where a stale empty handoff commit combined with drifted worktree↔branch mapping would otherwise wedge the handoff gate with `registered-branch-mismatch`. The explicit `cwd-integration-branch` mode is unchanged (`cwd-main` remains a deprecated alias normalized to it). `classifyOwnedLandedEvidence` also detects empty-own-diff (aheadCount > 0, zero net diff) and returns `proven-no-op` so downstream self-healing and post-handoff finalize paths benefit too. Additionally, merger's reuse-fallback path now consults `git worktree list --porcelain` before creating a new worktree: extant usable registrations of `fusion/<id>` are reused directly (rather than blindly `git worktree add -f` producing a duplicate registration), and stale registrations are pruned first. The direct-reuse shortcut is guarded by FN-4811 (refuses paths owned by a different task in `activeSessionRegistry`) and FN-4954 (skipped when `recycleWorktrees=true` with a pool attached, so `WorktreePool.acquire` lease bookkeeping stays consistent). Two audit subtypes — `merge:reuse-fallback-pruned-stale-registration` and `merge:reuse-fallback-reused-existing-registration` — replace the prior overloading of `merge:reuse-fallback-new-worktree` for these cases.
- **In-review branch-binding self-heal (FN-5083)**: `reconcile-in-review-branch-rebind` runs after `reconcile-task-worktree-metadata` and before `reclaim-stale-active-branches`. It restores `task.branch` (and clears `task.worktree` for fresh acquisition) for `in-review` tasks when exactly one case-insensitive `fusion/<id>` candidate branch has unique commits versus the integration base. Ambiguous candidates emit `task:auto-rebind-skipped` (`reason: "ambiguous-candidates"`) and are never auto-resolved. Branch construction across executor/worktree-pool/worktree-acquisition/merger/self-healing canonicalizes to lowercase via `canonicalFusionBranchName`; `fn_task_done` wrong-branch checks now auto-canonicalize case-only mismatches and emit `branch:auto-canonicalize-case`.
- **In-review is terminal-until-merged under `autoMerge: false` (FN-5147)**: when a project sets `settings.autoMerge: false`, `in-review` is the intended resting state until a human merges the PR. No lifecycle-mutating self-healing sweep (`reclaimSelfOwnedBranchConflicts`, `recoverGhostReviewTasks`, `recoverStaleIncompleteReviewTasks`, `recoverInterruptedMergingTasks`, `recoverStuckMergeDeadlocks`, `recoverMissingWorktreeReviewFailures`, `recoverPartialProgressNoTaskDoneFailures`, `recoverCompletionHandoffLimbo`, `recoverPostDoneNonContinuableWedge`, `recoverMergeableReviewTasks`, `recoverMergedReviewTasks`, `recoverAlreadyMergedReviewTasks`, `recoverOrphanOnlyScopeViolations`, `recoverForeignOnlyContaminatedInReviewTasks`, `recoverReviewTasksWithFailedPreMergeSteps`, `finalizeNoOpReviewTasks`, `surfaceInReviewStalls`, `surfaceInReviewStalled`) may move the task out of `in-review`, mark it `paused`/`failed`, or re-enqueue it for execution. Scoped FN-5819 exception: shared-group members (`branchContext.assignmentMode === "shared"`) are still allowed through the member→`branch_groups.branchName` integration step while `autoMerge` is off; this is a soft pre-integration only and does not permit shared-branch → default-branch promotion. RECONCILE-ONLY sweeps (branch rebind, blocker fan-out, stale-status clears, contamination metadata cleanup, attribution restore, PR refresh, misclassified-failure error clearing) continue to run.
- **Auto-merge integration-root default (FN-5279)**: direct auto-merge now defaults `mergeIntegrationWorktree` to `reuse-task-worktree`; merger must pass the reuse handoff gates or emit `merge:reuse-handoff-refused` and leave the task in `in-review` without silently falling back to `cwd-integration-branch` (`cwd-main` remains a deprecated alias normalized to that mode).
- **Orphaned execution sweep is observation-only (FN-5337)**: `recoverOrphanedExecutions` only annotates stale in-progress candidates with `task:orphan-detected-no-action` and `[orphan-detected] ... no action (operator-decides)` logs. It must never move `in-progress`/`in-review` backward to `todo` or mutate lease/worktree metadata. Proof-based backward recovery remains exclusively in `recoverInProgressLimbo` (FN-5219), `RestartRecoveryCoordinator`, `recoverMissingWorktreeReviewFailures`, and explicit executor/merger failure paths. Reintroducing lifecycle mutation here requires hard git/session proof gating plus CEO+CTO+PM sign-off.
- **Self-owned reclaim resume-limbo escalation (FN-5704)**: `reclaimSelfOwnedBranchConflicts` tracks `resumeLimboCount`, `resumeLimboTipSha`, and `resumeLimboStepSignature` for in-progress reclaim/unpause loops. If reclaim finds no progress (same tip, same step-status signature, and no active-session signal) for `MAX_NO_PROGRESS_RESUME_ATTEMPTS` consecutive sweeps, self-healing escalates by moving the task to `todo` with `preserveWorktree: true`, `preserveProgress: true`, and `preserveResumeState: true` instead of endlessly re-arming resume. Escalation emits `task:resume-limbo-escalated` run-audit metadata (`frozenTipSha`, `idleMs`, `resumeAttemptCount`, `currentStep`) and resets the limbo counter.
- **Merge-request shadow contract (FN-5741 Phase 1)**: `mergeRequestContractShadowEnabled` defaults OFF. OFF means no writes to `merge_requests` or `completion_handoff_markers` and the legacy lifecycle remains authoritative. ON enables write-only shadow persistence: executor/self-healing append `task:completion-handoff-accepted` marker+record writes only after successful legacy `handoffToReview`, and merger mirrors `merge:request-enqueued` plus `queued → running → succeeded` (or `manual-required` for `autoMerge:false`) transitions. Phase 1 never reads these shadow records for column movement, dependency checks, lease arbitration, merge dequeue, or FN-5479/FN-5704 limbo recovery decisions.
- **Dual-observe parity seam (FN-5742 Phase 2)**: with the same flag ON, legacy remains authoritative while shadow reads compute/emit parity telemetry only. Scheduler emits `merge:dependency-parity-diff` when `in-review|done|archived` dependency satisfaction diverges from completion-handoff marker satisfaction, and `merge:lease-parity-diff` when legacy in-review overlap leasing diverges from shadow lease decomposition. Merger emits `merge:request-dequeued-shadow` (agree/disagree metadata) by comparing legacy dequeue selection to shadow merge-request selection while explicitly skipping `manual-required` rows. Phase 3 dequeue cutover is gated on sustained parity (low disagreement rate) from these additive events; no lifecycle authority changes in Phase 2.
- **Authoritative cutover seam (FN-5743 Phase 3)**: with the flag ON, merge-request records and `completion_handoff_accepted` markers become authoritative enforcement signals for dequeue/retry ownership and dependency/lease gates. Accepted handoffs stop stamping `in-review` executor overlap leases, transient merge retries stay in merge-request state (`running → retrying → queued`, terminal `exhausted|succeeded|cancelled`) without `todo` rebounds, and user hard-cancel (`in-review → todo`) deterministically cancels pending merge-request records while keeping FN-5147/FN-5704 behavior unchanged.
- **No-progress churn terminalization (FN-5168)**: `StuckTaskDetector` now tracks ignored `fn_task_update` rebuffs via `recordIgnoredStepUpdate(taskId)` and, after one loop/compact-and-resume recovery has already fired in the same `execute()` lifecycle, escalates `ignoredStepUpdateCount >= 25` to the terminal reason `no-progress-churn`. `SelfHealingManager.checkStuckBudget()` maps that reason directly to `STUCK_NO_PROGRESS_CHURN`, emits `task:stuck-no-progress-churn-terminalized` with `{ taskId, ignoredStepUpdateCount, stuckKillStreak, lastReason }`, and parks the task in `in-review` without consuming the normal stuck-kill budget. Under FN-5147 `autoMerge: false`, that failed in-review task remains terminal-until-merged just like `STUCK_LOOP_EXHAUSTED`; the new class adds an earlier bounded exit, not a re-execution path.
- **Todo↔in-progress flapping convergence (FN-5941)**: live backward-recovery paths now share a `getFalsePositiveRequeueSignal(...)` guard that suppresses `in-progress → todo` recovery when any hard liveness proof exists (`getExecutingTaskIds`, recent active-heartbeat run, checked-out lease, live worktree+branch binding, or recent `executionStartedAt` inside the relevant grace window). Suppressed candidates emit observation-only `task:*no-action` audits instead of silently mutating lifecycle state. Scheduler adds a short `recentEngineTodoRequeues` settle window so engine-sourced requeues cannot be re-dispatched immediately on the same `task:moved → todo` tick. The durable convergence backstop is the dispatch-oscillation breaker: scheduler reuses `task.dispatchStormCount` + `task.lastDispatchAt` as a sliding-window counter (`dispatchOscillationThreshold`, `dispatchOscillationWindowMs`) and, when the threshold is exceeded, leaves the task parked in `todo`, sets `paused: true` with `pausedReason: "dispatch-oscillation"`, records `task:dispatch-oscillation-terminalized`, and requires an operator unpause or forward move to reset the counter.
- **Landed-files attribution (FN-5103)**: Rebase-strategy `mergeDetails.landedFiles` / `filesChanged` / `insertions` / `deletions` are captured from task-attributable commits only via `filterFilesToOwnTaskCommits` (subject-prefix + trailer + bracket-prefix evidence), tagged `landedFilesAttributionRestricted: true`. Zero own commits → `landedFiles: []` and `noOpVerifiedShortCircuit: true`. FN-5304 guard: when `<rebaseBaseSha>..HEAD` reports zero own commits, merger must also validate the source `fusion/<id>` tip; if that source tip still has attributable own commits relative to `rebaseBaseSha`, throw `SilentNoOpAttributionMismatchError`, refuse writing `mergeConfirmed: true`, park the task in `in-review` with `status: "failed"`, and emit `merge:no-op-attribution-mismatch`. If source ref is unavailable, skip with diagnostic + `merge:no-op-attribution-mismatch-skipped` (`reason: "source-ref-unavailable"`). Attribution-helper failures fall back to the unrestricted `rebaseBaseSha..sha` walk and set `landedFilesCaptureFallback: 'attribution-failed'`. Self-healing `recoverDoneTaskMergeMetadata` skips reconcile when `landedFilesAttributionRestricted` or `noOpVerifiedShortCircuit` is set so the narrower set is not overwritten with the full range. Squash-strategy capture is unchanged.
- **Soft-delete scheduler invalidation (FN-5137)**: `task:deleted` events must invalidate `AutoClaimSnapshotManager` and clear scheduler bookkeeping (`pausedTaskIds`, `failedTaskIds`, `wasNodeDispatchValidationBlocked`, `wasNodeBlocked`); `executor.execute()` / `resumeOrphaned()` / `resumeTaskForAgent()` refuse any task with `deletedAt` set.
- **Soft-delete in-flight abort (FN-5142)**: `task:deleted` must immediately abort/dispose active executor work (`activeSessions`, `activeStepExecutors`, `activeWorkflowStepSessions`, reviewer subagents), interrupt active merge state (`mergeAbortController`, `activeMergeSession`, `activeMergeTaskId`, `mergeActive`, `mergeQueue`, `pausedReviewTaskIds`), and abort triage specify/subagent sessions for that id. Handlers are per-task and idempotent.
- **Soft-delete audit + column reconcile (FN-5175)**: `TaskStore.deleteTask` records a `runAuditEvents` row (`mutationType: "task:deleted"`, `domain: "database"`) inside the same transaction that sets `deletedAt`, and sets `"column" = 'archived'` on the row. Callers without a heartbeat run context (`fn task delete`, pi extension, dashboard delete route) pass an `auditContext` with `agentId: "system"` and a synthetic `runId`. The watcher cross-instance emit path does NOT re-record the audit event. The row stays in `tasks` (not `archivedTasks`); `archiveTask` is unchanged.
- **Soft-delete resurrection guard (FN-5208)**: `TaskStore.readTaskJson()` must never fall back to `.fusion/tasks/<id>/task.json` when the DB row exists with `deletedAt` set — it throws `TaskDeletedError`. `atomicCreateTaskJson` / `atomicWriteTaskJson` / `atomicWriteTaskJsonWithAudit` refuse to upsert a task whose row is currently soft-deleted (unless the in-memory task carries `deletedAt` itself, for soft-delete maintenance paths), emit a `[soft-delete-resurrection-blocked]` log line, and record a `task:resurrection-blocked` run-audit event. Stale in-flight planner/triage writes for a soft-deleted ID surface `TaskDeletedError` and abort cleanly without emitting `task:created`.
- **Exhausted in-review visibility surfaces (FN-5513)**: retry-exhausted merge failures (`column='in-review'`, `status='failed'`, `mergeRetries >= 3`) can remain soft-deleted for lifecycle safety, but are now intentionally discoverable through opt-in read paths: `TaskStore.listExhaustedInReviewTasks({ includeDeleted })`, `GET /api/tasks/exhausted-in-review`, `GET /api/tasks/:id?includeDeleted=true`, CLI `fn_task_show` soft-delete fallback marker, CLI `fn_task_list({ includeDeleted: true })`, and the dashboard ReliabilityView "Exhausted in-review (hidden blockers)" panel. This complements FN-5488/FN-5496 downstream blocker healing by surfacing the upstream blocker without mutating lifecycle state.
- **Soft-delete stream verification gate (FN-5153)**: `docs/soft-delete-verification-matrix.md` is the authoritative checklist for the FN-5105 → FN-5143 soft-delete stream. Every scenario × layer cell must be GREEN (or have a linked follow-up FN) before the stream is closed; `packages/engine/src/__tests__/reliability-interactions/soft-delete-end-to-end.test.ts` is the cross-layer regression backstop.

## Reliability interaction backstops

Reliability-layer changes are in scope. Interaction regression backstops live in `packages/engine/src/__tests__/reliability-interactions/` — any task that adds or changes a reliability layer must add/update interaction tests there covering each plausible pair with existing layers (merge path, workflow/pre-merge, self-healing, scheduler/watchdog/restart recovery, governance gates).

- FN-4935 backstop: `packages/engine/src/__tests__/reliability-interactions/executor-liveness-gate.test.ts` guards fresh-acquisition skip behavior, structured liveness classifications, and executor-gate audit/requeue outcomes.
- FN-4887 backstop: `packages/engine/src/__tests__/reliability-interactions/foreign-only-contamination-recovery.real-git.test.ts` covers composition between bootstrap-misbinding, contamination dispatcher retry, misbound-in-review ordering, and FN-4811 active-session safeguards.
- FN-5039 backstop: `packages/engine/src/__tests__/reliability-interactions/worktree-contamination-attribution.real-git.test.ts` guards `captureModifiedFiles` trailer attribution filtering and `task:worktree-contamination-detected` audit fan-out across rebase contamination, clean, untrailered, and fallback paths.
- FN-4976 backstop: `packages/engine/src/__tests__/reliability-interactions/stale-self-owned-session-registry.test.ts` guards `cleanupConflictingWorktree` clearing stale same-task `activeSessionRegistry` entries before the FN-4811 foreign-owner check, while preserving refusal behavior for foreign owners and live same-task bindings.
- FN-5346 backstop: `packages/engine/src/__tests__/reliability-interactions/post-completion-stale-self-owned-binding.test.ts` covers post-completion and dep-abort same-task stale-binding cleanup, restart-residue recovery, same-task live-binding refusal, foreign-owner FN-4811 refusal, idempotent repeat sweeps, and FN-4954 lease-map composition.
- FN-4999 backstop: `packages/engine/src/__tests__/reliability-interactions/completion-handoff-limbo.test.ts` covers the `recoverCompletionHandoffLimbo` sweep stage (grace window, active-task skip, merge-blocker guard, capped retries, and audit fan-out).
- FN-5889 backstop: `packages/engine/src/__tests__/reliability-interactions/post-done-continuation-no-wedge.test.ts` covers the post-done step-session non-continuable suppression path plus `recoverPostDoneNonContinuableWedge`, including bounded self-heal ordering before stall surfacing.
- FN-5345/FN-5377 backstops: `packages/engine/src/__tests__/reliability-interactions/merge-reuse-task-worktree.test.ts` (`FN-5345: empty-own-diff branch auto-finalizes via early fast-path without acquiring reuse handoff`) covers the early no-op fast-path under drifted worktree mapping; `packages/engine/src/__tests__/real-git/prepare-commit-msg-empty-guard.real-git.test.ts` covers the empty-commit refusal hook (refuses `--allow-empty`, allows amend + real commits, no-op outside fusion worktrees).
- FN-5083 backstop: `packages/engine/src/__tests__/reliability-interactions/in-review-branch-rebind.test.ts` covers in-review branch rebind composition with metadata-cleared state, idempotent re-sweeps, and ambiguous-candidate skip behavior.
- FN-5093 backstop: `packages/engine/src/__tests__/reliability-interactions/in-review-stalled-detector.test.ts` covers composition between quiet-window in-review stalled surfacing and adjacent reason-driven/paused/ghost-recovery/auto-merge gating paths.
- FN-5103 backstop: `packages/engine/src/__tests__/reliability-interactions/landed-files-attribution.test.ts` covers attribution-restricted rebase landed-files capture, verified-short-circuit zero-own-commit capture, and attribution-failure fallback composition.
- FN-5147 backstop: `packages/engine/src/__tests__/reliability-interactions/in-review-automerge-off.test.ts` covers `autoMerge: false` + long-quiet in-review + maintenance/startup sweep cycles, asserting no column move / no paused / no status mutation / no requeue, plus explicit regression guards for `surfaceInReviewStalls` and `surfaceInReviewStalled`.
- FN-5168 backstop: `packages/engine/src/__tests__/reliability-interactions/non-progress-churn.test.ts` covers loop→compact recovery followed by ignored-step-update churn escalation, terminal `beforeRequeue(false)` behavior, audit/log payloads, and FN-5147 autoMerge-off composition.
- FN-5219 backstop: `packages/engine/src/__tests__/reliability-interactions/in-progress-limbo-recovery.test.ts` covers `recoverInProgressLimbo` composition with `recoverOrphanedExecutions` (no double-recovery), `reconcile-task-worktree-metadata` (live rebindable worktree wins), `recoverMissingWorktreeReviewFailures` (in-review vs in-progress disjoint), and executor task-id claim skip, plus an explicit FN-5149 reproduction case.
- FN-5704 backstop: `packages/engine/src/__tests__/reliability-interactions/reclaim-self-owned-resume-limbo-escalation.test.ts` covers bounded no-progress reclaim/resume detection, preserve-work escalation to `todo`, `task:resume-limbo-escalated` audit metadata, progress-signal reset behavior, and user-paused/autoMerge-off non-escalation guards.
- FN-5715 backstop: `packages/engine/src/__tests__/reliability-interactions/mission-validation-trigger-gap.test.ts` locks the mission-validation trigger invariant so done mission-linked tasks still start validation when the mission loop was stopped, startup recovery replays done implementing features with unpassed assertions, and recovery remains idempotent for already-passed features.
- FN-5782 backstop: `packages/engine/src/__tests__/reliability-interactions/branch-group-merge-routing.test.ts` guards branch-group merge routing so `shared` members land on `branch_groups.branchName`, grouped multi-member merges converge on the same integration branch, ungrouped/`per-task-derived` tasks stay on direct default-branch merge flow, and routed merges emit `merge:branch-group-routed` audit metadata.
- FN-5788 backstop: `packages/engine/src/__tests__/reliability-interactions/branch-group-promotion-gate.test.ts` guards the promotion eligibility hook/audit seam so member landings emit `merge:branch-group-promotion-gated` with deterministic reason metadata (`eligible`, `group-automerge-disabled`, `settings-automerge-disabled`, `global-pause`, `engine-paused`) while group branches remain open and do not auto-promote to the default branch.
- FN-5830 backstop: `packages/engine/src/__tests__/reliability-interactions/branch-group-promotion.test.ts` guards branch-group completion-gate + promotion lifecycle so promotion happens exactly once after all members land, re-calls are idempotent, and gated paths emit `merge:branch-group-promotion-gated` without default-branch promotion.
- FN-5819/FN-5846 backstop: `packages/engine/src/__tests__/reliability-interactions/shared-group-member-integration.test.ts` and `shared-branch-group-lifecycle.test.ts` guard the scoped autoMerge-off exception and deterministic finalize path so shared members integrate into the single group branch, produce `mergeTargetSource: "branch-group-integration"`/`mergeTargetBranch`, do not land on main, and are not moved backward by self-healing maintenance.
- FN-5901 backstop: `packages/engine/src/__tests__/reliability-interactions/mission-validator-run-reaper.test.ts` guards stale mission-validator-run recovery across manual and automatic trigger types, verifies `mission:validator-run-reaped` audit metadata, ensures archived/complete parents keep their terminal feature state untouched, and proves reaped active features resume validation instead of staying wedged behind abandoned `running` rows.
- FN-5738 backstop (superseded by FN-5902): `packages/engine/src/__tests__/reliability-interactions/mission-validation-trigger-gap.test.ts` no longer permits zero-assertion auto-pass. Current coverage proves legacy zero-link features lazily restore a managed assertion, route through validator runs, and do not emit `validation_auto_passed_no_assertions` during recovery replays.
- FN-5741 backstop: `packages/engine/src/__tests__/reliability-interactions/merge-request-shadow-handoff.test.ts` guards Phase-1 merge-request contract shadow writes: flag OFF is a no-op, flag ON writes marker/record strictly after legacy handoff, and `autoMerge:false` remains `manual-required` without shadow running transitions.
- FN-5742 backstop: `packages/engine/src/__tests__/reliability-interactions/dual-observe-merge-seam.test.ts` guards Phase-2 dual-observe invariants: legacy dependency satisfaction remains authoritative while parity diffs emit, and shadow dequeue selection never advances `manual-required` rows.
- FN-5743 backstop: `packages/engine/src/__tests__/reliability-interactions/merge-request-cancel-on-hard-cancel.test.ts` and `packages/core/src/__tests__/merge-request-record.test.ts` guard Phase-3 cutover invariants: transient merge retries mutate merge-request state (no column rebound), user hard-cancel after accepted handoff cancels pending merge requests, and non-user rebounds preserve legacy fail-soft semantics.
- FN-5770 backstop: `packages/engine/src/__tests__/reliability-interactions/workflow-interpreter-cutover.test.ts` guards the interpreter-authoritative lifecycle seam. The cutover remains opt-in (`workflowInterpreterAuthoritative` default OFF), readiness-gated by dual-observe parity evidence, reversible by flipping one flag back OFF, and must preserve file-scope, squash-overlap, `autoMerge:false`, hard-cancel, and self-healing interaction invariants.
- FN-5337 backstop: `packages/engine/src/__tests__/reliability-interactions/orphan-detected-no-requeue.test.ts` locks observation-only orphan detection across FN-5279 repro metadata desync, worktree-present and worktree-missing candidates, FN-5219 ordering, FN-5147 in-review isolation, FN-5083 branch-cleared composition, lease-manager non-invocation, and per-sweep idempotent audit emission.
- FN-5256 backstop: `packages/engine/src/__tests__/reliability-interactions/dependency-cycle-reconcile.test.ts` covers persisted dependency-cycle detection via `reconcileDependencyCycles`, bounded umbrella-back-edge auto-repair, ambiguous-cycle observe-only behavior, composition ordering with `reconcileSelfDefeatingDependencies`, and the post-sweep write-time guard invariant. Core write-boundary regressions (FN-5240/5241/5242 signature, indirect cycle, umbrella back-edge rejection) live in `packages/core/src/__tests__/store-dependency-cycle.test.ts`.
- FN-5325 backstop: `packages/engine/src/__tests__/reliability-interactions/scheduler-overlap-priority-inversion.test.ts` covers queued-overlap priority/age deferral, equal-priority age ordering, FN-4969 fanout composition, and transition-only `scheduler:overlap-priority-inversion` audit surfacing across unchanged, changed-blocker, and clear→reappear states.
- FN-5223 backstop: `packages/engine/src/__tests__/reliability-interactions/engine-active-since-floor.test.ts` covers engine-activation floor + grace composition across startup, pause/unpause, global-pause gating, and StuckTaskDetector lifecycle interactions.

The auto-recovery dispatcher at `packages/engine/src/auto-recovery.ts` (FN-4533) composes on top of existing layers (FN-4500 fast-path, FN-4508 deterministic branch-conflict, FN-4499 bootstrap-misbinding, FN-4428 contamination, `mergeAuditAutoRecovery` Stages 1–5, self-healing) to handle six residual classes: file-scope violation at squash, branch misbinding / ghost worktree, verification-fix scope leak, contamination, `branch-conflict-unrecoverable` residuals, and room-post/message-send failures. Invocation is additive — no existing layer's behavior changes.
