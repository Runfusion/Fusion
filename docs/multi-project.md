# Multi-Project

[← Docs index](./README.md)

Fusion can coordinate multiple repositories from one installation, with shared visibility and global concurrency control.

## Why Use Multi-Project Mode?

Use multi-project mode when you need to:

- Operate many repos from one dashboard/CLI
- Standardize settings and workflows across projects
- Monitor global activity and system-wide execution capacity

## Central Database Architecture

Multi-project metadata is stored in:

`~/.fusion/fusion-central.db`

Core tables:

- `projects`
- `projectHealth`
- `centralActivityLog`
- `globalConcurrency`
- `nodes`
- `peerNodes`
- `settingsSyncState`
- `__meta`

Per-project task data remains in each repo’s `.fusion/fusion.db`.

Peer/mesh coordination spans core + engine, with startup ownership in CLI process entrypoints:
- `NodeDiscovery` and `NodeConnection` in `@fusion/core` handle discovery and remote node connectivity/auth primitives.
- `PeerExchangeService` in `@fusion/engine` coordinates node-to-node sync/exchange workflows.
- Canonical replication semantics live in [`docs/shared-mesh-protocol.md`](./shared-mesh-protocol.md). That protocol separates strongly coordinated shared state from append-only streams, queued replay classes, and node-local runtime state.
- Distributed task-ID allocation is one strongly coordinated shared-state path: reserve/commit/abort are coordinator-mediated writes, and cluster-wide committed task totals come from allocator `committedClusterTaskCount` state (not per-node local task counts).
- `runServe()` and `runDashboard()` (CLI) own process-level mesh service lifecycle:
  - start one process-wide `PeerExchangeService` instance
  - call `CentralCore.startDiscovery()` only after the HTTP server is listening and the real bound port is known
  - stop peer exchange + discovery on shutdown
- `InProcessRuntime` remains project-scoped (scheduler/executor/heartbeat/missions) and does **not** start mesh services, which avoids one peer-exchange instance per project.

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

## Global Concurrency Management

A singleton central record enforces system-wide limits so one project cannot monopolize all execution slots.

## Plugin Scope in Multi-Project Mode

Plugin persistence is split across global and project scopes:

- Global installation metadata is shared across projects in `~/.fusion/fusion-central.db` (`plugin_installs`)
- Per-project activation/runtime state is tracked separately per normalized project path (`project_plugin_states`)

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

1. **Project runtime placement** (`projects.nodeId` in `~/.fusion/fusion-central.db`)
   - Decides where a project runtime is hosted in multi-project orchestration.
2. **Project working-directory mapping** (`projectNodePathMappings` in `~/.fusion/fusion-central.db`)
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

## Auto-Migration from Single-Project

On first run after upgrade:

- Existing project databases are detected
- Projects are registered into central DB automatically
- Existing single-project workflows continue working

Migration is idempotent and designed to avoid repeated re-registration.

## Rollback Procedure

If central registry behavior needs to be reverted:

1. Delete `~/.fusion/fusion-central.db`
2. Keep using per-project `.fusion/fusion.db` data
3. Fusion falls back to legacy/single-project behavior
4. Re-register projects later with `fn init` / `fn project add`

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
