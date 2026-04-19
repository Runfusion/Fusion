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

Peer/mesh coordination spans core + engine:
- `NodeDiscovery` and `NodeConnection` in `@fusion/core` handle discovery and remote node connectivity/auth.
- `PeerExchangeService` in `@fusion/engine` coordinates node-to-node sync/exchange workflows.

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

## Isolation Modes

Projects can run with:

- **`in-process`** (default): low overhead, shared process
- **`child-process`**: stronger isolation with independent process boundary

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
