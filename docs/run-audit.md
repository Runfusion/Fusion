# Run-Audit Catalogue

The run-audit catalogue for the S4 **Reliability, Durability & Observability** delivery-pipeline theme — a durable, single-source-of-truth reference for *who did what, when, and why after the fact* across the delivery pipeline's reliability/observability event surface.

## Overlap wait release

`task:overlap-wait-released` is emitted after the transactional overlap receipt becomes ready. Metadata is limited to task/predecessor IDs, episode/common-file counts, and the fixed `resume`/`briefing` plus freshness enums; paths, diffs, summaries, prompts, and remote URLs remain in the project-scoped receipt. Emission uses the engine bounded best-effort seam, so absent, throwing, rejecting, hanging, or late-settling sinks cannot alter synchronization, validate a plan, start work, or roll back the owner decision. The stateless plan-premise release check and durable receipt—not audit—are authoritative; run-audit is not exactly-once and is never re-emitted by every recovery tick.

`task:overlap-delivery-reconciled` is emitted when a delivered predecessor commit rewritten by an integration-branch rebase is proven equivalent to a commit the execution checkout does contain. Metadata is limited to `taskId`, `blockerTaskId`, `repository`, the original and reconciled SHAs, the fixed proof enum, and the episode count; paths, diffs, summaries, and reviewer prose stay in the project-scoped receipt. Emission uses the same engine bounded best-effort seam, so an absent, throwing, rejecting, hanging, or late-settling sink cannot approve a delivery, alter the refusal, or change the owner decision. Refusals are deliberately not audited: they are bounded, repeated per dispatch, and already named in the deduplicated task-log diagnostic.

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
| `task:zero-commit-landing-proof-refused` | A finalization lane refused to finalize a zero-commit card whose checkout still held work, or could not be classified (RUFU-274). Metadata is ids/counts/fixed enums only — never paths or content. |
| `task:zero-commit-landing-proof-deferred` | A finalization lane deferred on a zero-commit card because zero-ness or checkout content could not be proven, instead of finalizing on a guess (RUFU-274). Metadata is ids/counts/fixed enums only. |
| `task:zero-commit-landing-proof-cleared` | A re-probe proved the cause of a durable uncommitted-work hold is gone and the hold was cleared (RUFU-274). Metadata is the task ID, lane and prior reason code only. |
| `task:finalize-unproven-blocked` | Finalize is blocked because finalization has not been proven against the landing truth. |
| `task:merge-boundary-unproven-parked` | A workflow merge boundary could not be proven and its terminal park is recorded with best-effort, time-bounded telemetry that never blocks or stalls the park. |
| `task:merge-boundary-evidence-recovered` | Self-healing reverified durable unfinished work on a historic proofless boundary park and resumed named implementation remediation. Metadata contains task ID and a fixed outcome only. |
| `task:finalize-lost-work-blocked` | Finalize is blocked because it would discard work (lost-work guard). |
| `task:auto-recover-stale-merger-status` | Self-healing clears a stale merger status left on a finalize path. |
| `task:merge-admission-deferred-live-execution` | Merge admission found a live executor session, execution lock, or active task signal and deferred without parking the task. Metadata contains task ID plus fixed source, signal, and outcome values only. |
| `task:reconcile-confirmed-merge-checklist` | A confirmed merge reconciled stale non-terminal checklist steps or pending pre-merge results before terminal finalization. Metadata contains task ID, source, counts, prior column, and fixed outcome only. |

### Complete-column gate-evidence refusal (RUFU-406)

`task:move-refused-complete-column-gate-evidence` is emitted by the core move seam once per refused move
into a column carrying the `complete` trait, when the move was attributed to a human (`moveSource: "user"`)
and the card's required workflow gates carry no approving evidence — no row at all, `pending`, a
`failed`/`REVISE` row, or a `skipped` row without an audited operator waiver. It is written by
`@fusion/core` through the FN-9177 bounded seam and therefore sits intentionally outside the curated
delivery-pipeline catalogue, like the approval-hold pair below.

The row exists because the pre-existing invariant at this boundary read only the merge **blocker**, which a
`in-progress → done` move never consults: measured 2026-09-29, RUFU-389 and RUFU-337 reached the terminal
lane with zero `code-review` rows and left no row behind, and both had been closed by an agent through
`fn task move` — whose CLI transport hardcodes `moveSource: "user"`, so the audit trail read as a human
action. Metadata is `{ rejectionCode, toColumn, moveSource, moveCallerSurface, callerSessionId?, gateCount,
gateFindings }`: a fixed rejection code, a column, the caller-surface enum (`operator-cli` / `agent-cli` /
`dashboard-http` / `store-direct`, declared by the transport rather than inferred — the CLI classifies its own
process, so an agent shell reporting through `fn task move` no longer reads as an operator at the keyboard), the
session marker only when a process
marker proved it, and counts. `gateFindings` holds at most eight `lane:gateId:state` triples. The refusal
sentence, reviewer findings, verdict text, and paths never enter this row — the sentence lives on the card's
History line, written alongside it.

Without this row a refusal is invisible to the board: the move throws, the mover sees the sentence, and the
card stays put. With it, "how often does a human-attributed move get refused at the completion boundary,
and from which surface?" is one query.

## Self-healing reconciliation events

Reconciliation-scoped auto-recover/reclaim events the self-healing sweep surfaces when it repairs board state after the fact.

| Event | What it records / when it fires |
| --- | --- |
| `task:auto-recover-paused-abort-park` | Self-healing clears a benign pause-abort operator park and requeues the task. |
| `task:auto-rebound-paused-scope-decay` | Self-healing rebounds a task whose paused scope decayed past its floor, unblocking followers. |
| `task:auto-archive-failure-budget-exhausted` | Historical event retained for reading pre-removal logs; current self-healing does not archive tasks. |
| `task:reclaim-phantom-executor-binding` | Self-healing proves an in-memory executor-active binding is stale and requeues the task. |
| `task:reconcile-orphaned-pending-step-results` | Self-healing rewrites orphaned `pending` workflow-step results (no live session) to `failed`. |
| `task:stale-review-callback-waived` | Self-healing records a receipt-backed waiver for an eligible stale code-review callback. Metadata is ids, receipt presence, fixed actor/reason, prior status, and threshold category only; reviewer output, findings, lease owners, paths, and errors never enter run-audit, and an absent, throwing, or hanging sink cannot change the durable waiver. |
| `task:reconcile-unproven-review-approval` | Self-healing rewrites singular content-review approvals without input proof to recoverable `failed` results. |
| `task:reconcile-stale-duplicate-decision` | Self-healing clears a recurring duplicate-decision pause with no canonical target. |
| `task:reconcile-orphaned-non-convergence-hold` | Self-healing clears a drifted stage-one approval hold (`code-review-non-convergence` or `plan-review-replan-cap`) whose gate evidence no longer exists, in place and without a lifecycle move. |
| `task:reconcile-stale-agent-assignment` | Self-healing clears stale durable Agent.taskId/state drift while preserving file-scope leases. |
| `task:reconcile-engine-downtime-active-timing` | Self-healing shifts active-task anchors to exclude proven stopped-engine wall-clock. |
| `task:reconcile-engine-downtime-active-timing-no-action` | Self-healing finds no active task qualifies for downtime-timing reconciliation (no-action). |
| `task:reconcile-undeclared-column` | Self-healing re-homes a row out of a column its workflow no longer declares. |
| `task:reconcile-wedged-active-merge` | Self-healing reclaims a wedged single-flight merge entry. |
| `task:reconcile-stranded-completed-no-action` | A stranded-completed promoter withholds promotion of an all-steps-done/skipped task with a failure-park provenance (no-action). |
| `task:reconcile-legacy-adoption` | Self-healing startup adopts a pre-cutover legacy task row through the KTD-8 adoption table. |
| `task:reconcile-archived-into-done` | Self-healing moves a live historical archive row or restores a cold snapshot into the task's workflow completion lane. Metadata is limited to the task ID, source, counters, and a fixed outcome. |

### Stranded workflow continuation reclaim

`reconcileStrandedWorkflowContinuations` records what it did to a stranded continuation row: `workflowWorkItem:reconcile-stranded-requeued` when the row becomes claimable again and `workflowWorkItem:reconcile-stranded-retired` when its task can never run it again (deleted, archived, or soft-deleted). Both carry ids/counts only — `taskId`, `workItemId`, `nodeId`, `kind`, `priorState`, the fixed `reason`, and `stalenessMs` — never `lastError` prose or node config. A suppressed action emits nothing.

RUFU-263 made the sweep read the row's `blockedReason` before acting, because `held` is not one condition: a wait the store's own claim predicate can re-take (`workflow-principal-*`, `workflow-named-principal-*`, `workflow-role-pool-*`), an FN-514 delivery lock (`workflow-human-merge-approval*`), and a file-scope wait whose blocker the task still names (`file-scope:<blockerId>`) are all owned by another seam, so the sweep leaves them untouched and writes no row at all.

`workflowWorkItem:reconcile-stranded-no-action` is the deduped sibling for the two conditions the sweep must keep re-checking without re-firing every pass: a dependency wait with no dedicated releaser (`dependency:<taskId>`, `dependency-configuration-blocked`) and an unclaimable hold it has already announced once. The sweep stamps the row's own `retryAfter` on a 30-minute → 2-hour → 6-hour ladder, so the durable row is both the bound and the evidence — it survives a restart, while the in-memory memo means each `(taskId, nodeId, state, blockedReason)` condition is recorded and announced to the card history at most once. Metadata adds `reason` and `nextCheckAt` to the same id/count set; before this event the only trace of these conditions was one `[recovery] workflow continuation re-queued` task-log line per ~15-minute pass (RUFU-220: 782 identical lines while the card never moved). All three rows use the FN-9175 bounded best-effort seam and are intentionally outside the curated delivery-pipeline event catalogue, whose member-shape guard accepts lowercase event prefixes only.

### Orphaned git child reaper

`worktree:orphaned-git-child-reaped` records one signal-only termination pass (RUFU-210) over reparented git child processes still holding a removed task worktree as their cwd — the post-mortem shape of the RUFU-194 incident (`git rebase --continue` → `git commit -e` wedged on a missing editor for 1d13h after the worktree was gone). The sweep runs at startup recovery and, cadence-gated with the other git/worktree churn steps, in maintenance batch 1. A candidate must be a `git`-named process under a registered worktrees scan root whose directory is proven removed (readlink failure or the kernel ` (deleted)` cwd suffix) and whose `/proc` starttime proves it is older than the 30-minute grace floor; it receives SIGTERM, then SIGKILL after a 5 s grace, capped at 10 reaps per sweep. The sweep signals processes only — it never mutates task, worktree, or lifecycle state. One row is emitted per deleted worktree path with `target` = the path and metadata limited to `count`, `pids` (capped at 20), `ageMs`, the fixed `reason` (`deleted-worktree-cwd` or `deleted-cwd-suffix`), and `outcome: "reaped"`. Command lines, argv, other-process cwd values, and error prose are never recorded. On a host without `/proc` the sweep emits nothing at all — the absent row is the signal that the host could not be probed.

`worktree:orphaned-git-child-reap-no-action` is the deduped sibling: emitted once per manager lifetime (re-armed after any reap row) when the sweep ran on a probeable host and found no candidates, with `target: "orphaned-git-children"` and metadata `{ count: 0, outcome: "no-action" }`. Both writes use the FN-9175 bounded best-effort seam and are intentionally outside the curated delivery-pipeline event catalogue.

### Vanished task-directory detection

`task:vanished-approved-work` records one finding from `reconcile-vanished-task-dirs` (RUFU-283): a `.fusion/tasks/<ID>/task.json` mirror whose id resolves on **no** board read. It exists because RUFU-225 kept its mirror, its `in-review` column, an `APPROVE_WITH_NOTES` code-review verdict and 3 unmerged commits while resolving on no board read, and the board's silence was the only report — the integrity report is row-only (`status: "ok"` was correct), and FN-6783's orphan re-import needs a fully absent id plus a 7-day window the mirror never reached.

The literal names the class the operator must never lose silently — approved work with an unmerged branch — and it is emitted for every vanished-directory finding, because the disappearance is the event and `reason` says which neighbourhood it is: `row-missing-branch-unmerged` / `row-tombstoned-branch-unmerged` (work still reachable), `row-missing-branch-missing` / `row-tombstoned-branch-missing` (work already lost), and `state-unresolved` when the branch could not be probed.

### Approval-hold pair invariant (RUFU-297)

`task:move-cleared-approval-hold` is emitted post-commit by the core move implementation when a **user-driven move out of a review lane** clears an approval hold whose evidence the reopen hooks just destroyed (or the gated-session pause shape the move supersedes). Metadata: `{ priorStatus, awaitingApprovalReason, fromColumn, toColumn, moveSource, outcome: "cleared" }` — the reason-code enum (`"none"` for the bare marker), never hold prose or error text. It is written by `@fusion/core` through the FN-9177 bounded seam, so — like the vanished-work pair — it sits intentionally outside the curated delivery-pipeline catalogue. The row is the audit proof of the pair invariant at the move seam: a `step-wiping` review exit with **no** such row means the move preserved the evidence (plan-approval release, graph remediation, `preserveStatus`, `userPaused`) — the invariant's second half.

`task:reconcile-orphaned-non-convergence-hold` is the sweep-side twin (defect B): a card can hold
`status: "awaiting-approval"` + `awaitingApprovalReason: "code-review-non-convergence" | "plan-review-replan-cap"`
after its `workflowStepResults` were already destroyed, whose only pre-existing exit was merging the card —
exactly what the escalation hold was meant to defer. RUFU-297 shipped this event for the Code Review
class alone, so every card carrying the other drifted shape stayed silently merge-blocked; RUFU-314 widened
it to both (its `mutationType` declaration is unchanged — only its description, and the `reasonCode` values
that actually occur). The `reconcile-orphaned-non-convergence-holds` sweep clears either drifted shape
**in place** (no lifecycle move) when no pre-merge step result carries the `failed`/`advisory_failure`
evidence any more, skipping live sessions, pauses, and merge-active work. Discovery is `listTasks` over
every unarchived lane, not `getReviewTasks()`, because the cap park is authored from the planning/executor
lane — the wider scan still only clears in place.
Metadata: `{ taskId, column, priorStatus, reasonCode, outcome }` — five keys, pinned exactly by
`self-healing-orphaned-non-convergence-holds.pg.test.ts`. `reasonCode` is the fixed hold-reason enum (which
ladder parked the card — the two shapes are otherwise identical rows). The row carries no `phase`, no
`source`/`taskLineageId` envelope, and no rendered `awaitingApprovalReason` copy: RUFU-314 put the emit on
the FN-9175 seam (`emitBoundedRunAudit` directly, synthetic `self-healing` run id) precisely because the
run-auditor wrapper it replaced forwarded those envelope keys and no-op'd silently with no run context.
Neither value is prose — the `reasonCode` enum names both — so the closed set is what operators query.
The bounded seam is covered behaviorally, not by inspection: `non-executor-run-audit-sink-health.test.ts`
runs both reason codes through absent / throwing / rejecting / hanging / late-settling sinks and asserts the
clear, the task-log entry, and the pass count are identical in every mode while each non-absent mode still
lands exactly one closed-shape row.

Metadata is ids/counts/fixed enums only: `taskId`, `reason`, `branchRef`, `unmergedCommitCount`, `gateApproved` (whether a gate actually approved the card — `false` is a still-live card that vanished, not a false positive), and `salvageTarget`. Mirror prose, status text, step results, and error strings are never recorded — the mirror is read defensively for `column`/gate rows and discarded. `target` is `task:<ID>` and `agentId` is `self-healing`. The row is written before the mailbox notice, so a mailbox outage still leaves a queryable record; `unmergedCommitCount: null` is the honest "unknown", never a zero.

The matching operator notice is a `system:vanished-work:<taskId>:<reason>:<bucket>` mailbox message (`sendMessageOnce`, 6-hour bucket), not a `NotificationService` wedge: wedge dedupe and cooldown hang off the task row, which by definition does not exist here. See [`docs/solutions/reliability/vanished-task-directory-rufu-225.md`](solutions/reliability/vanished-task-directory-rufu-225.md).

`task:row-purged-for-resurrection` is the purge half of the same defect. `deleteTask(id, { allowResurrection: true })` physically removes a soft-delete tombstone, which is the only path that can reuse a vanished id, and it used to delete the `task_workflow_selection` / `workflow_steps` children first and the parent second with no audit row at all. The audit write now shares the parent-delete transaction (`emitBoundedRunAudit` is not usable there — a rolled-back delete must not leave its forensic row behind), so an unaudited removal is unreachable by ordering and a failed audit write raises `TombstonePurgeUnauditedError` with the tombstone intact. Metadata is `taskId`, `operation` (`createTask`/`duplicateTask`/`refineTask`), `allowResurrection`, `forceResurrect`, `deletedAtPresent`, and `purgedWorkflowStepCount`. This is an intentionally **awaited, unbounded** transactional writer (class C), not the bounded best-effort seam.

Both events are deliberately outside the curated delivery-pipeline event catalogue above: neither is a delivery-pipeline step, and `reconcile-vanished-task-dirs` repairs nothing. Their shape is pinned by `packages/core/src/__tests__/vanished-task-detection.test.ts`, `packages/engine/src/__tests__/vanished-task-detection-sweep.test.ts`, and `packages/core/src/__tests__/tombstone-purge-audit.test.ts` instead.

### Lane-capability bind revalidation and repair (RUFU-272)

`task:lane-capability-declined` is emitted by the heartbeat wake gate when a wake carrying an explicitly assigned card re-runs the bind verdict and the lane is capability-ineligible for it. The decline suppresses only this dispatch — the binding is untouched — so without this row the only trace was a warn log and the card sat in the lane's todo forever. Metadata: `{ outcome: "declined", taskId, agentId, column, code: "lane-capability-mismatch" }`, emitted through the FN-9175 bounded seam under the wake's real `runId`, deduped with a 10-minute cooldown per (lane, card, policy); the decline sentence is never recorded.

The same decline now settles the review attempt it refused, and RUFU-682 is why. When the refused attempt is one the
review dispatch sweep opened, the decline closes that reviewer-run row as `failed` with reason
`lane-capability-declined:<lane>/<binding>/<code>/<policySignature>` (witness and reason builder: `reviewerRunLaneDeclineReason`;
the closer: `declineReviewerRunForLane`, which refuses to settle a row another reviewer opened). That reason is what the sweep reads
back as a recorded refusal: it classifies the card as **`capability-declined`**, announces the sentence once per card per policy
episode through the card's History, and stops routing that binding, so the refusal is the last dispatch the lane ever receives for
that policy. It is **not** a `reviewer-busy` park: the card stays un-parked with no error, because the refusal is a routing fact
about one binding, not a fault in the card. The policy signature in the reason is what lifts it — editing the lane's roles, binding,
or `assignmentPolicy` changes the signature, so the previous refusal stops proving anything and dispatch re-arms on the next tick.
No new event is emitted, because the existing row already names the defect; what was missing was that the row's evidence lived where
the deciding loop could not read it. The refusal itself stays countable through the ledger: `select attempt_number, closed_reason
from project.task_reviewer_runs where task_id = '<ID>' and closed_reason like 'lane-capability-declined:%'` counts the refusals, and
the sweep's per-tick `emptyClasses()` map reports the card count under `capability-declined`.

The repair half is the self-healing sweep `reconcile-lane-capability-misbind` (registered after the agent-link mirror sweeps), the **only** mutation owner for this defect class. It writes exactly one of three events per outcome, all under the fixed `runId: "lane-capability-reconcile"`: `task:reconcile-lane-capability-misbind-rebound` (`{ outcome: "rebound", taskId, priorAgentId, nextAgentId, column, candidateCount }`) when the card moved to an auto-eligible lane via the `updateTask({ assignedAgentId })` assignment seam; `task:reconcile-lane-capability-decline-frozen` (`{ outcome: "frozen", taskId, priorAgentId, column, code, candidateCount: 0 }`) once per card when no eligible lane exists — the freeze is the named `lane-capability-mismatch` external block, so a re-runs-stable sweep emits it at most once across passes; and `task:reconcile-lane-capability-misbind-no-action` (`{ outcome: "suppressed", suppressedCount }`) at most once per pass when candidates existed but every one hit an absolute guard (live session, pause, user-pause, existing freeze). Metadata is ids/counts/fixed enums only — never decline prose, policy text, or errors. Live-session, paused, and user-paused cards are never touched and no lifecycle column move ever happens; branch, worktree, and step progress survive the rebind by construction. Shape is pinned by `packages/engine/src/__tests__/self-healing-lane-capability.test.ts` and `packages/engine/src/__tests__/lane-capability-reconciliation.pg.test.ts`.

### The planning fence that terminalized a card it should have retried (RUFU-288)

`task:reconcile-planning-fence-park` is written once per automatic planning re-queue of a card the durable principal fence refused, and `task:reconcile-planning-fence-park-no-action` once per parked card this pass examined and deliberately left alone. The pair exists because the failure they recover was previously indistinguishable from a planning defect: a `pg_advisory_lock` grant timeout was re-wrapped as `workflow-principal-fence-unavailable:triage`, matched no classifier, spent triage's whole recovery budget on an identical refusal, and left the card terminal (`PLANNING_FAILED_EXHAUSTED: … last error: workflow-principal-fence-unavailable:triage`, planning failure cleared) carrying an authoring verdict for an infrastructure refusal. Since RUFU-288 the same refusal is retried with backoff inside a dispatch, re-probed across dispatches by the `reconcile-planning-fence-parks` sweep (startup + maintenance batch 1, after the planning-admission-stall pass), and named to the operator by the `planning-fence-unavailable` wedge descriptor while it waits.

Both rows carry the same metadata — `{ taskId, column, stalenessMs, requeueCount, requirement, outcome }` — through the FN-9175 bounded seam under `agentId: "self-healing"` and a synthetic `runId`, so a slow or hostile audit sink can neither fail the repair nor delay the re-queue. `requirement` is the recovery-relevant axis: `lock-transport` (the per-task planning lifecycle lock timed out or failed — the RUFU-288 incident class), `store-unavailable` (a non-lock dependency broke underneath the fence), `cause-unknown` (the fence refused with no readable cause, which includes a card terminalized by a build that persisted no marker and whose surviving sentence named only the fence family). It replaces the free-form refusal sentence rather than duplicating it, so the incident class is countable without storing error text; the sentence itself, the carried cause, branch tips, and any error message are never recorded. `requeueCount` is the surviving half of the automatic budget: it is counted **across** dispatches, so a permanently broken fence cannot loop a card back into planning forever, while triage's own `attempt` stays bounded **within** one dispatch. Both live in `planningFailure.principalFence`, and the marker is an episode record only — no read path or badge derives from it, so a card that has moved on carries it inertly.

`outcome` is the discriminator that makes the no-action row worth querying, and it is a fixed enum: `requeued` (the mutation row's value), `fence-still-unavailable` (the probe itself refused, so the park stays — deduped per card, requirement, and re-queue count, because a sustained outage otherwise records one row per pass while hiding whether any card is still affected), `live-session`, `operator-held`, `auto-merge-off`, `workflow-unresolvable`, `lane-vocabulary-unreadable`, `left-planning-lane`, `requeue-budget-exhausted`, and `raced` (the lane move, pause, forced retry, or another writer got there first inside the task advisory lock). A genuine authoring exhaustion is never selected by this sweep at all — it stays in the generic `terminal-failed` lane with its existing auto-recovery — which is what makes the fence row a signal rather than a matcher that fires on every planning failure.

**The operator-visible half of the pair.** While a fence park waits, the card is alertable through its own wedge descriptor, `planning-fence-unavailable`, with a cause sentence that names the requirement and the transport detail (`timed out waiting for another planning pass on this card to finish (planning lifecycle lock acquisition timed out after 5000ms)`) instead of the raw engine sentence. Two decisions in that descriptor are load-bearing. It is a **new** descriptor class, so the generic `terminal-failed` alert ladder — including the automatic-recovery budget that withholds all failure-alert channels while retries are owed (see [`docs/agents.md`](agents.md)) — is untouched and a genuine planning defect still pages exactly as before; and the alert is **not** suppressed while automatic recovery is owed, because unlike a budgeted terminal park there is no re-dispatch coming to prove an attempt — the card waits in its planning lane for a re-probe — so withholding the alert would have made this class less visible than the one it replaced. Suppression is kept only for its genuine owners: a live planning retry, an already-surfaced planning stall, and a terminal planning park. The descriptor is derived from the park shape and not from the marker alone, which is what lets it name a card stranded by a build that persisted no marker at all; a card that has moved on, and prose that merely mentions the fence, yield nothing. The alert also has no retry-ladder twin: the `task:review-stall-*` ladder refuses to terminalize this class, so `in-review-stall-deadlock` can never freeze a card waiting on the fence. Shape is pinned by `packages/engine/src/__tests__/self-healing-planning-fence-park.test.ts`, with the refusal-side classification in `packages/engine/src/__tests__/triage-planning-fence-failure.test.ts` and the operator-facing sentence in `packages/engine/src/notification/__tests__/task-wedge-planning-fence.test.ts`.

### Worktree registrations nested inside a scratch tree (RUFU-290)

A `git worktree add` whose target sits **inside** another registered worktree is invisible to every directory walk, because the child is not an entry of any sweep root — it is an entry of the parent's tree. The two reapers that can see it therefore read the registration inventory (`git worktree list --porcelain`) instead of the filesystem: the registration-driven half of `cleanupStaleTempMergeWorktrees` reaps nested scratch children deepest-first while the parent clean-room is still alive, and the landing lane's nested leg reaps what sits below the exact path a landing just force-removed. Four rows describe that surface, all outside the curated delivery-pipeline catalogue, all through the FN-9175 bounded best-effort seam so a slow or hostile sink can neither change what was reaped nor delay a landing.

`worktree:tempdir-sweep` is the per-path row and gained three `reason` values with this pass: `nested-registration` (a registration below a scratch authority was deregistered), `outside-containment` (a scratch-shaped registration — its own entry name or an ancestor segment is `.ai-merge` — sits outside every Fusion authority, so it is **reported and never touched**; the inventory is repo-global and this sweep's authority ends at Fusion's scratch roots, which is what keeps 80-odd unrelated worktrees on a shared common dir out of reach), and `registration-residue-pruned` (the child's directory was already gone and `git worktree prune` cleared the record). Paths stay on these rows only.

`worktree:merge-temp-nested-removed` and `worktree:merge-temp-nested-deferred` are the aggregate counters, one pair per owning scratch entry so the row names the authority that admitted it: `{ authority: "clean-room-root" | "tmpdir" | "task-worktree", foundCount, removedCount, failedCount }` and `{ authority, deferredCount, deferredReason: "active-session" | "resume-reserved" }`. A deferral is announced because it is a deliberate decision to leave a registration in place under a live session or a resume reservation; entries under the age floor are counted, not announced, since one row per pass per fresh clean-room would be noise and the enumeration half is silent for the same class.

`worktree:post-landing-nested-registration` is the only row that can show a **landed** card still leaking registrations, which is the failure mode a forced parent removal creates: deleting the parent tree recursively removes the child's directory without deregistering it. Metadata is `{ foundCount, removedCount, residuePrunedCount, residueRemainingCount, failedCount, deferredCount, deferredReason?, outcome: "cleared" | "partial" | "deferred" }`, where `residuePrunedCount` counts records whose directory vanished with the parent and prune then cleared, and `residueRemainingCount` is what the re-read still finds. Outcome precedence is failure → deferral → residue: a deferred child is also still registered, so testing residue first would make `deferred` unreachable and would label a deliberate safety decision as a partial cleanup. Nested cleanup never changes the merge outcome — a non-`cleared` row means an actionable leak, not a failed landing. Workspace lanes report per-member tallies combined into one row **before** task-directory retirement branches, because one preserved sibling repository stops retirement while a sibling that *was* removed can still have leaked. Paths, branch names, verdicts, and error text never enter metadata.

What these rows are **not** is a capacity signal: reaping a phantom registration frees no `maxWorktrees` unit, because worktree capacity derives from persisted task rows and the in-memory holder registry, neither of which consults the registration inventory (see [`docs/architecture.md`](architecture.md) → "Worktree and naming helpers"). Shape is pinned by `packages/engine/src/__tests__/worktree-nested-registrations.test.ts`, the sweep halves in `packages/engine/src/__tests__/self-healing-tempdir-sweep.test.ts` and its `.real-git.test.ts` sibling, and the landing leg in `packages/engine/src/__tests__/post-landing-worktree-cleanup.test.ts`.

## Durable-agent error-state

Events that make durable-agent error states and their recovery inspectable.

| Event | What it records / when it fires |
| --- | --- |
| `agent:auto-recover-error-state` | A recoverable, non-operator-actionable durable-agent error is cleared by the heartbeat/self-healing sweep and retried. |
| `agent:reset-error-state-on-startup` | An engine restart clears an eligible durable-agent error/exhaustion park and re-arms the heartbeat (startup-only). |
| `agent:error-retry-exhausted` | A durable-agent error retry budget is exhausted and the agent is parked `paused` with pauseReason `error-retry-exhausted`. |
| `agent:error-parked-unrecoverable` | An operator-actionable durable-agent error parks the agent `paused` with pauseReason `error-unrecoverable` for human repair. |
| `agent:heartbeat-move-skipped-soft-delete` | A heartbeat move races a soft-deleted task and is skipped without parking the durable agent. |
| `agent:unresponsive-recovery-cancelled` | An `unresponsive-recovery` episode, or the recovery wake it queued, stood down because run history proves the agent is alive. Metadata is ids and timestamps only: `agentId`, the `stuckRunId` that stopped ticking, the `completingRunId` that closed completed after it, that run's `completedAt`, and `reason` (`episode-start` at the decision, `queued-wake-fire-time` when the wake fired only after a clean completion landed). |

`agent:throttle-cooldown-armed` records the heartbeat arming one bounded re-probe after a run failed on a
provider throttle envelope (HTTP 429 `rate_limit_error` / `Rate limit exceeded` / `~~429~~`) rather than
parking the agent. Metadata is ids/counts/fixed enums only: `agentId`, the shared attempt count `attempt`,
the `limit`, the computed `backoffMs`, and fixed `source: "run-failure"`; the provider envelope, model
identifiers, and account text never enter the row. The row is written once per arming failure — subsequent
failures in the same episode raise the streak and widen `backoffMs` on the floor-doubling-cap ladder, and
an exhausted budget parks `error-retry-exhausted` (the sibling row above) instead of re-arming. While the
cooldown is live, heartbeat run entry skips the run with `resultJson.reason: "throttle-cooldown"` and emits
no audit row of its own — the wait is already represented by the arming row plus the agent's own recovery
metadata (`agent-heartbeat-throttle-cooldown.test.ts` pins both). The skip deliberately consumes no unit of
the shared retry budget; only a re-probe that actually runs and fails does. The write uses the FN-9175
bounded best-effort seam, so an absent, throwing, or hanging audit sink can neither delay the failure path
nor turn a transient throttle into a durable park, and the event is intentionally outside the curated
delivery-pipeline event catalogue.

## Event-driven dispatch latency

`task:dispatch-latency-observed` (FN-519) answers "why did this card wait?" after the fact. Before
it, the binding gate existed only in a log line persisted nowhere, so a stall could not be attributed
to any of its five possible causes: a deliberate added wait, necessary I/O, real contention, a
missing signal, or provider latency.

Metadata is ids, bounded enums, and one duration only: optional `taskId` and `nodeId`, plus
`wakeOrigin` (`local-publication`, `remote-notification`, `capacity-release`, `owner-cleanup`,
`catch-up`, `periodic-backstop`), `phase` (`admission`, `claim`, `session-preparation`,
`node-entry`), `outcome` (`claimed`, `refused`, `no-candidate`), an optional rounded `observedMs`,
and an optional fixed `reasonCode` (`capacity`, `worktree-capacity`, `paused`, `awaiting-approval`,
`dependency`, `external-block`, `planner-live`, `deferred-deadline`, `lost-claim`,
`transport-degraded`). It never contains prompts, titles, task content, reviewer prose, error text,
blocker prose, connection URLs, or secrets.

Two reading notes. A `wakeOrigin` of `periodic-backstop` in a row means the EVENT path did not
deliver, which is the signal that a wake was lost or a transport is degraded; a `reasonCode` of
`transport-degraded` names that condition explicitly rather than leaving it silent. `observedMs` is a
wall-clock observation within ONE process and is never a duration computed between unsynchronized
clocks, so cross-process figures are presented as observations rather than measured latencies.

Emission uses the FN-9175 bounded engine seam (`emitBoundedRunAudit`) and is deduplicated on a
stable `(task, node, phase, outcome, reasonCode)` signature — deliberately excluding the duration, so
a persisting refusal collapses to one row while a CHANGED refusal reason is always reported and a
claim is never suppressed. It is never awaited before a claim or a handoff: the diagnostic that
measures dispatch latency must not be able to create any. Hostile-sink behaviour at the owning call
site is covered by `packages/engine/src/__tests__/dispatch-latency.test.ts`.

### The reviewer attempt that outlived its session (RUFU-559)

`task:reconcile-stranded-reviewer-runs` records one pass over reviewer attempts that are still occupying a
card's live slot after the liveness floor. A reviewer run row used to have no liveness reconcile at all, so an
attempt whose session died with the engine stayed `status='running'` indefinitely — measured on production: 275
such rows, not one of them live, the oldest 19 days old, with 20 in-review cards held by one. Because the review
dispatch sweep derives its anti-loop budget from those committed rows, a zombie reads as an unfinished attempt
and the stall classifier disposes the card as `completed-review-status-none`; every guard in the chain was
behaving correctly while the whole review lane sat still.

Age only selects a candidate. Death is proved with the canonical liveness triple (active session registry paths
for the task, the executing-task lock, `isTaskActive`), and the row is never deleted: it takes a terminal status
through the ledger's one-way completion, so a verdict that lands during the pass wins and the pass reports
`already-settled`. The close reason carries the shared `engine-lost:` prefix, which is also the prefix exempted
from the dispatch attempt budget — an attempt the engine orphaned was never an attempted review, and counting it
would turn "stranded" into "attempts exhausted, parked forever". Metadata is ids/counts/fixed enums only:
`taskId`, `reviewerRunId`, `reworkRound`, `stalenessMs`, `outcome` (`closed` / `already-settled` /
`live-session` / `unparseable-start`), `source`. The registered sweep runs at startup and in maintenance batch 2,
alongside `reconcile-orphaned-pending-step-results`, whose FN-8492 rules it deliberately mirrors.

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

`task:external-block-parked` records a task entering a durable external freeze, and `task:external-block-cleared` records operator Retry publishing its exact resume continuation. Metadata is IDs and fixed classifications only: task id, origin, code, source, column, and resume node id. The `project-configuration` origin and `dependency-readiness` source use the same event pair for proven repeating worktree initialization failures. Command strings, diagnostics, repository paths, and worktree-state tokens remain on `Task.externalBlock` or its private worktree record and are never copied into run-audit metadata. Both writes use the bounded best-effort emitter and are intentionally outside the curated delivery-pipeline event catalogue.

`task:step-session-abort-contained` records an interrupted step-session repair that retains the current lifecycle lane, checkout, node, and completed step progress. Its metadata is IDs, counts, and fixed outcomes only: task id, current column, abort trigger, recovery outcome, and completed-step count; it never includes failure text or step names. The executor emits it through the bounded best-effort seam, and it is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-pre-merge-gate-rerouted` records a merge-admission, self-healing, or graph-failure-sink attempt to seed the earliest enabled pre-merge gate that has no result or a verdict-less failure. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, `workflowStepId`, fixed `reason`, fixed `source` (`merge-gate`, `self-healing`, or `graph-failure`), and `missingGateCount`; it excludes reviewer prose, findings, fingerprints, blocker text, and errors. RUFU-217 extends the fixed `reason` enum additively with `verdictless-seeded` (the earliest seedable gate was a verdict-less failed gate, re-seeded within budget) and `rerun-budget-exhausted` (the gate's persisted per-task per-gate rerun budget is spent, so the card will surface to the operator instead of reseeding); `missingGateCount` keeps its existing meaning of the resolved required-gate count, and no metadata keys were added.

`task:merge-unrun-gate-retry-deferred` records the bounded auto-merge retry seam deferring instead of terminalizing a merge refusal whose message embeds the canonical never-ran-gate sentence (RUFU-276). The refusal is the FN-9191 deferral class, so the retry writes no `status`, `error`, or `mergeRetries` and burns no retry budget; this row is the only durable trace of the deferral. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, fixed `source` (`merge-retry`), and fixed `outcome` (`deferred`); the refusal sentence, blocker text, and errors are excluded. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-gate-park-repaired` records one self-healing repair pass over a review-lane card that an earlier build had already terminalized over a never-ran gate (`status: "failed"` with an `AUTO_MERGE_RETRY_REJECTED:` or raw not-run refusal, and at least one required pre-merge gate holding no result row at all). The repair seeds a fresh run of that gate through the same idle-seed call the FN-9243 lane uses — the seed itself keeps its own `task:merge-unrun-pre-merge-gate-rerouted` row — and this row records the park outcome, so an operator can tell "the seed was refused" from "the seed landed but the live row drifted". It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `workflowStepId`, `missingGateCount` (required gates with zero result rows, not the resolved required-gate count), fixed `source` (`self-healing`), and fixed `outcome` (`repaired`, `seed-refused`, or `signature-drift`); the parked sentence, review findings, and errors are excluded. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:graph-failure-after-handoff-honored` records the graph-failure sink honoring a completed handoff instead of terminalizing it: an execute-family node (execute / step-execute) failed for a row that was already in the workflow's resolved review lane with all plan steps done, `status`/`error` null, and not user-paused, so the card is left exactly as found (under `autoMerge: false`, `in-review` is terminal-until-human). Emitted through the bounded best-effort seam with IDs and a fixed reason only: `taskId`, `nodeId` (the failing execute-family node, `"unknown"` when the graph recorded none), `column` (the resolved review lane the card is honored in), and fixed `reason: "work-complete-handoff"`; the benign log sentence, failure text, and token totals never enter run-audit. It is intentionally outside the curated delivery-pipeline event catalogue.

### Execution re-arm of a stuck step (RUFU-308)

`task:execution-rearmed` records that a failed `step-execute` node was granted re-entry at the same node without a lifecycle move — the row is the only durable proof the re-entry happened, because an execution re-arm deliberately writes no lane change. It is emitted through the FN-9175 bounded best-effort seam (agent id from the engine run context, falling back to `executor`, with a synthetic `execution-rearm:<taskId>` run id) and records only `taskId`, `nodeId`, fixed `reason` from the closed set `step-failed` / `self-healing-stranded-recovery` / `self-healing-session-recovery` / `self-healing-worktree-reclaim` / `unclassified`, `attempt`, `attemptLimit`, fixed `evidence: "occupied"`, and fixed `outcome: "rearmed"`. `evidence` can only ever read `occupied` because that is the sole verdict that grants the action; the per-checkout verdict list (`repo=empty` etc.) stays on the task-log sentence and never enters run-audit, which holds no path, diff, or error text. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:execution-rearm-exhausted` records the one terminal park that ends a bounded re-arm episode: the card is left in its current lane with `EXECUTION_REARM_EXHAUSTED:` and one operator notice. It records only `taskId`, `nodeId` (`"unknown"` when the graph recorded none), fixed `reason` (`no-progress` when re-arms produced no step progress, `no-evidence` when recovery passes kept finding no worktree evidence to preserve), `attempt`, `refusal`, `attemptLimit`, `refusalLimit`, `column` (the lane the card stays in), and fixed `outcome: "exhausted"`. The park is sticky, so a card that keeps being polled after exhaustion writes no further row and no further notice; the notice dedupe is `logEntryOnce`, not an in-process set. Exhaustion detail sentences, error text, and worktree paths are excluded. It is intentionally outside the curated delivery-pipeline event catalogue.

### Assignee transfer teardown and heartbeat wake dedup

`task:assignee-transfer-abort` records one bounded row per ownership-transfer teardown decision (RUFU-260). It fires whenever a card with a previous owner is re-assigned or un-assigned, so the row documents what the engine did about the previous owner's live execution session rather than merely that ownership moved. The row targets the task id and sets `agentId` to the **previous** owner with a synthetic run id, so operator support can answer "why did this agent's session die mid-card?" by querying either the card or the agent. Metadata is IDs and fixed outcomes only: `outcome` (the fixed enum `aborted` — the previous owner had a live surface and it was torn down with `abortSource = abort-in-flight:assignee-transfer`; `column-binding-deferred` — the live session is staffed by a column-agent principal equal to the previous owner, so the column binding governs and the existing watcher keeps the session; `no-live-surface` — the card had no in-flight session or child process to dispose), `previousOwnerId`, `newOwnerId` (`null` for an un-assignment), and `reviewLaneSessionPreserved` — true only when the card sat in a review lane and a live prompt-lane (workflow-step) session was deliberately left running instead of aborted, because an assignee change must not destroy the review gate's own session (an interrupted review emits no verdict and wedges that required pre-merge gate for operator bypass). A deferred or no-live-surface teardown records the same row: it is a completed outcome, not a failure. Assignee display names, task titles, prompts, session or worktree content, worktree paths, and error prose are never recorded; the greppable abort reason lives in the abort provenance, not in metadata. The write uses the FN-9175 bounded best-effort seam, so an absent, throwing, or hanging audit sink can never delay or fail the teardown nor hold the per-task disposal barrier that the new owner's heartbeat wake awaits. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:heartbeat-wake-deduped` records a heartbeat wake that found a run already in flight for the same `(agent, goal)` pair and returned that run's identity instead of starting a second concurrent session on the same goal (RUFU-260). Metadata is IDs and a fixed outcome only: `outcome: "deduped"`, `taskId` (the goal the wake was asked to work), and `runId` — the pre-existing in-flight run whose identity the caller received. Target is the task id and `agentId` is the waking agent. The goal's text, prompt content, agent names, and run output are never recorded. The audit sink is the `TaskStore` (the `AgentStore` has no audit surface) and the bounded seam absorbs an absent sink as `absent`, which is never a failure of the wake; a dedup decision is recorded without ending, moving, or re-claiming the run that is already in flight. It is intentionally outside the curated delivery-pipeline event catalogue.

### Plan Review replan session budget

`task:plan-replan-session-failure-budget` records one accounting decision inside a live Plan Review `REVISE` episode — the window where the graph has already granted a spec-revision replan and the planner session is expected to rewrite `PROMPT.md`. RUFU-251 added it because a planner session that ended without producing a specification update consumed none of the Plan Review replan budget: it rebound through the filesystem-twin recovery counter only, and a card could loop plan → Plan Review → replan indefinitely while each turn consumed zero budget. Metadata is IDs, counts, and fixed outcomes only: `taskId`, `revisionKey` (the Plan Review revision key, `plan-review`), `attempt` (the turn this decision lands on, including the turn being decided), `cap` (the same ceiling the graph's remediation seam enforces, derived from the Plan Review workflow/node budget, `planReviewReplanCap`, and the shared absolute revision cap — never a second ledger), `remaining`, and fixed `outcome`:

- `consumed` — the session failure was charged to the shared revision-keyed ledger, so the card stays inside the bounded replan loop.
- `exhausted` — the turn was refused; the card is parked through the existing `plan-review-replan-cap` operator surface and no further planner session is dispatched.
- `spec-complete-recycled` — the planner session ended with the specification already complete and valid, so the card is released back to the Plan Review gate instead of consuming a turn. No marker is written for this shape, because the marker grammar is also the counter grammar.

The emitted row never contains prompt text, reviewer feedback, validation diagnostics, error text, or paths. A charged turn is additionally recorded as a `Workflow revision key: plan-review` task-log marker — the same ledger shape the graph's remediation seam appends — which is what makes the two accounting paths agree without a second persisted field. `SPEC_STALENESS_RECOVERY_EXHAUSTED:` is the operator-visible park sentence for the sibling bound RUFU-251 added (the scheduler's spec-staleness rebound now shares the planning recovery budget instead of writing unbounded `needs-replan` states); it is a task error prefix, not an event type. Both events are intentionally outside the curated delivery-pipeline event catalogue.

### Task branch base resolution

<!--
FNXC:TaskBaseResolution 2026-09-16-03:55:
RUFU-245 anchors every fresh task branch to the LOCAL integration ref (the local default branch)
and records the acquisition decision on the existing FN-9164 event. Divergence is proven from
already-available refs only — the resolver never fetches/pulls/merges, because reconciling a
diverged local default is an operator decision. The refusal sentence carries the branch names for
the operator, so the run-audit row must stay ids/outcomes-only and never echo them.
-->
`worktree:workspace-repo-base-branch` is the single base-resolution event (FN-9164). RUFU-245 added the acquisition-decision row: the worktree-acquisition gate emits exactly one row per fresh create with `stage: "acquire"` and `source: "local-integration"`, before any branch creation. `repoRelPath` is optional and present only for workspace per-repo resolutions; single-repo resolutions omit it. The `outcome` enum is `resolved-local-base` (branch anchored to the local integration SHA), `refused-diverged` (local and remote-tracking integration refs are proven to have diverged, acquisition refused), `skipped-remote-unresolvable` (the remote side could not be read, so acquisition proceeds fail-open), and `skipped-remote-rebase-disabled` (`worktreeRebaseBeforeMerge === false`, no remote participates). Metadata stays ids/counts/fixed enums only — `taskId`, optional `repoRelPath`, `stage`, `source`, `outcome`, optional `fallbackReason` — and branch/ref names and SHAs never enter metadata or `target`. The emit uses the existing bounded best-effort seam and is intentionally outside the curated delivery-pipeline event catalogue.

`TASK_BASE_DIVERGED:` is the operator-visible refusal sentence for proven divergence, not a new event type. It means the local integration ref (e.g. `main`) and its remote-tracking counterpart (e.g. `origin/main`) each carry commits the other lacks — proven with `git merge-base --is-ancestor` against already-fetched refs, never a fresh fetch. Remedy: the operator pulls (or pushes) the local default branch to reconcile it with the remote, then retries the card. All four acquisition entry points — the executor (`run-implementation`), the durable-agent heartbeat, the merger, and the workflow graph-node custom-node entry — surface the identical refusal and park the task `failed` with it; none of them consumes the branch-conflict `recoveryRetryCount` budget, emits the acquisition-exhaustion message, or calls `onTaskAcquisitionExhausted`, because divergence is a human reconciliation decision, not a retryable branch conflict. Ahead-only, behind-only, and aligned repos are never refused: a strictly-behind linear remote still receives the FN-8839 post-create linear rebase; only a rebase target proven to have diverged is skipped (the fresh branch keeps its local base).

<!--
FNXC:WorkspaceRootMember 2026-09-28-08:41 (RUFU-390): documents the reuse event emitted when a
configured workspace member resolves to the workspace root repository.
-->
`worktree:workspace-root-member-reused` records one workspace acquisition in which the configured member directory resolved to the workspace root repository (git walked up from `<root>/<member>` to `<root>`), so the member entry was repointed at the registered worktree that already holds the task branch instead of creating a second worktree of the same repository and branch. Metadata is ids and a fixed outcome only (`taskId`, `repoRelPath`, `outcome`); the reused path and branch name live on the task row and the task log, never in this row. The emit uses the FN-9175 bounded seam, so telemetry cannot alter or delay the acquisition.

### Cross-project handoff

<!--
FNXC:CrossProjectHandoff 2026-09-09-11:37:
RUFU-203 transfer audit pair. The success event distinguishes `created` from `deduplicated` so a
retried transfer that correctly reused its deterministic claim is visible as a no-op, not a second
handoff; the failure event's fixed reason enum is the only representation of the refusal — error
prose (which can embed project paths or store messages) never enters run-audit.
-->
`task:cross-project-handoff` records a completed cross-project transfer (copy-with-cross-reference) from the source project's store, and `task:cross-project-handoff-failed` records a refused or failed attempt. Metadata is ids/counts/fixed outcomes only: `sourceProjectId`, `sourceTaskId`, `targetProjectId`, `targetTaskId` (when a target card exists or was reused), `outcome` (`created` / `deduplicated` on success, `failed` on failure), `attachmentCount` and `skippedAttachmentCount` on success, and a fixed `reason` enum on failure (`target-unresolvable`, `attachment-copy-failed`, `store-write-failed`). Neither event records titles, descriptions, attachment names, or error text. Both use the FN-9175 bounded best-effort seam so a hostile telemetry sink cannot alter or delay the transfer response, and they are intentionally outside the curated delivery-pipeline event catalogue.

`task:reconcile-absent-branch-landed` records an ownership-trailer-proven review card finalized after its branch was cleaned up. `task:reconcile-absent-branch-unproven` records a skipped absent-branch candidate. Metadata is IDs and fixed outcomes only: task id, source (`self-healing` or `manual`), branch/base branch identifiers, merge SHA/strategy or fixed reason, and ownership-proof classification; it never contains commit subjects, diffs, or reviewer text. Both emissions use the FN-9175 bounded best-effort engine seam, so hostile sinks cannot alter reconciliation. The unproven event is deduplicated per manager only after its audit write records successfully, allowing a failed audit write to be retried.

### Compaction honesty event

`task:compaction-no-progress` records a context compaction that pi ran to completion (it returned a summary and appended the CompactionEntry) but deterministically did not shrink the context (tokens-after >= tokens-before), so the executor must not treat it as reclaimed headroom. Both executor lanes that consume `compactSessionContext` emit it — the loop-detected compact-and-resume recovery and the token-cap callback — distinguished only by their `source` (`loop-recovery` / `token-cap`). Metadata is ids/counts/fixed enums only: `source`, `tokensBefore`, `tokensAfter`, and `basis` (`pi-reported` when pi supplied the after-count, `pure-estimate` when it was recomputed with pi's per-message estimator). No summary text, prompt content, or error prose is ever recorded. Both lanes emit through the FN-9175 bounded best-effort seam so a hostile telemetry sink can neither block the refusal nor change the recovery decision, and the event is intentionally outside the curated delivery-pipeline event catalogue.

### Chat session handoff

<!--
FNXC:ChatHandoff 2026-09-10-01:13:
RUFU-199 Direct-chat handoff audit pair, catalogued here because `docs/run-audit.md` is the audit
reference a query starts from. The success event covers BOTH the briefed and the degraded primer —
honest degradation still creates the handoff — so `degraded-created` is a success outcome, not a
failure. The failure event fires before any rows are written (a refusal) or after the archival
compensation (child discarded, source left active), which is why `outcome` and `refusalCode` are
separate keys rather than one merged code.
-->
`chat:handoff-session-created` records a Direct-chat handoff that completed (the source was archived and a continuation session was created), and `chat:handoff-session-failed` records a refused handoff (before any rows are written) or the archival-failure compensation (the half-built child is discarded and the source stays active). A created row is filed under the continuation the operator now types into (`chat:<childSessionId>`); a failed row is filed under the source they clicked (`chat:<sourceSessionId>`), because that is the session whose action failed. Metadata is ids/counts/fixed enums only: `fromSessionId`, `toSessionId` on success, `outcome` (`created` / `degraded-created` on success, `refused` / `archival-failed` on failure; `summarizer-failed` is declared in the contract but unreachable in v1, since a briefing failure degrades rather than refuses), a fixed `refusalCode` (`not-found`, `disabled`, `room-unsupported`, `cli-backed-unsupported`, `task-planner-unsupported`, `source-not-active`, `generation-in-progress`, `unknown-model`, `archival-failed`), plus `messageCount` and `summaryChars` where measured. Neither event records the conversation transcript, the generated briefing text, or a refusal sentence — those live on the primer message row and the HTTP error respectively. Both emit through the FN-9175 bounded best-effort seam (`emitBoundedRunAudit`, `agentId: "chat-handoff"`) so telemetry can never decide whether a handoff lands, and they are intentionally outside the curated delivery-pipeline event catalogue.

### Stale in-flight chat generation recovery

<!--
FNXC:ChatInterruptedRecovery 2026-09-22-00:55:
Catalogued here because `docs/run-audit.md` is the audit reference a query starts from, and this pair
was undocumented until RUFU-256: the sweep landed in RUFU-144 and gained materialize + auto-continue
later, but its audit rows were never written down. Two facts are easy to get wrong when querying. The
row is filed once per sweep PASS under the literal `chat-sessions` target, not per `chat:<sessionId>`,
so the affected ids ride in metadata and are capped at 20. And `materializedCount` counts rows actually
persisted, so it is legitimately below `count` when an interrupted row could not be written even though
its stale flag was cleared. The restart auto-continue is deliberately NOT an audit event — its input is
transcript content, which is never audit metadata — so a query must not go looking for one.
-->
`chat:stale-in-flight-generation-cleared` records a pass of the `reconcile-stale-in-flight-chat-generations` sweep (registered in both startup recovery and maintenance batch 1) that cleared at least one stale `project.chat_sessions.in_flight_generation` flag, and deduped `chat:stale-in-flight-generation-no-action` records a pass where candidates existed but none had aged past the floor. A generation is a candidate when its session is generating and its staleness reference — the snapshot's `startedAt`, falling back to the session's `updated_at` for legacy rows that predate `startedAt` — parses as a finite time and is older than the 30-minute floor; a row whose age cannot be proven is **never** cleared. Metadata is ids/counts/outcomes only: `count` (flags cleared), `sessionIds` capped at 20 (so a wide fan-out still reports the true `count` with a truncated id list), `outcome` (`cleared` / `no-action`), and `materializedCount` — the cleared checkpoints that carried evidence of work (streamed text, streamed thinking, or a completed tool call) and were therefore recovered as an `interrupted` assistant row rather than silently dropped. `materializedCount` is never greater than `count`: the flag is cleared before the row is written, so a session whose interrupted row failed to persist counts in `count` but not in `materializedCount`, and an evidence-free checkpoint is intentionally a plain clear with nothing to resume. The no-action row is emitted once per manager and re-armed by the next cleared pass, so a sustained queue of young generations produces one row instead of one per sweep. Payload text — streamed text, thinking, tool arguments, tool results — is never recorded; recovered prose lives only on the message row, where the interrupted notice, auto-expanded Thinking, and Retry render it. Each materialized session is additionally reported to a dashboard-injected handler so Chat can continue that turn exactly once, and that continuation writes no run-audit row of its own — its durable evidence is the visible `restart-recovery` user row it appends to the transcript, which is what makes an automatic turn auditable by an operator reading the thread rather than querying telemetry. Both events use the FN-9175 bounded best-effort seam (`emitBoundedRunAudit`, `agentId: "self-healing"`, `runId: "chat-in-flight-generation-reconcile"`, `domain: "database"`, `target: "chat-sessions"`), so a hostile telemetry sink can neither delay nor alter recovery, and they are intentionally outside the curated delivery-pipeline event catalogue.

### Verification resource bound events

<!--
FNXC:VerificationResourceBound 2026-09-10-13:09:
RUFU-212 audit pair, catalogued here because `docs/run-audit.md` is the audit reference a query
starts from. The engaged event fires once per verification spawn that actually ran inside the
resource envelope (a bare fallback emits nothing — the absent row is the signal that the host
could not be bounded); the sustained event marks a bounded verification that stayed running long
enough to be worth operator attention (>= 120s). Both file under agentId `verification` and domain
`sandbox`, are intentionally outside the curated delivery-pipeline event catalogue, and use the
FN-9175 bounded best-effort seam so telemetry can never alter, delay, or fail the verification.
-->
`verification:resource-bound-engaged` records that a verification-class spawn (tags `tool`, `deterministic`, or `fix-repair`) ran with the resource envelope applied, and `verification:resource-bound-sustained` records the same run reporting its duration from the lane's existing exit path once that duration reaches the sustained threshold. Metadata is ids/counts/fixed buckets only: `lane`, `rung` (`scope` / `priority`), `quotaBucket` (the applied CPU quota as a share of the whole machine: `none` / `lt-25` / `25-50` / `50-75` / `gte-75`), numeric `cpuIoWeight` and `memoryMaxMb` only when those dimensions are set, and on the sustained event `durationBucket` (`lt-2m` / `2-5m` / `5-15m` / `gte-15m`) plus the raw `durationMs`. The target is the task id when the lane carries one, else `lane:<tag>`. Neither event records the verification command line, file paths, working directories, or error text.
`task:external-block-parked` records a task entering a durable external freeze, and `task:external-block-cleared` records operator Retry publishing its exact resume continuation. Metadata is IDs and fixed classifications only: task id, origin, code, source, column, and resume node id. Raw error prose remains on `Task.externalBlock` and is never copied into run-audit metadata. Both writes use the bounded best-effort emitter and are intentionally outside the curated delivery-pipeline event catalogue.

`task:step-session-abort-contained` records an interrupted step-session repair that retains the current lifecycle lane, checkout, node, and completed step progress. Its metadata is IDs, counts, and fixed outcomes only: task id, current column, abort trigger, recovery outcome, and completed-step count; it never includes failure text or step names. The executor emits it through the bounded best-effort seam, and it is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-pre-merge-gate-rerouted` records a merge-admission or self-healing attempt to seed the earliest enabled pre-merge gate that has no result. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, `workflowStepId`, fixed `reason`, `source`, and `missingGateCount`; it excludes reviewer prose, findings, fingerprints, blocker text, and errors.

### Absent-branch landed reconciliation

`task:reconcile-absent-branch-landed` records an ownership-trailer-proven review card finalized after its branch was cleaned up or when a still-present branch has no remaining task-owned unlanded commits. `task:reconcile-absent-branch-unproven` records a skipped absent-branch candidate. Metadata is IDs and fixed outcomes only: task id, source (`self-healing` or `manual`), branch/base branch identifiers, merge SHA/strategy or fixed reason, and ownership-proof classification; it never contains commit subjects, diffs, or reviewer text. Both emissions use the FN-9175 bounded best-effort engine seam, so hostile sinks cannot alter reconciliation. The unproven event is deduplicated per manager only after its audit write records successfully, allowing a failed audit write to be retried. `fn task reconcile <id>` and the automatic self-healing absent-branch sweep both call the same `SelfHealingManager.reconcileLandedReviewTask` fence, so a manual reconcile and an automatic one can never disagree about what "landed" means.

### Operator comment delivery (RUFU-259)

Every operator-facing comment write path (task comment, steering, review-address, PR address-feedback, Planner Chat
steering, `fn task comment`, `fn task steer`) hands the body to one resolved agent through the core delivery seam,
and each attempt records exactly one row: `task:comment-delivery` for the routed and transport outcomes, or
`task:comment-delivery-unowned` when the outcome is `unrouted` (no agent on the card, its column, its workflow, or
the lane pool could be named). The split exists so "nobody was told" is a queryable class of its own rather than a
value buried inside the general stream.

Metadata is ids/counts/fixed enums only: `source` (which surface accepted the comment), `kind`
(`comment` | `steering`), `commentId`, `via` (`assignee` | `column-binding` | `workflow-binding` | `triage-pool` |
`executor-pool` | `none`), `outcome` (`delivered` | `already-delivered` | `unrouted` | `no-message-store` |
`send-failed`), `unroutedReason` (`pool-empty` | `pool-ambiguous`, or `none`), the `skippedRungs` walk record,
`poolSize`, and `messageStoreAvailable`; a successful write adds `messageId` and a failed hand-off adds
`noticeDelivered`. The comment text, the rendered inbox body, and any error message are never recorded. `agentId`
and `runId` are the fixed synthetic `task-comment-delivery` identity, with `runId` =
`task-comment-delivery:<taskId>:<commentId>` so all rows for one comment group by that comment.

Emission goes through the core bounded seam (`emitBoundedRunAudit`), so an absent, throwing, or hanging audit sink
cannot fail a comment, delay the operator's response, or change the delivery outcome; the durable
`sendMessageOnce` inbox write is the only guarantee the seam makes. The undelivered cases additionally notify the
operator on the mailbox (deduped per comment) and log a non-delivery entry on the card, because a stored comment
that nobody was given is an outcome the operator has to be able to see without querying the audit store.

### Merge-boundary evidence recovery (FN-9345)

Missing implementation proof is normally repaired through the workflow's durable task log and graph remediation path before merge admission. On startup and periodic maintenance, `task:merge-boundary-evidence-recovered` records a historic proofless park only after durable unfinished work, lifecycle ownership, liveness, and auto-merge policy are re-verified. These repairs intentionally do not put boundary reason prose, foreach identities, paths, review output, or external capability diagnostics in run-audit metadata. If recovery cannot prove an executable owner, the existing terminal `task:merge-boundary-unproven-parked` event remains the fail-closed audit surface and retains its ids/counts/fixed-outcomes-only contract.

### The stall park that owned the verdict it was waiting for (RUFU-391)

`task:review-no-verdict-park-repaired` is written once per pass that re-seeds a required pre-merge gate whose latest row has no authored verdict and then lifts the in-review stall-deadlock park around that same card. Metadata is `taskId`, `workflowStepId`, fixed `source` (`self-healing`) and `outcome` (`cleared`/`signature-drift`) only — no findings, verdicts, blocker sentences, or error text.

`outcome:"cleared"` means the park's pause marker, park error, `status` and `error` were all dropped in one `updateTaskAtomic` write whose guard re-derived the SAME signature that admitted the seed: the deadlock pause reason, the park's own error prefix still on the row, no `userPaused`, and a required gate still verdict-less. Anything else is `signature-drift` and writes no field, so a card that changed shape underneath the recovery keeps its terminal evidence for an operator. If the re-run fails to converge again, the stall detector parks it again with fresh evidence — this event records one attempt, not a disarm.

### The stall park that froze a card applying review corrections (RUFU-280)

A Code Review `REVISE` with named remediation steps refuses the merge door for exactly as long as the remediation takes, and the refusal sentence does not change while the executor works through the wave — the shape the in-review stall deadlock ladder reads as a frozen card. Past the threshold it parked healthy cards `failed` with "stuck in the review lane with no executor or merger owning it", the one sentence an operator acts on to intervene in work that was running normally. The ladder now defers that terminal action while the state holds: `task:review-stall-surfaced` and `task:review-stall-observed` are unchanged, so the wait stays visible and countable, it simply is not treated as a deadlock. This event records the repair pass that un-parks the cards the earlier build already froze.

`task:merge-review-revision-park-cleared` is written once per card whose mis-parked stall deadlock is cleared in place (`status`, `error`, and the pause marker dropped, and the merge retry budget reset to what a lane that never judged this content had asked for; no column move, no progress loss). The sweep `reconcile-review-revision-stall-parks` runs at startup and in maintenance batch 1, immediately after `reconcile-orphaned-non-convergence-holds`. Admission requires the engine's own deadlock signature — the `in-review-stall-deadlock` pause marker plus that build's exact park sentence — and a live re-read under the shared task advisory lock that still finds the card awaiting revision. A card whose remediation has since finished keeps its park: that is a different fault with its own recovery owner, and an operator pause is never lifted here. Admission is the sibling repairs' full consent-and-liveness gate rather than a pause-and-signature subset: the pass resolves settings and returns without reading the board under a global or engine pause, refuses any card `allowsAutoMergeProcessing` rejects (project auto-merge Off with no per-task `autoMerge: true` opt-in, or a manual open PR), and stands down while an executor lock, a live session path, a durable agent's active run, or the merge queue owns the card — the facts a synchronous callback can see are re-checked inside the guarded write, so a consent flip during the pass cannot be stepped on. A withheld card emits no row of its own: the clear never happened, so there is nothing to record, and the pass reports the withheld count in its log line instead.

Metadata is `taskId`, `workflowStepId` (the gate whose authored `REVISE` the card is answering), fixed `source` (`self-healing`) and `outcome` only — no findings, verdicts, blocker sentences, or error text.

### Publishing a landing the completion gate would not acknowledge (RUFU-346)

Required post-merge evidence can block completion after the merge is already durable. Before this change the post-merge publish was a step that ran strictly *after* finalization, so every blocked or deferred arm returned or threw before it: the local integration ref had advanced, `origin` was never offered the landing, and the hosted gate that the card is waiting on cannot report against a ref the remote does not have. The wait was self-blocking — the missing evidence could never arrive because the publish that would let it arrive was gated behind the evidence.

The publish now runs inside finalization, before the refusal. Both events are written by the merger lane (`agentId: "merger"`, `runId: merge-<taskId>`, `target: <taskId>`, `domain: "git"`):

- `task:merge-publish-before-finalize` — the push step was reached. Metadata is `taskId`, `outcome` (`pushed`, or `not-pushed` when the push step ran and did not advance the remote ref) and `landingProof` (`lane` when the lane proved the landing in-process, `recorded` when only the durable `mergeDetails` record proved it). The transport detail stays on the `push:origin` row the push itself still writes; this row only explains why a push exists on a card that never completed.
- `task:merge-publish-before-finalize-unavailable` — a candidate existed and something stopped the push before it ran, which is the half that answers "why is landed work not on the remote?". Metadata is `taskId`, `hold` (fixed vocabulary: `policy-disabled`, `global-pause`, `task-paused`, `auto-merge-off`, `destination-changed`, `landing-proof-unproven`, `task-unavailable`, `authorization-unavailable`, `merge-aborted`, `push-failed`), `landingProof`, `landingProven`, and `reachedPush` (was the push step entered before the hold took effect). `push-failed` is the defensive member: a publish that *raised* inside the push step. A push that reports its own failure without raising records `outcome: not-pushed` on the published row instead, because the push did run.
- RUFU-396: `task:already-merged-never-delivered` records the self-healing reclaim sweep proving that a card whose branch tip was already merged never delivered **its own** work, so the stale worktree/branch/base metadata is reclaimed instead of the card being refused as a foreign-tip misbinding. The event exists because the refusal it replaces was terminal: the base can mention a card's id from commits that card never authored (a squash merge re-stamping another lineage's landed commit), and each such refusal burned one unit of the bounded branch-conflict budget until the card parked `branch-conflict-recovery-exhausted` with its work still to do. Metadata is ids/counts/fixed outcomes only (`taskId`, `branchTip`, `baseBranch`, `stampedBaseCommitCount`, `ownLandedCommitCount`, `declaredScopePathCount`, `outcome` from `reclaimed`/`metadata-clear-refused`); declared scope paths, commit subjects, touched paths, findings, and refusal sentences never enter the row. It is deliberately outside the curated delivery-pipeline catalogue, documents as prose here, and is emitted through the FN-9175 bounded seam, so telemetry cannot change the reclaim outcome. The rescue fires only on a **proven** absence: an undeclared scope, an unreadable commit, or an approved content review for that card leaves the previous verdict in place and emits nothing.

Neither row carries a remote URL, ref tip, error message, finding, or spec sentence; a failed push keeps its detail in the engine log and its own `push:origin` row. Emission is the bounded seam (FN-9175), so telemetry can never replace the blocked-finalization refusal the caller has to see. A pass that COMPLETED publishes too but records neither row here — the card is done and `push:origin` is its record — and a pass that was never blocked on required evidence emits nothing at all.

These two events are deliberately **not** in the curated delivery-pipeline event catalogue. That catalogue is the lifecycle record of a card moving through delivery and `run-audit-catalogue.test.ts` locks it table-for-table against the `## Delivery-pipeline finalization` section above; this pair records a git-transport decision taken on a card that never reached the completion leg, alongside the other prose-documented exceptions (`task:external-block-parked`, the chat-lane compaction pair, the worktree-base decision rows). Do not add rows for them to that table.

### Long-term memory budget maintenance (RUFU-279)

`memory:long-term-over-budget` records a long-term `MEMORY.md` (project scope, or one durable agent's
own memory) that exceeds the code-owned byte budget; `memory:long-term-consolidated` records a rewrite
that actually landed; `memory:long-term-consolidation-failed` records a maintenance pass that refused
to write. Over-budget findings are rate-limited per file by a size/entry-count signature plus a 6-hour
cooldown, so a card that stays in the same condition reports once per window instead of once per
15-minute maintenance batch. A sweep with no breach and no failure writes no row at all.

Metadata is ids/counts/fixed enums only: `scope` (`project`/`agent`) with `agentId` when scoped to an
agent, measured `bytes`, `budgetBytes`, `overByBytes`, `entryCount`, booleans `duplicatesFound`,
`conflictsFound`, `tooLarge`, `overBudget`, `stillOverBudget`, counts `duplicateSectionsCollapsed` and
`conflictsRetained`, and the fixed `stage` enum
`read`/`too-large`/`backup`/`backup-scope`/`concurrent-write`/`write`/`verify`. Because the rewrite is
backup-first and loss-free, a `consolidated` row is also proof that a memory backup covering that file
was created in the same pass; `bytesBefore`/`bytesAfter` and `entryCountBefore`/`entryCountAfter` name
both sides of the change, and `stillOverBudget` stays true when collapsing duplicates could not bring
the file under the bound. Entry headings, entry text, diff text, file paths, and error messages are
never recorded — the durable memory content is precisely what an operator would have to redact.

The three events are deliberately absent from the curated `run-audit-catalogue.ts` delivery-pipeline
list: that catalogue is locked table-for-table against the delivery surface, and these rows are
background maintenance telemetry with no delivery pipeline to describe.
`packages/engine/src/__tests__/memory-long-term-audit-contract.test.ts` pins the declaration, the
documentation, and that exclusion together.
