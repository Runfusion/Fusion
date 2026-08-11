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
| `task:finalize-lost-work-blocked` | Finalize is blocked because it would discard work (lost-work guard). |
| `task:auto-recover-stale-merger-status` | Self-healing clears a stale merger status left on a finalize path. |

## Self-healing reconciliation events

Reconciliation-scoped auto-recover/reclaim events the self-healing sweep surfaces when it repairs board state after the fact.

| Event | What it records / when it fires |
| --- | --- |
| `task:auto-recover-paused-abort-park` | Self-healing clears a benign pause-abort operator park and requeues the task. |
| `task:auto-rebound-paused-scope-decay` | Self-healing rebounds a task whose paused scope decayed past its floor, unblocking followers. |
| `task:reclaim-phantom-executor-binding` | Self-healing proves an in-memory executor-active binding is stale and requeues the task. |
| `task:reconcile-orphaned-pending-step-results` | Self-healing rewrites orphaned `pending` workflow-step results (no live session) to `failed`. |
| `task:reconcile-stale-duplicate-decision` | Self-healing clears a recurring duplicate-decision pause with no canonical target. |
| `task:reconcile-stale-agent-assignment` | Self-healing clears stale durable Agent.taskId/state drift while preserving file-scope leases. |
| `task:reconcile-engine-downtime-active-timing` | Self-healing shifts active-task anchors to exclude proven stopped-engine wall-clock. |
| `task:reconcile-engine-downtime-active-timing-no-action` | Self-healing finds no active task qualifies for downtime-timing reconciliation (no-action). |
| `task:reconcile-undeclared-column` | Self-healing re-homes a row out of a column its workflow no longer declares. |
| `task:reconcile-wedged-active-merge` | Self-healing reclaims a wedged single-flight merge entry. |
| `task:reconcile-stranded-completed-no-action` | A stranded-completed promoter withholds promotion of an all-steps-done/skipped task with a failure-park provenance (no-action). |
| `task:reconcile-legacy-adoption` | Self-healing startup adopts a pre-cutover legacy task row through the KTD-8 adoption table. |

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