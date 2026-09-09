# Run-Audit Catalogue

The run-audit catalogue for the S4 **Reliability, Durability & Observability** delivery-pipeline theme — a durable, single-source-of-truth reference for *who did what, when, and why after the fact* across the delivery pipeline's reliability/observability event surface.

## Status / purpose

This document is the **run-audit observability catalogue** for the Core Product Vision & Roadmap mission (Mission **M-MSL4E01A-0001-Y9QC**, Milestone **M2 — Roadmap Definition**, Slice **S4 — Reliability, Durability & Observability roadmap**, feature **F-MSL72J0A-000M-GIJN**), **grounded in the M1 vision theme verbatim**:

> "**Reliability, durability, and observability** of the delivery pipeline — tasks, agents, and their delivery are recoverable and inspectable."

See the north-star grounding: [Core Product Roadmap — §4. Reliability, Durability & Observability](./roadmap.md) and [Product Vision — Strategic Themes](./vision.md).

The S4 roadmap near-term item ("Recoverable and inspectable delivery") calls for the pipeline's run-audit behavior to be **inspectable after the fact**. This catalogue is that surface: it centralizes the delivery-pipeline-focus run-audit event names (finalization, self-healing reconciliation, durable-agent error-state) so an operator or agent can answer *"which run-audit events are emitted for delivery-pipeline finalization / durable-agent error-state / self-healing reconciliation, and when?"* without grepping source. It is kept truthful by a parity test that enforces lock-step with the typed catalogue module.

## How to read / query the run-audit surface

Run-audit events are captured via the run-audit store using the discriminated event union type `DatabaseMutationType` in the engine ([`packages/engine/src/util/run-audit.ts`](../packages/engine/src/util/run-audit.ts)). Metadata follows the **ids/outcomes-only** convention — never description prose. All events named below are literal members of that union; the typed catalogue array [`packages/engine/src/run-audit/run-audit-catalogue.ts`](../packages/engine/src/run-audit/run-audit-catalogue.ts) enforces member-validity at compile time, and the parity test (`run-audit-catalogue.test.ts`) keeps this doc and the module in lock-step so neither can drift from the real union.

Query the stored surface through the audit-store read path (project-scoped historical record of emitted mutation events) filtering by the `mutationType` names below and the ids/outcomes-only structured metadata each event records. This catalogue documents *what each event means*; the audit store records *when each was emitted* in a project's history.

## Delivery-pipeline finalization

Events that close a task's delivery: blocked/advanced completion parks, already-merged / already-on-main no-ops, finalize column-mismatch reconciliation, post-finalize verification, finalize-blocking guards, and stale-merger recovery.

| Event | What it records / when it fires |
| --- | --- |
| `task:completed-blocked-parked` | A fully implemented task is parked instead of advancing to review because a live completion blocker applies. |
| `task:completed-blocked-advanced` | The parked completed task's blocker cleared and its work advances to review. |
| `task:auto-recover-already-merged` | Self-healing finds a task already merged into main and records the no-recovery-needed outcome. |
| `task:auto-recover-finalize-already-on-main` | A finalize attempt is skipped because the task's changes are already present on main. |
| `task:auto-merge-skipped-already-done` | Auto-merge is skipped because the task is already done/landed. |
| `task:auto-merge-finalize-column-mismatch-reconciled` | Finalize found the task in a different live column than its target and reconciled the column. |
| `task:auto-merge-finalize-column-mismatch-no-action` | Finalize found a column mismatch but took no action (e.g. blocked/no-action per triple-proof). |
| `task:post-finalize-verification-no-op` | Post-finalize verification ran and found nothing to verify (no-op), recording the check outcome. |
| `task:no-commits-finalize-blocked-incomplete-steps` | Finalize is blocked for a zero-commit task with incomplete workflow steps (FN-6461 lane). |
| `task:empty-merge-finalize-blocked-no-landed-proof` | The AI empty-merge lane vetoes a zero-diff no-op finalize with no landed proof (FN-8141). |
| `task:finalize-unproven-blocked` | Finalize is blocked because finalization has not been proven against the landing truth. |
| `task:merge-boundary-unproven-parked` | A workflow merge boundary could not be proven and its terminal park is recorded with best-effort, time-bounded telemetry that never blocks or stalls the park. |
| `task:finalize-lost-work-blocked` | Finalize is blocked because it would discard work (lost-work guard). |
| `task:auto-recover-stale-merger-status` | Self-healing clears a stale merger status left on a finalize path. |
| `task:merge-admission-deferred-live-execution` | Merge admission found a live executor session, execution lock, or active task signal and deferred without parking the task. Metadata contains task ID plus fixed source, signal, and outcome values only. |
| `task:reconcile-confirmed-merge-checklist` | A confirmed merge reconciled stale non-terminal checklist steps or pending pre-merge results before terminal finalization. Metadata contains task ID, source, counts, prior column, and fixed outcome only. |

## Self-healing reconciliation events

Reconciliation-scoped auto-recover/reclaim events the self-healing sweep surfaces when it repairs board state after the fact.

| Event | What it records / when it fires |
| --- | --- |
| `task:auto-recover-paused-abort-park` | Self-healing clears a benign pause-abort operator park and requeues the task. |
| `task:auto-rebound-paused-scope-decay` | Self-healing rebounds a task whose paused scope decayed past its floor, unblocking followers. |
| `task:auto-archive-failure-budget-exhausted` | Historical event retained for reading pre-removal logs; current self-healing does not archive tasks. |
| `task:reclaim-phantom-executor-binding` | Self-healing proves an in-memory executor-active binding is stale and requeues the task. |
| `task:reconcile-orphaned-pending-step-results` | Self-healing rewrites orphaned `pending` workflow-step results (no live session) to `failed`. |
| `task:reconcile-unproven-review-approval` | Self-healing rewrites singular content-review approvals without input proof to recoverable `failed` results. |
| `task:reconcile-stale-duplicate-decision` | Self-healing clears a recurring duplicate-decision pause with no canonical target. |
| `task:reconcile-stale-agent-assignment` | Self-healing clears stale durable Agent.taskId/state drift while preserving file-scope leases. |
| `task:reconcile-engine-downtime-active-timing` | Self-healing shifts active-task anchors to exclude proven stopped-engine wall-clock. |
| `task:reconcile-engine-downtime-active-timing-no-action` | Self-healing finds no active task qualifies for downtime-timing reconciliation (no-action). |
| `task:reconcile-undeclared-column` | Self-healing re-homes a row out of a column its workflow no longer declares. |
| `task:reconcile-wedged-active-merge` | Self-healing reclaims a wedged single-flight merge entry. |
| `task:reconcile-stranded-completed-no-action` | A stranded-completed promoter withholds promotion of an all-steps-done/skipped task with a failure-park provenance (no-action). |
| `task:reconcile-legacy-adoption` | Self-healing startup adopts a pre-cutover legacy task row through the KTD-8 adoption table. |
| `task:reconcile-archived-into-done` | Self-healing moves a live historical archive row or restores a cold snapshot into the task's workflow completion lane. Metadata is limited to the task ID, source, counters, and a fixed outcome. |

## Durable-agent error-state

Events that make durable-agent error states and their recovery inspectable.

| Event | What it records / when it fires |
| --- | --- |
| `agent:auto-recover-error-state` | A recoverable, non-operator-actionable durable-agent error is cleared by the heartbeat/self-healing sweep and retried. |
| `agent:reset-error-state-on-startup` | An engine restart clears an eligible durable-agent error/exhaustion park and re-arms the heartbeat (startup-only). |
| `agent:error-retry-exhausted` | A durable-agent error retry budget is exhausted and the agent is parked `paused` with pauseReason `error-retry-exhausted`. |
| `agent:error-parked-unrecoverable` | An operator-actionable durable-agent error parks the agent `paused` with pauseReason `error-unrecoverable` for human repair. |
| `agent:heartbeat-move-skipped-soft-delete` | A heartbeat move races a soft-deleted task and is skipped without parking the durable agent. |

## Maintenance contract

Adding a new catalogued run-audit event requires updating **both** the typed catalogue module (`packages/engine/src/run-audit/run-audit-catalogue.ts`) **and** this doc together — the parity test (`packages/engine/src/__tests__/run-audit-catalogue.test.ts`) fails if the documented event set and the catalogue module's set ever diverge, keeping the observability surface truthful as the real `DatabaseMutationType` union evolves. Removing an event likewise requires updating both in the same change.

### Emit-seam policy

All engine telemetry must use `emitBoundedRunAudit` from `packages/engine/src/util/emit-bounded-run-audit.ts`. It is best-effort and never load-bearing for lifecycle correctness: absent/non-function, synchronously throwing, rejecting, never-settling, and late-settling sinks are absorbed without altering the owning branch. The seam swallow-logs and bounds each write; it intentionally adds no retry, backoff, or queueing.

This applies to executor, run-auditor, self-healing, merger, PR reconciliation, scheduler, project-engine, plugin, mission-loop, hold-release, goal diagnostics, overseer advisor, mesh-lease, in-process runtime, credential rotation, and workflow-column-boundary emitters. `packages/engine/src/merge/merge-write-fence.ts` retains its bespoke non-`RunAuditEventInput` recorder. New engine emitters must ship with a behavioral sink-health regression covering hostile sink states, not only a source-routing assertion.

### Core emit-seam policy

Core best-effort emitters use `packages/core/src/run-audit/emit-bounded-run-audit.ts`. This is a deliberate copy of the engine seam because `@fusion/core` cannot import `@fusion/engine`; it synchronously invokes a valid sink, then absorbs throws, rejection, timeout, and late settlement without making telemetry lifecycle-load-bearing. `emitBoundedRunAudit` is the default void seam. `emitBoundedRunAuditWithOutcome` returns `recorded`, `absent`, `failed` (with the original error), or `timed-out` where a forensic throw ordering or caller-visible skipped payload depends on the audit result; workflow-switch torn reconciliation and phantom committed-reservation reconciliation use it. FN-9181 applies FN-9178's class-A decision to detached recall capture: `memory:capture-recorded` and `memory:capture-failed` are bounded, while the injectable `deps.audit` adapter remains a test seam with its existing bare-metadata contract. Transactional writers and explicitly awaited durability/ordering writers remain unbounded. `packages/core/src/__tests__/core-run-audit-sink-health.test.ts` and `core-run-audit-emitter-isolation.test.ts` respectively enforce hostile-sink behavior and source routing.

### Awaited core exclusion decision

FN-9178 classified awaited sites with hostile-sink characterization tests. FN-9180 routed the class-A `task-deleted-outbox:catch-up`, `:reconciliation-fallback`, `:lease-fenced`, and `:retention-pruned` rows through `emitBoundedRunAudit`; each remains awaited at its post-acknowledgement, post-cursor, or post-DELETE position so bounded telemetry preserves ordering. FN-9181 routed detached recall capture through the same bounded seam. `task:workflow-switch-torn` and `task:reconcile-phantom-committed-reservation` are class B and use the bounded outcome seam because their throw/result payload depends on audit outcome. `task:bypass-review`, `task:resume-step`, and both resurrection-blocked records are class C and intentionally unbounded: they claim persistence before return, destructive cleanup, or a forensic throw.

All `recordRunAuditEventWithinTransaction(tx, ...)` calls and the `recordRunAuditEventBackend(tx, ...)` transactional call are permanently out of scope. Their audit row shares a transaction with the mutation it describes; bounding would split that atomicity. The full matrix and evidence pointers are in the FN-9178 `decision` task document; `excluded-awaited-run-audit-store-sites.test.ts`, `excluded-awaited-run-audit-layer-sites.test.ts`, and the core routing ratchet pin this boundary.

### Review convergence events

`task:review-finding-disputed`, `task:review-convergence-escalation`, `task:review-arbitration`, and `task:review-convergence-human-escalation` record review-cycle progression. `task:review-convergence-escalation` includes the fixed `escalationSource` outcome (`dedicated`, `execution-fallback`, or `none`); its `hasModelTarget` flag is true only when a distinct model pair was resolved and persisted. Metadata contains only ids, counts, and fixed outcomes; provider/model identifiers, dispute rationales, findings, reviewer feedback, and arbiter output are never recorded. All five emission sites use the FN-9175 bounded best-effort seam, so hostile telemetry cannot alter or block the ladder, arbitration release, or dispute result.

`task:review-empty-content-parked` records the one-time terminal close for a provably empty Code Review input. Its metadata is limited to task and workflow-step ids, the resting column, and the fixed failed outcome; reviewer prose and findings remain off audit rows. The empty-merge finalize-blocked events also include the fixed `parkedStatus: "failed"` outcome. These writes use bounded best-effort emission and are intentionally outside the curated delivery-pipeline event table.

`task:review-input-recaptured` records a positive review lane that proved its own checkout fast-forwarded and re-bound its identity to the final reviewed content. `task:merge-stale-content-review-rerouted` records a singular stale-content merge refusal, from merge admission or self-healing, that attempted graph-owned review re-entry. Self-healing may recover the bounded-retry rejection, raw merge-door blocker, or retry-exhausted park only after re-seeding the stale lane; metadata uses task and workflow-step ids, fixed reroute reason/source, and fixed park outcome fields (`parkShape`, `parkCleared`, `mergeRetriesReset`) only. Neither event records fingerprints, diffs, paths, findings, or reviewer prose. Both use the FN-9175 bounded best-effort seam.

| Event | Metadata |
| --- | --- |
| `review-remediation-appended` | Task id, gate id, wave, and count only. |
| `review-remediation-parked` | Task id and fixed park outcome only. |

### External block lifecycle

`task:external-block-parked` records a task entering a durable external freeze, and `task:external-block-cleared` records operator Retry publishing its exact resume continuation. Metadata is IDs and fixed classifications only: task id, origin, code, source, column, and resume node id. Raw error prose remains on `Task.externalBlock` and is never copied into run-audit metadata. Both writes use the bounded best-effort emitter and are intentionally outside the curated delivery-pipeline event catalogue.

`task:step-session-abort-contained` records an interrupted step-session repair that retains the current lifecycle lane, checkout, node, and completed step progress. Its metadata is IDs, counts, and fixed outcomes only: task id, current column, abort trigger, recovery outcome, and completed-step count; it never includes failure text or step names. The executor emits it through the bounded best-effort seam, and it is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-pre-merge-gate-rerouted` records a merge-admission or self-healing attempt to seed the earliest enabled pre-merge gate that has no result. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, `workflowStepId`, fixed `reason`, `source`, and `missingGateCount`; it excludes reviewer prose, findings, fingerprints, blocker text, and errors.
