# Multi-Project

[← Docs index](./README.md)

Fusion can coordinate multiple repositories from one installation, with shared visibility and global concurrency control.

The [2026-07-14 PostgreSQL runtime cutover review](./postgres-migration-review-2026-07-14.md) is the current authority for legacy-reader and deployment boundaries.

## Why Use Multi-Project Mode?

Use multi-project mode when you need to:

- Operate many repos from one dashboard/CLI
- Standardize settings and workflows across projects
- Monitor global activity and system-wide execution capacity

## Central Registry Architecture

Multi-project metadata is stored in the PostgreSQL `central` schema. Embedded mode uses Fusion's managed PostgreSQL data directory; external mode uses `DATABASE_URL`.

Core tables:

- `projects`
- `projectHealth`
- `centralActivityLog`
- `globalConcurrency`
- `nodes`
- `peerNodes`
- `settingsSyncState`
- `taskClaims` (authoritative cross-node task checkout claims keyed by `(projectId, taskId)`)
- `__meta`

Per-project task data is keyed by `projectId` in PostgreSQL's `project` schema. Each repo keeps `.fusion/project.json` as its filesystem identity marker; `.fusion/fusion.db` is read only by the one-time legacy migrator.

Use PostgreSQL-native backup/restore tooling for authoritative runtime data. Legacy `fn backup` SQLite artifacts remain migration/recovery inputs; restoring one does not replace the live PostgreSQL registry.

`taskClaims` is the central cross-node lease mutex introduced by FN-4819 §2: claim acquisition/renewal/release happen in PostgreSQL, while per-project lease fields mirror the central winner for local scheduler/runtime consumption.

Peer/mesh coordination spans core + engine, with startup ownership in CLI process entrypoints:

- Topology visibility is now cluster-wide from any connected node: dashboard mesh reads aggregate remote local snapshots and dedupe by `nodeId`, with fallback to last-known local mesh state when a peer is temporarily unreachable.
- Outage tolerance persistence is central and project-scoped: degraded mesh snapshots and queued write replay rows are stored with `projectId` keys so partitions in one project do not blur reconciliation state across other registered projects.
- `NodeDiscovery` and `NodeConnection` in `@fusion/core` handle discovery and remote node connectivity/auth primitives.
- `PeerExchangeService` in `@fusion/engine` coordinates node-to-node sync/exchange workflows.
- `MeshLeaseManager` in `@fusion/engine` is the single authority for stale lease detection and abandoned-work recovery across nodes.
- Canonical replication semantics live in [`docs/shared-mesh-protocol.md`](./shared-mesh-protocol.md). That protocol separates strongly coordinated shared state from append-only streams, queued replay classes, and node-local runtime state.
- Distributed task-ID allocation is one strongly coordinated shared-state path: reserve/commit/abort are coordinator-mediated writes, and cluster-wide committed task totals come from allocator `committedClusterTaskCount` state (not per-node local task counts).
- `runServe()` and `runDashboard()` (CLI) own process-level mesh service lifecycle:
  - start one process-wide `PeerExchangeService` instance
  - call `CentralCore.startDiscovery()` only after the HTTP server is listening and the real bound port is known
  - stop peer exchange + discovery on shutdown
- `InProcessRuntime` remains project-scoped (scheduler/executor/heartbeat/missions) and does **not** start mesh services, which avoids one peer-exchange instance per project.

## Mesh lease recovery in multi-node execution

Task ownership is shared as persisted lease metadata (`checkedOutBy`, `checkedOutAt`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`) through the canonical mesh sync payloads.

When a node disappears or stops renewing ownership, recovery is routed only through `MeshLeaseManager.recoverAbandonedLease(...)`. The manager now performs a two-write release: it releases the authoritative central `taskClaims` row first, then clears per-project owner fields (`checkedOutBy`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkedOutAt`) and bumps `checkoutLeaseEpoch` locally.

If one side succeeds and the other fails, the next scheduler/self-healing tick runs `reconcileLeaseRow(taskId)` to deterministically converge local and central lease state without a side queue. Recovery/reconciliation paths emit `task:auto-recover-lease-*` run-audit events (`...-released`, `...-already-healed`, `...-foreign-owner`, `...-central-unavailable`, `...-partial-write`, `...-reconciled`) for traceability.

This fencing prevents double-claims: a restarted or delayed stale owner cannot reclaim work once central ownership has been released and lease generation has advanced.

## Recovering a missing central project row

If a project's PostgreSQL central-registry row is deleted, Fusion recovers it on next startup:

1. Startup checks central for a row at the project path.
2. If missing, it reads `<project>/.fusion/project.json` (or imports a legacy SQLite identity once).
3. If present, central reattaches that exact `projectId` instead of creating a new one.

This prevents “empty workspace” regressions where project data still exists locally but is keyed to an older `projectId`.

PostgreSQL backups remain the first-line protection strategy, but this identity reattach path restores the path-to-project mapping without minting a new ID.

## Registering and Managing Projects

```bash
fn project add my-app /path/to/app
fn project list
fn project show my-app
fn project set-default my-app
fn project detect
fn project remove my-app --force
```

## `--project` Flag and Resolution

You can target a project explicitly:

```bash
fn task list --project my-app
fn task create "Fix oauth callback" --project my-app
```

Resolution order without `--project`:

1. explicit flag
2. default project
3. current-directory auto-detection

## Project Health Tracking

Central health tracking keeps mutable project metrics, including:

- active task counts
- in-flight agent counts
- project status (`initializing`, `active`, `paused`, `errored`)
- dashboard project status badges degrade gracefully if registry or health data briefly carries an unknown or missing status value

`projectHealth.inFlightAgentCount` is persisted slot/health bookkeeping, not an authoritative live running-agent count. Read-layer surfaces that need the current number of running agents (for example the dashboard project health route and `fn project list/info`) derive it from in-progress executor tasks plus active triage planners (`column === "triage"`, `status === "planning"`, and not paused) while preserving the stored health row for non-count metadata.

## Global Concurrency Management

<!-- FNXC:GlobalConcurrencyControls 2026-06-26-18:35: Live global-concurrency readouts must count both in-progress executors and active triage planners because both hold concurrency slots; paused or non-planning triage rows stay excluded. -->
A singleton central record enforces system-wide limits so one project cannot monopolize all execution slots. `globalConcurrency.currentlyActive` remains persisted slot bookkeeping maintained by acquire/free flows; live read-only running-agent displays derive `currentlyActive` and per-project active counts from `in-progress` tasks plus triage tasks with `status === "planning"` that are not paused in already-open project stores, while the persisted `globalMaxConcurrent` cap and `queuedCount` continue to come from central concurrency state. The slot acquire/free limiter semantics and DB column names are unchanged.

## Plugin Scope in Multi-Project Mode

Plugin persistence is split across global and project scopes:

- Global installation metadata is shared across projects in PostgreSQL `plugin.plugin_installs`
- Per-project activation/runtime state is tracked separately per normalized project path (`project_plugin_states`)
- Project-local `.fusion/fusion.db` `plugins` rows are legacy migration-only input and are no longer a write target for installs

Operationally:
- `install` / `uninstall` are global actions
- `enable` / `disable` and runtime state/error are project-scoped
- A single global plugin install can be enabled in one project and disabled in another

## Isolation Modes

Projects can run with:

- **`in-process`** (default): low overhead, shared process
- **`child-process`**: stronger isolation with independent process boundary

## Node Routing

Multi-project deployments use three related node/path records at different layers:

1. **Project runtime placement** (`central.projects.nodeId` in PostgreSQL)
   - Decides where a project runtime is hosted in multi-project orchestration.
2. **Project working-directory mapping** (`central.projectNodePathMappings` in PostgreSQL)
   - Stores the absolute path for a project on each node (`projectId` + `nodeId` key).
   - Local mappings are auto-created from `projects.path` at registration and kept in sync when local canonical path changes.
3. **Task dispatch default** (`defaultNodeId` in project settings)
   - Decides where tasks route when they do not have a per-task override.

These fields are intentionally distinct.

### Path mapping API surface

Dashboard and node workflows should use dedicated mapping endpoints rather than overloading `projects.nodeId`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects/:id/path-mappings` | List all node-specific absolute paths for one canonical project ID. |
| GET | `/api/projects/:id/path-mappings/:nodeId` | Read a single project+node mapping. |
| PUT | `/api/projects/:id/path-mappings/:nodeId` | Upsert a project+node absolute path mapping. |
| DELETE | `/api/projects/:id/path-mappings/:nodeId` | Remove a project+node mapping. |
| GET | `/api/nodes/:id/path-mappings` | List all project mappings known for one node. |

These APIs persist/read `projectNodePathMappings` (`projectId` + `nodeId` key). They do **not** assign runtime hosting, and they do **not** change task routing defaults.

### Node onboarding path-capture flow

When adding a node from the dashboard, onboarding now supports attaching already-registered projects and capturing a node-specific absolute path for each selected project.

- Step 1: register the node (`POST /api/nodes`)
- Step 2: upsert one `projectNodePathMappings` record per selected project (`PUT /api/projects/:id/path-mappings/:nodeId`)

This onboarding mapping capture is intentionally separate from:
- `projects.nodeId` (runtime host-node assignment)
- `projects.path` / `ProjectInfo.path` (canonical registered project path)

So node onboarding records where a given node can access a project on disk, without changing which node hosts the runtime or task-routing defaults.

### Runtime placement (`projects.nodeId`)

`ProjectManager` uses project registration data plus isolation mode to pick runtime type:

- `isolationMode: "child-process"` → always `ChildProcessRuntime`
- `isolationMode: "in-process"` + remote `projects.nodeId` → `RemoteNodeRuntime`
- `isolationMode: "in-process"` + local/unset/missing node assignment → `InProcessRuntime`

Runtime startup now resolves `ProjectRuntimeConfig.workingDirectory` from the exact routed/current node mapping (`projectNodePathMappings` for `{projectId,nodeId}`) via `CentralCore` resolver APIs. It does **not** fall back to `projects.path` when that node mapping is missing; startup/update fails with a clear mapping error.

So `projects.nodeId` is a **project host-node assignment**, not a per-task override, and not the node-specific working-directory source of truth (that lives in `projectNodePathMappings`).

### Task routing defaults (`defaultNodeId` + `Task.nodeId`)

Within a project runtime, effective task routing resolves as:

1. task override (`Task.nodeId`)
2. project default (`defaultNodeId`)
3. local execution

Task creation also has a separate **transport node** concept: dashboard/API clients can route the create request through a remote node proxy while still setting `Task.nodeId` for where execution should occur later. Transport-node selection controls which node receives the HTTP write; `Task.nodeId` controls execution routing after the task exists.

This allows each project to maintain independent routing behavior even when managed from one central registry.

### Unavailable node policy in multi-project context

`unavailableNodePolicy` is project-scoped and can be set differently per project (`block` or `fallback-local`).

Dispatch ordering now enforces project/node path mapping validation before health policy evaluation:

1. Resolve effective node (`Task.nodeId` → `defaultNodeId` → local).
2. If routed to a node, require a persisted `projectNodePathMappings` entry for `(projectId, nodeId)`.
3. If mapping is missing/blank, dispatch is blocked in `todo` with a clear log message (`Execution blocked: project has no path mapping for node <id>`).
4. Only mapped nodes continue to unavailable-node policy (`block` vs `fallback-local`).

This keeps configuration errors (missing mapping) distinct from health/failover behavior.

### Example: different node defaults per project

- **Project A** (`projects.nodeId` assigned to remote host): runtime executes via `RemoteNodeRuntime`; `defaultNodeId=edge-a` routes unpinned tasks to edge-a.
- **Project B** (`projects.nodeId` unset): runtime stays local `InProcessRuntime`; `defaultNodeId=edge-b` still marks its task dispatch default independently.

See also:
- [Settings Reference → Node Routing settings](./settings-reference.md#node-routing-settings-project-scope)
- [Task Management → Node Routing](./task-management.md#node-routing)
- [Architecture → Task Routing Architecture](./architecture.md#task-routing-architecture)

### Verification coverage (automated)

The multi-node mapping/routing contracts are guarded by automated suites:

- Onboarding `projectMappings` payload + discovery UX: `packages/dashboard/app/components/__tests__/AddNodeModal.test.tsx`, `packages/dashboard/app/hooks/__tests__/useNodes.test.ts`, `packages/dashboard/src/__tests__/node-routes.test.ts`, `packages/dashboard/src/__tests__/routes-projects-across-nodes.test.ts`.
- Mapping persistence/backfill invariants: `packages/core/src/__tests__/central-core.test.ts`, `packages/core/src/__tests__/central-db.test.ts`, `packages/core/src/__tests__/central-project-node-mappings.test.ts`.
- Dispatch blocking on missing mappings + routed working-directory resolution: `packages/engine/src/__tests__/scheduler-node-routing.test.ts`, `packages/engine/src/__tests__/node-dispatch-validation.test.ts`, `packages/engine/src/__tests__/project-engine-manager.test.ts`, `packages/engine/src/__tests__/hybrid-executor.test.ts`.

## HybridExecutor wiring

Runtime startup in `fn serve`, `fn dashboard`, and `fn daemon` now keeps `ProjectEngineManager` as the per-project engine lifecycle owner and conditionally layers `HybridExecutor` for orchestration concerns (`ProjectRuntime` abstraction + `NodeHealthMonitor`).

Gate policy is centralized in `shouldUseHybridExecutor(centralCore)` and evaluated in this order:
1. `FUSION_HYBRID_EXECUTOR=1|0` env override (`reason: "env-override"`)
2. multi-node registry state (`reason: "multi-node"`)
3. multi-project active/initializing state (`reason: "multi-project"`)
4. otherwise disabled (`reason: "single-project-local-only"`)
5. central lookup failures degrade to disabled (`reason: "central-unavailable"`)

When enabled, shutdown ordering is deterministic: `hybridExecutor.shutdown()` runs before `engineManager.stopAll()` so runtime orchestration services (including node health monitoring) tear down before project engines.

### Distributed claim mutex

Task checkout now uses an atomic claim path (`TaskStore.tryClaimCheckout`) keyed by a precondition on `(checkedOutBy, checkoutNodeId, checkoutLeaseEpoch)`.

- First claim from unowned state succeeds and bumps `checkoutLeaseEpoch`.
- Contending claims fail with `CheckoutConflictError` and keep the existing owner row intact.
- Lease renewal for the current owner requires an exact epoch precondition and updates `checkoutLeaseRenewedAt`/`checkoutRunId` without bumping the epoch.

### Unavailable node handoff

Owning-node outage behavior is explicitly governed by `owningNodeHandoffPolicy` (global and per-project settings):

- `block` → park work until owner recovers.
- `reassign-to-local` (default) → local node takes over.
- `reassign-any-healthy` → any healthy node may claim/restart.

`Scheduler` and `MeshLeaseManager` both call `decideOwningNodeHandoff(...)` so dispatch-time routing and lease recovery use the same decision surface.

| Capability | Status |
|---|---|
| Distributed checkout claim mutex | Shipped |
| Owning-node lease handoff policy | Shipped |
| Scheduler failover across nodes | Not shipped (explicit non-goal) |
| Live-process state migration | Not shipped (explicit non-goal) |

### Isolation-mode transition

`HybridExecutor.transitionProjectIsolation(projectId, nextMode, { force? })` provides the supported runtime path for isolation-mode changes.

- In HybridExecutor mode, transition persists via `CentralCore.transitionProjectIsolation(...)` then restarts the project runtime.
- If restart is blocked by active tasks and `force` is not set, the persisted isolation-mode change is rolled back and the call returns `reason: "active_tasks"`.
- In single-project mode (no HybridExecutor), the dashboard route falls back to `updateProject(...)` and returns `transitionDeferred: true` so callers know the change applies on next engine start.

For a bounded remediation/design predicate that clarifies the multi-node runtime readiness follow-up scope (distributed ownership claim boundary, unavailable-owner handoff semantics, single↔multi isolation transition guards, and explicit no-remediation non-goals), see `docs/design/fn-4814-multi-node-runtime-readiness.md`. That brief is the execution contract for FN-4813 and supersedes any stale framing that implies HybridExecutor wiring is missing.

## Auto-Migration from Single-Project

On first run after upgrade:

- Existing project databases are detected
- Projects are registered into central DB automatically
- Existing single-project workflows continue working

Migration is idempotent and designed to avoid repeated re-registration.

## Backend rollback

There is no SQLite runtime rollback. Do not delete PostgreSQL data or set `FUSION_NO_EMBEDDED_PG`; the flag now fails startup. Restore PostgreSQL from backup or point `DATABASE_URL` at a recovered database, then run `fn init` / `fn project add` only to repair project registration metadata.

## Runtime Architecture

### ProjectRuntime interface

Each project runtime supports start/stop/status/metrics and access to scheduler/task store (for in-process mode).

### HybridExecutor

HybridExecutor orchestrates all project runtimes and forwards project-attributed events.

### IPC Protocol (child-process mode)

Host → worker commands include:

- `START_RUNTIME`
- `STOP_RUNTIME`
- `GET_STATUS`
- `GET_METRICS`
- `GET_TASK_STORE`
- `GET_SCHEDULER`
- `PING`

Worker → host events include:

- `TASK_CREATED`
- `TASK_MOVED`
- `TASK_UPDATED`
- `ERROR_EVENT`
- `HEALTH_CHANGED`

## HybridExecutor Diagram

```mermaid
flowchart TD
    HE[HybridExecutor]
    PM[Project Manager]
    CC[CentralCore]

    HE --> PM
    HE --> CC

    PM --> A[Project A Runtime\n(in-process)]
    PM --> B[Project B Runtime\n(child-process)]
    PM --> C[Project C Runtime\n(in-process)]

    B --> IPC[IPC Worker Channel]
```

See also: [Architecture](./architecture.md), [CLI Reference](./cli-reference.md), and [Missions](./missions.md).

## Identity persistence and recovery

Each project persists its canonical central identity in `.fusion/project.json` as `projectId` and `projectCreatedAt`. Registration paths use `CentralCore.ensureProjectForPath({ path, identity, ... })` after `readProjectIdentity()`; that reader accepts a legacy SQLite identity only as migration input. Reattachment refuses silent remint when the persisted ID belongs to another path.

Dashboard `POST /api/projects` now surfaces this mismatch as `409` with `error: "orphan-identity"` and recovery metadata, and callers can opt into recovery flows with `acceptRecovery: true` behavior at the route layer.

Back up PostgreSQL with the deployment's PostgreSQL backup tooling; `.fusion/project.json` is identity metadata, not a substitute for a database backup.
