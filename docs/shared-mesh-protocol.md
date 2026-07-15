# Shared Cluster Protocol (Postgres multi-node)

[← Docs index](./README.md)

<!--
FNXC:SharedPostgresMultiNode 2026-07-14-23:45:
This document supersedes the multi-leader SQLite mesh replication contract. Durable project state is shared PostgreSQL; mesh HTTP is membership, optional auth material, and execution ownership — not a second database.
-->

This document is the canonical contract for Fusion **multi-node operation on shared PostgreSQL**.

The historical multi-leader SQLite mesh (HTTP task replication, settings gossip, strong-write quorum, offline task write queues) is **retired**. Nodes that share `DATABASE_URL` already share durable state at the database layer.

## 1. Goals and non-goals

### Goals

- One shared durable project + central state across multiple Fusion nodes.
- Exclusive execution ownership per task via central claims + lease epochs.
- Per-node worktrees, processes, and path mappings without live process migration.
- Explicit degraded topology reads when peer **HTTP** health probes fail (membership visibility), without inventing divergent local task truth.

### Non-goals

- Scheduler failover (a peer does not take over another node’s live scheduler tick loop).
- Live-process / in-memory session migration mid-task.
- Multi-leader task writes when Postgres is unavailable (if the DB is down, nodes do not queue alternate task realities over HTTP).
- Treating embedded Postgres as a multi-host shared backend (embedded is per-machine only).

Supported recovery model: **lease handoff** under `OwningNodeHandoffPolicy` (`park`, `reassign-to-local`, `reassign-any-healthy`) so a healthy node resumes from **durable** task state.

## 2. Terms

- **Node**: A Fusion runtime/API process with a registered `central.nodes` row and local execution capacity.
- **Shared database**: One Postgres cluster (schemas `project`, `central`, `archive`) reached via the same `DATABASE_URL` on every participating node.
- **Claim**: Authoritative ownership row in `central.task_claims` keyed by `(projectId, taskId)`.
- **Lease epoch**: Monotonic fencing generation on the task row that invalidates stale owners after recovery.
- **Membership gossip**: Optional peer HTTP exchange of known peers / metrics; does not carry task or settings payloads under Postgres.
- **Auth material**: Provider credentials in per-machine `auth.json` (not in the shared DB by default); optional secure HTTP sync remains.

## 3. Data-class matrix (current truth)

| Data class | Mode | Notes |
|---|---|---|
| Tasks, deps, steps, columns | **Shared Postgres** | Commit is cluster-visible; no HTTP task replication |
| Missions / agents config / workflows / audit | **Shared Postgres** | Same |
| Project + global settings | **Shared Postgres** | Settings HTTP push/pull between nodes is disabled (`409`) |
| Distributed task IDs | **Shared Postgres** | `distributed_task_id_state` / `_reservations`; always local allocator against shared rows |
| Checkout ownership | **Central claim + task mirror** | `task_claims` then task lease columns |
| Agent runtime / worktrees / live sessions | **Node-local** | Paths may differ via `project_node_path_mappings` |
| Auth credentials (`auth.json`) | **Node-local + optional sync** | `sharedState.authMaterial` / auth routes only |
| FS blobs (`.fusion/tasks/*`) | **Node-local** | Metadata may be in PG; bytes on the materializing host |
| Topology / peer metrics | **Registry + probes** | `central.nodes` / peers; optional gossip + health HTTP |

## 4. Execution ownership

### Claim path

1. `AgentStore.checkoutTask` → `CentralClaimStore.tryClaimTask` (`central.task_claims`).
2. Mirror winner onto the task row (`tryClaimCheckout`: `checkedOutBy`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`).
3. Scheduler/executor on the winning node run locally; other nodes must not start a second exclusive execution lane for the same claim.

### Recovery path

Only `MeshLeaseManager.recoverAbandonedLease(...)`:

1. Prove recoverable (owner offline/error, or lease/heartbeat stale; not active local execution).
2. Apply handoff policy when configured.
3. Release **central claim first**, then clear task lease fields and **bump epoch**.
4. Requeue to `todo` (preserve progress when appropriate).
5. Partial split-brain → `reconcileLeaseRow` on a later tick.

Run-audit: `task:auto-recover-lease-*`, `node:lease:*`, `node:handoff:*` as applicable.

## 5. Membership and HTTP mesh surfaces

Still useful under shared Postgres:

| Surface | Role |
|---|---|
| `GET /api/mesh/state` | Topology snapshot for dashboard Nodes UI |
| `POST /api/mesh/sync` | Peer gossip: `knownPeers` (+ optional `authMaterial` only) |
| `POST/GET /api/mesh/task-ids/*` | Local allocator against shared ID tables (no remote coordinator hop) |
| Auth sync routes | Optional credential fan-out for file-local auth |
| mDNS discovery | Join convenience, not task SoT |
| Docker mesh config generator | Provision managed peers |

Removed / disabled:

| Surface | Status |
|---|---|
| `POST /api/mesh/tasks/create` | Removed — DB is the replication plane |
| Task/agent/mission/audit shared-state domains | Removed |
| Settings gossip / node settings push-pull | Disabled on Postgres (`409`) |
| Remote task-ID coordinator forwarding | Disabled on Postgres |

## 6. Write queue and degraded topology (narrowed)

Historical multi-leader design used `meshWriteQueue` for offline **task** write replay and `meshSharedSnapshots` for last-known global task state.

Under shared Postgres:

- **Do not** invent local task commits when Postgres is unavailable.
- `meshWriteQueue` is limited to **topology / auth** retry classes (membership sync / auth material), not task or settings payloads.
- `meshSharedSnapshots` support **degraded membership/topology** reads only; they are not a substitute board store.
- `PeerExchangeService.replayPendingWritesForNode` replays only those narrow scopes.

If Postgres is down, operators fix the database; nodes do not multi-master task rows over HTTP.

## 7. Process lifecycle

- `fn serve` / `fn dashboard` start one process-wide `PeerExchangeService` and call `CentralCore.startDiscovery()` after the HTTP server binds the real port.
- `InProcessRuntime` is project-scoped (scheduler/executor/heartbeat) and does **not** start mesh services.
- `HybridExecutor` remains the multi-project / multi-node orchestration path when the hybrid gate enables it.

## 8. Security boundary

- Peer HTTP (sync, auth, remote isolation runtime) requires node API-key authentication when configured.
- Never log raw secrets from auth snapshots.
- Database credentials in `DATABASE_URL` must not appear in logs (redaction helpers in the Postgres connection layer).

## 9. Operator checklist

See the **Shared Postgres multi-node runbook** in [`docs/multi-project.md`](./multi-project.md).

Short form:

1. Same external `DATABASE_URL` on every node.
2. Register nodes/projects + path mappings per host.
3. Run engines; claims enforce exclusive execution.
4. Expect worktrees/auth/blobs to remain node-local unless you opt into auth-sync or a future blob store.

## 10. Historical note

Earlier revisions of this file described protocol id `fusion.shared-mesh` v1 with strong/queued/append-only write classes and quorum acks for multi-leader SQLite. That contract is archived by this rewrite. Implementation remnants that still mention multi-leader envelopes are compatibility shims and must not reintroduce HTTP task replication.
