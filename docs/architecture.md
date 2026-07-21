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
          │ - PostgreSQL schemas             │
          │ - .fusion/tasks/* (artifacts)    │
          │ - .fusion/project.json (identity)│
          └──────────────────────────────────┘
```

---

## 2) Monorepo Structure

| Package | Published | Role | Key files |
|---|---|---|---|
| `@fusion/core` | Private | Domain model, PostgreSQL stores/adapters, settings, shared types, and legacy import tooling | `packages/core/src/types.ts`, `store.ts`, `postgres/`, `central-core.ts`, `agent-store.ts` |
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
  - Hybrid model: PostgreSQL metadata + filesystem artifacts under `.fusion/tasks/{id}`
- **Database adapter**: `packages/core/src/postgres/`
  - Drizzle-backed PostgreSQL connection and async data layers
  - Project-scoped rows carry `projectId`; central/plugin schemas hold shared control-plane state
  - `packages/core/src/postgres/sqlite-migrator.ts` and SQLite adapters are legacy import tooling, not runtime authority
  - `ai_sessions.status` lifecycle includes `draft` (pre-start planning session), then `generating`, `awaiting_input`, terminal `complete` / `error`; deletion is final within a bounded tombstone window that blocks a straggling post-delete write from resurrecting the row (FN-7949) — see `docs/storage.md` "AI session delete tombstones"
- **Roadmap feature ownership**: roadmap contracts, ordering/handoff helpers, persistence, routes, and dashboard UI live in `plugins/fusion-plugin-roadmap` (package `@fusion-plugin-examples/roadmap`, plugin id `fusion-plugin-roadmap`) rather than dashboard/core ownership.
- **CentralCore**: `packages/core/src/central-core.ts`
  - Global project registry, health, central activity feed, global concurrency
  - Backed by the PostgreSQL `central` schema through `AsyncCentralDatabase`
- **Specialized stores**:
  - `AgentStore` (`agent-store.ts`) — filesystem-based agent metadata + heartbeat run history
  - `MissionStore` (`mission-store.ts`) — mission/milestone/slice/feature hierarchy
  - `GoalStore` (`goal-store.ts`) — strategic goal CRUD with server-enforced 5-active-goal cap
  - `AutomationStore` (`automation-store.ts`) — scheduled jobs with global/project scope isolation
  - `MessageStore` (`message-store.ts`) — PostgreSQL-backed mailbox/inbox/outbox messaging
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
- `project` scope stores rows in PostgreSQL project-scoped `secrets` storage (FN-4788).
- `global` scope stores rows in PostgreSQL central `secrets_global` storage (FN-4788).

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
- When the active session is still generating after reload/reconnect (`isGenerating: true`), `useChat`/`useQuickChat` hydrate the UI from `inFlightGeneration` immediately, seed the shared stream handlers with that same text/thinking/tool-call snapshot, then reconnect `/api/chat/sessions/:id/stream` with `Last-Event-ID = replayFromEventId` so newly replayed deltas append to the restored bubble instead of replacing it or re-appending already-known deltas.
- Hooks also auto-reattach if a stale cached session is selected and a later refresh (or session re-fetch) flips `isGenerating` to true with an `inFlightGeneration` snapshot; dedupe is guarded by a last-attached `(sessionId, replayFromEventId)` ref so snapshot checkpoint bumps do not open duplicate SSE streams.
- Attach-triggered message loads may commit the persisted transcript when they match the last attached generation even if React has not yet settled the active-session state/ref. Cache misses during that attach path must preserve the already visible thread so prior user/assistant messages remain visible beside the live streaming assistant response.
- During an active main-chat turn, intermediate session snapshots, tool-call events, and stale message-load responses must never blank or reflow the already-rendered prior thread; the visible transcript remains append-only until the authoritative completion/recovery reload.
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
  - **Global install metadata** in PostgreSQL table `central.plugin_installs`, including manifest/path/settings/schema/dependencies
  - **Per-project runtime state** in central DB table `project_plugin_states` keyed by normalized project path (`enabled`, `state`, `error`)
- Legacy project-local `plugins` rows in `.fusion/fusion.db` are one-time migration input; migration is idempotent and keeps newest `updatedAt` install metadata as global canonical data while preserving per-project enablement rows
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
- **Planning**: the planning processor generates task plans (`PROMPT.md`) and selects eligible planning tasks by priority first, then FIFO (`createdAt` ascending) within each priority tier. If the stuck-task detector kills a not-yet-approved planning session after a non-empty `PROMPT.md` draft exists, the retry is requeued as `needs-replan` and seeds the next prompt in revision mode from that draft instead of cold-starting. When `PROMPT.md` is absent, a non-empty `plan` task document written through `fn_task_document_write` is the fallback seed; missing or whitespace-only drafts still cold-start.
- **Executor**: `TaskExecutor` (`executor.ts`) implements tasks in worktrees
- **Reviewer**: `reviewStep()` (`reviewer.ts`) performs plan/code/spec reviews
- **Merger**: `aiMergeTask()` (`merger.ts`) merges approved work
- **Task-detail chat / steering comments**: `TaskStore.addSteeringComment()` writes chat steering text to both `task.comments` and `task.steeringComments`. The executor still uses `steeringComments` for live in-session injection, while next-prompt agent lanes read canonical user-authored `task.comments`: planning/spec generation, spec review, plan/code reviewers, standard merger prompts, and clean-room AI merge + merge-review prompts all surface recent user comments through the shared `agent-user-comments.ts` formatter.

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
  - Dependency-blocking lease invariant (FN-6292): an `in-progress` task with unmet scheduling dependencies must not contribute an active file-scope lease in scheduler lease maps. This prevents a holder from queueing its own dependency behind its lease and creating a circular wait.
  - **Mission symbol admission (FN-8306):** autonomous mission implementation evaluates `evaluateMissionLineageApproval` (active Mission/Milestone/Slice, triaged or in-progress Feature, and required plan fingerprint). Approved work with durable declared symbols atomically acquires project-scoped locks after ordinary capacity, checkout, and dependency gates; same symbols queue with holder diagnostics while disjoint symbols can run in parallel. Mission-linked work lacking approved lineage is `lineage-blocked` and consumes neither symbol nor work lease. Non-mission work and approved mission work without resolvable symbols retain coarse file-scope serialization. Active scheduler heartbeats and long-running workflow processors renew their short crash-recoverable leases before expiry. Central `moveTask` exits from implementation release declared-symbol locks for review, cancellation/requeue, and terminal transitions; self-healing only expires terminal/missing/expired owners as a backstop.

#### BlockedBy stamping invariants
- Scheduler writes overlap-based `blockedBy` only when overlap gating is active and there is a live overlapping active scope; otherwise overlap logic does not stamp blockers.
- Active overlap scopes exclude permanently-failed `in-review` tasks (`status === "failed"`, typically produced by `checkStuckBudget()` after `stuckKillCount > maxStuckKills`) so superseding re-implementation tasks are not indefinitely queued behind work that will never merge. (FN-4200)
- Stamping is sticky when valid (FN-3899): if a todo task is already `queued` behind a blocker that is still active and still overlaps, the scheduler preserves that blocker and skips rewrites.
- When the blocker must change, selection is deterministic: active overlap candidates are ordered by task ID and the first overlapping task is chosen, removing tick-order churn.
- Writes are idempotent: scheduler updates `status/blockedBy` only when values change, reducing per-tick churn and audit noise.
- Self-healing remains responsible for terminal/missing blocker cleanup (`clearStaleBlockedBy()`), while scheduler overlap stamping now focuses on stable active-overlap attribution.
- `reconcileDependencyBlockingLeases()` (FN-6292) unwinds existing dependency/lease circular waits: when an `in-progress` holder has unmet scheduling dependencies and an unmet dependency is blocked by the holder's stale file-scope lease, self-healing gates the backward move with triple proof, moves the holder back to `todo` with progress/worktree/resume state preserved, and emits `task:reconcile-dependency-blocking-lease` (or `task:reconcile-dependency-blocking-lease-no-action` when proof fails). Engine rebounds do not set `userPaused`.
- `reconcileInReviewUnmetDependencies()` (FN-6793/FN-6797) enforces the same dependency invariant after accidental review advancement: unpaused, auto-merge-eligible `in-review` tasks with live unmet dependencies move back to `todo` with `status: "queued"`, `blockedBy` set to the first unmet dependency, and worktree/progress/resume state preserved. Global/engine pause short-circuits the sweep; task pause/user-pause, `autoMerge:false`, live execution, checkout guards, and failed rebound mutations leave the task untouched with a no-action audit when applicable. Engine rebounds do not set `userPaused`.
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
- FNXC:Automations 2026-06-27-00:00: Scheduled automations use an atomic claim-then-run CAS in `AutomationStore.claimDueSchedule()` to advance `nextRunAt` before execution; this prevents duplicate runs when project/global/all-scope pollers or multiple engine processes observe the same due row.

### Sandbox backend seam (FN-4636)
- Engine user-configured command runners now route through `packages/engine/src/sandbox/` via a shared `SandboxBackend` abstraction (`resolveSandboxBackend()`), currently implemented only by the transparent `NativeSandboxBackend` passthrough (no behavior change).
- The seam now covers both exec-shaped commands (`run`) and spawn-shaped verification commands (`runStreaming`), with `packages/engine/src/verification-utils.ts` delegating `runVerificationCommand`/`execWithProcessGroup` through `runStreaming`.
- **Async shellout invariant (FN-8367):** executor, scheduler, merger, self-healing, and dashboard activity share the engine's Node event loop, so user-configured or potentially long-running work must use bounded async execution. Production `execSync`, `spawnSync`, and `execFileSync` are restricted to the audited short git-plumbing call sites in `packages/engine/src/__tests__/engine-no-blocking-shellout.test.ts`; its call-site-level allowlist is the enforced source of truth. Data-dependent `git diff` is only permitted there when both `timeout` and `maxBuffer` bound it; otherwise it must use async `exec`/`execFile`.
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
- FN-7608: a `wait-for-approval` gate outcome is a REAL session-suspending state, not just a soft per-call rejection. `wrapToolsWithActionGate()` invokes `gateContext.pauseForApproval(...)` for BOTH the newly-created-request sub-case and the reused-pending sub-case (previously only the former), and `TaskExecutor.buildActionGateContext()`'s `pauseForApproval` closure pauses the task in the store AND fires `awaitAbortInFlightTaskWork(taskId, "awaiting-approval:...")` to abort the in-flight executor session for that task — fire-and-forget (not awaited inline), because `session.abort()` internally awaits `agent.waitForIdle()`, which cannot resolve until the very tool call invoking `pauseForApproval` returns (awaiting it inline would deadlock). `HeartbeatMonitor`'s gate context has no persistent in-flight session surface to abort (each heartbeat tick is a short bounded request/response cycle), so pausing the task/agent there is sufficient — see the `FNXC:AgentGating` comment at its `pauseForApproval` closure. Both canonical executor prompts (`EXECUTOR_SYSTEM_PROMPT` in `executor.ts`, `EXECUTOR_PROMPT_TEXT` in `agent-prompts.ts`) carry a byte-identical carve-out: waiting on a pending approval is a legitimate turn end, and probing for ungated workarounds (re-issuing the gated call, read-only equivalents, `fn_web_fetch`/`fn_task_attach` bypasses) is forbidden.

### Concurrency, recovery, and resiliency
- `AgentSemaphore` (`concurrency.ts`) — slot acquisition. Multi-project runtimes share a single manager-owned semaphore for the cross-project `globalMaxConcurrent` cap, while each `InProcessRuntime` wraps that pool in a scoped semaphore that tracks only that project's held slots. Engine stop, `pauseProject`, and `stopAll` abort in-flight agents, wait the configured stop drain window, then return any residual scoped slots to the shared pool without using a blanket `reconcileActiveCount(0)`, so other projects' active slots are preserved and stopped projects do not starve global capacity.
- `RecoveryPolicy` (`recovery-policy.ts`) — retry/recovery decision policy
- `StuckTaskDetector` (`stuck-task-detector.ts`) — inactivity/loop stall detection
- `GridlockDetector` (`gridlock-detector.ts`) — detects all-blocked todo pipelines and emits notification events (plus explicit clear signals when gridlock resolves)
- `TransientErrorDetector` (`transient-error-detector.ts`) — retriable error classification
- Durable agent error recovery (FN-7835/FN-7844/FN-7859/FN-7878/FN-7884): a heartbeat-managed, runtime-enabled non-ephemeral agent that lands in `state:"error"` remains timer-eligible and clears `lastError` by transitioning `error → active` at the next heartbeat run entry when `lastError` is recoverable. Generic/unknown errors are recoverable by default; immediate `error-unrecoverable` parking is reserved for operator-actionable auth/model/billing/quota failures, while stale worktree/module-resolution errors stay on their dedicated self-healing suppression/rebuild path. Recovery is bounded by one shared `heartbeatErrorRecovery` attempt budget (`MAX_HEARTBEAT_ERROR_RECOVERY_ATTEMPTS`, settings-overridable through the engine's optional cast-based knob) across both the timer path and `SelfHealingManager.recoverOrphanedAgents()`. Self-healing is the stale-agent backstop and still stores `durableErrorRecovery` cooldown/stale-module metadata, but it writes/reads the shared heartbeat counter and emits the same `agent:auto-recover-error-state` / `agent:error-retry-exhausted` audit surface with `source:"self-healing"`. The sweep flips `error → active` before `restartDurableAgentHeartbeat()` calls `executeHeartbeat()`, preventing run-entry recovery from re-counting or double-emitting for the same recovery. Success resets the shared counter and clears legacy sweep retry state; budget exhaustion parks the agent `paused` with `pauseReason:"error-retry-exhausted"`. On engine startup, `SelfHealingManager.resetDurableAgentErrorStateOnStartup()` runs before the steady-state sweep and treats restart as an explicit operator retry: eligible `error` and `error-retry-exhausted` durable agents have shared/legacy retry metadata reset, `lastError` and the exhaustion pause cleared, state set to `active`, heartbeat re-armed, and `agent:reset-error-state-on-startup` emitted without applying the sweep's staleness/cooldown/exhaustion gates. Non-recoverable durable heartbeat errors are not restarted; timer, startup, and sweep paths preserve exclusions for disabled runtime agents, ephemeral agents, active executions, user pauses, `error-unrecoverable` parks, operator-actionable errors, and stale worktree/module-resolution suppression.
- `SelfHealingManager` (`self-healing.ts`) — auto-unpause/maintenance recovery actions
  - Batch 1 maintenance includes `reconcile-orphaned-task-dirs` (FN-6783), a paused-safe housekeeping step that calls `TaskStore.reconcileOrphanedTaskDirs()` so valid live `.fusion/tasks/{ID}/task.json` records missing from PostgreSQL become visible without waiting for process restart. The guard skips any ID already present in active, soft-deleted, archived, or tombstoned storage and emits `task:reconcile-orphaned-task-dir` only for recovered rows.
  - Batch 1 maintenance also includes `reconcile-phantom-committed-reservations` (FN-7069), which calls `TaskStore.reconcilePhantomCommittedReservations()` for committed task-ID reservations that have no live/soft-deleted/archived task row and no `.fusion/tasks/{ID}/task.json`. The sweep prunes orphaned `activityLog` rows and `agents`/cascaded `agentRuns`, preserves `runAuditEvents`, and keeps the reservation `committed` per FN-5105 so the ID is permanently reserved rather than resurrected or handed out again.
  - Startup recovery and Batch 1 both call `reconcileStaleSymbolLocks()` (FN-8305). It expires only project-scoped held locks whose lease elapsed or whose owner task is terminal/missing, preserves live owners, and does not alter task lifecycle, scheduler admission, worktrees, semaphores, or verification. The audit surface is `symbol-lock:reconcile-stale` plus a deduplicated `symbol-lock:reconcile-stale-no-action` idle signal.
  - FN-8405 supplies the prerequisite declaration/resolution seam: `Task.declaredSymbols` is the durable source and `TaskStore.resolveTaskSymbolsForWorkItem({ taskId })` resolves through the owning task without reading its prompt. Scheduler admission does not acquire or admit locks here; FN-8306 is the separate consumer.
  - Batch 1 maintenance now includes one `fts-maintenance` step for both search indexes. The live `tasks_fts` branch still runs `merge` every tick, `optimize` every 4th tick, and `rebuild` above `32 MiB` or `1 MiB × live task count`. The archive `archived_tasks_fts` branch is lighter because archive writes are mostly append-only: `merge` every 8th tick, `optimize` every 24th tick, and `rebuild` above `64 MiB` or `512 KiB × archived row count`. Each branch is independently guarded by `fts5Available` and emits `task:fts-maintenance` run-audit telemetry with distinct `target` values (`tasks_fts` vs `archived_tasks_fts`).
  - AI merge clean-room worktrees are created under the configured worktrees directory's hidden container, `<worktreesDir>/.ai-merge/`, as `fusion-ai-merge-fn-<id>-<random>` detached worktrees. When that container is repo-local, its relative path is added to the repo's local git exclude when possible (alongside the legacy `.fusion/ai-merge/` entry) so an in-flight clean room does not dirty the integration checkout. After `git worktree add` and before the merge/review loop, `runAiMerge` bootstraps the clean room with the shared merge dependency-sync helper: a configured `worktreeInitCommand` is authoritative and always runs, while unset settings infer `pnpm`/`npm`/`yarn`/`bun` installs from lockfiles and can skip only when the `node_modules/.fusion-install-marker` hash still matches. Failures and aborts hard-stop the AI merge before merge agents or verification run, and `merge:ai-deps-sync` records the command, skip state, and duration. Inline cleanup runs from `runAiMerge`'s clean-room `finally` for successful lands, empty/no-op finalization, concurrent-advance retries, and thrown/aborted merges. Cleanup canonicalizes the path, attempts `git worktree remove --force`, always falls back to filesystem removal, then runs `git worktree prune` so stale or partial registrations (including `git worktree add` failures) do not dangle. Cleanup emits `merge:ai-worktree-cleanup` audit events for git-remove, fs-rm, and prune phases; benign already-absent/de-registered paths are treated as idempotent success, while genuine filesystem-removal failures are logged/audited with `success: false` rather than silently swallowed.
  - Worktrees-dir sweeps that list direct children of `<worktreesDir>` (pool idle scan, orphan cleanup/reap, self-healing unregistered-orphan reap, and cap enforcement) must exclude the `.ai-merge` container by name; those one-level sweeps never inspect or recycle clean rooms beneath it. Batch 1 sweeps stale AI merge clean-room worktrees under the new `<worktreesDir>/.ai-merge/` root and still scans legacy `.fusion/ai-merge/` plus legacy `tmpdir()` locations for pre-relocation leftovers; candidates are bounded to names starting with `fusion-ai-merge-`. `runAiMerge` registers each live clean-room worktree in `activeSessionRegistry` with kind `ai-merge` as soon as the directory exists and keeps both raw and canonical paths registered for the duration of the merge, so the dedicated periodic sweep and pre-merge prune defer when either path is active (including concurrent same-task merge attempts). The default age gate is 2 hours; task-aware cleanup uses a 10-minute grace period for `done`/`archived` tasks and for genuinely missing/deleted task rows, and every removal path is clamped by the same 10-minute minimum-age floor so a freshly created worktree is never reaped. Transient `getTask` lookup failures (for example PostgreSQL availability/transaction errors) are not treated as deletion evidence; they log a warning, emit `lookup-error` only if eventually removed, and retain the conservative 2-hour gate. The sweep canonicalizes paths before checking `activeSessionRegistry`, attempts `git worktree remove --force <path>` before filesystem removal, runs `git worktree prune` after cleanup attempts, and emits `worktree:tempdir-sweep` run-audit telemetry for removal attempts and failures. Fresh directories, active-session paths, and individual removal failures are skipped/logged without aborting the maintenance cycle.

  - `recoverGhostReviewTasks()` is a fallback only for idle, non-terminal `in-review` states. Terminal/actionable states (notably `status: "failed"`) are preserved and **not** auto-kicked back to `todo`.
  - `recoverPausedAbortFailures()` clears executor pause/resume abort parks only when the durable row is safe to recover. `todo`/`in-progress` rows are requeued for normal scheduling, while clean `in-review` rows (completed steps, not paused/user-paused/executing, auto-merge eligible, no confirmed or terminal merge evidence) have `status`/`error` cleared in place so review progression can continue. FN-7749 adds the manual-hold exception to the prior `autoMerge:false` guard: a benign hard-cancel pause/resume abort at a merge-region/manual-hold node is the healthy Merge & Close resting state, so already-parked rows of that exact shape are cleared in place without moving backward (FN-5147-compliant). User hard-cancel, global/user pause, terminal merge, live-execution, and other `autoMerge:false` guards remain operator-actionable. Successful recovery emits `task:auto-recover-paused-abort-park` with `preservedInReview` metadata.
  - Workflow graph pause/resume is node-reentrant for typed engine-internal interruptions. When `WorkflowGraphExecutor` sees the graph abort signal or a node returns `value: "aborted"`, it stamps the interrupted node and `engine-pause` abort kind into graph context. `TaskExecutor` then uses the existing bounded `graphResumeRetryCount` budget to clear the transient abort, suppress failure notification with an `Auto-recovered:` task log, and re-enter the graph/task only under the same safety guards: no user/active global pause, no merge/finalize provenance, no genuine node failure, no terminal merge value, no `autoMerge:false` protected review row, and no active execution owner. Global-pause provenance from the graph-controller abort is re-entrant once the global pause has been lifted because it represents the same in-flight node interruption. Generic legacy pause-abort parks without the typed node marker remain operator-action failures except for the narrow `in-review`/`plan` stale-replay shape: hard-cancel pause provenance, `node:plan:value === "aborted"`, no typed interrupted node, no active task/user/global pause, no terminal merge value, no confirmed merge, auto-merge eligibility, and only a clean row or the exact stale plan pause-abort failure. That path logs `stale replay ignored`, clears only the stale failure state when present, preserves `in-review`, and never re-enters planning or moves the task to `todo`.
  - FN-7863 adds a progress-anchored guard at the execute-node self-requeue funnel (`failedNode === "execute"` and either the live row is `todo` or the in-process self-requeue marker proves a stale `in-progress` read). The guard persists `executeRequeueLoopCount` plus `executeRequeueLoopSignature`, warns at `EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD = 3`, and terminalizes at `MAX_EXECUTE_REQUEUE_LOOP_CYCLES = 6` with `status:"failed"` and an `EXECUTION_DISPATCH_LOOP_EXHAUSTED:` error. FN-7941 hardens the signature against residual human-reported `execute_loop_stall` cases (#2043/#2045/#2046/#2047): the signature now stores terminal-step high-water progress (`done`/`skipped` count plus total planned steps) instead of raw `currentStep` + every step status, so `pending`/`in-progress` drift or `done`↔`in-progress` oscillation cannot reset the counter forever. Only monotonic terminal-step progress resets the streak; decreases/oscillation below the high-water keep counting. The guard preserves worktree/branch/step progress, skips paused/user-paused/done/archived terminalization, still resets on manual retry, successful completion, forward moves, and unpause, and complements rather than replaces the scheduler's wall-clock `dispatchStormCount` guard (fast flapping stays scheduler-owned; slow no-progress flapping is caught here).
  - FN-7926 keeps completed-but-blocked work out of that FN-7863/FN-7941 backstop. When `taskDone === true` or all implementation steps are `done`/`skipped` but `getTaskCompletionBlocker()` still reports a live `blockedBy` or unresolved dependency, the executor parks the task in `todo` with `pausedReason:"completed-work-blocked"`, `status:"queued"`, and a task-log entry containing the exact blocker reason. The park preserves worktree/branch/step progress and clears the execute-requeue signature so completed work cannot accumulate toward `EXECUTION_DISPATCH_LOOP_EXHAUSTED:`. `reconcileCompletedBlockedTasks()` runs in self-healing; once the blocker clears, and only when auto-merge processing is allowed and no live execution/user pause owns the row, it clears the park and calls the completed-task recovery handoff so the work advances to `in-review` without re-running implementation.
  - `reattach-orphaned-assigned-executions` is a forward-resume safety net for durable-agent assignments. During startup recovery and periodic maintenance, after orphaned-agent and stale-heartbeat-run repairs, self-healing finds `in-progress` tasks with an `assignedAgentId` whose agent has no active heartbeat run and no active executor session after the orphan grace window. It re-dispatches in place via `executor.resumeTaskForAgent(agentId)` (the same seam used by clean `HeartbeatMonitor.onRunCompleted` and guarded by executor double-execution checks), emits `task:reattach-orphaned-execution`, and never moves the task backward. This complements engine-start `executor.resumeOrphaned()` and leaves unassigned/role-based execution recovery to the existing startup/limbo/stuck-task paths.
  - Durable `Agent.taskId` is a running assignment for parked `todo`/`triage` task rows only when the agent has live proof: a fresh active heartbeat run or an executor-active/tracked heartbeat signal. Scheduler overlap requeues, task move sync, self-healing, and Reports Health Check share this invariant: stale durable links are cleared or rendered as stale while `status: "queued"` and `overlapBlockedBy` remain on the task row so file-scope lease blocking is not weakened. `fn_list_agents` and `fn_agent_show` render the linked task column next to `Current Task` (for example `Current Task: FN-1234 (triage)` or `Current Task: FN-1234 (not active — done)`) so parked-column planning ownership is not misread as in-progress execution drift.
  - Mission validation has a dedicated stale-run reaper: startup recovery and Batch 2 maintenance call `reapStaleMissionValidatorRuns()` when wired by the runtime, using `VALIDATOR_RUN_STALE_MAX_AGE_MS` (currently 6 hours). The sweep terminates ownerless `mission_validator_runs.status='running'` rows as `error`, writes the reap reason into `summary`, leaves `lastValidatorRunId` pointing at the now-terminal run, and emits run-audit telemetry with `mutationType: "mission:validator-run-reaped"` plus `runId`/`featureId`/`missionId`/`triggerType`/`elapsedMs` metadata. Active mission features move to `loopState="needs_fix"` + `lastValidatorStatus="error"` unless their parent mission is already `complete`/`archived`.

#### Stuck-loop exhaustion terminal contract
When stuck-kill retries are exhausted, `checkStuckBudget()` marks executor-phase tasks `status: "failed"`, moves them to `in-review`, and writes an error that starts with `STUCK_LOOP_EXHAUSTED:`. The error and final task-log line both include the kill count/max and last stuck reason (`loop` or `inactivity`). `StuckTaskDetector` also untracks the task and refuses to re-track it while that failed terminal error remains, preventing further automatic kill/requeue churn. The final log line explicitly states that no further automatic retries will run and directs operators to manually retry, pause, or move the task back to triage to resume work.

Planning-phase stuck kills use the same `stuckKillCount` / `settings.maxStuckKills` budget before execution starts. While under budget, a stuck triage requeue resumes from a non-empty on-disk `PROMPT.md` draft in revision mode and logs resume feedback; if `PROMPT.md` is absent, it falls back to a non-empty `plan` task document. Absent or whitespace-only drafts preserve cold-start behavior, and recoverable written drafts continue through prompt-based planning recovery. At budget exhaustion, triage parks the task as `status: "failed"`, `paused: true` with a `STUCK_LOOP_EXHAUSTED:` error so a reasoning-looping planner cannot restart indefinitely.

Plan Review reviewer outages use a narrower retry state: triage tasks parked as `status: "plan-review-unavailable"` already have an existing `PROMPT.md`, so polling routes them around the full planning agent. Retry rereads the prompt, requires non-empty deterministic-valid content, preserves the file unchanged, and reruns only the Plan Review/finalization path while holding the same global agent semaphore slot as planning/review AI work. APPROVE (or a previously passed Plan Review result) releases the task normally; REVISE/RETHINK moves it to `needs-replan`; another UNAVAILABLE/error refreshes the backoff. Missing, empty, or deterministically invalid prompts fail with a task log instead of cold-starting planning.

Active `fn_run_verification` subprocesses are a bounded progress signal (FN-6598). `createRunVerificationTool()` brackets each command with `StuckTaskDetector.beginVerification()` / `endVerification()`; while the command is active and still inside its own timeout plus cleanup grace, the detector suppresses `loop` and `no-progress-churn` classification so healthy marathon verification output cannot consume stuck-kill budget. `inactivity` is not suppressed: the verification runner must continue emitting line output or synthetic heartbeats, and if the process overruns its recorded deadline or never sends an end signal, normal detection resumes.

If loop recovery times out during compact-and-resume and the executor does not unwind within the bounded force-requeue grace window, `TaskExecutor.markStuckAborted()` now hard-cancels the hung task before clearing execution guards: spawned child agents are terminated, `awaitAbortInFlightTaskWork()` reaps API/step/workflow/configured-command/subagent/CLI surfaces, completed/in-progress steps are reconciled against committed branch state before any checkout deletion, the task worktree is removed with `RemovalReason.ExecutorStuckKilled`, stale in-memory worktree/loop/paused/stuck state is cleared, and then the task is moved back to `todo` with the configured `preserveProgressOnStuckRequeue` semantics. With preserve-progress enabled, committed step progress is retained; when the branch has no unique commits, affected steps are reset to `pending` before the worktree/branch are cleared so a retry cannot skip deleted uncommitted-only work. The path preserves the concurrent-recovery guard: if the latest task column is no longer `in-progress`, it only clears the execution guard and does not reap/remove resources that a self-healing recovery now owns. Task logs distinguish loop detection, compaction timeout, force-kill cleanup start, force-requeue, and cleanup completion/failure.
  - `recoverMissingWorktreeReviewFailures()` is a narrow failed-review recovery: only `status: "failed"` `in-review` tasks with the explicit session-start signature `Refusing to start coding agent in missing worktree:` (from `assertValidWorktreeSession()`) are requeued. Recovery clears stale session metadata (`worktree`, `branch`, `sessionFile`, transient failure state), preserves valid step progress/retry counters, logs the auto-recovery reason, and moves the task back to `todo` for a clean retry.
  - `recoverMergeableReviewTasks()` only re-enqueues truly eligible tasks; retry-exhausted review tasks are skipped to avoid re-enqueue/no-op loops that keep refreshing `updatedAt`.
  - `recoverAlreadyMergedReviewTasks()` auto-finalizes retry-exhausted `in-review` tasks when self-healing can prove their work already landed on the merge target. On this landed-content path it clears soft blockers (`paused`, stale `status: "failed"`, and residual `error`) before moving to `done`; true hard blockers (for example incomplete steps, awaiting-user-review, or failed pre-merge workflow steps) still park the task in stable `in-review/failed` state with a blocker error instead of entering an auto-finalize loop. Already-merged/tip recovery must prove task ownership before setting `mergeDetails.mergeConfirmed` or moving to `done`: accepted evidence is a matching `Fusion-Task-Id`, matching `Fusion-Task-Lineage`, a task-ID anchored conventional subject, or a patch-id/tree-equal fallback from the canonical `fusion/<task-id>` branch whose tip and candidate commit are not explicitly attributed to another task/lineage. Foreign task tips (for example an FN-7143 row pointing at an FN-7187 tip) are rejected in place with `[recovery] already-merged rejected ... reason=foreign-task-tip` and `task:auto-recover-already-merged-rejected` audit metadata instead of finalizing the wrong task.
  - `recoverTransientMergeFailures()` handles retry-exhausted `in-review` merge failures only when `classifyTransientMergeError()` returns a bounded transient class: `lease-handoff-target-not-queued`, `spurious-concurrent-advance-same-sha`, `process-spawn-failure` (`spawn ENOTDIR`, `spawn … ENOENT`, or a clean-room path reported as `is not a working tree`), `ai-provider-turn-failure`, or `network-transport-failure`.
    - FN-8004 added the last two classes. `ai-provider-turn-failure` covers ACP-backed merge models (Grok/OMP/generic ACP) whose turn fails provider-side: `promptAcpSession` preserves the JSON-RPC code as `… (acp rpc code -32603, retryable)` and the classifier anchors on that envelope or the `<Runtime> ACP turn failed:` prefix. Anchoring is deliberate — the bare JSON-RPC text is `Internal error`, which must never match unanchored or it would disguise genuine application defects as retryable blips. Only provider-fault codes (`-32603`, `-32000`…`-32003`) are retryable; caller-fault codes (`-32600`…`-32602`) stay permanent because retrying repeats the failing call.
    - `network-transport-failure` is a delegation to `isTransientError()`, closing a real asymmetry: the inline retry gate (`ProjectEngine.maybeRetryTransientMerge`) accepted `isTransientError(msg) || classifyTransientMergeError(msg)`, while this sweep consulted only the classifier. Errors such as `ECONNRESET`/`socket hang up` therefore earned inline retries but became invisible to the sweep once parked `failed` — stranding them permanently. Both gates now share one definition by construction. To keep this delegation from importing the detector's `usage-limit-detector.js → logger.js` chain (the chain FN-5627 split the classifier out to avoid), the pure predicates live in the import-free leaf `transient-error-patterns.ts`, re-exported by `transient-error-detector.ts`.
    - Because `status:"failed"` is itself what suppresses both recovery paths, a misclassification here is not merely a missed retry — it is terminal. FN-8004's 20-second Grok blip permanently parked a task whose branch held complete, reviewed work. Recovery resets `mergeRetries`, clears transient `status`/`error`, increments `mergeDetails.transientRecoveryCount`, and requeues auto-merge so the next attempt recreates the AI-merge clean room. The budget stays capped by `MAX_TRANSIENT_MERGE_RECOVERIES`; exhausted tasks remain parked with the `merger:transient-failure-budget-exhausted` audit path so real structural failures cannot loop forever. FN-6278 makes this recovery mostly after-the-fact insurance for cwd spawn faults: the merge runner now preflights reuse integration roots and repairs/reacquires missing or de-registered task worktrees before the first git spawn, so a stale `task.worktree` should not consume the transient recovery budget by repeatedly producing `spawn git ENOENT`.
  - `reconcileTaskWorktreeMetadata()` (FN-4962) reconciles stale `task.worktree`/`task.branch` rows against authoritative `git worktree list --porcelain` branch mappings during startup recovery, periodic maintenance, and completion fan-out. The stage must run before `reclaim-stale-active-branches`: stale rows rebound to live `fusion/<id>` worktrees emit `task:auto-recover-worktree-metadata-rebound`; stale rows with no live branch mapping are nulled (`worktree=null`, `branch=null`, `baseCommitSha` unchanged) and emit `task:auto-recover-worktree-metadata-cleared`.
  - `recoverInProgressLimbo()` (FN-5219) is the safety net for stranded executor rows: reset/requeue paths must never leave a task in `in-progress` without a runnable execution context. After metadata reconcile, stale `in-progress` tasks with null branch, missing/cleared worktree metadata, no live executor claim, and all-pending steps are audited and moved back to `todo`.

##### Orphan-only scope-violation auto-recovery
`recoverOrphanOnlyScopeViolations()` handles the narrow FN-4350 shape without weakening the file-scope invariant: it runs only when all of these predicates hold — task is `column === "in-review"`; task is failed (`status === "failed"`, with engine/global pause both off); error evidence is a FileScopeViolation (`tool_error` agent-log payload from `formatFileScopeViolationAgentLog`, with `task.error` prefix fallback); `task.scopeOverride !== true`; task is not actively executing and `mergeDetails.mergeConfirmed !== true`. It then verifies the task's specific work is already on `main` using `findAlreadyMergedTaskCommit` (Fusion-Task-Id trailer / ancestry / patch-id / tree-equality proof). Only when staged files are orphan-only (no declared-scope overlap after excluding `.changeset/*`) and main-branch proof is positive does it finalize as a no-op (`resolutionStrategy: "orphan-discard-no-op"`), append an explicit auto-recovery log line, and tear down the task worktree so orphan staging is discarded.

Guardrails: this routine does **not** retry merges, does **not** apply to mixed/non-orphan staging, and does **not** run when no landed-work proof exists (FN-4280 class protection).
  - FN-4285 decision: tree-equality recovery (`rev-parse <base>^{tree}` == `<task-branch>^{tree}`) in `findAlreadyMergedTaskCommit` closes stranded already-merged branches that evade trailer/ancestry/patch-id matching. FN-7220 tightens the guardrail: patch-id and tree-equal matches imply ownership only from the canonical task branch and are rejected when either the branch tip or candidate merge-target commit carries a foreign Fusion task/lineage trailer.
  - No-`fn_task_done` recovery classification is normalized across executor, restart recovery, and self-healing: detection keys on executor-emitted `"without calling fn_task_done"` strings (while still tolerating legacy `task_done` wording), then applies the bounded ladder deterministically (in-session retries → bounded todo requeues with preserved progress when appropriate → terminal surfaced failure when budget is exhausted).
  - `clearStaleBlockedBy()` clears `blockedBy` (and transient `status`) on todo tasks when their blocker is missing, done, archived, paused in-review, or failed in-review with merge retries exhausted. FN-3924 extends this with a dependency-integrity guard: if a task has explicit dependencies and `blockedBy` is not one of the currently unresolved deps, the stale marker is cleared. FN-4091 broadens the sweep to active `in-progress` and un-paused `in-review` tasks as well, but those repairs only null `blockedBy` (they do not rewrite scheduler-owned queued state). FN-5488 adds two fast paths: (1) failed in-review blockers at/above `MAX_AUTO_MERGE_RETRIES` always fan out unblock recovery with explicit reason codes, and (2) `status="merging"|"merging-pr"` blockers with no active merger owner are treated as unbacked after a short grace window (`unbackedMergingFanoutGraceMs`, default 60s) so manual retry/unpause `updatedAt` refreshes cannot deadlock downstream todos indefinitely. Recovery logs now use `Auto-recovered (FN-5488): ... reason=<code>` for auditability while preserving FN-4538 overlap-blocking invariants.
  - FN-5624 suppresses transient worktree-local `.fusion/tasks/<id>/task.json` ENOENT session-start failures. When the missing file path is under `task.worktree`, executor routes through unusable-worktree auto-recovery, skips persisting `status: "failed"`/`error` on the task row, and emits `[transient-task-json-suppressed] ... reason=missing-task-json-under-worktree`. The corresponding self-healing `Auto-recovered:` log entry keeps notification suppression aligned with the existing `/^Auto-recovered:/` grace-window rule.
  - `inspectBranchConflict()` now treats self-owned zero-attribution collisions as reclaimable (instead of foreign) when ownership is proven by task/worktree identity, so stranded self-branches do not enter unrecoverable loops.
  - `reclaimSelfOwnedBranchConflicts()` includes paused `branch-conflict-unrecoverable` tasks (not just todo/in-progress), clearing paused/error state in one update and requeueing only when parked in `in-review`.
  - FN-6736 adds a phantom executor-binding liveness gate to the same reclaim path. When the only remaining veto is an in-memory `executor-active`/live-worktree signal, the task is `in-progress`, the execution age is far beyond grace, `checkedOutBy` is empty, no active heartbeat/agent row exists, and run-audit activity is stale, self-healing force-clears the phantom executor binding and requeues the task to `todo` with worktree and progress preserved. Live evidence still wins (FN-4811), missing-worktree limbo remains owned by `recoverInProgressLimbo()` (FN-5219), and the path does not increment FN-5704 resume-limbo counters.
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
  - FN-8064 writes best-effort proactive `status` rows to the task-detail chat for step start, completion, intentional skips, and failure in both step-session/graph callbacks and store-accepted default `fn_task_update` transitions. Graph and legacy review paths each write one reviewer row: plan/spec APPROVE uses the plan-verified message; other real verdicts use the verdict message; `UNAVAILABLE` and reviewer exceptions write a safe operational "review could not complete" status without claiming a verdict. Failure and review-summary diagnostics are nullish-safe, secret-redacted, absolute-path/stack/newline stripped, and capped at 300 characters, so narration never blocks execution or persists raw command output.
- `RunAudit` (`run-audit.ts`) — mutation audit tracking (DB/git/filesystem)
  - FN-7214: `task:reenter-paused-aborted-workflow-node` records executor re-entry after a typed workflow graph node was interrupted by engine pause/resume. Metadata includes `nodeId`, `fromColumn`, retry `attempt`/`maxAttempts`, `abortProvenance`, whether the task was preserved in `in-review`, and the re-entry `mode`.
  - FN-7220: `task:classify-stale-in-review-plan-pause-abort-replay` records executor classification of a stale generic `in-review` plan-node pause/resume replay. Metadata includes `nodeId`, `fromColumn`, `abortProvenance`, whether a stale failure was cleared, `graphResumeRetryCount`, and `mode: "preserved-in-review"`.
  - FN-7220: `task:auto-recover-already-merged-rejected` records self-healing rejection of cross-task already-merged/tip metadata. Metadata includes `reason` (`foreign-task-tip`, `foreign-lineage-tip`, or `foreign-landed-commit`), `phase`, candidate SHA, candidate owner when known, task branch, and merge target branch.
  - FN-6782/FN-6796: `task:auto-recover-paused-abort-park` records self-healing recovery of pause-abort operator parks. Metadata includes the source column and whether recovery preserved a clean `in-review` row instead of requeueing to `todo`.
  - FN-7069: `task:reconcile-phantom-committed-reservation` records task-store startup or self-healing cleanup of committed-reservation-without-task phantoms. Metadata includes `reservationStatus: "committed"` plus pruned `activityLog` and `agents` counts; `runAuditEvents` and the committed reservation are intentionally retained for auditability and ID permanence.
  - FN-7074: `task:reservation-commit-rolled-back` records preventive create-path rollback when a distributed reservation was committed with the task-row insert but a later create materialization step failed. Metadata includes `{ reservationId, nodeId, reason: "failed-create", error }`; the task row/partial directory are removed and the reservation is moved to `aborted` so FN-7069 should not need to clean up a new phantom.
  - FN-7863: `task:execution-dispatch-loop-terminalized` records executor terminalization of a no-progress execute-node self-requeue loop. Metadata includes `{ taskId, cycleCount, maxCycles, progressSignature, failureValue }`; the task row carries `EXECUTION_DISPATCH_LOOP_EXHAUSTED:` and remains in its visible failed state with committed/step progress preserved.
  - FN-7926: `task:completed-blocked-parked` records executor diversion of completed work whose `getTaskCompletionBlocker()` is still live, and `task:completed-blocked-advanced` records self-healing advancement after that blocker clears. Metadata stays ids/counts/outcomes-only (`taskId`, blocker/source/prior column/status) so operators can distinguish dependency waits from real execute-loop exhaustion.
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
<!--
FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
Under shared PostgreSQL, mesh services own membership/auth/claims — not task replication. Durable board state is the shared database; PeerExchange no longer multi-masters tasks or settings over HTTP.
-->
- `NodeHealthMonitor` (`node-health-monitor.ts`) — remote node liveness/metrics checks for handoff and recovery
- `PeerExchangeService` (`peer-exchange-service.ts`) — membership gossip + optional auth material; settings/task HTTP replication disabled when nodes share Postgres
- `MeshLeaseManager` (`mesh-lease-manager.ts`) — canonical abandoned-lease detection + recovery path (`central.task_claims` then task-row mirror)

### Outage ownership boundaries (topology/auth only)
- Durable **task** state does not queue offline over mesh when Postgres is down. If the shared database is unavailable, nodes do not invent alternate local task truth.
- `CentralCore` still exposes `meshSharedSnapshots` + `meshWriteQueue` for **topology / auth** retry and degraded membership reads (`recordMeshSnapshot`, `getLatestMeshSnapshot`, `enqueueMeshWrite`, `listPendingMeshWrites`, `markMeshWrite*`, `getMeshDegradedReadState`).
- `PeerExchangeService` classifies retryable **membership/auth** sync failures, may enqueue those narrow scopes, and replays them via `replayPendingWritesForNode(targetNodeId)`. Task/settings payloads are not queued for multi-leader replay under Postgres.
- `NodeHealthMonitor` liveness transitions may trigger membership/auth replay attempts (`onNodeRecovered`); `online` is not proof that replay succeeded.
- Dashboard mesh routes (`register-mesh-routes.ts`) keep `GET /api/mesh/state` and attach degraded `readState` metadata when peer probes fail.

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
- Canonical multi-node contract: [`docs/shared-mesh-protocol.md`](./shared-mesh-protocol.md) (shared Postgres + claims; multi-leader HTTP task replication retired).
- Distributed task-ID allocation is a **shared-database** primitive (not a remote mesh coordinator):
  - Durable state lives in Postgres `project.distributed_task_id_state` / `distributed_task_id_reservations` (async allocator path).
  - Reserve/commit/abort run against those shared rows under the project’s transactions. Default reservation TTL is `15 * 60 * 1000` ms. Expired/aborted reservations are **burned** and never reissued. Failed creates abort the still-reserved reservation (or roll back a just-committed reservation via `task:reservation-commit-rolled-back` when create materialization fails after the commit flip); once a reservation is fully committed with a durable task row, it is final and not re-aborted as an ordinary abort.
  - `committedClusterTaskCount` is the authoritative committed-task count for a prefix within a project partition.
  - Store open reconciles each prefix high-water mark past existing live/archived/reservation sequences.
  - `/api/mesh/task-ids/*` always uses the local allocator under Postgres (shared rows are the coordinator). Remote coordinator forwarding is disabled.
- Task creation: reserve → insert task (shared DB) → commit reservation (or abort on failure). HTTP peer task replication and `applyReplicatedTaskCreate` multi-node fan-out are not part of the Postgres multi-node path.
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
- System stats snapshot and vitest process controls APIs (`GET /api/system-stats`, `POST /api/kill-vitest`) exposing dashboard process/system telemetry (including app CPU percentage and host memory rendered as numeric values, radial gauges, and trend sparklines in the Command Center System area), task/agent aggregates, and manual vitest process termination. Host-memory usage is derived from shared OS-available memory (`process.availableMemory()` with an unreliable `freemem` fallback) rather than raw free pages so macOS inactive/cache memory is not counted as used.
- Command Center analytics APIs (`GET /api/command-center/tokens`, `/tools`, `/activity`, `/productivity`, `/team`, `/github`, `/signals`, `/plugin-activations`, `/live`) are project-scoped dashboard routes. `/productivity` reads Lines changed from nullable `task_commit_associations.additions`/`deletions` merge-time or backfilled diff stats, derives estimated `hoursSaved` from that LOC via the exported `HUMAN_LINES_PER_HOUR` rate, and keeps the unavailable sentinel for both fields when no in-range association has stats. `POST /api/command-center/productivity/backfill-loc` is the explicit operator-triggered, dry-run-defaulting local-git backfill for historical NULL stats; it is not run during dashboard rendering or analytics reads. Its `taskDuration` payload aggregates done tasks whose `executionCompletedAt` falls in the selected range, using positive `tasks.cumulativeActiveMs` values for completed count, average, median, p90, and total active execution time; missing qualifying durations remain unavailable rather than zero. `/signals` aggregates real local `incidents` rows for total/open/resolved counts, MTTR, and source/severity/status breakdowns and returns honest empty/unavailable sentinels instead of synthetic signal volume. `/plugin-activations` aggregates persisted plugin/extension load events for the selected range and returns unavailable when no rows exist instead of treating missing history as zero activations.
<!-- FNXC:CommandCenter 2026-06-21-00:00: Maintainers need the pricing contract in architecture docs: MODEL_PRICING is hand-maintained, pricingAsOf changes with every rate edit, provider coverage includes OpenAI/Codex/Anthropic/Gemini, and Command Center never guesses or persists costs. -->
<!-- FNXC:CommandCenter 2026-06-22-00:00: FN-6876 made pricing operator-editable: user/global overrides and LiteLLM one-click refreshes must take precedence over the built-in table while remaining estimates, not persisted billing truth. -->
<!-- FNXC:CommandCenter 2026-06-25-13:30: Document the `openai-codex:*` keying gotcha explicitly. Codex runs persist the `openai-codex` provider, so their pricing entries must be keyed `openai-codex:<modelId>` (a whole dedicated section in model-pricing.ts) or cost reads `unavailable`; the maintenance contract doc must name this so the rule survives. -->
- Model pricing & cost estimation: Command Center token cost is derived at read time by `packages/core/src/model-pricing.ts` and is not persisted as billing truth. Maintainers still update the built-in `MODEL_PRICING` fallback table in that file; keys are lowercased `${provider}:${model}` with a bare `:model` fallback for callers that only know the model id. Codex runs store the `openai-codex` provider, so those rates must be keyed explicitly as `openai-codex:*` (for example `openai-codex:gpt-5-codex`) rather than relying on the OpenAI provider or bare-model fallback, otherwise Command Center shows their cost as `unavailable`. Each entry stores USD per 1M tokens for input, output, cache-read, and cache-write plus a `source` citation. Bump `pricingAsOf` in the same change as any built-in rate edit, because the dashboard surfaces it as the **prices as of** date and marks entries low-confidence after `PRICING_STALE_AFTER_MS` (approximately 180 days / two quarters) relative to that date. Global `modelPricingOverrides` from Settings take precedence over built-ins using the same exact-key then bare-model lookup order; `POST /api/command-center/pricing/fetch` is the only dashboard network path and fetches LiteLLM's model pricing JSON on explicit user action, parses it through the pure core parser, persists the resulting overrides with fetched metadata, and leaves the prior overrides intact on fetch/parse failure. Unknown models resolve to `unavailable` rather than a guessed price.
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

#### End-to-end project-scoping invariant

- Every task-data route resolves its request project once through `getProjectContext`/`getScopedStore` (or the canonical resolver used by real-time providers) and uses that resolved store for the whole handler. A supplied `projectId` never falls back to the injected/default store; unscoped launches retain the resolver's single-project fallback.
- `/api/events` and `/api/ws` bind their listeners to that same request-scoped store. Their project-scoped channel keys and listeners prevent events from one project's task IDs from reaching another project, including when IDs overlap.
- Project-scoped client hooks capture the active project context/version before starting fetches, SSE subscriptions, WebSocket callbacks, or reconnect work. Before applying an async result or event they reject work whose captured context is stale, emit the shared `dropped-stale-event` dashboard trace where applicable, and leave the newly active project's state untouched.
- The canonical client implementation is `useProjectContextGuard`, as used alongside the established `useTasks` and badge-WebSocket guards. New project-scoped hooks must reuse this capture-at-start and stale-drop pattern rather than independently comparing mutable current-project state.
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
- **Stale planning liveness invariant:** stale-processing eviction never removes a task with a live, non-aborted triage session (`activeSessions.has(id) && !stuckAborted.has(id)`). It therefore remains in `getProcessingTaskIds()` and cannot be finalized, cleared for replanning, or priority-nudged by planning recovery sweeps. Hung promises without a session and stuck-aborted/disposed sessions remain reclaimable after the stale threshold.
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
  - Response: `{ status: "ok" | "degraded", version: string, uptime: number, database: { healthy: boolean, corruptionDetected: boolean, corruptionErrors: string[], isRunning: boolean, lastCheckedAt: string | null }, taskIdIntegrity: { status: "ok" | "anomaly" | "error", checkedAt: string | null, anomalies: [...], error?: string, recommendedAction: string | null } }`
  - PostgreSQL startup and explicit refreshes never open or inspect a SQLite file. The server derives the live async layer from its `TaskStore`; a missing layer fails health closed instead of falling back to a synchronous healthy sentinel.
  - The compatibility-shaped `database.corruptionDetected` and `database.corruptionErrors` fields carry PostgreSQL connectivity and health-query failures so existing dashboard clients receive an actionable degraded response.
  - The former background `PRAGMA integrity_check` scheduling, per-`fusion.db` deduplication, and SQLite corruption notification behavior are pre-cutover history only; they are not a runtime fallback.
  - `POST /api/health/refresh` recomputes PostgreSQL connectivity and task-ID integrity on demand. Detector failures return `taskIdIntegrity.status: "error"` and degrade the top-level status; they are never rewritten as an empty healthy report.
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
- **Database** — task:create, task:update, task:move, etc. Node handoff/recovery emits structured events: `node:handoff:parked` (handoff denied/parked), `node:handoff:reassign-local` (local takeover approved), `node:handoff:reassign-any` (any-healthy takeover approved), and `node:lease:recovered` (abandoned lease cleared and task requeued).
- **Database / `overseer:intervention`** (FN-7519, emission façade FN-7520, runtime wiring FN-7551) — the planner-overseer intervention timeline's single canonical mutation type. `target` is the task ID; metadata carries the six intervention field groups (`stage`, `reason`, `action`, `outcome`, optional `attemptCount`/`attemptLimit`, optional `sourceLinks`). Written only via `recordPlannerIntervention` and read via `getPlannerInterventionTimeline`/`parseInterventionEntry` (`packages/core/src/planner-intervention.ts`) so no parallel audit store or timeline-mapping exists; surfaced read-only in the task-detail Intervention Timeline (`GET /tasks/:id/overseer/interventions`). FN-7520 adds the canonical `emitOverseerObservation` / `emitOverseerSteering` / `emitOverseerRecoveryAttempt` / `emitOverseerRetry` / `emitOverseerConfirmation` / `emitOverseerEscalation` emission façade (`packages/core/src/planner-overseer-events.ts`) that fixes each decision-point category's `action`/default `outcome` and funnels through `recordPlannerIntervention` — the single seam FN-7511/FN-7512/FN-7513 call rather than emitting `overseer:intervention` events inline. FN-7551 wires this façade to the LIVE runtime: `ProjectEngine`'s `PlannerOverseerMonitor#onObservation` callback (deduped per `(taskId, stage:signal)`), `buildPlannerRecoveryHandlers` (steering/retry/targeted-fix/confirmation-request, plus `PlannerRecoveryController`'s new optional `onConfirmationResolved` hook for the approve/deny resolution), and `pollPlannerOverseer`'s bounded-recovery-exhaustion escalation (deduped per `(taskId, stage)`) — so the intervention timeline now reflects real engine activity, not only synthetic unit-test entries.
- **Git** — worktree:create, worktree:remove, `worktree:remove-fallback` (metadata `{ fallback: "filesystem-non-empty", error }` when native git removal falls back to filesystem removal + admin prune), commit:create, merge:resolve, merge:audit-failure, `worktree:reanchored`, and worktrunk lifecycle events (`worktree:worktrunk-install|create|sync|prune|remove`, plus `worktree:worktrunk-fallback`, `worktree:worktrunk-failure`, and `worktree:worktrunk-fallback-native`). Worktrunk events share metadata `{ op, binaryPath?, worktreePath?, durationMs?, exitCode?, stderrPreview?, installSource?, prunedCount? }` with `installSource` (`"release-binary" | "cargo"`) limited to successful `worktree:worktrunk-install` events and `prunedCount` limited to successful prune events when known. `worktree:worktrunk-install` is emitted only for true install actions; cache hits, configured `worktrunk.binaryPath` overrides, and `$PATH` resolutions intentionally remain silent. Dirty post-merge audit outcomes emit `merge:audit-failure` with metadata `{ mode, strategy, action, reason, issueCount, duplicateSubjectCount, touchedFileOverlapCount, verificationPassed, auditTargetLabel }`. FN-5279 adds `merge:reuse-handoff-acquired`, `merge:reuse-handoff-refused`, `merge:reuse-handoff-released`, and `merge:reuse-handoff-deferred-to-worktrunk` for task-worktree auto-merge handoff visibility. FN-5351 adds `merge:integration-worktree-state` (pre-handoff checkout/dirty snapshot for resolved integration branch), `merge:cwd-integration-fallback-refused` (terminal refusal park event), and `merge:integration-ref-advance` (integration ref advance outcome telemetry).
- **Git / `merge:file-scope-violation`** — emitted by the merger when `FileScopeViolationError` aborts a squash. `target` is the task ID; metadata includes `stagedFiles`, `declaredScope`, `resetLabel`, `stagedFileCount`, and `declaredScopeCount`. Consumed by `fileScopeInvariantFailuresPerDay` in `GET /api/health/reliability` (FN-4360).
- **Git / `merge:no-op-attribution-mismatch`** — emitted by the rebase landed-files attribution guard (FN-5304) when `<rebaseBaseSha>..HEAD` has zero attributable own commits but the source `fusion/<id>` tip still carries attributable own commits. `target` is the task ID; metadata includes `recordedSha`, `rebaseMergeBaseSha`, `sourceBranchRef`, `sourceBranchOwnCommitCount`, and `sourceBranchOwnCommitShas`.
- **Git / `merge:no-op-attribution-mismatch-skipped`** — emitted when the FN-5304 source-tip guard cannot run because the source branch ref is unavailable (for example already pruned). `target` is the task ID; metadata includes `reason` (`"source-ref-unavailable"`).
- **Database / `task:auto-recover-misrouted-foreign-commit`** — emitted per dropped misrouted commit during FN-4948 contamination recovery. `target` is the recovering task; metadata carries `{ droppedSha, foreignTaskId, paths }`.
- **Database / `task:no-commits-finalize-blocked-incomplete-steps`** — emitted by no-op finalize lanes when a `noCommitsExpected` task has no net branch changes but incomplete/skipped steps outweigh done steps. Metadata includes `{ reason, doneCount, incompleteCount, lane, classification?, baseRef? }`; the accompanying task log explains that the task was demoted to `todo` with progress preserved instead of finalized as done.
- **Database / `task:orphan-detected-no-action`** — emitted by `recoverOrphanedExecutions` (FN-5337) when row metadata looks orphaned after grace windows; annotation-only event with no lifecycle mutation (`in-progress` task stays put).
- **Database / `task:reattach-orphaned-execution`** — emitted by `reattachOrphanedAssignedExecutions` (FN-6336) when self-healing re-dispatches an idle assigned `in-progress` task forward via `executor.resumeTaskForAgent(agentId)` after proving the assigned agent has no active heartbeat run or active execution.
- **Database / `task:reconcile-stale-agent-assignment`** — emitted when self-healing or heartbeat reconciliation clears stale durable `Agent.taskId`/`state` for a task parked in `todo`/`triage` without live execution proof. Metadata includes `{ agentId, taskId, taskColumn, agentState, status, blockedBy, overlapBlockedBy, hadFreshRun, hadActiveExecution, reason }`; task queue/lease fields are preserved.
- **Database / `task:reconcile-stale-duplicate-decision`** — emitted when self-healing clears a triage-marker duplicate-decision pause whose canonical is missing, deleted, done, or archived. Metadata is ids/outcomes-only: `{ taskId, canonicalId, canonicalColumn, canonicalDeleted, priorPausedReason }`; active canonicals and user pauses are excluded.
- **Database / `task:soft-delete-column-reconciled`** — emitted by `reconcileSoftDeletedColumnDrift` (FN-5566, re-land FN-5446) when a soft-deleted row (`deletedAt IS NOT NULL`) is found with legacy `column != 'archived'`; rewrites only `column` (no resurrection), with metadata `{ previousColumn }`.
- **Database / `session:runtime-resolved`** — emitted once per `createResolvedAgentSession` call with metadata `{ sessionPurpose, runtimeId, wasConfigured, provider, modelId, mockProviderActive, testModeActive, runtimeHint? }` for per-lane runtime/provider attribution.
- **Database / `task:reconcile-dependency-blocking-lease`** — emitted by `reconcileDependencyBlockingLeases()` (FN-6292) when self-healing rebounds an `in-progress` holder to `todo` because an unmet dependency is blocked by the holder's stale file-scope lease. Metadata includes the dependency ID, blocked-by marker, and unmet dependency list.
- **Database / `task:reconcile-in-review-unmet-dependencies`** — emitted by `reconcileInReviewUnmetDependencies()` (FN-6793/FN-6797) when self-healing rebounds an `in-review` task to blocked `todo` because one or more declared dependencies are still unmet. Metadata includes `unmetDeps`, `blockedBy`, and prior review status; the `-no-action` companion is emitted when task pause/user-pause, `autoMerge:false`, live execution/checkout proof, or a failed rebound mutation prevents the backward move.
- **Database / `task:reconcile-orphaned-task-dir`** — emitted by `TaskStore.reconcileOrphanedTaskDirs()` (FN-6783) when store open or self-healing Batch 1 re-imports a valid live `.fusion/tasks/{ID}/task.json` directory with no PostgreSQL task row anywhere. Metadata includes the recovered ID, column, status, and task JSON path.
- **Database / `task:*-no-action` backward-move family (FN-5335)** — backward self-healing sweeps now emit annotation-only events when triple proof fails instead of mutating lifecycle state. New mutation types: `task:reclaim-pr-conflict-no-action`, `task:reclaim-self-owned-branch-conflict-no-action`, `task:auto-rebound-scope-decay-no-action`, `task:finalize-no-op-review-no-action`, `task:stale-incomplete-review-no-action`, `task:ghost-review-no-action`, `task:stuck-merge-deadlock-no-action`, `task:no-progress-no-task-done-no-action`, `task:missing-worktree-review-no-action`, `task:partial-progress-no-task-done-no-action`, `task:reconcile-dependency-blocking-lease-no-action`. See `docs/self-healing-backward-move-audit.md` for per-stage disposition.
- **Filesystem** — file:write, prompt:write, attachment:create, etc.
- **Sandbox** — backend lifecycle events from `SandboxBackend` wiring in executor/merger/routine-runner (`sandbox:prepare`, `sandbox:run`, `sandbox:failure`, `sandbox:fallback`) introduced after FN-4636.

Events are tied to specific run IDs for end-to-end traceability.

For scheduler concurrency diagnostics, the queued reason now names the active limiter(s) and usage (for example `gate=maxConcurrent ...`). The reason includes the `bindingGates` (`maxConcurrent`/`maxWorktrees`/`semaphore`), per-gate `{ used, limit, slack }`, `holders`, and computed `available`. `holders.maxConcurrent` and `holders.maxWorktrees` are current `in-progress` task IDs; `holders.semaphore` mirrors that set but semaphore slots can also be consumed by triage/merge agents outside `in-progress`. So if `semaphore.used` exceeds the visible holder list, that usually indicates non-execution agents are legitimately consuming shared capacity (not stale accounting). `maxWorktrees` is also enforced inside `TaskStore.moveTaskInternal` when committing an allocated move into `in-progress`, making it a hard active execution worktree cap even when workflow WIP/`maxConcurrent` would allow more tasks. These queued-reason logs are transition-only: a newly emitted line indicates the limiter signature changed or the condition cleared and later reappeared, not that a poll loop simply observed the same blocked state again.

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
- **PostgreSQL**: project-scoped rows in the `project` schema
- **Identity marker**: `.fusion/project.json`
- **Filesystem blobs** (task-local artifacts):
  - `.fusion/tasks/{TASK_ID}/PROMPT.md`
  - `.fusion/tasks/{TASK_ID}/agent.log`
  - `.fusion/tasks/{TASK_ID}/attachments/*`

PostgreSQL schema is initialized by `packages/core/src/postgres/schema-applier.ts`; project isolation is enforced by `projectId` keys and async data-layer binding.

### Central storage (multi-project)
- **PostgreSQL central schema**
- Schema in `packages/core/src/postgres/schema/central.ts`
  - `projects`, `projectHealth`, `centralActivityLog`, `globalConcurrency`, `nodes`, `peerNodes`, `projectNodePathMappings`, `settingsSyncState`, `__meta`
- `projectHealth.inFlightAgentCount` and `globalConcurrency.currentlyActive` are persisted slot/health bookkeeping fields. They are not live read-layer running-agent counts; dashboard and CLI read surfaces derive current running agents from tasks in `column === "in-progress"` while leaving slot acquire/free semantics and DB column names unchanged.

### Memory files
- OpenClaw-style memory workspace:
  - `.fusion/memory/MEMORY.md`
  - `.fusion/memory/YYYY-MM-DD.md`
  - `.fusion/memory/DREAMS.md`
- The legacy top-level memory file is migration-compatibility only (seed/alias behavior) and is not canonical storage.

### File-based side stores
Some data remains intentionally filesystem-based:
- Agent instruction bundles and heartbeat markdown: `.fusion/agents/*` (`AgentStore`)

Agent/message/approval metadata and history persist in PostgreSQL.

### Migration from legacy SQLite/file storage
- Detection + migration: `packages/core/src/postgres/sqlite-migrator.ts` and startup-factory migration helpers
- Imports legacy `fusion.db`, `archive.db`, and file records into PostgreSQL once
- Legacy databases/backups remain recovery input and are never runtime write targets

### Archive system
- Archived task snapshots are stored in PostgreSQL cold-storage tables
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
- **Review phase**: pre-merge review gates run as workflow-graph nodes — the graph's node handlers invoke `reviewStep()` (`reviewer.ts`) and record outcomes into `task.workflowStepResults`. Review level is a creation-time preset that writes the task's enabled workflow steps at create; the runtime does not re-read it, and the legacy in-session `fn_review_step` tool is deleted.
- **Merge phase**: `aiMergeTask()` handles merge strategy and post-merge workflow steps

> **Fast Mode:** Tasks with `executionMode: "fast"` skip optional pre-merge workflow-graph gates unless explicitly selected. Completion blockers (tests, build, typecheck from PROMPT.md) and post-merge workflow steps remain enforced.

### Step status model
Task steps use statuses: `pending`, `in-progress`, `done`, `skipped`.

### Workflow steps
- Defined in project config as `WorkflowStep`
- **Pre-merge** steps run as workflow-graph nodes — bypassed in fast mode unless explicitly selected. The executor's `runWorkflowSteps()` loop is deleted; the graph is the only pre-merge gate runner, and it records outcomes into `task.workflowStepResults`.
- **Post-merge** steps run in merger (`runPostMergeWorkflowSteps()`)

#### Graph ownership is unconditional (U10b)

There is no legacy execute path. `executeWorkflowGraph()` (formerly `maybeExecuteWorkflowGraph`,
which returned "did the graph claim this task") returns `void`: every `execute()` is graph-owned,
`runImplementation()` requires a `graphCompletion` callback, and a TaskStore that cannot resolve a
workflow selection fails closed loudly rather than falling through to an executor with no gates.

#### `needs-replan` is a graph-owned signal, not legacy residue

`task.status === "needs-replan"` is written by the graph's own `plan-replan` seam (the
`plan-review --failure--> plan-replan` edge → `requestPreMergeOptionalStepFix`) and by the
stale-spec / filesystem-validation guards that feed the same loop. It is consumed by triage (todo
rediscovery, and the surgical-revision seed that edits a rejected `PROMPT.md` instead of rewriting
it), by hold-release (blocks re-dispatch of a plan the reviewer just rejected), and by
`task-merge` (auto-merge block). The adoption census in `legacy-adoption.test.ts` deliberately
requires the literal to still be written in `executor.ts` — it guards the graph's writer. Migrating
those readers to a purpose-built workflow run-state signal is a deferred post-cutover follow-up
(a naming/purity change), not un-migrated legacy machinery.

### Task pause ownership
- Only explicit user actions pause ordinary tasks: the dashboard/CLI task pause controls and manual `in-progress → todo` moves. System safety pauses remain reserved for explicit approval waits and bounded guardrails such as token-budget, worktrunk-failure, and dispatch-oscillation protection.
- Agent pause/sleep and heartbeat recovery never pause assigned tasks. Assigned tasks stay in their current column and retain their existing `paused`/`pausedByAgentId` state so the scheduler can re-dispatch unpaused work and user-paused work remains intentionally parked.
- Only explicit user unpause actions may clear `task.userPaused`; engine self-healing, heartbeat/agent resume cascades, and approval resume paths must leave user-paused tasks parked.

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

- **Substrate (engine-owned, never workflow-configurable):** `AgentSemaphore`, checkout leases, worktree/git/session ops, PostgreSQL transactions, the crash-recovery machinery, the audit trail, the global max-sessions cap, and the three non-configurable lost-work merge guards (no sibling `fusion/fn-*` target, line-anchored attribution, no `modifiedFiles` clear on a no-op finalize).
- **Policy (workflow/trait-owned):** transition validity, WIP/capacity, hold/release, drag meaning, retries, merge strategy, squash posture, file-scope enforcement mode.

**Transition authority.** `moveTaskInternal` remains the single transition authority. Flag-on, it swaps the `VALID_TRANSITIONS` lookup for workflow-resolved column-graph validation (`resolveAllowedColumns`/`workflowHasColumn` in `workflow-transitions.ts`) plus sync trait guards run in-lock; rejections are typed `TransitionRejection`s. `VALID_TRANSITIONS` and the closed `Column`/`COLUMNS` helpers in `types.ts` are `@deprecated` while the flag exists — retained as the flag-off authority and the parity oracle, not yet removed.

**Trait model.** A trait is declarative flags + optional lifecycle hooks (`guard`, `gate`, `onEnter`, `onExit`, `releaseCondition`), resolved through one registry (`trait-registry.ts`, built-ins in `builtin-traits.ts`). Sync `guard` and the `complete`/`archived` flags are built-in-only; plugin traits (KTD-7) get async hook points only and route through the prompt-session/script machinery. Composition conflicts are rejected at save both in the editor and server-side (`assertColumnTraitsValid` in `createWorkflowDefinition`/`updateWorkflowDefinition`, surfaced as a 400). Capacity is enforced in-txn (KTD-10), never bypassable — not a guard. Enter/exit effects run post-commit, idempotent, guarded by the `transitionPending` marker; a throwing/missing plugin hook degrades (audit) and never strands the card or wedges the lock.

**Graduation.** The flag default-flip is gated by `computeWorkflowColumnsGraduationReport()` (`workflow-parity.ts`; store method `TaskStore.computeWorkflowColumnsGraduationReport`), aggregating: five-invariant dual-observe parity, default-workflow transition parity vs `VALID_TRANSITIONS` (`checkTransitionParity`), and the U6 dual-accept marker/column disagreement count. `ready` is true only when all gates pass over a non-empty observation window. The report is the gate; it does not flip the flag.

**Execution-entry invariant: unplanned/intake-resident cards never enter a processing column (FN-7648).** The hold/release sweep (`runHoldReleaseSweep` in `packages/engine/src/hold-release.ts`, driven from `Scheduler.runHoldReleaseSweepPass`) releases a `hold`-trait card into the nearest downstream `countsTowardWip` column. A card must never be released while it is still unplanned — `status === "planning"` (specified-in-place), its PROMPT.md still equals `buildBootstrapPrompt(...)` (the bootstrap stub), or it is resident in a column carrying the `intake` trait. This is enforced by one shared, trait-based predicate, `isUnplannedForExecution(store, task, ir)` (exported from `hold-release.ts`), evaluated at TWO points so no release surface can bypass it: `issueRelease` in `hold-release.ts` (the choke point for the sweep, `promoteHeldTask`, and `releaseHeldTaskByEvent` — all three funnel through it) refuses to release into a processing target while unplanned, and the scheduler's `reserveSlot` callback (`scheduler.ts`) applies the same guard before reserving a worktree/semaphore slot. The guard is intentionally NOT keyed on the literal `"todo"` column id (kept only as an additional OR-condition for the legacy/merged-planner-capacity `todo` column, which cannot self-report via traits) — it resolves the `intake` trait on the card's OWN resolved workflow IR, so a custom workflow whose intake column is renamed (`ideas`, `Inbox`, the default workflow's renamed "Planning") is covered identically. A held-back card releases any reservation it had not yet been granted (the check runs before `reserveSlot` is called) and is left with `status`/`blockedBy` untouched, so it neither leaks a worktree/semaphore slot nor gets stranded.

### Step inversion: steps as workflow-modelable nodes (`experimentalFeatures.workflowGraphExecutor`)

The columns/traits track moved *board* policy (transitions, capacity, hold, merge orchestration) onto the substrate/policy line. The **step-inversion** track extends the same inversion to *task steps* and to the *task shape itself*, riding the existing `workflowGraphExecutor` flag (orthogonal to `workflowColumns`). With the flag off — and for the default coding workflow always — step policy stays exactly as it is today (the monolithic `execute` seam, PROMPT.md `### Step N:` parsing, graph-owned review-node verdicts). The default workflow is the byte-identical parity oracle; inversion is opt-in via custom workflows and a built-in stepwise coding workflow.

**One new substrate seam pair.** The substrate gains exactly one new capability, expressed as two methods: `runTaskStep(task, stepIndex)` (run exactly one step inside the task's session and observe its `complete Step N` commit) and `resetStepToBaseline(task, stepIndex, baselineSha, checkpointId?)` (the RETHINK mechanics — git reset + session rewind + `updateStep(...,"pending")`). Both delegate to existing code (extracted from `StepSessionExecutor` and the legacy RETHINK block); neither reimplements step physics or authors commits. The substrate owns *how* a step runs and resets; the graph owns *when*. Baseline/checkpoint state, previously fragile in-memory Maps lost on restart, moves into persisted instance run-state (`workflow_run_step_instances`, schema v108).

**Everything else becomes authored graph structure (policy).** Step granularity, per-step plan/code review, the verdict→action mapping, rework/escalation routing, parallelism, and even the existence of PROMPT.md stop being engine law:

- A `parse-steps` node reads a workflow-declared **artifact** (PROMPT.md is just the default workflow's declared `step-source` artifact) and runs a registry **parser** (`step-headings`, `json-steps`, or a plugin-contributed parser) to write `Task.steps[]`. It is the only graph-side step-list writer and must dominate any `foreach`. Parsers fail closed to a routable `outcome:parse-error`.
- A `foreach(source:"task-steps")` node instantiates an inline template subgraph once per planned step, with `mode` (sequential/parallel) and `isolation` (shared/worktree) as explicit axes and per-instance run-state pinned + persisted for crash-safe resume.
- Resume-limbo graph failures are retried only through a narrow persisted counter (`Task.graphResumeRetryCount`, max 2). The executor classifies a failure as transient only when it happens immediately after the engine restart/unpause resume log marker, reports no graph `reason`, has no completed step progress, and the task has no durable `lastError`/`failureReason`; it clears transient `status`/`error`, logs the auto-retry, and schedules one more graph execution. Any explicit graph reason, completed step progress, durable task error, missing resume marker, or exhausted counter remains a genuine `status:"failed"` disposition and goes to review handoff, preserving the FN-5704 anti-loop contract.
- FN-7996 uses the separate durable `Task.consecutiveToolFailureRetryCount` budget for same-model retries after threshold consecutive `tool_error` completions; it never consumes `graphResumeRetryCount`, and exhaustion falls through to the unchanged terminal graph-failure park.
- Paused graph exits are benign only while the task is still in `in-progress`; that is the user-pause/engine-pause state where preserving the pause without requeueing is intentional. If the graph reports a pause/abort exit after the task has already advanced to another live column (for example `in-review` after an unpause/resume race), `TaskExecutor.handleGraphFailure()` surfaces the boundary as operator-actionable failure evidence (`status:"failed"`/`error` when no failure is already present, plus a task-log entry) and does **not** move, rewind, or auto-merge the task unless the graph result carries the typed interrupted-node marker. The exceptions are typed in-flight node pause aborts (FN-7214), completed/no-commit finalize-to-review teardown (FN-6625/FN-6644/FN-6647), and benign merge-seam pause/resume aborts (FN-6735). For FN-7214 node aborts, `hard-cancel` and lifted `global-pause` provenance can re-enter the interrupted node through the bounded `graphResumeRetryCount` path; explicit `userPaused`, active global pause, merge/finalize provenance, genuine node failures, `autoMerge:false` human-gated review rows, retry-exhausted tasks, and already-confirmed merges still use the protected operator-action path. For completed finalize handoff, once the persisted task row proves a completed finalize handoff (non-`in-progress`, all steps done/skipped, no live pause/status/error, and the finalize-to-review log entry), a trailing graph abort resolves as an already-advanced benign graph exit even if volatile completion markers were cleared by teardown/restart and later abort provenance was re-marked from `completion-finalize` to `hard-cancel`. For merge-seam aborts, `in-review` tasks with no persisted status/error and no confirmed merge may re-enter bounded auto-merge retry only when the failed graph node is a merge/request-merge seam, the graph value is not conflict/contamination/foreign/retry-exhaustion evidence, project settings allow auto-merge processing (or the task is a shared-branch local integration member), and the merge retry budget is not exhausted. `done` and `archived` remain terminal and keep their column/status, while existing failure details are preserved.
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
- Assignment triggers skipped because a heartbeat run is already active are deferred and re-fired from `HeartbeatMonitor.onRunCompleted`, preserving the existing completion recovery path while avoiding timer-dependent stalls.
- FN-7645: `HeartbeatTriggerScheduler.auditTimerRegistrations` (60s cadence) repairs both MISSING timer registrations and "zombie" ones — a timer map entry that stays present after its underlying `setInterval` silently stops firing. When a tickable, heartbeat-managed agent's `lastHeartbeatAt` exceeds the repair-stale threshold (`heartbeatIntervalMs * heartbeatRepairStaleMultiplier`, default 2x) even though a timer entry already exists, the audit clears and re-registers it (phase-aligned via `computeInitialDelayMs`), logging `reason=zombie-timer-rearmed`. This closes the gap where long-interval (~1h) agents could silently drift stale for hours because their sparse cadence meant a single lost tick was never re-armed by the previous missing-registration-only repair; short-interval agents were unaffected because their frequent ticks self-heal within minutes. All existing guards are preserved: pause suppression (`globalPause`/`enginePaused`) still gates dispatch in `onTimerTick`, FN-4119 stale active-run reaping still runs first for agents with a live run, ephemeral/task-worker agents stay excluded via `isTimerEligibleAgent`, and `registrationEpochs` staleness protection is untouched.
- FN-7939: the FN-7645/FN-7718 repair audit is itself self-supervised. `HeartbeatTriggerScheduler` records audit-loop liveness and runs an independent watchdog that re-arms the 60s audit interval plus immediately executes one audit when the driver is stale for a bounded multiple of the audit cadence, so a dropped auditor cannot strand active agents for hours while timer entries remain present. Repeated `zombie-timer-rearmed` repairs that do not advance `lastHeartbeatAt` are also bounded: after the non-advancing count crosses the scheduler threshold, the repair metadata records the count/escalation and logs the greppable `reason=heartbeat-rearm-nonadvancing-escalated` signal instead of silently churning forever; intentional `globalPause`/`enginePaused` suppression and healthy active runs remain non-escalating.
- FN-7718: CLI-driven `fn agent stop`/`start` mutate the agent row from a SEPARATE process, so the in-process `agent:updated` listener never fires for those transitions — the 60s audit is the ONLY cross-process reconciliation path. The audit now invalidates a stopped/non-eligible agent's lingering timer entry (state made non-tickable, `runtimeConfig.enabled === false`, or ephemeral/`!isHeartbeatManaged`) instead of bare-`continue`ing past it, so the entry never survives to become an orphaned/"zombie" registration. `syncTimerForAgent` mirrors this for the in-process start seam: an eligible agent whose present timer entry is already stale beyond the same repair threshold is force-cleared and re-armed rather than left in place by the "already ticking" no-op. Net effect: a `stop`/`start` cycle durably clears the zombie-timer condition in one audit cycle instead of deferring repair to the FN-7645 stale-repair path minutes later.
- FN-7723 (follow-up from FN-7718): `AgentStore` (`packages/core/src/agent-store.ts`) now supports an opt-in cross-process change-detection fast-path over the FN-7645/FN-7718 audit backstop — `startWatching()`/`stopWatching()`/`checkForChanges()`, modeled directly on `TaskStore`'s `fs.watch`+poll pattern (`packages/core/src/store.ts`): an `fs.watch` on the project's `.fusion` dir as a fail-soft fast-path nudge, plus an always-on poll fallback (default 2s) gated by `db.getLastModified()` so an unchanged DB costs one cheap `__meta` read. On a detected change it diffs current agent rows against a last-seen per-instance snapshot (comparing `state` explicitly, not just `updatedAt`, since two rapid writes can land in the same ISO-millisecond and mask a genuine transition) and re-emits the EXISTING `agent:updated`/`agent:stateChanged` events — no new event names, so `HeartbeatTriggerScheduler.watchAgentLifecycle`'s current listener reacts unchanged, funneling through the same `syncTimerForAgent` seam (including FN-7718's stale-present-entry force-re-arm). Only the long-lived engine `AgentStore` instance opts in (started/stopped alongside `HeartbeatTriggerScheduler` in `packages/engine/src/runtimes/in-process-runtime.ts`); the CLI's short-lived `AgentStore` (`packages/cli/src/commands/agent.ts`) and per-request dashboard stores never call `startWatching()`. The 60s `auditTimerRegistrations` sweep is UNCHANGED and remains the durable backstop — this is a purely additive latency improvement, not a replacement: a `fn agent stop`/`start` is now typically observed within one poll interval (~2s) instead of up to 60s.
- FN-7726 (follow-up from FN-7723): the mechanical fs.watch+poll lifecycle `TaskStore.watch()` and `AgentStore.startWatching()` each hand-rolled (fail-soft `fs.watch` setup with its two canonical warn strings, the `setInterval` poll fallback, and idempotent teardown) is now a single shared `FsWatchPollController` (`packages/core/src/fs-watch-poll-controller.ts`). The controller owns ONLY that mechanism — `start({dir, recursive?, pollIntervalMs, onPoll, log, errorContext?})`/`stop()`/`isWatching()`/`watcher` (a live-handle getter kept for test seams). It does NOT own diff/emit logic or gating: `getLastModified()`-vs-`lastKnownModified` gating and the `pollingInProgress` re-entrancy guard remain private fields on each store, evaluated inside each store's own `checkForChanges()` (the function passed to the controller as `onPoll`) exactly as before extraction — a deliberate scoping decision (see FN-7726's task `plan` document) to avoid coupling the shared controller to each store's very different diff bodies (TaskStore's delete/archive/artifact-cursor diff vs. AgentStore's snapshot state compare). `TaskStore` and `AgentStore` each hold a private `watchPoll: FsWatchPollController` instance and pass their own logger (`storeLog`/`agentStoreLog`) so the `[task-store]`-prefixed and agent-prefixed fail-soft warn strings are unchanged. Public method names/signatures (`watch()`/`stopWatching()` on `TaskStore`; `startWatching()`/`stopWatching()`/`isWatching()`/`checkForChanges()` on `AgentStore`) and all existing events/latencies/gating are unchanged — this is a behavior-preserving internal refactor, not a new mechanism.

### Custom instructions
`packages/engine/src/agent-instructions.ts` resolves per-agent instruction text/path with path-traversal and extension validation.

### Planner overseer session advisor (OMP advisor parity)

/*
FNXC:PlannerOversight 2026-07-13-23:10 / 2026-07-14-12:00:
Session-advisor layer shadows executor agent-log deltas with a second model,
severity-routed notes, and an emission guard. **Off by default** via workflow
setting `plannerOverseerAdvisorEnabled` (false). When enabled, also requires
both `plannerOverseerAdvisorProvider` and `plannerOverseerAdvisorModelId`.
Lifecycle supervisor (FN-7511–7520) remains authoritative for stage signals,
retry, and merge confirmation and does not depend on the LLM advisor.
*/

When enabled and a model is configured, `OverseerAdvisorService` (engine) queues
transcript deltas from `AgentLogger.onEntriesFlushed` and the planner-overseer
poll's agent-log cursor, prompts an isolated advisor model, and — after
`OverseerEmissionGuard` — injects `[session-advisor]` steering comments for
levels `steer`/`autonomous` (observe logs only). The system prompt
(`OVERSEER_ADVISOR_SYSTEM_PROMPT`) ports oh-my-pi advisor judgment policy
(peer-programmer role, critical silence rules, nit/concern/blocker criteria)
with Fusion anchors (PROMPT.md, File Scope, verification) and a JSON
`note`/`severity` or `silence` reply contract. Human-control withhold still
applies at inject time.

**Watchdog / review-priority discovery** (`discoverOverseerWatchdogFiles` in
`overseer-watchdog.ts`) loads every readable `OVERSEER.md` and `WATCHDOG.md`
from: (1) the user agent dir when configured, (2) each directory from the task
worktree/cwd upward to the repo root (or home), including both bare and
`.fusion/` / `.omp/` nested variants. Multiple files concatenate; user-level
first, then project ancestor→leaf so the leaf is most prominent.

### Planner overseer monitoring (records-only)

/*
FNXC:PlannerOversight 2026-07-04-00:00:
FN-7511 delivers the monitoring foundation for a planner-oversight layer that watches an in-flight task's
lifecycle without steering it. `packages/engine/src/planner-overseer.ts` declares the five watched stages
(`OVERSEER_WATCHED_STAGES`: executor, reviewer, merger, pull-request, workflow-gate), a normalized
`OverseerStageObservation` model, and a `resolveWatchedStage(task)` resolver with deterministic precedence
(workflow-gate > pull-request > merger > reviewer > executor) so a task in a compound state resolves to
exactly one stage. `PlannerOverseerMonitor#observeTask(task, level)` is the gating seam: when the task's
effective planner oversight level (`resolveEffectivePlannerOversightLevel`, FN-7508/FN-7509/FN-7510) is
`"off"`, nothing is recorded; otherwise exactly one observation is recorded into a bounded per-task ring
buffer (default cap 20) and the optional `onObservation` callback is invoked best-effort.
*/

`ProjectEngine` constructs a `PlannerOverseerMonitor` alongside `PrMonitor` and exposes it via
`getPlannerOverseer()`. A bounded `setInterval` poll (45s cadence, cleared on `stop()`) walks the
current `in-progress`/`in-review` tasks, resolves each task's effective planner oversight level, and
calls `observeTask` — skipping tasks that resolve to `"off"` or to no watched stage. Observations for
tasks that leave the in-flight set are dropped from the ring buffer on the next poll.

This layer is **records-only**: no lifecycle mutation, retry, merge, notification, or external-service
call happens here, and it emits no run-audit events or dashboard UI. Steering/recovery, confirmation
gates, human-control safeguards, and dashboard/UI/run-audit surfaces are deferred to FN-7512 through
FN-7520; this module is the seam those subtasks read observations from.

#### Executor-stage stall detection (FN-7743)

/*
FNXC:PlannerOversight 2026-07-09-00:00:
FN-7743 requirement: an ordinary in-progress task (FN-7732) sat stuck for hours with no recovery action
because `deriveSignalAndSources`'s `case "executor"` had NO staleness check — a non-paused in-progress
task always reported `signal: "progressing"` regardless of how long it had been idle, so
`decidePlannerRecovery` always returned `action: "none"`.
*/

The executor stage now detects a stalled/idle non-paused `in-progress` task and reports `signal: "stuck"`
instead of always `"progressing"`. `PlannerOverseerMonitor#observeTask` accepts an optional
`{ now?: () => number; executorStuckAfterMs?: number }` (both default: `Date.now` and the declared
`plannerOverseerExecutorStuckAfterMs` workflow-setting default) and threads them into the still-pure,
still-never-reads-settings `deriveSignalAndSources`. The staleness input is `task.columnMovedAt ??
task.updatedAt` (mirroring the existing "age is measured from columnMovedAt when present, otherwise
updatedAt" convention already used by `stalePausedReviewThresholdMs`/`stalePausedTodoThresholdMs`) — the
best available store-backed proxy for "last execution activity" at this poll seam, since the live
in-session `StuckTaskDetector` heartbeat state (`packages/engine/src/stuck-task-detector.ts`) is
in-memory-only and unavailable here. A missing or unparseable timestamp degrades to `"progressing"`
(fail-safe — never fabricate a stall). The `stuck` reason buckets inactivity to whole hours so the FN-7577
`stage|signal|reason` feed dedup stays effective (it must never embed an ever-changing millisecond value).

`ProjectEngine.pollPlannerOverseer` resolves `plannerOverseerExecutorStuckAfterMs` from the task's
already-fetched effective workflow settings (`resolveExecutorStuckAfterMs`, fail-safe default 2 hours) once
per task per poll cycle — the same `workflowEffective` fetch already used for `plannerOversightLevel` — and
passes it into `observeTask`. `decidePlannerRecovery` already mapped executor `stuck` → `inject_guidance`
(no change needed there); the human-control withhold guard in `evaluateOverseerHumanControl` still runs
BEFORE any recovery decision, so a stuck-but-user-paused/approval-blocked/autoMerge-off task is still fully
withheld.

### Planner overseer bounded autonomous recovery (FN-7512)

/*
FNXC:PlannerOversight 2026-07-04-12:00:
FN-7512 builds the bounded autonomous-recovery layer on top of FN-7511's observation seam. When the
task's effective planner oversight level resolves to `"autonomous"`, the planner overseer may take ONE
of three bounded corrective actions on the task's currently watched stage:
  - **inject_guidance** — post a planner-authored steering comment into the active agent lane.
  - **retry_step** — re-enqueue a stuck/failed step via the existing store retry/re-enqueue path.
  - **request_targeted_fix** — post a steering comment tagged as a targeted-fix request, referencing
    the observation's specific error source link.
At every other effective level (`"off"`/`"observe"`/`"steer"`) the decision is always `"none"` — this
layer is completely inert unless oversight is `"autonomous"`.
*/

`packages/core/src/planner-recovery.ts` declares the shared, engine-free recovery vocabulary:
`PlannerRecoveryActionKind` (`inject_guidance | retry_step | request_targeted_fix | none`),
`PlannerRecoveryObservation` (a structural mirror of FN-7511's `OverseerStageObservation` so the engine
can pass one straight through with no adapter), `PlannerRecoveryAttemptState`, `PlannerRecoveryDecision`,
and the pure, never-throw `decidePlannerRecovery(input)`. Decision rules, in order:

1. No observation, or `oversightLevel !== "autonomous"` → `"none"`.
2. The per-`(taskId, watchedStage)` attempt count has reached `PLANNER_RECOVERY_MAX_ATTEMPTS` (default
   `3`, mirroring `MAX_RECOVERY_RETRIES` in `recovery-policy.ts`) → `"none"`, `exhausted: true` — the
   layer stops autonomously and the task is left for escalation (FN-7514+ owns the human-control story).
3. `merger` / `pull-request` stages → `"await_confirmation"` (FN-7513) with `requiresConfirmation: true`,
   `sideEffectClass: "merge_pr"`: these require confirmation and are surfaced, never dispatched, by the
   bounded layer itself — see "Planner overseer confirmation gate (FN-7513)" below.
4. `reviewer` stage → `"inject_guidance"`.
5. `executor` / `workflow-gate` stage with `signal === "failed"` → `"request_targeted_fix"` when a
   source link carries a specific fixable error (`failed-check` / `merge-error`), else `"retry_step"`.
6. Any other `executor` / `workflow-gate` signal (stuck/blocked/progressing/awaiting-human) →
   `"inject_guidance"`.

`packages/engine/src/planner-recovery-controller.ts`'s `PlannerRecoveryController` is the dispatcher,
mirroring the `AutoRecoveryDispatcher` + `StuckTaskDetector` handler-injection conventions: it holds an
in-memory per-`(taskId, watchedStage)` attempt registry, calls `decidePlannerRecovery`, and — only when
an action other than `"none"` is chosen — dispatches through injected `PlannerRecoveryHandlers`
(`injectGuidance` / `retryStep` / `requestTargetedFix`, all optional and async), incrementing the
attempt count only on a successful dispatch. `tick(task, ctx)` is a no-op (returns `null`) when
`task.userPaused === true` or when there is no active observation, and never throws — any handler or
snapshot-provider error degrades to a no-op.

`ProjectEngine` wires one concrete `PlannerRecoveryController` alongside its `PlannerOverseerMonitor`,
reusing ONLY existing mechanisms — no new session/tool/merge channel:

- `injectGuidance` / `requestTargetedFix` → `store.addSteeringComment(taskId, text, "agent")` (the same
  channel the executor's real-time injection listener already watches).
- `retryStep` → `store.moveTask(taskId, "todo", { preserveProgress: true, moveSource: "engine" })` — the
  same in-progress→todo retry/re-enqueue path auto-recovery and self-healing already use.

`controller.tick(task)` is called from the SAME bounded 45s poll FN-7511 uses for `observeTask`, guarded
so it only runs when the resolved effective level is `"autonomous"` (every other level already
`continue`s before reaching the tick). Attempt state for a task is cleared (`controller.clear(taskId)`)
whenever the task leaves the in-flight `in-progress`/`in-review` set, alongside the FN-7511 observation
ring buffer.

**Explicit scope boundaries (owned by later subtasks, not this layer):** merge/PR actions and
destructive/external-service side effects (FN-7513, confirmation-gated); comprehensive human-pause /
`autoMerge:false` / human-review terminal safeguards beyond the bare `userPaused` skip (FN-7514); a
persisted intervention timeline (FN-7519); run-audit/activity events (FN-7520); and any dashboard UI
(FN-7515+).

### Planner overseer confirmation gate (FN-7513)

/*
FNXC:PlannerOversight 2026-07-04-13:00:
FN-7513 adds the safety gate deciding which FN-7512 recovery-layer actions may run autonomously versus
which must be blocked behind an explicit, recorded human approval. Merge/PR progression (advancing a
merge, promoting a shared branch, retrying/forcing a merge, opening/updating/merging a pull request) and
any destructive or external-service side effect (branch/worktree deletion, force operations, remote
pushes, third-party GitHub/GitLab calls) are classified confirmation-required, regardless of the
effective oversight level. Bounded recovery (inject_guidance / retry_step / request_targeted_fix on
non-merge/PR stages, FN-7512) is unaffected and remains no-confirmation. The invariant: a gated action
NEVER executes without a recorded, approved `PlannerConfirmationRequest`.
*/

`packages/core/src/planner-confirmation.ts` declares the classifier vocabulary:

- **`PlannerActionSideEffectClass`** (`"bounded_recovery" | "merge_pr" | "destructive_external"`).
- **`PlannerConfirmationRequest`** — `{ requestId, taskId, watchedStage, sideEffectClass, proposedAction,
  reason, sourceLinks, requestedAt, status: "pending" | "approved" | "denied", resolvedAt?, resolvedBy? }`.
  Conceptually mirrors `TaskMergeDetails.mergeConfirmed` (an explicit human approval precedes a side
  effect) but is its own record — it never reads or writes `mergeConfirmed`, which stays owned by the
  merge dispatch path.
- **`classifyPlannerActionSideEffect({ watchedStage, proposedAction })`** — pure, deterministic,
  never-throw. `merger` / `pull-request` stage actions beyond guidance/retry → `"merge_pr"`; an
  explicit allow-list of destructive/external action names (branch/worktree delete, force push/merge/
  delete, remote push, GitHub/GitLab/external-service calls, PR open/merge, shared-branch promotion) →
  `"destructive_external"` regardless of stage; everything else → `"bounded_recovery"`. Malformed input
  or an unrecognized non-bounded action on a non-merge/PR stage fails CLOSED to
  `"destructive_external"` rather than silently allowing an unclassified action through.
- **`requiresPlannerConfirmation(sideEffectClass)`** — `true` for `"merge_pr"` / `"destructive_external"`,
  `false` for `"bounded_recovery"`.

`packages/core/src/planner-recovery.ts`'s `decidePlannerRecovery` now calls the classifier for every
branch and returns `requiresConfirmation` / `sideEffectClass` / (for gated decisions) `proposedAction` on
`PlannerRecoveryDecision`. The merger/pull-request branch, previously `"none"`, now returns `action:
"await_confirmation"` naming what would run on approval (`advance_merge` / `advance_pull_request`); every
other rule (level gate, attempt bound, exhaustion) is unchanged.

`packages/engine/src/planner-recovery-controller.ts`'s `PlannerRecoveryController` adds the gate:

- A per-`(taskId, watchedStage)` **pending-confirmation registry** (`getPendingConfirmations(taskId)`)
  — idempotent: `tick` never creates a second pending request for a stage that already has one pending.
- `requestConfirmation(task, request, ctx)` (optional handler) — records/surfaces the pending request;
  it must NOT perform the side effect itself.
- `executeMergePrAction(taskId, request, ctx)` / `executeDestructiveExternalAction(taskId, request, ctx)`
  (optional handlers) — invoked ONLY from `resolveConfirmation(..., "approved", ...)`, never from `tick`.
- `resolveConfirmation(taskId, requestId, "approved" | "denied", resolvedBy?)` — on `"approved"`,
  dispatches the matching execution handler exactly once and clears the pending request; on `"denied"`,
  clears the request with no side effect, leaving the task for other escalation (FN-7514+), AND consumes
  one bounded-recovery attempt for that `(taskId, watchedStage)` pair (the same shared
  `PLANNER_RECOVERY_MAX_ATTEMPTS` budget `dispatch()` consumes). Without counting denials against the
  budget, a denied merge/PR/destructive confirmation would resurface as an identical pending request on
  the very next `tick()` forever; counting it means repeated denials eventually exhaust the stage
  (`decidePlannerRecovery` then returns `action: "none", exhausted: true`) instead of re-prompting
  indefinitely. Never throws — handler rejections are logged and swallowed, and the request is still
  cleared.
- `tick(task, ctx)`: when `decidePlannerRecovery` returns `requiresConfirmation: true`, calls
  `requestConfirmation` (idempotently) and does NOT invoke any side-effecting handler; bounded-recovery
  decisions still dispatch exactly as FN-7512 (with the attempt increment). The `"autonomous"`-only gate
  and the `userPaused` skip are preserved.
- `clear(taskId)` also clears pending confirmations (in addition to attempt state) on terminal task
  transitions.

`ProjectEngine` wires the concrete handlers in `buildPlannerRecoveryHandlers`: `requestConfirmation`
posts a `[planner-oversight] merge checkpoint (...)` steering comment (reusing the same
`addSteeringComment` channel as bounded recovery, so a human sees it). FN-7692: the wrapper prefix is
deliberately neutral ("checkpoint", not "confirmation required") because the trailing `reason` string
accurately states whether the merge/PR will advance automatically under the active auto-merge policy
(advisory) or genuinely awaits a human approval (blocking) — `decidePlannerRecovery`'s additive
`autoMergeWillProceed` input, threaded from the existing `allowsAutoMergeProcessing` predicate, selects
the accurate wording; this is messaging-only and does not change `action`/`requiresConfirmation`/
`sideEffectClass`. `executeMergePrAction` branches
on `request.proposedAction` (falling back to `request.watchedStage` defensively) rather than treating
every approved `"merge_pr"` request identically: ONLY `"advance_merge"` (the `merger` stage) reuses the
EXISTING `store.mergeTask(taskId)` merge mechanism; `"advance_pull_request"` (the `pull-request` stage)
is intentionally a no-op today because no reusable PR-specific advance mechanism exists yet — an
approved PR confirmation must never fall through to a direct task merge/cleanup, which would bypass the
PR workflow entirely. No `executeDestructiveExternalAction` is wired yet, since FN-7511's observation
model does not currently emit a destructive-action signal; a future task can wire one (and the
PR-specific execution handler) using existing safe helpers when a concrete need arises.

**Downstream ownership (not this layer):** rendering the pending-confirmation UI/badge (FN-7515+/
FN-7517), comprehensive human-control safeguards beyond `userPaused` (FN-7514), a persisted intervention
timeline (FN-7519), and run-audit/activity events (FN-7520) all consume the data this gate exposes but
are implemented elsewhere.

### Planner overseer human-control guard (FN-7514)

FN-7514 supplies the comprehensive human-control safeguard the FN-7512/FN-7513 layers deferred: the
overseer must be fully inert — no steering, retry, targeted-fix, or FN-7513 confirmation-required action
(merge/PR progression, destructive/external-service side effect) may fire, and no pending confirmation
may even be recorded — whenever a task is (a) user-paused, (b) blocked on a pending human approval
decision (FN-7736), or (c) ineligible for auto-merge processing per the FN-5147 `autoMerge:false` /
PR-based human-review terminal contract.

`packages/engine/src/overseer-human-control-policy.ts` exports the pure predicate
`evaluateOverseerHumanControl(task, settings)` (no I/O, mirrors the `recovery-policy.ts` style), returning
`{ withhold: boolean; reason?: "user-paused" | "approval-blocked" | "auto-merge-off-human-review" }`. It
reuses `allowsAutoMergeProcessing` from `@fusion/core` VERBATIM for the auto-merge-off half, and
`isTaskBlockedOnApproval` from `@fusion/core` VERBATIM for the approval-hold half (checked FIRST, ahead of
the user-pause/auto-merge-off checks — see the approval-hold contract below) — never re-derives either
predicate inline. For the pause half, it distinguishes:

- Explicit user pause: `task.userPaused === true`, OR `task.paused === true` with NO `task.pausedReason`
  (the `fn_task_pause` tool / `TaskStore.pauseTask` never stamps a `pausedReason`).
- Engine/self-healing park (NOT user pause): `task.paused === true` WITH a `pausedReason` (every
  self-healing park path — branch-conflict-unrecoverable, token_budget_exceeded,
  in-review-stall-deadlock, worktrunk_operation_failed, etc. — always stamps one).
- Approval hold (also NOT user pause, checked before the user-pause branch above so it is never
  shadowed): `task.paused === true` WITH `task.pausedReason === "awaiting-approval"` (the canonical
  `AWAITING_APPROVAL_PAUSE_REASON`), OR `task.status === "awaiting-approval"`. See the approval-hold
  contract section below for the full rationale.

`PlannerRecoveryController.tick()` (`planner-recovery-controller.ts`) consults this guard FIRST — before
the snapshot lookup, before `decidePlannerRecovery`, before FN-7513's confirmation classification. When
withheld, `tick()` returns `null` immediately (same contract as the prior bare `userPaused` check) and
never reaches the point where a pending `PlannerConfirmationRequest` could be created. A snapshot lookup
AFTER the withhold decision (read-only, for audit metadata only — stage/oversightLevel — never feeding
back into the decision) feeds an optional `recordHumanControlWithheld` handler, which `ProjectEngine`
wires to a bounded `RunAuditor.database({ type: "overseer:oversight-withheld-human-control", ... })`
no-action event (metadata: `{ taskId, reason, stage, oversightLevel }`). The controller dedupes this
emission per `(taskId, withheld reason)` — a task stuck in the same withheld state across many poll
cycles emits the event once, not on every tick; a reason change (or `clear(taskId)` on terminal
transition) re-arms it.

`ProjectEngine.pollPlannerOverseer` fetches global `Settings` once per poll cycle (not per task) and
threads it through `ctx.settings` to `tick()`, so the guard's `allowsAutoMergeProcessing` check sees the
same settings self-healing already gates lifecycle mutation on.

**Downstream ownership (not this layer):** the dashboard UI/badges surfacing withheld state (FN-7515+),
a persisted intervention timeline (FN-7519), and richer run-audit/activity presentation (FN-7520).

### Approval-hold contract for recovery and oversight (FN-7736)

A task can be blocked awaiting a human approval decision via two distinct mechanisms, and every
automated recovery (self-healing) and oversight (planner overseer) path must refuse to rebound, requeue,
resume, re-plan, or otherwise advance a task while either hold is active:

1. **Triage plan-approval gate** — parks the task spec at `status: "awaiting-approval"`. Already a member
   of `HARD_BLOCKING_TASK_STATUSES` (`packages/core/src/task-merge.ts`) and preserved by
   `GHOST_REVIEW_PRESERVED_STATUSES` in `self-healing.ts`; `POST /api/tasks/:id/approve-plan` is the only
   route that clears it.
2. **Runtime tool-approval gate** — a gated tool call parks a RUNNING task via `pauseForApproval`
   (`executor.ts` and `agent-heartbeat.ts`), which calls `store.pauseTask(taskId, true, ..., {
   pausedByAgentId, pausedReason: AWAITING_APPROVAL_PAUSE_REASON })`. Before FN-7736 this call stamped
   only `paused: true` with NO durable `pausedReason`, so recovery/oversight code keying on
   `pausedReason` could not recognize the hold, and self-healing's `autoReboundPausedScopeDecay` could
   rebound the held task back to `todo` (defeating the approval gate) once a follower task's scope-decay
   threshold elapsed.

`packages/core/src/task-merge.ts` exports the canonical `AWAITING_APPROVAL_PAUSE_REASON =
"awaiting-approval"` constant and the shared pure predicate `isTaskBlockedOnApproval(task)`, which returns
`true` for EITHER hold shape (`task.paused === true && task.pausedReason ===
AWAITING_APPROVAL_PAUSE_REASON`, or `task.status === "awaiting-approval"`). Both are re-exported via
`index.ts`/`index.gate.ts` for engine consumption. Consulted at:

- **`SelfHealingManager.PAUSED_SCOPE_DECAY_EXCLUDED_REASONS`** (`self-healing.ts`) — includes
  `AWAITING_APPROVAL_PAUSE_REASON` alongside `branch-conflict-unrecoverable`, `worktrunk_operation_failed`,
  and `token_budget_exceeded`, so `autoReboundPausedScopeDecay` skips an approval-held holder task even
  when a follower is present and the age threshold has elapsed.
- **`classifyPausedAbortWorkflowRecovery`** (`self-healing.ts`) — already skips any `task.paused === true`
  row before this task; the approval-hold shape is covered by that generic guard (regression-tested
  explicitly rather than relying on the incidental coverage).
- **`evaluateOverseerHumanControl`** (`overseer-human-control-policy.ts`) — checks `isTaskBlockedOnApproval`
  FIRST, ahead of the accidental "paused with no reason" user-pause heuristic, returning
  `{ withhold: true, reason: "approval-blocked" }`. This ordering is load-bearing: once FN-7736 started
  stamping a durable `pausedReason` on the tool-approval hold, the old no-reason heuristic would stop
  matching it — the explicit `approval-blocked` branch prevents that from silently flipping the overseer
  from withhold to act.
- **Every other self-healing sweep** that gates on generic `task.paused === true` (or `task.paused ||
  task.userPaused`) before taking a lifecycle-advancing action already skips an approval-held task
  regardless of `pausedReason`, and needed no change.

`TaskStore.pauseTask(id, paused, runContext?, agentOptions?)` accepts an optional `agentOptions.pausedReason`
seam (widened for FN-7736) so the durable reason lands atomically with the pause write, avoiding a second
racy `updateTask` call; unpausing (`pauseTask(id, false)`, used by the approval-resolution route) clears
the caller-supplied `pausedReason` the same way it already clears `pausedByAgentId`/`userPaused`, so the
hold is not sticky once the operator decides.

### Planner overseer runtime-state exposure (FN-7531)

/*
FNXC:PlannerOversight 2026-07-04-00:00:
FN-7531 closes the data-exposure gap FN-7516 needed: the planner overseer's runtime state (FN-7511's
`PlannerOverseerMonitor` observations, FN-7512/FN-7513's `PlannerRecoveryController` attempt/pending-
confirmation registries) was engine-side and in-memory only. This task adds a lightweight, serializable
snapshot and surfaces it on the `GET /api/tasks` payload so task cards can render an indicator without
a second round-trip.
*/

`packages/core/src/planner-overseer-state.ts` declares the externally-meaningful five-value enum
`PLANNER_OVERSEER_STATES` (`idle | watching | steering | recovering | awaiting-confirmation`), the
serializable `PlannerOverseerRuntimeSnapshot` interface (`state`, `oversightLevel`, `watchedStage?`,
`signal?`, `attemptCount?`, `attemptLimit?`, `pendingConfirmation?`, `observedAt?` — `watchedStage`/
`signal` are kept as bare `string` so the engine's stage taxonomy is not pulled into `@fusion/core`),
and the pure, never-throw `derivePlannerOverseerState(input)`. Precedence: `oversightLevel === "off"`
or no active observation → `"idle"`; a pending confirmation → `"awaiting-confirmation"` (wins over an
in-flight recovery attempt); a recorded recovery attempt → `"recovering"`; `"steer"` level → `"steering"`;
otherwise (`observe`/`autonomous` watching, no attempts/pending) → `"watching"`.

`ProjectEngine.getPlannerOverseerRuntimeSnapshot(taskId)` (delegating to the pure
`assemblePlannerOverseerRuntimeSnapshot` helper in `packages/engine/src/planner-overseer-runtime-snapshot.ts`
for testability) reads the latest observation from `PlannerOverseerMonitor.getObservations(taskId)` plus
`PlannerRecoveryController.getPendingConfirmations(taskId)`/`getAttemptCount(taskId, stage)`, and returns
`null` (never throws) when there is no active observation for the task. `GET /tasks`
(`register-task-workflow-routes.ts`) additively enriches each returned task with `plannerOverseerState`
when the engine snapshot is non-null — best-effort, mirroring the existing `branchProgress` enrichment
block right beside it: any engine error is swallowed and the un-enriched list is returned, and tasks with
no active observation omit the field entirely (byte-identical payload). `Task.plannerOverseerState?` is a
transient field — engine-populated at serialization time, never persisted to the store or task.json.

When an in-flight task's effective planner oversight resolves to `"off"`,
`ProjectEngine.pollPlannerOverseer` clears retained monitor observations and associated recovery/advisor
runtime in that same poll. The snapshot therefore returns `null` rather than retaining a stale active state.

FN-7516's `TaskCard` renders the badge/affordance; this task only provides the field, the engine
accessor, and (since FN-7516 had not yet landed consumption) a minimal guarded read plus a
memo-comparator entry so the card repaints on state change.

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

Commit associations also carry optional `additions`/`deletions` shortstat counts captured by merge paths or filled later by the explicit `POST /api/command-center/productivity/backfill-loc` operator backfill. These nullable fields are the Command Center Productivity LOC source: analytics sum additions + deletions only when at least one in-range row has stats, derive estimated human hours saved as `round((additions + deletions) / HUMAN_LINES_PER_HOUR, 1)`, and preserve the `—` unavailable sentinel for both LOC and hours saved when all matching rows are `NULL` so unknown historical data is never rendered as `0`. The backfill only touches rows where both columns are `NULL`; malformed SHAs and commit objects unavailable in the local repo stay `NULL`, so partial historical coverage remains visible until a real local git object supplies stats. The hours-saved field is a conservative estimate, not exact time tracking.

Command Center Productivity task-duration stats use task rows, not commit rows: done tasks completed in range (`executionCompletedAt`) contribute when `cumulativeActiveMs > 0`. The aggregator computes completed count plus average, median, p90, and total active execution milliseconds; if no qualifying task exists, the duration metrics use the same unavailable `—` contract instead of reporting `0`.

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
  - Fields round-trip through JSON and PostgreSQL persistence via the shared task contract in `packages/core/src/types.ts`.

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
- **Task-pinned worktrees (`worktreeNaming: "task-id"`)**: under task-id naming a task is pinned to exactly one derivable directory `<worktreesDir>/<lowercased-task-id>` for its entire lifecycle. `worktree-pinning.ts` (`isTaskPinnedWorktreeNaming`, `pinnedWorktreePathForTask`) derives the path purely from the task id (unique forever via committed reservations, so no dedup-suffixing is possible). `acquireTaskWorktree` runs a **derive → validate → reuse-or-recreate** flow in pinned mode: it re-derives the path, corrects a disagreeing `task.worktree` cache (emitting `worktree:pin-rederived`), then reuses the directory warm when it is a registered, usable worktree checked out on the task's own branch, otherwise reclaims it in place (`removeWorktree` + recreate at the SAME path — never a sibling name). Because the path is derived, the FN-7996 stale/foreign-pointer shape self-corrects at next dispatch without consuming worktree-session retries. Task pinning and `recycleWorktrees` are **mutually exclusive**: enabling both is rejected at the settings-write boundary (`assertWorktreeNamingRecycleExclusive`, enforced in `store.updateSettings` and the dashboard `PUT /settings` route), so pinning only applies when recycling is off. As a runtime backstop for legacy on-disk configs that carry both, `acquireTaskWorktree` gates pinned mode on `!recycleWorktrees` (recycling wins, pinning off). Worktrunk-managed layouts own their own path derivation, so pinning is bypassed when that backend is active. Non-pinned `"random"`/`"task-title"` naming and the pool acquire/release path (including `merger.ts` release) are byte-inert.

#### WorktreeBackend abstraction
- Backend contract: `WorktreeBackend` (`packages/engine/src/worktree-backend.ts`, re-exported via `packages/engine/src/worktree-pool.ts`).
- Implementations: `NativeWorktreeBackend` (Fusion-managed `git worktree` flow) and `WorktrunkWorktreeBackend` (delegates to the external `wt` CLI from [max-sixty/worktrunk](https://github.com/max-sixty/worktrunk)).
- Backend selection is driven by `worktrunk.enabled`; when enabled, worktrunk-managed layout overrides `worktreesDir` for delegated operations.
- Worktrunk layout is authoritative on create: after `wt switch --create`, Fusion resolves the actual registered worktree path via `git worktree list --porcelain` and uses that path (instead of assuming `resolveTaskWorktreePath` alignment).
- Delegated operation surface in the interface: `create`, `sync`, `prune`, `remove` (plus backend path resolution via `resolveWorktreePath`).
- Executor acquisition paths (`worktree-acquisition.ts`) resolve backend selection centrally, so create flow stays backend-agnostic above the pool/acquisition layer.
- Worktree removal is backend-mediated across merger, self-healing, worktree-pool, executor, and step-session cleanup paths via `removeWorktree(...)` (`WorktreeBackend.remove()`). Native removal first runs `git worktree remove --force`; when git reports recoverable on-disk cleanup failures such as `Directory not empty`, `failed to delete`, or modified/untracked content, it falls back to async filesystem removal and `git worktree prune` (`pruneWorktreeAdminEntries`) so both the directory and dangling admin entry are cleared.
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
- FN-5279 adds `mergeIntegrationWorktree` for auto-merge only. Default `reuse-task-worktree` hands merger ownership from executor to the merger inside the task worktree after five gates (clean tree, expected branch, no live executor session, canonical branch/worktree binding, lease handoff). Refusals emit `merge:reuse-handoff-refused`, leave the task in `in-review`, and do **not** silently fall back to project-root merge mode. `cwd-integration-branch` is the explicit opt-in project-root path; `cwd-main` is a deprecated alias normalized to `cwd-integration-branch`. Integration-branch defaults across merger and self-healing flows are resolved dynamically via `resolveIntegrationBranch(rootDir, settings)` (`integrationBranch` → `baseBranch` → `origin/HEAD` → `main`). When `worktrunk.enabled=true`, worktrunk-managed merge/worktree behavior still wins and the handoff path emits a defer event instead of taking over. FN-5363 tightens this path: `acquireMergeQueueLease({ targetTaskId })` is strict (no queue-head fallback), merge queue rows are enqueue/lease-gated to `in-review` tasks, and stale non-review rows are auto-cleaned (including on `in-review` column exit when leases are absent or expired). FN-5353 extends the same contract: merger self-enqueues the target before strict target leasing, null target leases are surfaced as `merge:reuse-handoff-refused` with `reason: "target-not-queued"`, `acquireReuseHandoff` hard-refuses `reason: "worktree-equals-project-root"`, and `resolveMergeIntegrationRoot` returns a missing-worktree sentinel (`rootDir: ""`) so reacquire executes before any reuse gate can misroute against project root. FN-6278 adds a stable cwd preflight before root-derived git spawns: in `reuse-task-worktree` mode, an empty, missing, incomplete, or de-registered `task.worktree` is repaired/reacquired before the first spawn, while `cwd-integration-branch` remains a no-op project-root path. FN-5351 adds a production verification trail for integration-branch invariants: `merge:integration-worktree-state`, `merge:cwd-integration-fallback-refused`, and `merge:integration-ref-advance`.
- `merger.ts` also exposes a test-only `__test__` helper object for internal merger unit/integration coverage (for example autostash orphan cleanup behavior)
- Supports workflow-step execution after merge (post-merge phase)
- Deterministic verification now runs a bootstrap preamble (`node scripts/ensure-test-artifacts.mjs`) before configured `testCommand`/`buildCommand`, then self-heals Vite `Failed to resolve entry for package "@fusion/..."` workspace-entry faults by rebuilding the missing package once and retrying the failed command. If that retry still reports the same missing-entry fault, merger raises a typed environment fault and `ProjectEngine` leaves the task in-review (no verificationFailureCount increment or in-progress bounce) so the next recovery sweep can retry after other runs rebuild artifacts.
- FN-4232/FN-4605 extends that bootstrap to cover stale dist consumers comprehensively: `@fusion/{core,dashboard,engine,plugin-sdk}` and `@fusion-plugin-examples/{dependency-graph,hermes-runtime,openclaw-runtime,paperclip-runtime}` are checked for missing/stale artifacts (staleness compares newest `src/` mtime against the oldest required `dist/` artifact mtime for configured packages). Package-level `pretest` hooks in `@fusion/dashboard` and `@fusion-plugin-examples/dependency-graph` invoke the same bootstrap for filtered test runs.
- When stale or missing artifacts are found, the preamble logs `[test-bootstrap] rebuilding workspace dist artifacts (missing or stale): ...`; if rebuild fails, remediation now prints exact artifact-path diagnostics (`[test-bootstrap] missing: ...` / `[test-bootstrap] stale (src newer than dist): ...`) plus the FN-4232/FN-4605 reference and recovery commands.

#### Finalize integrity gate
- Finalize-to-done now runs an ownership classifier with three outcomes: `owned-commit` (task trailer/subject commit proven landed on merge target), `proven-no-op` (zero-ahead branch plus start point reachable from target), and `unproven` (missing ownership evidence, including foreign start-point inheritance).
- `owned-commit` and `proven-no-op` can finalize. `proven-no-op` explicitly reconciles metadata by clearing stale `task.modifiedFiles` and stamping `mergeDetails.noOpMerge=true` with `landedFiles: []`.
- `noCommitsExpected === true` tasks have an additional no-op finalize guard (FN-6461): if a zero-net-change lane reaches finalize with step evidence showing incomplete/skipped work outweighing completed work (`incompleteCount >= doneCount`, with at least one step), the task must not move to `done`. Merger and self-healing write `task.error`, log an operator-visible reason, emit `task:no-commits-finalize-blocked-incomplete-steps`, and move the task back to `todo` with `preserveProgress: true`. All-done no-commits tasks, mostly-done tasks with only a minor skipped tail, zero-step tasks, ordinary tasks, and no-commits tasks with real landed changes keep the existing finalize behavior.
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
- Dashboard operators inspect orphan counts, review diffs, apply stashes, and explicitly drop entries with confirmation from **Git Manager → Recovery**; the recovery controls are part of Git Manager rather than a standalone top-level dashboard view.
- Decision: recovery stays user-gated. Auto-apply was rejected because clean-tree checks are racy, stash placement is ambiguous after source task merge, and apply conflicts can produce hard-to-untangle state. `sweepAutostashOrphans` continues to auto-drop only subsumed entries while preserving live developer work.

#### Automated follow-up dedup (FN-5232)
- Engine-side automated follow-up creation now routes through `packages/engine/src/verification-followup-dedup.ts` instead of calling `TaskStore.createTask()` directly from recovery/eval/PR-comment paths.
- Verification-style follow-ups stamp `sourceMetadata.verificationFailureSignature`, a deterministic SHA-256 digest over `{ lane, sorted failing test basenames }` (or `lane|no-files` when no files can be parsed). Open matches reuse the existing task and append at most one `[verification recurrence]` log entry per hour; closed/done/archived matches within 24 hours create a fresh task with `sourceMetadata.supersedesTaskId` pointing at the prior task.
- Non-verification automated follow-ups can supply `extraMatchKeys` (for example eval `suggestionId` or PR `prNumber`) so dedup stays deterministic even when no test-file signature exists.
- This layer composes with FN-4892 same-agent intake dedup in `@fusion/core`: engine dedup prevents repeated automated recovery spam up front, while store-side same-agent intake flags newly-created near-duplicates in place by default; only explicit `autoArchiveDuplicateTasksEnabled: true` archives the new task.
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

1. **PostgreSQL for transactional authority**
   - Embedded PostgreSQL preserves zero-config operation; `DATABASE_URL` supports external deployments
   - Shared project/central schemas provide one async transactional model across runtimes

2. **Hybrid persistence (DB + filesystem blobs)**
   - Structured metadata in PostgreSQL, large text/artifacts in task directories
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

Project settings expose per-category caps (`maxBranchConflictRecoveries`, `maxReviewerContextRetries`, `maxReviewerFallbackRetries`) plus a master cap (`maxTotalRetriesBeforeFail`). When a cap is exceeded, engine code throws `RetryStormError`; executor and triage Plan Review terminal failure handling serialize this into `task.error` so dashboard surfaces can render structured failure details. Plan Review must terminalize this guard rather than re-queue `plan-review-unavailable`, which would otherwise continue burning the reviewer-fallback budget. Callers that hold the failure which burned the final retry pass it to `recordRetry({ cause })`; it surfaces as `underlyingError` in `serializeRetryStormError` so a cap never masks the real error (e.g. `429: overloaded_error`).

### Plan Review provider failures must back off and pause (FN-8006)

`reviewStep` throws `ReviewerProviderError` for usage-limit/transient provider failures so they never launder into an `UNAVAILABLE` verdict, but `runPlanReviewBeforeExecution` catches every throw inline to keep triage alive — which means provider failures still arrive at the `plan-review-unavailable` park. Two rules bound that park; both are load-bearing and neither is optional:

1. **Usage limits pause every lane.** The inline catch hides the error from triage's own `isUsageLimitError` handler in `specifyTask`, so the Plan Review path fires `usageLimitPauser.onUsageLimitHit` itself. Without this, `reviewer.ts`'s escalation contract ("escalate so `UsageLimitPauser` pauses every lane") holds only on the executor path.
2. **Every re-park uses bounded backoff.** Parks go through `computeRecoveryDecision` (60s → 120s → 240s, ±10% jitter) and terminalize at `MAX_RECOVERY_RETRIES`. The park previously used a fixed 30s `nextRecoveryAt` with no attempt counter, so a sustained outage re-ran Plan Review every 30s for hours (~1,900 requests/5h observed) — the volume that trips a provider's low-interactivity throttle and prolongs the outage being retried.

Plan Review borrows the shared `recoveryRetryCount` transient-triage budget for this backoff and clears it on any real verdict (APPROVE/REVISE/RETHINK); a stale count would otherwise shorten the executor's later transient budget for a task whose only fault was surviving a reviewer outage.

## Lifecycle invariants

This section preserves the detailed lifecycle/self-healing contracts that were formerly in `AGENTS.md`.

- **Planning-recovery no-regression (FN-7977/FN-8361)**: a provider, model-selection, transport, or deterministic planning failure may only mutate a task after re-reading its live row and proving it remains in the planning stage. Execution/terminal columns, a worktree, or materialized steps prove advancement; stale triage recovery must leave that column, status, worktree, step progress, and `PROMPT.md` untouched. Patch writes use `updateTaskAtomic`; recovery releases use `moveTaskIf` and recovery duplicate deletion uses `deleteTaskIf`, each read-predicate-mutating under one task lock. A predicate skip is normal scheduler advancement and short-circuits the remaining recovery body. A genuine Plan Review `REVISE` remains a separate, explicit replan signal.
- **Orphan `fusion/*` branches**: branches with zero unique commits vs `main` are pruned by `cleanupOrphanedBranches` (`branch:orphan-prune`). Branches with unique commits are not auto-rescued; operators inspect and clean them manually via standard git tooling (`git branch -D`, `git worktree remove`, etc.).
- **Stale active branches**: self-healing's `reclaim-stale-active-branches` stage prunes a `fusion/<task-id>` branch with zero unique commits when no usable worktree mapping exists, then clears `task.branch`/`task.worktree`/`task.baseCommitSha`. It must defer reclaim (emit `branch:stale-active-reclaim-deferred`) when the task worktree is in `activeSessionRegistry`, when `executionStartedAt` is within `STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS` (10 minutes), or when the mapped worktree has uncommitted changes.
- **Worktree metadata reconcile ordering (FN-4962)**: `reconcile-task-worktree-metadata` must run before `reclaim-stale-active-branches`; stale `task.worktree` metadata is rebound to live `fusion/<task-id>` worktrees when present (`task:auto-recover-worktree-metadata-rebound`) or cleared (`task:auto-recover-worktree-metadata-cleared`) when absent.
- **Completion fan-out is synchronous**: `SelfHealingManager.reconcileCompletedTask()` runs on `in-review → done`. Downstream stale `blockedBy` links and residual `fusion/<task-id>` branch/worktree artifacts are reconciled immediately, not on a periodic sweep.
- **In-review stall deadlock**: identical stalls (same code + reason) repeated past `inReviewStallDeadlockThreshold` (default 3) auto-pause with `pausedReason: "in-review-stall-deadlock"` and `status: "failed"`. User-initiated retry paths (dashboard retry, `fn_task_retry`, and CLI `task retry`) clear that automatic deadlock pause so the retry can execute, but they never override explicit/manual pauses or unrelated automatic pause reasons.
- **Restart recovery**: `RestartRecoveryCoordinator` classifies interrupted `in-progress` runs. Unusable-worktree session-start failures (`missing`, `incomplete`, `unregistered git worktree`) are recoverable; retries are capped at `MAX_WORKTREE_SESSION_RETRIES=3` before escalating. `recoverMissingWorktreeReviewFailures` also owns durable unusable-worktree session-start failures that reached `in-review` with a merge-active status (`merging`, `merging-pr`, or `merging-fix`): before interrupted/deadlocked merge sweeps can re-drive the same phantom path, it applies auto-merge eligibility, workspace-task exclusion, and triple-proof, clears stale `worktree`/`branch`/`sessionFile`, resets the exhausted worktree-session retry budget, increments `recoveryRetryCount` as the bounded merge-active stale-metadata clear counter, and requeues to `todo` preserving progress. Operator retry surfaces (`fn_task_retry`, CLI `task retry`, dashboard retry) have the same signature-only reset primitive so a missing-worktree failure does not require a valid `merging` transition.
- **Durable agent heartbeat error recovery (FN-7835/FN-7859/FN-7878)**: `HeartbeatTriggerScheduler` keeps timers armed for durable heartbeat-managed agents in `state:"error"` when `lastError` is recoverable: generic/unknown errors and transient credential-rotation failures get the bounded retry budget, while operator-actionable credential/scope, quota/billing, and model-access failures do not restart. Stale worktree/module-resolution errors also skip naive retry recovery so the dedicated stale-host/worktree suppression path can handle them. `HeartbeatMonitor.executeHeartbeat()` clears recoverable errors at run entry (`error → active`, clears `lastError`), increments a consecutive `metadata.heartbeatErrorRecovery` counter, and emits `agent:auto-recover-error-state`; success resets the counter. Once the bounded budget (`MAX_HEARTBEAT_ERROR_RECOVERY_ATTEMPTS`, settings-overridable) is exhausted, the agent is parked `paused` with `pauseReason:"error-retry-exhausted"` and `agent:error-retry-exhausted` is emitted. Non-recoverable durable heartbeat errors are parked `paused` with `pauseReason:"error-unrecoverable"` and `agent:error-parked-unrecoverable` rather than remaining indefinitely in bare `error`.
- **Executor pre-session liveness gate (FN-4935/FN-6861)**: the gate now skips for fresh acquisitions (`acquisition.source === "fresh"`), emits structured `not_usable_task_worktree:<classification>` diagnostics (including canonicalized registered-path snapshots) and a `worktree:incomplete-detected` audit event with `source: "executor-liveness-gate"`, while preserving the existing `taskDoneRetryCount` / `MAX_TASK_DONE_REQUEUE_RETRIES` requeue contract. The project repo root is never a usable task worktree even though it is a legitimately registered Git worktree; `classifyTaskWorktree` returns `repo-root` for canonical root-equal paths, and resume acquisition treats that as self-healable stale metadata by clearing `task.worktree` and creating a fresh checkout under the configured worktrees directory. FN-5772 adds a bounded nested-root self-heal: when `task.worktree` points at a strict descendant of a registered worktree root inside the configured worktrees dir, executor re-anchors `task.worktree` to the git top-level, emits `worktree:reanchored` (`fromPath`, `toPath`, `source`), and proceeds; repo-root/outside-dir/unregistered top-level mismatches still fail. FN-4651 `worktreeSessionRetryCount` remains scoped to the in-review/session-start recovery path.
- **Stale self-owned active-session reconcile on conflict cleanup (FN-4973)**: when executor worktree-conflict cleanup finds only a same-task stale `activeSessionRegistry` entry and no live in-memory `activeWorktrees` binding for that task/path, it must unregister the stale entry before `removeWorktree` (plus one-shot backstop reconcile on same-task `ActiveSessionWorktreeRemovalError` races). Foreign-task entries remain protected by FN-4811 and must never be reconciled by the requesting task.
- **Same-task stale removal canonical helper (FN-5346)**: executor same-task cleanup paths now route pre-removal reconciliation through `reconcileSelfOwnedActiveSessionForRemoval` (via executor helper wiring), so stale self-owned `activeSessionRegistry` residues are cleared only when no live in-memory binding exists, while FN-4811 foreign-owner refusals and live-owner protections remain intact.
- **Live worktree conflict fallback (FN-7385)**: when branch-conflict cleanup is refused because the conflicting path belongs to an active executor/workflow-step session (including same-task process-active sessions, foreign `activeWorktrees` owners, or DB-only live owners), executor acquisition must preserve that path and retry with a fresh generated worktree plus bounded sibling branch. Stale/non-live conflicts still use the existing cleanup/reclaim path, and unrecoverable non-active cleanup failures remain actionable errors.
- **Task title/ID drift (FN-4898)**: active and archived title writes normalize foreign embedded `FN-NNN` tokens via `packages/core/src/task-title-id-drift.ts`. Empty placeholder groups (`()`, `[]`, `{}`) left behind by token stripping are also removed in both `normalizeTitleForTaskId` and `sanitizeTitle` (FN-4978). Lineage is preserved in `sourceParentTaskId` / description markers, not title embeds. FN-5077 extends drift normalization to reject dangling-connector fragments (`"Close as duplicate of"`) so token-stripped residuals never persist as task titles.
- **PR-conflict reclaim wiring (FN-4763)**: GitHub PR refresh now persists normalized `prInfo.mergeable` conflict state and, when conflicting, funnels tasks into self-healing’s existing reclaim machinery (`reclaimPrConflictForTask` / `reclaim-pr-conflicts` stage) so branch-conflict handling stays centralized with existing `inspectBranchConflict` outcomes and unrecoverable pause semantics. PR refresh also captures `prInfo.conflictDiagnostics` (conflicting files + suggested local recovery commands) for dashboard surfacing.
- **Worktrunk-managed lifecycles**: when `worktrunk.enabled`, self-healing defers prune/idle/worktree-cap sweeps to the worktrunk backend; branch-level stale/ conflict reclaim stays native. Orphan `fusion/*` branches are operator-managed via standard git tooling (no auto-rescue task filing).
- **Post-finalize verification no-op (FN-4944)**: when auto-merge receives a delayed `VerificationError` after a task is already `done` with `mergeDetails.mergeConfirmed === true` (already-on-main fast-path), it must log one `[verification] ... no action` diagnostic and must not bounce the task back to `in-progress` / `merging-fix`. Defense-in-depth now re-checks the done+mergeConfirmed condition immediately before each verification-failure status write site, and emits `task:post-finalize-verification-no-op` database audit events with failure metadata for forensics.
- **Transient auto-merge retry classification (FN-5697)**: non-conflict auto-merge errors now run through `isTransientError(...)` before terminal parking. Transient provider/network failures (for example `This operation was aborted`, `socket hang up`, and `server_error` payloads) are retried with bounded exponential backoff (`5s/10s/20s`) and `status=null` for both direct and pull-request merge strategies; once `MAX_AUTO_MERGE_TRANSIENT_RETRIES` is exhausted, tasks are parked `in-review/failed` with explicit transient-exhaustion logs.
- **Merge-seam abort provenance (FN-6568/FN-6735/FN-7749)**: workflow graph merge-node failures must not be classified as pause/resume aborts merely because the merge seam hard-canceled an in-flight session. `TaskExecutor` tracks paused-abort provenance separately (`global-pause`, `merge-seam`, `hard-cancel`); genuine user/global pauses still preserve FN-6478/FN-5147 parking, while non-paused merge-seam graph failures (`merge`, `requestMerge`, built-in merge-region node ids, `merge-manual-hold`, and `merge-retry`) route back into the bounded auto-merge retry path instead of being parked `status:"failed"` with `mergeRetries=NULL`. Benign pause/resume aborts at these seams are retryable when the task is already `in-review`, has no durable failure/status, has not confirmed a merge, remains auto-merge eligible (or is a shared-branch local integration), and has merge retries remaining. When auto-merge is off (`settings.autoMerge:false` or an explicit task-level `autoMerge:false`), a benign hard-cancel at a non-terminal merge-region/manual-hold node is instead preserved cleanly in `in-review` for human Merge & Close; stale pause-abort status/error of this exact shape is cleared in place and never requeued. Conflict/contamination/foreign-work/retry-exhaustion values, pre-existing failures, global/user pauses, shared-branch member integrations, and post-confirmation partial landings retain their existing terminal/retry/finalize behavior.
- **Worktree pool exclusivity (FN-4954)**: `WorktreePool.acquire(taskId)` / `release(path, taskId?)` track a `leased` map so every pooled path is either idle or leased, never both. Cross-task double-lease detection throws `PoolDoubleLeaseError` and emits `worktree:pool-double-lease-detected`; merger Step 8 now detaches HEAD and clears `task.worktree` / `task.branch` before releasing paths back to the pool.
- **Stale registration recovery (FN-5056)**: `NativeWorktreeBackend.create` and `executor.tryCreateWorktree` detect `missing but already registered worktree` failures, run `git worktree prune` (plus `remove --force` / `add -f` fallbacks) before retrying, and emit `worktree:stale-registration-{detected,recovered,recovery-failed}` audit events.
- **Bare branch-collision recovery (FN-8132)**: after stale lock/registration recovery, `NativeWorktreeBackend.create` classifies a `git worktree add -b` “branch already exists” error even when its requested target path is absent. It attaches an unregistered branch only when every unique commit is attributed to the requesting task, recreates merged/subsumed or no-unique-work branches from the caller-pinned start point, and refuses foreign, unattributed, or mixed unique history without moving its ref. A live foreign worktree remains a `BranchConflictError`; recovery dispositions emit `worktree:branch-collision-recovery`.
- **Raw worktree deletion must be paired with prune (FN-5058)**: any direct filesystem deletion of a worktree directory (`rm -rf` / `rmSync`) must be followed by best-effort `git worktree prune` via `pruneWorktreeAdminEntries` so `.git/worktrees/*` admin entries are not stranded in a missing-but-registered state (FN-5056 class).
- **Meta-task auto-archive safety guards (FN-5064)**: `auto-archive-meta-resolved`/`auto-archive-meta-stalled` must skip archival (with `task:auto-archive-meta-*-skipped` audits) whenever guard checks detect substantive work signals such as unique branch commits, recent executor activity, pending `taskDoneRetryCount`, merge-in-progress state, or active worktree session. The corresponding `task:auto-archive-meta-resolved-skipped` and `task:auto-archive-meta-stalled-skipped` run-audit rows are transition-only per task+guard-reason signature: emit once on first skip, suppress repeated sweeps while the same reasons persist, clear when the skip no longer applies, and re-emit if a different reason later blocks archival.
- **Scheduler fanout tiebreaker (FN-4969)**: within the same priority class, scheduler dispatch prefers runnable `todo` tasks with the highest active dependency-dependent fanout; `urgent` always outranks lower priorities regardless of fanout, and `overlapBlockedBy`/file-scope overlap blockers are excluded from unblock weight.
- **Scheduler overlap priority/age guard (FN-5325)**: with `groupOverlappingFiles=true`, scheduler now defers a lower-priority (or younger same-priority) candidate when an overlapping queued todo task exists, preserving priority→age→task-id order for overlap serialization without preempting in-progress work. If the inversion is against an already-running lower-priority blocker, scheduler still defers the candidate; the per-pairing audit event was removed in FN-6174 due to zero consumers and table bloat.
- **Empty-commit refusal + early empty-own-diff finalize (FN-5345/FN-5377)**: Fusion task worktrees install a `prepare-commit-msg` hook that refuses `git commit --allow-empty` and other zero-staged-diff commits, preventing verification-only tasks from manufacturing empty handoff commits that defeat the merger's no-op classifier. The hook allows legitimate empty-tree paths (amend, merge, squash, cherry-pick, revert, rebase). Amend detection tokenizes the parent process command line (`ps -o args=` with `/proc/$PPID/cmdline` fallback for Alpine/busybox) and stops at the first message-supplying flag (`-m`/`-F`/`--message`/`--file`) so a commit message containing the substring `--amend` cannot bypass the guard. In `aiMergeTask`, an early empty-own-diff fast-path runs BEFORE any reuse-handoff acquisition: when integration mode is `reuse-task-worktree`, the branch exists, `git rev-list --count <mergeTarget>..<branch>` is > 0, and `git diff --quiet <mergeBase>..<branch>` exits 0, the task auto-finalizes as no-op with `mergeDetails.noOpMerge: true` and emits `task:auto-recover-finalize-already-on-main` with `reason: "empty-own-diff-early-fast-path"`. The fast-path best-effort removes the stranded worktree (FN-4811 same-task/foreign-owner guard) and deletes the `fusion/<id>` branch so empty-own-diff residuals do not accumulate. This unsticks tasks where a stale empty handoff commit combined with drifted worktree↔branch mapping would otherwise wedge the handoff gate with `registered-branch-mismatch`. The explicit `cwd-integration-branch` mode is unchanged (`cwd-main` remains a deprecated alias normalized to it). `classifyOwnedLandedEvidence` also detects empty-own-diff (aheadCount > 0, zero net diff) and returns `proven-no-op` so downstream self-healing and post-handoff finalize paths benefit too. Additionally, merger's reuse-fallback path now consults `git worktree list --porcelain` before creating a new worktree: extant usable registrations of `fusion/<id>` are reused directly (rather than blindly `git worktree add -f` producing a duplicate registration), and stale registrations are pruned first. The direct-reuse shortcut is guarded by FN-4811 (refuses paths owned by a different task in `activeSessionRegistry`) and FN-4954 (skipped when `recycleWorktrees=true` with a pool attached, so `WorktreePool.acquire` lease bookkeeping stays consistent). Two audit subtypes — `merge:reuse-fallback-pruned-stale-registration` and `merge:reuse-fallback-reused-existing-registration` — replace the prior overloading of `merge:reuse-fallback-new-worktree` for these cases.
- **Verified no-op/duplicate executor completion (FN-6275/FN-7488)**: explicit `fn_task_done` may complete with zero branch commits only when the summary starts with a recognized sentinel (`PREMISE STALE:`, `NO-OP:`, `NOOP:`, `DUPLICATE: FN-NNNN ...`, or `REDUNDANT:`), the task already carries a no-commit contract, or the PROMPT declares a source-free gitignored task-artifact delivery. The source-free path is intentionally narrow: File Scope must be populated and limited to board/task artifacts such as `.fusion/tasks/...`, task documents/logs, or attachments; the prompt must forbid force-adding ignored `.fusion/` artifacts and fabricating empty commits or equivalently state that source-free/gitignored task artifacts are the only deliverables; and any tracked source/docs/config/test/changeset scope keeps the `no_commits` refusal active (even if `.fusion/` artifacts are also listed). These exemptions only relax the `no_commits` invariant; `wrong_toplevel`, `wrong_branch`, pending-step/review refusals, and scope-leak guards still run. Accepted sentinel completions persist `noCommitsExpected: true`, write task-log audit details with marker kind/reason/raw summary/run/agent IDs, and add a task timeline activity so the no-code terminal path remains explainable. Prompt-derived source-free completions log `prompt-derived source-free task-artifact contract` for operator audit. Ordinary zero-commit implementation completions without one of these contracts are still refused.
- **In-review branch-binding self-heal (FN-5083/FN-6695)**: `reconcile-in-review-branch-rebind` runs after `reconcile-task-worktree-metadata` and before `reclaim-stale-active-branches`. It restores `task.branch` (and clears `task.worktree` for fresh acquisition) for `in-review` tasks when exactly one case-insensitive `fusion/<id>` candidate branch has unique commits versus the integration base. Ambiguous candidates emit `task:auto-rebind-skipped` (`reason: "ambiguous-candidates"`) and are never auto-resolved. Unsafe metadata repair is also skipped with `task:auto-rebind-skipped`: `userPaused` preserves authoritative user intent, and `checkedOutBy` preserves live agent checkout ownership. Branch construction across executor/worktree-pool/worktree-acquisition/merger/self-healing canonicalizes to lowercase via `canonicalFusionBranchName`; `fn_task_done` wrong-branch checks now auto-canonicalize case-only mismatches and emit `branch:auto-canonicalize-case`.
- **In-review is terminal-until-merged under `autoMerge: false` (FN-5147)**: when a project sets `settings.autoMerge: false`, `in-review` is the intended resting state until a human merges the PR. No lifecycle-mutating self-healing sweep (`reclaimSelfOwnedBranchConflicts`, `recoverGhostReviewTasks`, `recoverStaleIncompleteReviewTasks`, `recoverInterruptedMergingTasks`, `recoverStuckMergeDeadlocks`, `recoverMissingWorktreeReviewFailures`, `recoverPartialProgressNoTaskDoneFailures`, `recoverCompletionHandoffLimbo`, `recoverPostDoneNonContinuableWedge`, `recoverMergeableReviewTasks`, `recoverMergedReviewTasks`, `recoverAlreadyMergedReviewTasks`, `recoverOrphanOnlyScopeViolations`, `recoverForeignOnlyContaminatedInReviewTasks`, `recoverReviewTasksWithFailedPreMergeSteps`, `finalizeNoOpReviewTasks`, `surfaceInReviewStalls`, `surfaceInReviewStalled`) may move the task out of `in-review`, mark it `paused`/`failed`, or re-enqueue it for execution. That includes merge-active unusable-worktree recovery: automation emits `task:reconcile-missing-worktree-merge-active-no-action` with `reason:"auto-merge-off"` instead of moving the row, while explicit operator retry remains supported because it is a manual reset request. Explicit per-task overrides are distinguished by `task.autoMergeProvenance: "user"`; ambiguous legacy rows stamped `autoMerge: true` by the pre-FN-6245 review-entry path are marked `"legacy-stamp"` once and surfaced in run-audit/logs, but are only cleared by the operator-driven `reconcileLegacyAutoMergeStamps({ apply: true })` action. Scoped FN-5819 exception: shared-group members (`branchContext.assignmentMode === "shared"`) are still allowed through the member→`branch_groups.branchName` integration step while `autoMerge` is off; this is a soft pre-integration only and does not permit shared-branch → default-branch promotion. FN-7182 applies the same human-gated treatment to an open `PrInfo.manual` PR created or linked from the dashboard **Create PR** action: automatic merge queues and self-healing stand down until the PR is closed/merged or handled manually, while pipeline-created PRs without `manual` remain auto-merge eligible. RECONCILE-ONLY sweeps (branch rebind, blocker fan-out, stale-status clears, contamination metadata cleanup, attribution restore, PR refresh, misclassified-failure error clearing) continue to run.
- **Auto-merge integration-root default (FN-5279)**: direct auto-merge now defaults `mergeIntegrationWorktree` to `reuse-task-worktree`; merger must pass the reuse handoff gates or emit `merge:reuse-handoff-refused` and leave the task in `in-review` without silently falling back to `cwd-integration-branch` (`cwd-main` remains a deprecated alias normalized to that mode).
- **Orphaned execution sweep is observation-only (FN-5337)**: `recoverOrphanedExecutions` only annotates stale in-progress candidates with `task:orphan-detected-no-action` and `[orphan-detected] ... no action (operator-decides)` logs. It must never move `in-progress`/`in-review` backward to `todo` or mutate lease/worktree metadata. Proof-based backward recovery remains exclusively in `recoverInProgressLimbo` (FN-5219), `RestartRecoveryCoordinator`, `recoverMissingWorktreeReviewFailures`, and explicit executor/merger failure paths. Reintroducing lifecycle mutation here requires hard git/session proof gating plus CEO+CTO+PM sign-off.
- **Self-owned reclaim resume-limbo escalation (FN-5704)**: `reclaimSelfOwnedBranchConflicts` tracks `resumeLimboCount`, `resumeLimboTipSha`, and `resumeLimboStepSignature` for in-progress reclaim/unpause loops. If reclaim finds no progress (same tip, same step-status signature, and no active-session signal) for `MAX_NO_PROGRESS_RESUME_ATTEMPTS` consecutive sweeps, self-healing escalates by moving the task to `todo` with `preserveWorktree: true`, `preserveProgress: true`, and `preserveResumeState: true` instead of endlessly re-arming resume. Escalation emits `task:resume-limbo-escalated` run-audit metadata (`frozenTipSha`, `idleMs`, `resumeAttemptCount`, `currentStep`) and resets the limbo counter.
- **Merge-request shadow contract (FN-5741 Phase 1)**: `mergeRequestContractShadowEnabled` defaults OFF. OFF means no writes to `merge_requests` or `completion_handoff_markers` and the legacy lifecycle remains authoritative. ON enables write-only shadow persistence: executor/self-healing append `task:completion-handoff-accepted` marker+record writes only after successful legacy `handoffToReview`, and merger mirrors `merge:request-enqueued` plus `queued → running → succeeded` (or `manual-required` for `autoMerge:false`) transitions. Phase 1 never reads these shadow records for column movement, dependency checks, lease arbitration, merge dequeue, or FN-5479/FN-5704 limbo recovery decisions.
- **Dual-observe parity seam (FN-5742 Phase 2)**: with the same flag ON, legacy remains authoritative while shadow reads compute/emit parity telemetry only. Scheduler emits `merge:dependency-parity-diff` when `in-review|done|archived` dependency satisfaction diverges from completion-handoff marker satisfaction, and `merge:lease-parity-diff` when legacy in-review overlap leasing diverges from shadow lease decomposition. Merger emits `merge:request-dequeued-shadow` (agree/disagree metadata) by comparing legacy dequeue selection to shadow merge-request selection while explicitly skipping `manual-required` rows. Phase 3 dequeue cutover is gated on sustained parity (low disagreement rate) from these additive events; no lifecycle authority changes in Phase 2.
- **Authoritative cutover seam (FN-5743 Phase 3)**: with the flag ON, merge-request records and `completion_handoff_accepted` markers become authoritative enforcement signals for dequeue/retry ownership and dependency/lease gates. Accepted handoffs stop stamping `in-review` executor overlap leases, transient merge retries stay in merge-request state (`running → retrying → queued`, terminal `exhausted|succeeded|cancelled`) without `todo` rebounds, and user hard-cancel (`in-review → todo`) deterministically cancels pending merge-request records while keeping FN-5147/FN-5704 behavior unchanged.
- **No-progress churn terminalization (FN-5168)**: `StuckTaskDetector` now tracks ignored `fn_task_update` rebuffs via `recordIgnoredStepUpdate(taskId)` and, after one loop/compact-and-resume recovery has already fired in the same `execute()` lifecycle, escalates `ignoredStepUpdateCount >= 25` to the terminal reason `no-progress-churn`. `SelfHealingManager.checkStuckBudget()` maps that reason directly to `STUCK_NO_PROGRESS_CHURN`, emits `task:stuck-no-progress-churn-terminalized` with `{ taskId, ignoredStepUpdateCount, stuckKillStreak, lastReason }`, and parks the task in `in-review` without consuming the normal stuck-kill budget. Under FN-5147 `autoMerge: false`, that failed in-review task remains terminal-until-merged just like `STUCK_LOOP_EXHAUSTED`; the new class adds an earlier bounded exit, not a re-execution path.
- **Verification-active stuck-loop suppression (FN-6598)**: `fn_run_verification` registers a per-task active verification window with `StuckTaskDetector`. Within the command's own timeout budget, subprocess output/heartbeats are treated as forward progress and suppress only `loop` / `no-progress-churn`; the deadline restores normal classification if the command or end callback wedges, and `inactivity` remains governed by heartbeat flow.
- **Todo↔in-progress flapping convergence (FN-5941)**: live backward-recovery paths now share a `getFalsePositiveRequeueSignal(...)` guard that suppresses `in-progress → todo` recovery when any hard liveness proof exists (`getExecutingTaskIds`, recent active-heartbeat run, checked-out lease, live worktree+branch binding, or recent `executionStartedAt` inside the relevant grace window). Suppressed candidates emit observation-only `task:*no-action` audits instead of silently mutating lifecycle state. Scheduler adds a short `recentEngineTodoRequeues` settle window so engine-sourced requeues cannot be re-dispatched immediately on the same `task:moved → todo` tick. The durable convergence backstop is the dispatch-oscillation breaker: scheduler reuses `task.dispatchStormCount` + `task.lastDispatchAt` as a sliding-window counter (`dispatchOscillationThreshold`, `dispatchOscillationWindowMs`) and, when the threshold is exceeded, leaves the task parked in `todo`, sets `paused: true` with `pausedReason: "dispatch-oscillation"`, records `task:dispatch-oscillation-terminalized`, and requires an operator unpause or forward move to reset the counter.
- **Landed-files attribution (FN-5103)**: Rebase-strategy `mergeDetails.landedFiles` / `filesChanged` / `insertions` / `deletions` are captured from task-attributable commits only via `filterFilesToOwnTaskCommits` (subject-prefix + trailer + bracket-prefix evidence), tagged `landedFilesAttributionRestricted: true`. Zero own commits → `landedFiles: []` and `noOpVerifiedShortCircuit: true`. FN-5304 guard: when `<rebaseBaseSha>..HEAD` reports zero own commits, merger must also validate the source `fusion/<id>` tip; if that source tip still has attributable own commits relative to `rebaseBaseSha`, throw `SilentNoOpAttributionMismatchError`, refuse writing `mergeConfirmed: true`, park the task in `in-review` with `status: "failed"`, and emit `merge:no-op-attribution-mismatch`. If source ref is unavailable, skip with diagnostic + `merge:no-op-attribution-mismatch-skipped` (`reason: "source-ref-unavailable"`). Attribution-helper failures fall back to the unrestricted `rebaseBaseSha..sha` walk and set `landedFilesCaptureFallback: 'attribution-failed'`. Self-healing `recoverDoneTaskMergeMetadata` skips reconcile when `landedFilesAttributionRestricted` or `noOpVerifiedShortCircuit` is set so the narrower set is not overwritten with the full range. Squash-strategy capture is unchanged.
- **Soft-delete scheduler invalidation (FN-5137)**: `task:deleted` events must invalidate `AutoClaimSnapshotManager` and clear scheduler bookkeeping (`pausedTaskIds`, `failedTaskIds`, `wasNodeDispatchValidationBlocked`, `wasNodeBlocked`); `executor.execute()` / `resumeOrphaned()` / `resumeTaskForAgent()` refuse any task with `deletedAt` set.
- **Soft-delete in-flight abort (FN-5142)**: `task:deleted` must immediately abort/dispose active executor work (`activeSessions`, `activeStepExecutors`, `activeWorkflowStepSessions`, reviewer subagents), interrupt active merge state (`mergeAbortController`, `activeMergeSession`, `activeMergeTaskId`, `mergeActive`, `mergeQueue`, `pausedReviewTaskIds`), and abort triage specify/subagent sessions for that id. Handlers are per-task and idempotent.
- **Archive releases active-session locks (FN-7717)**: `task:moved` with `to === "archived"` (from ANY column, including in-progress via a direct single-hop `fn_task_archive`, and triage/planning where Plan Review and other workflow-step sessions run) now disposes in-flight session surfaces via `awaitAbortInFlightTaskWork` and sweeps any remaining `activeSessionRegistry` paths for the task, so a leaked lock can never survive archive and block a successor task's `registerPath` on the same session path. The `to === "archived"` check is ordered BEFORE the `from === "in-progress"` branch so a direct in-progress→archived move gets the same full cleanup instead of falling into the narrower in-progress-only branch. `to === "done"`/`"in-review"` are deliberately excluded — those columns legitimately hold `ai-merge`/`workspace-repo-land` merge leases.
- **Soft-delete audit + column reconcile (FN-5175)**: `TaskStore.deleteTask` records a `runAuditEvents` row (`mutationType: "task:deleted"`, `domain: "database"`) inside the same transaction that sets `deletedAt`, and sets `"column" = 'archived'` on the row. Callers without a heartbeat run context (`fn task delete`, pi extension, dashboard delete route) pass an `auditContext` with `agentId: "system"` and a synthetic `runId`. The watcher cross-instance emit path does NOT re-record the audit event. The row stays in `tasks` (not `archivedTasks`); `archiveTask` is unchanged.
- **Soft-delete fast path cleanup (FN-7968)**: user-visible `TaskStore.deleteTask` completion is bounded by the soft-delete transaction, audit row, cache/event emission, dependency/lineage gates, and near-duplicate cleanup. Potentially slow branch cleanup (`cleanupBranchForTask` git subprocesses) is scheduled after the row is already soft-deleted; it must still clear stale execution-start branch references and persist the cleaned-branch log entry on the deleted row. Dashboard `DELETE /tasks/:id` likewise responds after `deleteTask` and schedules execution-agent binding release off the HTTP critical path; the release remains observable through warning logs on failure.
- **Soft-delete resurrection guard (FN-5208)**: `TaskStore.readTaskJson()` must never fall back to `.fusion/tasks/<id>/task.json` when the DB row exists with `deletedAt` set — it throws `TaskDeletedError`. `atomicCreateTaskJson` / `atomicWriteTaskJson` / `atomicWriteTaskJsonWithAudit` refuse to upsert a task whose row is currently soft-deleted (unless the in-memory task carries `deletedAt` itself, for soft-delete maintenance paths), emit a `[soft-delete-resurrection-blocked]` log line, and record a `task:resurrection-blocked` run-audit event. Stale in-flight planner/triage writes for a soft-deleted ID surface `TaskDeletedError` and abort cleanly without emitting `task:created`.
- **Exhausted in-review visibility surfaces (FN-5513/FN-6569)**: retry-exhausted merge failures (`column='in-review'`, `status='failed'`, `mergeRetries >= maxAutoMergeRetries`, default `3`) can remain soft-deleted for lifecycle safety, but are now intentionally discoverable through opt-in read paths: `TaskStore.listExhaustedInReviewTasks({ includeDeleted })`, `GET /api/tasks/exhausted-in-review`, `GET /api/tasks/:id?includeDeleted=true`, CLI `fn_task_show` soft-delete fallback marker, CLI `fn_task_list({ includeDeleted: true })`, and the dashboard ReliabilityView "Exhausted in-review (hidden blockers)" panel. This complements FN-5488/FN-5496 downstream blocker healing by surfacing the upstream blocker without mutating lifecycle state.
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
- FN-5168/FN-6598 backstop: `packages/engine/src/__tests__/reliability-interactions/non-progress-churn.test.ts` covers loop→compact recovery followed by ignored-step-update churn escalation, terminal `beforeRequeue(false)` behavior, audit/log payloads, FN-5147 autoMerge-off composition, and verification-active suppression so healthy `fn_run_verification` runs do not reach `onLoopDetected` / stuck-budget handling while the no-verification control still trips.
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
- FN-5770 backstop: `packages/engine/src/__tests__/reliability-interactions/workflow-interpreter-cutover.test.ts` guards the interpreter-authoritative lifecycle seam. The cutover remains opt-in (`workflowInterpreterAuthoritative` default OFF), readiness-gated by clean populated parity summary evidence while retired `workflowInterpreterDualObserve` settings stay inert, reversible by flipping one flag back OFF, and must preserve file-scope, squash-overlap, `autoMerge:false`, hard-cancel, and self-healing interaction invariants.
- FN-5337 backstop: `packages/engine/src/__tests__/reliability-interactions/orphan-detected-no-requeue.test.ts` locks observation-only orphan detection across FN-5279 repro metadata desync, worktree-present and worktree-missing candidates, FN-5219 ordering, FN-5147 in-review isolation, FN-5083 branch-cleared composition, lease-manager non-invocation, and per-sweep idempotent audit emission.
- FN-5256 backstop: `packages/engine/src/__tests__/reliability-interactions/dependency-cycle-reconcile.test.ts` covers persisted dependency-cycle detection via `reconcileDependencyCycles`, bounded umbrella-back-edge auto-repair, ambiguous-cycle observe-only behavior, composition ordering with `reconcileSelfDefeatingDependencies`, and the post-sweep write-time guard invariant. Core write-boundary regressions (FN-5240/5241/5242 signature, indirect cycle, umbrella back-edge rejection) live in `packages/core/src/__tests__/store-dependency-cycle.test.ts`.
- FN-5223 backstop: `packages/engine/src/__tests__/reliability-interactions/engine-active-since-floor.test.ts` covers engine-activation floor + grace composition across startup, pause/unpause, global-pause gating, and StuckTaskDetector lifecycle interactions.

The auto-recovery dispatcher at `packages/engine/src/auto-recovery.ts` (FN-4533) composes on top of existing layers (FN-4500 fast-path, FN-4508 deterministic branch-conflict, FN-4499 bootstrap-misbinding, FN-4428 contamination, `mergeAuditAutoRecovery` Stages 1–5, self-healing) to handle six residual classes: file-scope violation at squash, branch misbinding / ghost worktree, verification-fix scope leak, contamination, `branch-conflict-unrecoverable` residuals, and room-post/message-send failures. Invocation is additive — no existing layer's behavior changes.

### Concurrent soft-delete heartbeat races (FN-8004)

A heartbeat `moveTask` failure with the typed `TaskDeletedError` soft-delete message is a benign board miss: the durable agent stays active, clears `lastError` and heartbeat recovery metadata, and emits `agent:heartbeat-move-skipped-soft-delete`. Its audit metadata is structured only: `agentId`, `taskId`, `deletedAt`, `moveAttemptedAt`, and `source`.
