# Multi-Project

[← Docs index](./README.md)

Fusion can coordinate multiple repositories from one installation, with shared visibility and global concurrency control. Multi-project mode means many registered projects; [workspace mode](./workspaces.md) means one registered project containing multiple Git sub-repositories.

The [2026-07-14 PostgreSQL runtime cutover review](./postgres-migration-review-2026-07-14.md) is the current authority for legacy-reader and deployment boundaries.

## Why Use Multi-Project Mode?

Use multi-project mode when you need to:

- Operate many repos from one dashboard/CLI
- Standardize settings and workflows across projects
- Monitor global activity and system-wide execution capacity

## Central Registry Architecture

Multi-project metadata is stored in the PostgreSQL `central` schema. Embedded mode uses Fusion's managed PostgreSQL data directory; external mode uses `DATABASE_URL`.

<!--
FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
Multi-node durable state lives in shared PostgreSQL (central + project schemas), not per-node SQLite files or HTTP task replication. Embedded Postgres is per-machine only; multi-node shared boards require external DATABASE_URL.
-->

Fusion stores multi-project and multi-node coordination state in **PostgreSQL**:

| Schema | Role |
|---|---|
| `central` | Project registry, nodes, path mappings, global concurrency, **task claims**, mesh topology helpers |
| `project` | Tasks, agents, settings, workflows, missions, distributed task IDs (row-isolated by `project_id` + RLS) |
| `archive` | Cold archive storage |

**Default (single machine):** unset `DATABASE_URL` → embedded Postgres under `~/.fusion/embedded-postgres/`. That data directory is **local to the host**. Two laptops each running embedded Postgres do **not** share a board.

**Multi-node (shared board):** every Fusion node sets the **same external** `DATABASE_URL`. A direct URL needs no duplicate `DATABASE_MIGRATION_URL`; set that override only when the runtime URL is a transaction pooler or schema work needs a separate direct endpoint. All nodes share one database; execution (worktrees, agent processes) stays per node.

## PostgreSQL runtime pool capacity

`FUSION_PG_POOL_MAX` sets the normal runtime-query pool capacity for each Fusion store. It accepts only an integer from `1` through `500`; the default is `3`. Resolution is explicit startup `poolMax` option first, then `FUSION_PG_POOL_MAX`, then the default. Blank, fractional, non-numeric, zero, negative, and above-range environment values produce a safe warning and retain the default rather than being coerced or clamped.

Restart Fusion after changing this setting. Each store uses the configured runtime pool plus one dedicated migration session and one dedicated health session, so account for `FUSION_PG_POOL_MAX + 2` potential connections per active store when sizing a shared external PostgreSQL deployment. Raising the pool can help scheduler bursts only when the PostgreSQL server and pooler have sufficient capacity; it does not replace database connection limits or pooler configuration.

Core `central` tables (names as exposed by the data layer; SQL uses snake_case):

- `projects`
- `project_health`
- `central_activity_log`
- `global_concurrency`
- `nodes` / `peer_nodes`
- `project_node_path_mappings`
- `task_claims` (authoritative cross-node checkout mutex keyed by `(project_id, task_id)`)
- Topology helpers: `mesh_shared_snapshots`, `mesh_write_queue` (membership/auth retry only — **not** task-state replication)

Per-project task data is keyed by `projectId` in PostgreSQL's `project` schema. Each repo keeps `.fusion/project.json` as its filesystem identity marker; `.fusion/fusion.db` is read only by the one-time legacy migrator.

## Dashboard realtime task scope

Task IDs are project-local. Every task lifecycle frame emitted on a scoped `/api/events` stream carries that stream's `projectId`, including envelope payloads and their nested task rows. Dashboard task state is owned by `(projectId, taskId)`: a client discards a known foreign task event before it can update rendered rows or the saved board snapshot.

An absent `projectId` remains valid for legacy and unscoped streams. Clients accept those frames for compatibility, while a present identity that differs from the selected project is always rejected.

### Agent ownership predicates

<!--
FNXC:MultiProjectIsolation 2026-08-11-09:31:
Runfusion/Fusion#3414 requires every `project.agents` read, update, and delete—plus its agent-owned satellite rows—to carry the same ownership predicate as writes. External PostgreSQL deployments commonly use owner or superuser connections that bypass RLS, so application predicates remain the isolation boundary.
-->

Bound agent-store layers scope those operations with `projectScopeFor(..., projectId)`. An unbound or blank layer is intentionally a no-op scope for compatibility and cross-project analytics callers; it must not be converted to a literal empty `project_id` filter or a throwing project-id accessor.

Use PostgreSQL-native backup/restore tooling for authoritative runtime data. Legacy `fn backup` SQLite artifacts remain migration/recovery inputs; restoring one does not replace the live PostgreSQL registry.

`taskClaims` is the central cross-node lease mutex introduced by FN-4819 §2: claim acquisition/renewal/release happen in PostgreSQL, while per-project lease fields mirror the central winner for local scheduler/runtime consumption.

Legacy SQLite paths (`~/.fusion/fusion-central.db`, `<repo>/.fusion/fusion.db`) are migration/input only. Runtime writes go through the PostgreSQL schemas above.

`task_claims` is the cross-node lease mutex (FN-4819 §2): claim acquire/renew/release hit `central.task_claims` first; per-task lease columns on the project task row mirror the winner for scheduler/UI.

### Shared Postgres multi-node runbook

1. Provision one Postgres (local Docker, RDS, Supabase, etc.).
2. On **every** Fusion node: `export DATABASE_URL=...` (same URL). Do not duplicate a direct URL into `DATABASE_MIGRATION_URL`; if you use PgBouncer/Supavisor in transaction mode, set that override to a direct (non-pooled) connection for schema work and planning lifecycle locks.
3. Register projects and nodes so they appear in shared `central.projects` / `central.nodes`.
4. For each host, set `project_node_path_mappings` so that host’s absolute checkout path is recorded for each project.
5. Run `fn serve` / the engine on each node. Task IDs and settings are shared via Postgres; checkout exclusivity uses `task_claims`; abandoned-owner recovery uses `MeshLeaseManager`.
6. Keep provider credentials (`auth.json`) in mind: they are still file-local unless you use auth-sync. Task filesystem blobs under `.fusion/tasks/{ID}/` remain on the node that materializes them until a later blob strategy.

What is **not** multi-node via shared DB alone:

- Live agent/executor process migration mid-task
- Scheduler failover of another node’s tick loop
- Embedded Postgres sharing across machines

Canonical ownership / control-plane contract: [`docs/shared-mesh-protocol.md`](./shared-mesh-protocol.md).

## Durable workspace coordination across nodes

Workspace mode uses project-scoped PostgreSQL coordination records, not a node's in-memory registry, for sub-repository acquisition, per-repository landing, workspace-task liveness, merge-pending recovery guards, and merge-body dispatch. The durable records are `project.workspace_coordination_leases` and the write-ahead `project.workspace_land_intents`; lease operations are serialized with a project/resource advisory transaction lock.

Set a stable `FUSION_NODE_ID` on every engine host. Each process also creates a fresh, process-local incarnation ID at startup. A lease owner is the triple `(ownerTaskId, ownerNodeId, ownerIncarnationId)`, with a monotonically increasing fence token:

| Existing owner vs claimant | Result |
| --- | --- |
| Same task, node, and incarnation | Re-entrant claim: retain the fence token and refresh the TTL. |
| Same task, different node or incarnation | Contention: fail closed; the claimant must wait for expiry or authorized reclamation. |
| Different task | Contention: fail closed. |
| Expired holder | A new claimant may atomically reclaim the record and receives a new fence token. |

The TTL and its renewal timer indicate liveness; they are not authorization to mutate a shared resource. A caller must prove its owner triple and fence token at the action boundary. Lease-row changes use owner-and-fence-scoped conditional updates, while durable land intent, `landedSha`, merge admission, and merge-outcome writes run inside the same advisory-locked transaction that re-verifies the lease. Do not validate a lease and then act outside that transaction.

### Resource-bound fences

The fence token is enforced by the resource as well as by the database. Fusion uses exactly these mechanisms:

1. **Git fence refs.** When `pushAfterMerge` is enabled, a sub-repository land publishes `refs/fusion/workspace-lease/<repo-slug>` and a merge body publishes `refs/fusion/merge-dispatch/<task-id>`. At the irreversible push, one `git push --atomic` compare-and-swaps the target ref observed by that tenancy and every applicable published pin: the repository fence plus the enclosing merge-dispatch fence for workspace land, or the dispatch pin for a merge-only push. A target-tip-only CAS is insufficient: a superseded owner can otherwise push while the target tip is still unchanged. If the target CAS rejects because the remote is behind the approved squash, Fusion re-observes it once and retries only after proving that observed commit is an ancestor of the published commit; every fence pin remains unchanged. The remote must permit both `refs/fusion/...` namespaces; a rejected namespace or fence-ref publication fails closed and never falls back to a tip-only push. With `pushAfterMerge` off, workspace land uses its durable lease and local ref CAS without publishing remote fence refs.
2. **Transaction-bound durable writes.** The lease validity check and the protected state write occur in one advisory-locked transaction.
3. **Owner-and-fence conditional lease updates.** Renew, release, and lease-state transitions cannot alter a successor's row.

A fence ref is published once when a git-writing tenancy is `acquired` or `reclaimed-expired`. A re-entrant claim reuses the existing `fenceRefName` and `fenceRefSha`; it does not rotate the pin or increment the fence. Republishing would invalidate that same tenancy's prepared CAS push and orphan its pending intent. The only re-entrant exception is the publish gap: a git-writing row with no fence ref because the process died after claiming but before publishing may publish its missing pin. For a workspace merge-dispatch tenancy, the same deterministic pin is published to every target sub-repository remote before any workspace land begins; the non-git workspace root is never treated as the protected remote. Acquire-kind leases never carry a fence ref, and renewal never publishes or changes one.

### Merge dispatch and commit points

A merge-dispatch lease is claimed when the queue dispatches a merge body, not when it enqueues one. A losing dispatch claim is a benign drop rather than a task failure; the enqueue-to-dispatch interval intentionally has no active merge body.

The merge body re-proves its fence at every commit point: dispatch admission; the atomic target-plus-dispatch-fence push (and repository fence where a workspace land also owns one); each subsequent PR merge, remote-branch deletion, or status effect; and terminal outcome persistence. The fenced push is the first shared irreversible effect. Non-CASable remote effects must be idempotent and occur after it. Therefore a lease may expire during a long merge without making a second push or outcome valid: a superseded body stops before its next commit point. If the push succeeded but a later outcome write is fenced out, Fusion reports `merge-completed-unrecorded`; operators should inspect the remote target and audit trail rather than retrying blindly or expecting a rollback.

### Crash-safe workspace land recovery

Before a land push, Fusion writes a durable pending land intent containing the task/repository identity, expected target tip, intended SHA, `remoteUrl`, integration ref, and fence-ref pin. The order is intent → atomic target-and-applicable-fences push → one lease-validated transaction that persists `landedSha` and resolves the intent. This closes the crash window between a successful push and durable task state.

Pending intents are enumerated project-wide from PostgreSQL, not from the surviving node's local candidates, registries, or worktrees. Recovery fetches the recorded remote and proves intended-SHA reachability on the recorded integration ref; local tip equality, TTL alone, or a stale local object store are not proof. A subsequent land first resolves any pending intent for its task/repository, so it cannot squash a second time across an unresolved prior commit point.

Exactly two authorities may resolve an intent:

- The holder-authorized resolver holds a live lease handle and may resolve its equal-fence intent or a strictly lower-fence predecessor.
- The recovery-authorized resolver has no handle and resolves only when its transaction proves no held, unexpired lease exists; it also refuses an intent/lease fence mismatch.

There is no third writer. A pending intent is an operator-visible recovery state: inspect its audit records and remote integration ref, then allow holder or recovery reconciliation to establish ground truth rather than manually assuming the land failed.

### Reclamation and operator behavior

Lease renewal extends a live holder, but restart recovery never clears an unexpired lease—not even for a duplicated `FUSION_NODE_ID`. This deliberately trades a bounded TTL wait for safety. Startup releases only this node's expired predecessor-incarnation rows; periodic maintenance marks expired rows reclaimable without changing intents or fence refs. `isMergePending` first checks local queue state, then queries held `merge-dispatch` leases for every node; a durable-store error is conservatively pending. The phantom land-lease sweep also enumerates durable `land` and `acquire` rows, then reclaims only through an owner-and-fence CAS that derives terminal ownership from the task row in the same transaction; callers cannot supply a stale terminal proof. On contention, Fusion reports a busy/deferred operation and preserves the incumbent holder. Operators should wait for normal release/expiry or investigate a persistently pending intent, instead of bypassing a fence or editing a shared checkout.

### Cluster membership and process ownership

- Topology visibility is cluster-wide: dashboard mesh reads aggregate node registry state (and optional remote health probes), with degraded fallback metadata when a peer HTTP probe fails.
- `mesh_write_queue` / `mesh_shared_snapshots` are **not** a multi-leader task write log. Under shared Postgres they are limited to topology/auth retry and degraded membership reads. Task durability is the database commit itself.
- `NodeDiscovery` and `NodeConnection` in `@fusion/core` handle discovery and remote connectivity/auth probes.
- `PeerExchangeService` in `@fusion/engine` gossips membership (and optional `authMaterial`); it does **not** replicate tasks/settings over HTTP when nodes share Postgres.
- `MeshLeaseManager` is the single authority for stale lease detection and abandoned-work recovery.
- Distributed task-ID allocation uses shared `project.distributed_task_id_*` rows. Under Postgres, reserve/commit/abort always hit the local allocator against those shared rows — never a remote “coordinator” hop.
- `runServe()` / `runDashboard()` own process-level peer-exchange + discovery lifecycle (one instance per process, after the HTTP port is known).
- `InProcessRuntime` stays project-scoped and does **not** start mesh services.

## Mesh lease recovery in multi-node execution

Task ownership is durable lease metadata on the shared task row (`checkedOutBy`, `checkedOutAt`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`) plus the authoritative `central.task_claims` row.

When a node disappears or stops renewing ownership, recovery is routed only through `MeshLeaseManager.recoverAbandonedLease(...)`. The manager performs a two-write release: release the central `task_claims` row first, then clear per-task owner fields and bump `checkoutLeaseEpoch`.

If one side succeeds and the other fails, the next scheduler/self-healing tick runs `reconcileLeaseRow(taskId)` to converge claim and task-row state. Recovery emits `task:auto-recover-lease-*` run-audit events for traceability.

This fencing prevents double-claims: a restarted or delayed stale owner cannot reclaim work once central ownership has been released and the lease generation has advanced.

## Recovering a missing central project row

If a project's PostgreSQL central-registry row is deleted, Fusion recovers it on next startup:

1. Startup checks central for a row at the project path.
2. If missing, it reads `<project>/.fusion/project.json` (or imports a legacy SQLite identity once).
3. If present, central reattaches that exact `projectId` instead of creating a new one.

This prevents “empty workspace” regressions where project data still exists but is keyed to an older `projectId`.

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

### Routing visibility

<!--
FNXC:ProjectRoutingVisibility 2026-09-23-00:20:
RUFU-269. The order above is the contract and is deliberately unchanged — cwd-over-default would break
agent lanes that rely on a configured default. What changed is the silence around it: a default project
pointing at another repo used to file cards there with no output naming the target, and the printed
`Path:` looked cwd-relative. An operator standing in Fusion created two cards that landed physically in
another project's checkout and only found out by listing that disk. Resolution provenance is now recorded
on the project context, printed by every card-minting command, and confirmed interactively when the
central default disagrees with the project the shell sits in.
-->

The order itself is unchanged; what changed is that the CLI now tells you which branch of it fired. `ProjectContext` carries the resolution source (`flag` / `default` / `cwd` / `cwd-fallback`) plus the project detected from the current directory, and every command that mints a card (`fn task create`, `duplicate`, `refine`) prints the target before it writes:

```
  Project: gedapp  /home/me/code/gedapp  (resolved via the central default project)
  ✓ Created GEDA-1057: Fix checkout button
    Column: triage
    Path:   /home/me/code/gedapp/.fusion/tasks/GEDA-1057/
```

When the **default project** wins but the current directory belongs to a **different registered project**, the CLI writes a warning naming both projects to **stderr** before any board write. On `fn task create` at a real terminal it then asks `Create this card in project "<name>" anyway? [y/N]:`; declining exits 0 having written nothing — no task row and no `.fusion/tasks/<id>/` directory. `duplicate` and `refine` warn but never block, since they already name an existing card.

The prompt never fires — the warning is still shown — when an answer cannot be typed:

- `--yes` on `fn task create` (also stops `--yes` from leaking into the card title).
- `--quiet` or `FUSION_QUIET=1`.
- Piped or non-TTY stdin/stdout, so scripted pipelines cannot hang.

An explicit `--project`, a cwd-detected target, and the unregistered-cwd local-store fallback are what the operator already asked for or already see announced elsewhere, so they are never second-guessed. An invalid `--project` value errors out during resolution and creates nothing. See [CLI reference — Project routing visibility](./cli-reference.md#project-routing-visibility).

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

- Global installation metadata is shared across projects in PostgreSQL `central.plugin_installs`
- Per-project activation/runtime state is tracked separately per normalized project path (`project_plugin_states`)
- Project-local `.fusion/fusion.db` `plugins` rows are legacy migration-only input and are no longer a write target for installs

Operationally:
- `install` / `uninstall` are global actions
- `enable` / `disable` and runtime state/error are project-scoped
- A single global plugin install can be enabled in one project and disabled in another
- The Plugin Manager list/toggle, lifecycle SSE stream, and every loader for a project resolve the same normalized project root key. An enable or disable response is reflected immediately; a daemon launch directory never substitutes its state when an explicit project is selected.

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

### Boot lifecycle: background init, bounded shutdown, readiness gate

`HybridExecutor.initialize()` loads one project runtime per registered project, and each load boots a project store to read that project's concurrency settings. On a 24-project deployment that loop is tens of seconds and is coupled to database latency, so **no boot surface awaits it any more**. `fn dashboard`, `fn serve`, and `fn daemon` construct the executor, start the boot in the background, and go straight to releasing the migration holding server and binding the real HTTP listener — the same pattern `engineManager.startAll()` already uses. Before this, the awaited boot kept the holding server bound, and the holding server answers every non-health `/api/*` request with `503 "Fusion is starting (database migration may be in progress)"`, which froze the board for writing for as long as the boot took.

What that guarantees, and what replaces the old implicit "HTTP is up ⇒ the executor is up" assumption:

- **Observable completion.** When the loop finishes, the log carries one greppable marker: `HybridExecutor initialized: <N> project runtimes in <X>ms`. Projects that fail to load are counted into a separate warning, so the marker's count is the number of runtimes actually serving.
- **Bounded per-project probing.** The concurrency probe is capped by `startupCapacityProbeTimeoutMs` (default `2500` ms). A project whose probe times out or throws falls back to the registry concurrency snapshot and logs the project plus the reason, so one slow or broken project cannot stretch the boot.
- **Self-contained shutdown bound.** `shutdown()` waits at most `shutdownInitWaitTimeoutMs` (default `5000` ms) for an in-flight boot, then aborts it, tears down every runtime that did load (including ones that finish later), names the projects still loading in a warning, and rejects with `HybridExecutor shutdown incomplete: …`. `serve`/`daemon` have no shutdown-step timeout wrapper to lean on, so the bound lives inside the executor and every call site turns that rejection into a warning — an incomplete stop is reported, and the teardown queued behind it still runs.
- **Readiness is asked, never assumed.** `whenReady()` resolves when project runtime loading is complete, shares the in-flight boot with `initialize()`, and rejects when no boot has completed. A failed boot is not cached: a later `initialize()` starts a fresh attempt.

The one route that genuinely needs loaded runtimes is the live isolation-mode transition, `PATCH /api/projects/:id`. It now waits for readiness under a bounded, injectable window (`ServerOptions.hybridExecutorReadyWaitMs`, default `DEFAULT_HYBRID_EXECUTOR_READY_WAIT_MS = 5000` ms) and answers honestly instead of running the transition against a half-built executor:

| State | Answer |
| --- | --- |
| Runtimes loaded | unchanged `200`, or `409 active_tasks` when the project has live in-flight work (see **Isolation-mode transition** for what counts as busy; `details.blockingTaskIds` names the cards when the guard could name them) |
| Still loading when the window expires | `503 hybrid_executor_starting` — retry shortly |
| Boot never completed / last attempt failed | `503 hybrid_executor_failed` — waiting will not help |

Both refusals leave the stored `isolationMode` untouched, which is the same consistency guarantee the pre-existing `503 isolation_transition_unavailable` (no executor at all) already gave. The wait is floored at 1 ms, so a mis-set knob produces a retryable `503` instead of a request that hangs — the hang being the failure mode this whole change removes.

Note the wiring asymmetry: only `fn dashboard` passes `hybridExecutor` into its HTTP server, so the readiness branch is reachable there; `serve` and `daemon` construct and background the executor without exposing it to their routers, and that route keeps its existing `isolation_transition_unavailable` answer on those surfaces.

Guarded by `packages/engine/src/__tests__/hybrid-executor-boot-lifecycle.test.ts` (lifecycle, probing bound, shutdown drain, marker, readiness classification), `packages/cli/src/commands/__tests__/serve.test.ts` and `daemon.test.ts` (the real listener is reached while `initialize()` is still pending), and `packages/dashboard/src/__tests__/routes-project-isolation-transition.test.ts` (the transition refusals).

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
- **What "busy" means here is live work, not board traffic** (RUFU-323). The count is the executor's live worktree-holder count — a card is counted only while it is actively executing or holds a live session surface — so cards merely parked in in-progress or in-review lanes, including terminal `failed` cards, never refuse a transition. Before this, the number was the size of the executor's in-memory worktree map, which retains a terminal park's binding, so a project whose only activity was two failed cards answered `active_tasks` forever and the operator could not switch its isolation mode without `force`. A committed terminal park now also releases that binding, which is what makes the count converge on its own.
- **The durable row decides, the in-memory binding only informs** (RUFU-328). RUFU-323 made the metric read live holders; it did not change who holds the veto — a non-zero count still threw before anything durable was consulted, so a card whose stored row already reads `failed` refused its own project forever whenever its worktree release never landed (the leaked binding *is* a still-true in-memory signal, which is why a rule that exempted only "not live" cards could never release the guard it exists to release). When the busy metric says busy, the runtime now answers the question instead of the metric: `getInFlightBlockers()` resolves the holder ids out of the same live set the metric counted and reads their board rows in **one** batched list read (lane-scoped to `in-progress`/`todo`/`in-review`, `derive: false`, `excludeLog: true`, deliberately **not** `slim` — its finalize re-parses `PROMPT.md` per row and can issue writes on a read — and never `getTask()` per id, which serialises behind the per-task advisory lock), then releases a holder only when its row is `status: "failed"` **in the in-progress lane**: the canonical terminal-park shape. `failed` in `todo` or `in-review` still blocks, because that describes work the engine may resume. A card the read did not describe is unknown and unknown blocks. A released card whose in-memory surface is still live is recorded as drift in the engine log (`contradictedInMemory`) rather than re-blocking — the disagreement names the leak to repair.
- **Every failure mode of that read refuses conservatively** (RUFU-328). A runtime without the capability, a `null`, malformed, rejected or never-settling answer, a store that cannot answer, or an attempt whose budget is already spent — all keep the historical bare `{ kind: "active_tasks", count }` refusal with no ids, because "the board would not answer" is not evidence of an idle runtime. The budget is two code-owned constants declared once: `ISOLATION_BLOCKER_READ_TIMEOUT_MS` (500 ms) for one decision — a guard check, a drain vote, an IPC round-trip — and `ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS` (300 ms) for the single durable read answering it, enforced inner `<` outer. A slow database can therefore only ever make this guard behave exactly as it did before. `force: true` keeps its historical meaning: never consult the store, shut down on the unbudgeted path.
- **The shutdown drain is charged for the decision that unlocked it** (RUFU-328). A proven-clear answer carries `drainMs` — the runtime's own configured `runtimeStopDrainMs` (same key and default as `stop()` derives for itself) minus everything this attempt has already spent — and `ProjectManager.restartProjectRuntime()` hands it to `stop()`, charging the project lookups that happen in between as well. Only the proven-clear path carries it: a refusal never reaches the shutdown, and `force` never consulted durable state, so both keep the historical full drain a runtime derives for itself. An answer that could not decide never reaches `stop()` at all.
- **Each runtime answers for itself, or answers "cannot answer"** (RUFU-328). An in-process runtime reads its own `TaskStore`. A `child-process` runtime cannot reach the engine's store — the child holds none, its parent `TaskStore` is a proxy — so the parent asks over IPC (`GET_IN_FLIGHT_BLOCKERS`), and the child clamps to the **inner** bound rather than the parent's: forwarding the outer number would let a hung child-side store spend every millisecond the parent is also willing to wait, racing the child's answer against the parent's IPC timeout so that "cannot answer" degrades into whichever error frame lands first. Clamping makes the ordering deterministic, so the reason that reaches the operator names the store, not the channel; a handler rejection is folded into the `null` answer because `IpcWorker` would otherwise turn it into a transport-error frame. A `remote-node` runtime **deliberately has no** `getInFlightBlockers`: it owns no local `TaskStore` (`getTaskStore()` throws by design), so the member is left absent — the safe branch, not an unfinished one. `restartProjectRuntime()` treats a missing capability exactly as it did before RUFU-328, so a remote project is never restarted on an answer it cannot prove, and the worst outcome is the historical conservative refusal, never a false all-clear. Inventing a cross-node status protocol for a settings-change guard is explicitly out of scope.
- **The 409 names the cards it refuses for** (RUFU-328). The refusal body gains `details.blockingTaskIds` next to `details.activeTaskCount` (the dashboard error envelope nests the payload under `details`), so the operator can reconcile the block against the board instead of guessing which counted card is actually live. The list is **omitted**, never sent empty, when the guard could not name anything: an empty array would claim the board proved nothing blocks while the transition stayed refused. `activeTaskCount` remains in every shape, so an existing client that reads only the count is unaffected.
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

Each project persists its canonical central identity in `.fusion/project.json` as `id` and `createdAt`. Registration paths use `CentralCore.ensureProjectForPath({ path, identity, ... })` after `readProjectIdentity()`; that reader accepts a legacy SQLite identity only as migration input. Reattachment refuses silent remint when the persisted ID belongs to another path.

Dashboard `POST /api/projects` now surfaces this mismatch as `409` with `error: "orphan-identity"` and recovery metadata, and callers can opt into recovery flows with `acceptRecovery: true` behavior at the route layer.

Back up PostgreSQL with the deployment's PostgreSQL backup tooling; `.fusion/project.json` is identity metadata, not a substitute for a database backup.

## Workspace task repository scope

For a workspace project, configured repositories may all be acquired before planning, but acquisition is not task scope. Fusion persists an explicit per-task repository scope that planning confirms. Only repositories both in that scope and evidenced by qualified modified files are reviewed, landed, or considered by partial-land recovery. A clean scoped repository appears as **No changes — not reviewed** and is neither a failed review nor a partial land.

Before the first land, an accepted extension is recorded in task scope history. After a land begins, scope extension is refused and should be handled as a follow-up task, preserving the existing integration boundary and per-repository leases.
