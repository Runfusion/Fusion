# FN-4824 — Cross-node assignment-wake propagation contract

## 1) Scope & Relationship to FN-4819

This contract closes the FN-4819 §3 operational-handoff gap for assignment-driven wakes across nodes by defining push, fallback, and missed-wake recovery behavior for owner and peer runtimes. It does not change FN-4819 §2 distributed checkout mutex work (FN-4822), and it does not cover FN-4819 §5 non-goals: scheduler failover, live-process migration, multi-master writes, or automatic node promotion.

## 2) Definitions

- **owner node**: node that currently owns execution responsibility for an agent/task assignment in practice (the node that must wake the assigned agent).
- **peer node**: another node in the mesh that can observe/forward assignment signals but is not the wake target for that assignment.
- **assignment event**: cross-node event representing an assignment write.
- **wake**: a heartbeat trigger equivalent in intent to local `agent:assigned` handling.
- **push path**: delivery via remote event stream (`/api/events/stream`) consumed by `RemoteNodeClient.streamEvents`.
- **fallback path**: bounded pull/poll while push transport is degraded but still reachable.
- **missed wake**: assignment occurred but no wake fired before stream failure window ended.
- **eventual wake bound**: maximum allowed time from restoration/recovery condition to wake emission.

### Event payload contract

```ts
export interface TaskAssignedEventPayload {
  taskId: string;
  agentId: string;
  fromNodeId: string;
  toNodeId?: string;
  leaseEpoch?: number;
  assignedAt: string; // ISO-8601
}
```

## 3) Push Path Contract (healthy transport)

1. The originating node **MUST** emit `task:assigned` on the same event surface already used for `task:created`, `task:moved`, and `task:updated` (`/api/events/stream`).
2. Event name is **`task:assigned`**. Payload shape is `TaskAssignedEventPayload`.
3. The receiving remote runtime **MUST** forward this event through `RemoteNodeRuntime.forwardRemoteEvent` by re-emitting `task:assigned` for owner-side listeners.
4. Owner-side wake listener **MUST** treat forwarded `task:assigned` as semantically equivalent to local `agent:assigned` wake intent.
5. Under healthy transport, p95 assignment-write → wake latency target is **<= 2 seconds**.

## 4) Fallback Path Contract (transport degraded but reachable)

1. While SSE is disconnected and reconnecting inside `runEventStreamLoop` backoff window (`reconnectBaseDelayMs`..`maxReconnectDelayMs`, bounded by `maxReconnectAttempts`), assignment wake delivery **MUST NOT** rely solely on SSE.
2. Runtime **MUST** invoke a fallback pull seam during disconnected windows: `RemoteNodeClient.pollPendingAssignments({ since })`.
3. Poll response **MUST** include assignment rows newer than a cursor (`assignedAt`/cursor semantics).
4. Owner-side listener **MUST** trigger wake when poll returns assignment newer than the last observed `(taskId, agentId, assignedAt)` tuple.
5. Fallback bound: wake **MUST** occur within **<= 2 × reconnectBaseDelayMs** (default **<= 10 s**) even if zero SSE events succeed in that interval.
6. Idempotency requirement: replay of already-observed assignment (`same taskId + same assignedAt`) **MUST NOT** emit a duplicate wake.

## 5) Missed-Wake Recovery Contract (transport unavailable, then restored)

1. If stream errors past `maxReconnectAttempts` and runtime transitions to `errored`, assignment writes during outage are considered potential missed wakes.
2. On next successful transport restoration/health re-entry, owner-side scheduler/runtime **MUST** run one-shot reconciliation:
   - enumerate locally-owned agents,
   - detect `assignedTaskId` changes vs last observed snapshot,
   - emit exactly one wake per recovered assignment.
3. Eventual wake bound after restoration is **<= next heartbeat tick + reconciliation pass**, hard ceiling **<= 60 s** under default heartbeat settings.
4. Reconciliation **MUST** emit audit event `wake:cross-node-reconcile` with `{ ownerNodeId, peerNodeId, agentIds, recoveredAssignments }`.

## 6) Telemetry & Audit Requirements

For every cross-node wake trigger, telemetry **MUST** include source discriminator:

- `source="cross-node-push"`
- `source="cross-node-poll"`
- `source="cross-node-reconcile"`

Required diagnostics:

- `[wake-trigger-diagnostics]` log entry includes source discriminator and `taskId`.

Required run-audit event names:

- `wake:cross-node-push`
- `wake:cross-node-poll`
- `wake:cross-node-reconcile`

## 7) Non-Goals

- No distributed mutex/schema definition changes (FN-4822).
- No changes to local single-node `agent:assigned` semantics.
- No scheduler failover or live-process state migration.
- No settings consensus or multi-master writes.
- No cross-node settings sync behavior changes (FN-4796).

## 8) Testability Surface

The following scenarios are required and must be executable with in-process fakes and fake timers:

1. **Healthy push**: injected `task:assigned` over stream causes one wake on owner runtime with `source: "cross-node-push"` and correct `{taskId, agentId}`.
2. **Degraded poll fallback**: stream disconnect path still wakes within <= 10 s simulated via poll fallback; no duplicate wake on later stream replay.
3. **Missed-wake reconciliation**: runtime reaches `errored`, assignment happens during outage, restoration + reconcile emits one `cross-node-reconcile` wake and audit event.
4. **No-wake invariants**: duplicate broadcast with same `(taskId, agentId, assignedAt)` does not re-wake; newer `assignedAt` does.
5. **Telemetry shape**: wake diagnostics include source discriminator and `taskId`.

## 9) References

- `docs/design/fn-4819-distributed-multi-node-coordination-gap.md:173-324` (§3 unavailable-node handoff policy and testability framing)
- `packages/engine/src/agent-heartbeat.ts:3665-3755` (`watchAssignments`, local `agent:assigned` wake hook)
- `packages/engine/src/agent-heartbeat.ts:2430-2456` (`task_assigned` reason and `[wake-trigger-diagnostics]` surface)
- `packages/engine/src/runtimes/remote-node-runtime.ts:153-230` (event stream loop, reconnect/backoff lifecycle)
- `packages/engine/src/runtimes/remote-node-runtime.ts:239-271` (`forwardRemoteEvent` switch)
- `packages/engine/src/runtimes/remote-node-client.ts:98-120` (`streamEvents` source)
- `packages/engine/src/runtimes/in-process-runtime.ts:1180-1220` (in-process event-forwarding baseline)
- `packages/dashboard/src/sse.ts:384-390,773-775` (SSE catalog currently forwarding `task:created|moved|updated`)
- `packages/dashboard/src/server.ts: /api/events, /api/events/keepalive, /api/events/disconnect` (event stream routes)
- `packages/core/src/agent-store.ts: assignTask + `agent:assigned` emission seam
- `packages/engine/src/node-health-monitor.ts` (health restoration signal seam)
- `packages/engine/src/mesh-lease-manager.ts` (`isLeaseRecoverable`/`recoverAbandonedLease` seam referenced by FN-4819 §3.3)
