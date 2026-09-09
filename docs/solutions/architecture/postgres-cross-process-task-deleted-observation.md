---
category: architecture
module: PostgreSQL lifecycle observation
tags:
  - postgresql
  - task-lifecycle
  - cross-process
  - outbox
problem_type: architecture-decision
applies_when: A Fusion deployment has more than one TaskStore process sharing a PostgreSQL project and a consumer needs to observe task deletion.
---

# PostgreSQL cross-process `task:deleted` observation

## Decision

Use a **transactional PostgreSQL outbox with per-consumer durable cursors** for cross-process lifecycle observation. The initial scope is `task:deleted`; its event contract must be deliberately extended before other lifecycle events join the stream.

The unreachable polling replica is removed by FN-8683. FN-8684 lands the transactional writer and FN-8685 lands the consumer-state migration, explicit identity helper, observed dispatcher, fenced polling seam, and bounded self-healing retention invocation. The consumer remains at-least-once: dispatch precedes the durable receipt/cursor acknowledgement, so crash-window duplicates are expected and observed listeners must remain idempotent.

## Problem and current boundary

`TaskStore` lifecycle events are process-local `EventEmitter` events. The former SQLite polling replica in `packages/core/src/task-store/lifecycle-ops.ts` attempted to compare a cache with task rows and re-emit deletions. It cannot operate in the supported runtime: `dbImpl` in `packages/core/src/task-store/task-id-integrity.ts` always throws for `store.db`, with no backend-mode branch, and `watchImpl` returns after asynchronously warming `taskCache` for an injected `AsyncDataLayer`.

Consequently, a delete in one PostgreSQL process is observed only by that writer's store. A dashboard, CLI, child process, or other node holding another `TaskStore` does not receive `task:deleted`, and must not be described as having cross-process lifecycle observation until the outbox exists.

The mechanism must ultimately feed these existing bridge and listener surfaces:

- `packages/engine/src/project-runtime.ts` event contract;
- `packages/engine/src/runtimes/in-process-runtime.ts` TaskStore-to-runtime forwarding;
- `packages/engine/src/runtimes/child-process-runtime.ts` IPC receipt and `child-process-worker.ts` IPC send;
- `packages/engine/src/runtimes/remote-node-runtime.ts` remote-node transport;
- `packages/engine/src/project-manager.ts` project-runtime forwarding;
- live consumers including the scheduler, executor, triage, project engine, and dashboard SSE endpoint.

## Existing delete ownership

The delete writer owns the transactional soft-delete (`deletedAt`) and its one `task:deleted` run-audit row. After commit it also owns the best-effort operator mailbox side effect in `task-delete-notice.ts`. An observing process must **not** invoke either writer-owned operation again. Observers only update their local cache and deliver an explicitly observed lifecycle notification to safe consumers.

`deletedAt` remains the deletion identity: a repeated delete of an already soft-deleted task creates no new lifecycle event. The row's `archived` column value is only a historical persistence sentinel; there is no separate live task-archive flow.

## Options considered

### PostgreSQL LISTEN/NOTIFY

- **Delivery:** at-most-once. Notifications are delivered only to connected listeners after transaction commit; payloads are not a durable queue.
- **Restart/drop behavior:** a disconnected or restarting consumer misses notifications. It can run a full reconciliation against `tasks`/`deletedAt`, but cannot recover an ordered, bounded event history from NOTIFY itself.
- **Ordering:** commit-order notification is separate from the synchronous in-process emitter. The writer can emit locally after commit, while remote delivery has no exactly-once or global listener order.
- **Soft deletes and side effects:** payloads can name a task and `deletedAt`, but subscribers must query to distinguish stale/duplicate data. A subscriber must not write mailbox notices or delete run-audit rows, or it double-fires writer-owned side effects.
- **Migration:** no table migration is required, but a dedicated connection lifecycle, channel authorization, payload-size handling, and reconciliation path are required.
- **Delete-write cost:** one `pg_notify` call in the delete transaction; small, but it provides no durable retry contract.

Rejected: it improves promptness but cannot meet durable delivery across an engine restart or dropped connection without separately building a durable reconciliation mechanism. Adding that mechanism makes a durable outbox the clearer primary record.

### Transactional outbox (recommended)

- **Delivery:** at-least-once to each registered durable consumer; consumers make handling idempotent. The delete and outbox insert commit atomically, so a committed delete cannot be silently absent from the event stream.
- **Restart/drop behavior:** consumers resume from their stored cursors and scan missed rows. A lost live wake-up only delays the scan; it does not lose the event.
- **Ordering:** outbox sequence order is the authoritative cross-process order per project. It does not redefine synchronous in-process `EventEmitter` ordering; local writer listeners remain immediate, while remote consumers process committed sequence order.
- **Soft deletes and side effects:** one `task:deleted` event is inserted only for the first `deletedAt` transition. The observed-event dispatcher must carry `originProcessId`/writer identity and `observed: true`, and must forbid mailbox notice, delete run-audit, or delete mutation calls.
- **Migration:** yes. An outbox table, consumer-cursor table, and dead-letter/attempt state require a numbered migration explicitly registered in `packages/core/src/postgres/schema-applier.ts` (version constant plus bookkeeping check).
- **Delete-write cost:** one additional indexed insert in the existing delete transaction. This is bounded and fails atomically with the delete instead of creating a hidden loss window.

Selected because its durable record supplies replay, ordered catch-up, operational visibility, and a bounded recovery path without relying on a continuously connected process.

### Engine → dashboard bridge

- **Delivery:** typically at-most-once unless the bridge develops persistence, acknowledgement, replay, and retry. IPC/SSE alone loses messages on engine/dashboard restart or reconnect.
- **Restart/drop behavior:** the dashboard can refetch board data, but an engine restart or independent CLI/remote-node consumer has no shared durable history. The bridge also cannot reach a dashboard process that is not connected to that engine.
- **Ordering:** can preserve a single engine's send order, but not globally across multiple engine nodes or direct API/CLI writers.
- **Soft deletes and side effects:** the bridge can forward the writer event, but receivers must still avoid repeating writer-owned notice/audit work.
- **Migration:** no migration for a simple bridge; a durable bridge would need storage equivalent to an outbox.
- **Delete-write cost:** low for send-only IPC, but it moves reliability cost into process supervision and reconnect handling.

Rejected: it is useful as a transport adapter after durable observation exists, but is not the system-of-record for a multi-node PostgreSQL project and excludes non-engine writers.

## Recommended outbox contract

### Event shape and identity

Within the delete transaction, insert a project-scoped outbox row such as:

```text
sequence (monotonic per project), project_id, event_type = "task:deleted",
event_id = "task-deleted:<taskId>:<deletedAt>", task_id, deleted_at,
writer_process_id, occurred_at, payload_version
```

The unique `(project_id, event_id)` key prevents concurrent delete attempts from producing two events for one `deletedAt` transition. The payload contains only the minimum post-commit observer data: task ID, `deletedAt`, prior column/status if consumers need them, event identity, writer identity, and schema version. It never contains mailbox prose, credentials, or free-text run-audit metadata.

### Cursor, acknowledgement, and idempotent handling

Create a project-scoped `lifecycle_consumer_cursors` row keyed by `(project_id, consumer_id)`, holding `last_acked_sequence`, lease/heartbeat metadata, and current failure state. Every independently durable receiver gets a stable consumer ID (for example dashboard instance role, engine runtime role, or remote-node bridge role); ephemeral SSE clients are fed from their local durable receiver and do not own cursors.

A consumer reads rows with `sequence > last_acked_sequence` in ascending order. It updates local cache and invokes the **observed-event-safe** listener path, then advances the cursor in the same consumer transaction where possible. Handler idempotency is mandatory because a process can crash after side effects and before cursor acknowledgement: deduplicate on `(consumer_id, event_id)` or make every permitted observed handler a no-op when the task is already absent at the recorded `deletedAt`.

This prevents duplicate delivery from becoming duplicate local work while preserving an at-least-once retry record.

### Reconnect catch-up

On startup, connection recovery, or a missed wake-up, a consumer scans from `last_acked_sequence + 1`. `LISTEN/NOTIFY` may later wake consumers for low latency, but it is only a hint; cursor scanning is authoritative. Retain normal outbox rows for **30 days** after all active durable consumers acknowledge them. A consumer whose cursor is older than the retained floor, missing, or invalid must run full reconciliation: refresh its live task cache from `tasks WHERE deleted_at IS NULL`, remove locally cached IDs absent from that result, and record its cursor at the current committed sequence before resuming.

This prevents a dropped connection or restart from creating an unrecoverable observation gap; the full reconciliation is the bounded fallback once retained history is no longer available.

### Retry and poison handling

For a failed event, do not advance its cursor. Retry with exponential backoff (1s, 5s, 30s, 5m, then 15m) for at most **10 attempts**. Persist attempt count, next-attempt time, and last failure class (bounded code only) on a consumer-delivery row or dead-letter table. After attempt 10, atomically park the delivery as dead-letter, emit `lifecycle-observation:consumer-poisoned` run-audit metadata containing only project/consumer/event IDs and counts, and advance the main cursor only after recording that park.

The consumer continues with later events; a poison event cannot wedge the stream or disappear silently. A repair tool replays a dead-letter event explicitly after the underlying defect is fixed and emits `lifecycle-observation:consumer-replayed`.

### Retention and pruning ownership

`SelfHealingManager` owns pruning during its scheduled/store-open lifecycle-maintenance sweep. It prunes an acknowledged normal outbox row only when it is older than 30 days **and** every non-retired durable consumer cursor is at or beyond its sequence. It prunes resolved dead letters after 30 days; unresolved dead letters are retained until an operator resolves or retires their consumer. Consumer retirement is an explicit audited operation, never inferred from a transient missed heartbeat.

This prevents pruning events that an active consumer has not acknowledged and leaves poison evidence available for repair.

## Rollout sketch

1. Add schema migration and schema-applier registration for outbox, cursor/delivery, and dead-letter state; include fresh/upgrade/RLS tests.
2. Add a transactional delete-outbox writer beside the existing PostgreSQL soft-delete/audit transaction. Guard the unique event identity and prove idempotent re-delete writes nothing.
3. Implement consumer polling/cursor replay and an observed-event dispatcher. Keep it separate from the writer emitter so it cannot call `task-delete-notice.ts`, write the delete audit row, or mutate deletion state.
4. Adapt in-process, child-process, remote-node, project-manager, and dashboard bridges to consume observed events from the durable dispatcher. Preserve current payload compatibility for live listeners.
5. Add a NOTIFY wake-up only as an optimization after cursor catch-up is proven; it is never the delivery authority.
6. Enable per deployment, observe cursor lag/dead letters, and retain the old full-cache reconciliation fallback during rollout. The removed SQLite polling replica is not a rollback path because it cannot run in PostgreSQL mode.

## Implementation status

FN-8684 landed the transactional writer and FN-8685 landed the consumer-state tables, explicit consumer identity helper, observed dispatch, fenced polling, reconciliation boundary, retry/dead-letter handling, and bounded self-healing retention invocation. Delivery is available only to PostgreSQL `TaskStore` instances constructed with an explicit durable consumer identity; stores without one intentionally remain observation-disabled. Runtime wiring must source any instance key from a named persisted field, never boot-generated process state.

## Consequences

Cross-process `task:deleted` observation is available through the configured outbox consumer. In-process deletes and their existing listeners remain supported and unchanged. Any feature that needs cross-process lifecycle correctness must depend on the outbox implementation rather than reintroducing `store.db` polling.
