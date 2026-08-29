# FN-4820 — Multi-Node Coordination Validation vs FN-4819

## 1. Scope & Method

### Scope

This audit validates the **current implementation on `main`** against FN-4819 across exactly three areas:

1. Scheduler ownership / checkout semantics across nodes
2. Wake / assignment propagation across nodes
3. Conflict-handling telemetry

### Explicit non-goals (inherited from FN-4819 §5)

This audit does **not** propose implementation work for:

- Scheduler failover
- Live-process state migration
- Cross-node settings consensus
- Multi-master writes to one per-project `.fusion/fusion.db`
- Automatic node promotion

### Method

- Evidence source: repository files on commit `2595b4111fefe510d2cbc556b83d8b3c50067655`
- Method: direct `file:line` code citation from current code paths
- Design baseline: `docs/design/fn-4819-distributed-multi-node-coordination-gap.md` (§1–§5)
- Classification policy: conservative (`partial` unless requirements are fully met)

## 2. FN-4819 Concern Coverage Matrix

| FN-4819 concern | Status | Primary evidence (file:line) | Notes |
|---|---|---|---|
| §1 Single-node WAL baseline and cross-node gap | **works today** (baseline only) | `packages/core/src/store.ts:155-160`; `packages/core/src/store.ts:3822-3831`; `packages/core/src/agent-store.ts:1371-1460` | Single-project SQLite row-level lease fields + CAS-style update exist. This satisfies the baseline model but does not close distributed arbitration by itself. |
| §2 Distributed checkout mutex (central claim authority) | **missing** | `packages/core/src/central-db.ts:36-286` (no `taskClaims` table); repo search: `taskClaims` no hits; `packages/core/src/agent-store.ts:1371-1460` | Checkout logic is task-row-local. No authoritative central claim row keyed by `(projectId, taskId)` as required by FN-4819 §2.2/§2.3. |
| §3 Unavailable-node handoff policy | **partial** | `packages/engine/src/node-routing-policy.ts:4-75`; `packages/engine/src/scheduler.ts:1004-1044`; `packages/engine/src/mesh-lease-manager.ts:84-140`; `packages/engine/src/node-health-monitor.ts:103-148` | Policy seams and stale lease recovery exist, but durable run-audit event `task:auto-recover-node-unreachable` from FN-4819 §3.3 is not implemented. |
| §4 Isolation/ownership transition path | **partial** | `packages/core/src/central-core.ts:521-547`; `packages/engine/src/hybrid-executor-gate.ts:20-36`; `packages/engine/src/project-manager.ts:168-196`; `packages/core/src/central-db.ts:36-286` | Runtime mode selection + isolation transition activity logging exists, but no central `taskClaims` bootstrap and no visible rollback guard tied to sole-node condition from FN-4819 §4.4/§4.5. |

## 3. Findings by Audit Area

### 3.1 Ownership / checkout semantics across nodes

#### Finding A — Checkout CAS is local-row atomic, not central-distributed

- **Severity:** P0
- **Summary:** Current checkout conflict protection is atomic against one task row, but no cross-node central authority claim exists.
- **Current behavior:**
  - `AgentStore.checkoutTask()` uses holder checks and `tryClaimCheckout` when available (`packages/core/src/agent-store.ts:1371-1460`).
  - `TaskStore.tryClaimCheckout()` performs compare-and-set over task fields (`checkedOutBy`, `checkoutNodeId`, `checkoutLeaseEpoch`) (`packages/core/src/store.ts:3822-3831`).
  - Lease fields are persisted on task rows (`packages/core/src/store.ts:155-160`).
- **Expected per FN-4819:** FN-4819 §2.2/§2.3 requires an authoritative central claim row (`~/.fusion/fusion-central.db`) keyed by `(projectId, taskId)` for atomic lease arbitration.
- **Delta:** No `taskClaims` authority table or central claim mutation path found (`packages/core/src/central-db.ts:36-286`; repo search no `taskClaims` symbol).
- **Recommended follow-up:** Add central claim-table mutex path and wire checkout through it before task-row sync.

#### Finding B — Lease recovery writes only task row and task log entries

- **Severity:** P1
- **Summary:** Abandoned lease recovery can clear lease fields and requeue tasks, but reconciliation remains task-row-local and not central-claim-driven.
- **Current behavior:**
  - `recoverAbandonedLease()` checks staleness and node health, then clears checkout fields and moves task to `todo` (`packages/engine/src/mesh-lease-manager.ts:84-140`).
  - Scheduler invokes lease recovery during todo dispatch (`packages/engine/src/scheduler.ts:829-836`).
- **Expected per FN-4819:** FN-4819 §2.5 and §3.3 require central claim release/sync authority and bounded handoff semantics tied to that authority.
- **Delta:** Recovery does not interact with any central lease claim primitive; no central/local reconciliation worker path evidenced.
- **Recommended follow-up:** Introduce central-claim-aware recovery + reconciliation semantics for split-write scenarios.

#### Finding C — Scheduler dispatch guards reduce local double-starts but do not prove multi-node exclusivity

- **Severity:** P1
- **Summary:** Scheduler re-read CAS and handoff checks help local correctness, but no evidence of distributed mutual exclusion beyond local data path.
- **Current behavior:**
  - Scheduler re-reads the task to verify still `todo` before dispatch (`packages/engine/src/scheduler.ts:958-965`).
  - Owner health and handoff policy are applied before dispatch (`packages/engine/src/scheduler.ts:1004-1044`; `packages/engine/src/node-routing-policy.ts:4-75`).
- **Expected per FN-4819:** FN-4819 §2 requires centralized ownership arbitration independent of scheduler timing.
- **Delta:** Dispatch policy gates are additive, but no global claim winner/loser contract is present in cited code.
- **Recommended follow-up:** Add race tests and scheduler integration assertions against central claim winner semantics.

### 3.2 Wake / assignment propagation across nodes

#### Finding D — Assignment wake is event-push local; cross-node wake guarantee is implicit/indirect

- **Severity:** P1
- **Summary:** Local assignment wake hook is explicit; cross-node propagation path appears indirect via remote runtime event stream, not a dedicated assignment-delivery contract.
- **Current behavior:**
  - Local assignment trigger subscribes to `agent:assigned` and invokes callback source `assignment` (`packages/engine/src/agent-heartbeat.ts:3663-3740`).
  - In-process runtime forwards local `task:*` events (`packages/engine/src/runtimes/in-process-runtime.ts:1186-1194`).
  - Remote runtime consumes `/api/events/stream` and forwards remote `task:*` events (`packages/engine/src/runtimes/remote-node-runtime.ts:153-213,241-254`; `packages/engine/src/runtimes/remote-node-client.ts:98-120`).
- **Expected per FN-4819:** FN-4819 §3 + audit scope expects explicit understanding of owner/peer wake propagation and missed-wake behavior.
- **Delta:** No dedicated “task assigned on node A must wake owner on node B” contract or acceptance test seam was found in these modules.
- **Recommended follow-up:** Define and test explicit cross-node assignment wake semantics (push/pull fallback, bounded latency, missed-wake recovery).

#### Finding E — Peer exchange loop provides periodic mesh sync, not assignment wake routing

- **Severity:** P2
- **Summary:** Peer exchange cadence is periodic gossip and settings/shared-state sync; it is not an assignment wake transport.
- **Current behavior:**
  - Peer exchange default sync interval is 120s and syncs online peers sequentially (`packages/engine/src/peer-exchange-service.ts:116-206`).
- **Expected per FN-4819:** FN-4819 requires clear operational behavior when wake signals are missed or delayed.
- **Delta:** No assignment-specific fallback in peer exchange indicates uncertain wake SLO under event-stream outages.
- **Recommended follow-up:** Document wake fallback behavior and add measurable latency/error telemetry for cross-node assignment delivery.

### 3.3 Conflict-handling telemetry

#### Finding F — Required `task:auto-recover-node-unreachable` event is absent

- **Severity:** P1
- **Summary:** FN-4819 names a required run-audit event for node-unreachable recovery, but the event type is not present.
- **Current behavior:**
  - Run-audit database event union contains several `task:auto-recover-*` events (`packages/engine/src/run-audit.ts:126-136`).
  - `task:auto-recover-node-unreachable` is not listed there and not found in engine source search.
- **Expected per FN-4819:** FN-4819 §3.3 requires durable run-audit row `task:auto-recover-node-unreachable` on unreachable-owner recovery.
- **Delta:** Recovery path currently relies on task log entries / logger messages instead of typed run-audit event.
- **Recommended follow-up:** Add typed run-audit event emission for unreachable-owner recovery path and test coverage.

#### Finding G — Handoff/recovery decisions can complete without structured run-audit classification

- **Severity:** P2
- **Summary:** Handoff decisions are persisted mainly as `taskStore.logEntry` text.
- **Current behavior:**
  - Scheduler logs handoff decisions via `logEntry` (`packages/engine/src/scheduler.ts:1018-1025`).
  - Mesh lease manager logs and task log entries on recovery (`packages/engine/src/mesh-lease-manager.ts:108-133`).
- **Expected per FN-4819:** Durable conflict telemetry should support querying by event class.
- **Delta:** Text log entries are less queryable than typed run-audit records.
- **Recommended follow-up:** Standardize node-handoff/recovery telemetry into run-audit event taxonomy.

## 4. Prioritized Follow-Up Backlog

1. **[FN-4822] Add authoritative central task-claim mutex for cross-node checkout arbitration**  
   **Severity:** P0  
   Implement FN-4819 §2.2/§2.3 by introducing a central `(projectId, taskId)` claim authority and routing checkout acquisition through it before task-row sync.

   **Acceptance criteria:**
   - Introduce central claim persistence keyed by `(projectId, taskId)` with owner tuple and epoch semantics from FN-4819 §2.3.
   - `checkoutTask` winner/loser behavior follows FN-4819 §2.4 (exactly one winner; loser gets `CheckoutConflictError`).
   - Renewal keeps epoch stable; owner change bumps epoch.
   - Add race integration test asserting one winner across concurrent claim attempts (FN-4819 §2.8).

2. **[FN-4823] Make lease recovery central-claim-aware with reconciliation guarantees**  
   **Severity:** P1  
   Align abandoned-lease recovery and release semantics with FN-4819 §2.5 and §3.3 so central authority and task-row views cannot diverge silently.

   **Acceptance criteria:**
   - Recovery/release path updates or reconciles central claim + task row according to FN-4819 §2.5.
   - Split-write failure mode has deterministic repair path before next dispatch.
   - Scheduler + mesh lease recovery tests cover offline/error owner-node handoff behavior (FN-4819 §3.6).

3. **[FN-4824] Specify and test cross-node assignment wake propagation contract**  
   **Severity:** P1  
   Define explicit push/pull/missed-wake behavior for assignment propagation between nodes, with bounded-latency and recovery expectations.

   **Acceptance criteria:**
   - Document assignment wake contract across node A→node B transitions, including missed-stream fallback.
   - Add integration tests proving assigned owner receives actionable wake under normal and degraded transport conditions.
   - Define and expose measurable worst-case wake latency behavior consistent with FN-4819 §3 operational intent.

4. **[FN-4825] Emit typed run-audit telemetry for node-unreachable auto-recovery**  
   **Severity:** P1  
   Add structured telemetry for unreachable-owner recovery path so conflict handling is queryable and auditable.

   **Acceptance criteria:**
   - Add `task:auto-recover-node-unreachable` run-audit event support and emit on applicable recovery paths (FN-4819 §3.3).
   - Add tests validating event emission metadata for owner node, policy decision, and resulting task transition.
   - Ensure no recovery completion path is silent (must emit either success/failure classified event).

5. **[FN-4826] Normalize node handoff telemetry taxonomy beyond free-text task logs**  
   **Severity:** P2  
   Reduce ambiguity by converting key scheduler/lease-manager handoff text logs into typed event classes.

   **Acceptance criteria:**
   - Define typed telemetry names for handoff parked/reassign/recovered outcomes.
   - Keep backward-compatible human-readable task log entries where useful.
   - Add tests ensuring each decision path emits one structured telemetry event.

## 5. Non-Goals Reaffirmation

The following FN-4819 non-goals were respected and **no follow-up task below targets them**:

- Scheduler failover
- Live-process state migration
- Cross-node settings consensus
- Multi-master concurrent writes to one per-project `.fusion/fusion.db`
- Automatic node promotion

## 6. References

### Primary design reference

- `docs/design/fn-4819-distributed-multi-node-coordination-gap.md`

### Ownership / checkout evidence

- `packages/core/src/store.ts:155-160` — lease-related task fields exist on row model
- `packages/core/src/store.ts:3822-3831` — `tryClaimCheckout` CAS precondition update
- `packages/core/src/agent-store.ts:1371-1460` — checkout acquisition path and conflict behavior
- `packages/core/src/agent-store.ts:1417-1420` — renewal/epoch behavior in claim payload
- `packages/core/src/store.ts:3900-3917` — task selection filters against foreign checkout holder
- `packages/core/src/central-db.ts:36-286` — central schema inventory (no `taskClaims` table)
- `packages/core/src/central-core.ts:7` — central DB location contract (`~/.fusion/fusion-central.db`)
- `packages/engine/src/scheduler.ts:829-836` — scheduler invokes lease recovery for checked-out todo
- `packages/engine/src/scheduler.ts:958-965` — re-read guard for todo dispatch
- `packages/engine/src/scheduler.ts:1004-1044` — handoff + unavailable-node policy gate during dispatch
- `packages/engine/src/node-routing-policy.ts:4-75` — handoff and unavailable-node decision logic
- `packages/engine/src/mesh-lease-manager.ts:84-140` — abandoned-lease recovery path
- `packages/engine/src/mesh-lease-manager.ts:93-115` — owner offline/error handoff policy branch
- `packages/engine/src/mesh-lease-manager.ts:117-127` — lease clear + epoch increment + row mutation
- `packages/engine/src/mesh-lease-manager.ts:129-140` — task log + todo rebound behavior

### Wake / assignment propagation evidence

- `packages/engine/src/agent-heartbeat.ts:3663-3740` — local `agent:assigned` wake trigger
- `packages/engine/src/agent-heartbeat.ts:3731-3734` — assignment callback payload fields
- `packages/engine/src/runtimes/in-process-runtime.ts:1186-1194` — local task event forwarding
- `packages/engine/src/runtimes/remote-node-runtime.ts:153-213` — remote stream loop and reconnect behavior
- `packages/engine/src/runtimes/remote-node-runtime.ts:241-254` — forwarding remote `task:*` events
- `packages/engine/src/runtimes/remote-node-client.ts:98-120` — stream endpoint parsing (SSE/JSON fallback)
- `packages/engine/src/runtimes/remote-node-client.ts:114-120` — long-polling JSON fallback handling
- `packages/engine/src/runtimes/remote-node-client.ts:406-416` — retry behavior for failed requests
- `packages/engine/src/peer-exchange-service.ts:116-206` — periodic peer sync loop (default interval behavior)
- `packages/engine/src/peer-exchange-service.ts:262-380` — per-peer sync request flow

### Conflict telemetry evidence

- `packages/engine/src/run-audit.ts:97-111` — existing `branch:*` structured audit taxonomy
- `packages/engine/src/run-audit.ts:126-136` — existing `task:auto-recover-*` taxonomy
- `packages/engine/src/run-audit.ts` search result — no `task:auto-recover-node-unreachable` entry
- `packages/engine/src/scheduler.ts:1018-1025` — handoff decisions persisted via `taskStore.logEntry`
- `packages/engine/src/mesh-lease-manager.ts:108-133` — recovery outcomes persisted via logs/task entries

### Isolation transition evidence

- `packages/core/src/central-core.ts:521-547` — `transitionProjectIsolation` + activity log write
- `packages/core/src/central-core.ts:531-535` — noop guard for unchanged isolation mode
- `packages/engine/src/hybrid-executor-gate.ts:20-36` — runtime-mode gate based on node/project topology
- `packages/engine/src/project-manager.ts:168-196` — runtime selection by isolation mode + assigned node type
- `packages/core/src/central-db.ts:36-286` — absence of migration/bootstrap for central `taskClaims`

### Additional context references consulted

- `AGENTS.md` (Storage Model, Multi-Project Support, Checkout Leasing, Architecture)
- `docs/storage.md`
- `docs/multi-project.md`
- `docs/shared-mesh-protocol.md`
- `docs/architecture.md`
- `packages/engine/src/project-engine-manager.ts:398-409` — runtime config construction includes isolation mode input
- `packages/engine/src/project-engine-manager.ts:360-389` — runtime creation/start lifecycle context
- `packages/engine/src/agent-heartbeat.ts:2016-2028` — checkout validation preflight in heartbeat execution
- `packages/engine/src/peer-exchange-service.ts:175-206` — triggerSync/single-flight synchronization behavior
- `packages/core/src/central-core.ts:252-302` — project registration includes isolation mode defaulting
- `packages/core/src/central-core.ts:449-485` — project update path persists isolation mode changes
- `packages/engine/src/runtimes/remote-node-client.ts:179-183` — retryability classification for remote failures
- `packages/engine/src/runtimes/remote-node-runtime.ts:181-203` — bounded reconnect attempt behavior
