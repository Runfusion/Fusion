/*
FNXC:PostMergeRecovery 2026-10-01-09:01 (upstream FN-9442 adopted, RUFU-306 / RUFU-370 / RUFU-430 layered on top):
Two implementations of one recovery existed after the upstream sync — ours (`reseedUnrunPostMergeGate`,
RUFU-306) and upstream's `resumeMissingPostMergeGate` (FN-9442) — under one filename. Upstream's is now the
single mechanism, because it owns two guards ours did not have: a fresh durable checkout lease is live
ownership even with no in-process session, and the seed is fenced on `expectedWorkflowSelection` plus
`expectedTaskUpdatedAt` so a card whose selection moved keeps its park instead of being seeded from an
unrelated workflow. What our seam had and their version lacked is kept as extensions here rather than as a
second function:
  - a bounded per-(task, gate) attempt budget, because their version resumes again on every pass and a gate
    that dies the same way each time burns model budget forever;
  - a refusal REASON on every non-resumable arm, so "why was this card not resumed" is answerable from the
    caller's notice instead of collapsing into one opaque boolean;
  - the per-project evidence contract (RUFU-430), so a board with no CI reporter is never told to go produce
    CI evidence and a board that declares the demand is never exempted;
  - the workspace-card refusal, because seeding a post-merge reviewer onto a lane whose repos are already
    cleaned makes the reviewer re-acquire against a moved base and burn the rerun budget (the SANE-507 loop);
  - `paused` cards whose only hold is the engine's own in-review stall deadlock stay resumable (RUFU-391):
    the classifier exempts paused cards, so refusing them here could never lift.
*/
/*
FNXC:PostMergeRecovery 2026-10-05-09:31 (origin/main FN-9502 adopted on top of the fork's contract seam):
This sync brings in upstream's second FN-9442 follow-up, which retried the same file. Nothing upstream added
is dropped, and nothing the fork layered on is dropped either:
  - ADOPTED verbatim: `EXHAUSTED_PREFIX`, `hasLegacyRecoveryFailure`, `isRejectedGateRecheckDue` (the
    15/30/60-then-hourly revisit of rejected evidence), and the exported `isPostMergeGateRecoveryDue` that
    puts them together. Upstream's fenced clear of the legacy `Post-merge verification needs remediation`
    park is adopted too, fence and checkout-lease preconditions included, because that park was written by
    an older build in the field and nothing else lifts it.
  - KEPT: the one `(store, task, { source, contract })` seam with the named refusal taxonomy. It is not a
    cosmetic preference — every production caller in the merged tree hands a card projection plus the
    per-project contract (`auto-merge-finalization.ts`, four `self-healing.ts` sites), and the finalizer's
    operator notice reads `reason` through `isTerminalPostMergeReseedRefusal`. Upstream's
    `{outcome:"resumed"} | {outcome:"not-resumable"}` is strictly less informative than `outcome` + `reason`
    (`resumed` ≡ `outcome:"seeded"`, `not-resumable` ≡ `outcome:"not-seeded"` plus the reason that names the
    operator action), so mapping their arms onto ours loses no answer.
  - NOT re-added: upstream's `exhausted` arm and `hasExhaustedRechecks` helper. They exist only in the merge
    base; FN-9502 deleted both from `origin/main` and replaced the terminal exhaustion park with the legacy
    clear plus the hourly revisit. The ≥3-failed-attempts count survives there as the schedule's clamp.
  - The two arms this seam can take are each bounded by the mechanism its own requirement names: the MISSING
    arm by the fork's durable per-(task, gate) budget, the REJECTED-EVIDENCE arm by upstream's schedule. The
    budget counts only the missing arm's own log marker, so it cannot strand CI evidence that lands after
    the early retries — which is the failure upstream's comment forbids.
*/
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  allowsAutoMergeProcessing,
  computeWorkflowIrPin,
  getPostMergeEvidenceGateStatuses,
  getPostMergeFinalizeBlocker,
  getRequiredPostMergeEvidenceDecision,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  isWorkspaceTask,
  resolveWorkflowIrForTaskWithProvenance,
  type PostMergeEvidenceContract,
  type Task,
  type TaskStore,
  type WorkflowStepResult,
} from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
// FN-9175: engine-lane emitters use the engine seam, which absorbs an absent, throwing, or hanging sink.
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { createMergeWriteFence, type MergeWriteFence } from "./merge-write-fence.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";

/*
FNXC:PostMergeRecovery 2026-10-05-09:31:
`RequiredPostMergeEvidenceDecision` is derived from the reader rather than imported. The fork's earlier
sync resolved `@fusion/core`'s barrel to our line and dropped upstream's separate
`export type { RequiredPostMergeEvidenceDecision }` statement, so the NAME is not exported from
`index.ts` even though the shape is reachable through `getRequiredPostMergeEvidenceDecision`. Deriving it
keeps upstream's exported helper signature intact without widening this file's scope into core's barrel.
*/
type RequiredPostMergeEvidenceDecision = Awaited<ReturnType<typeof getRequiredPostMergeEvidenceDecision>>;

/*
FNXC:UnrunPostMergeGateRecovery 2026-09-28-07:34 (RUFU-370):
RUFU-306 bounded the SEED, and the bound holds — but the caller had no way to tell a refusal that will
become a seed later from a refusal that can never produce evidence, so production kept deferring on
seconds-spaced passes: `[post-merge gate reseed: workspace]` for SANE-452 and
`[post-merge gate reseed: active-continuation]` for STAS-288, both forever. These are the refusals where
retrying the same seam is provably useless: a workspace card is refused by this seam by construction, a
workflow with no such node cannot seed it, and the seed budget is already spent. `active-continuation`,
`operator-held` and `workflow-selection-changed` stay NON-terminal here — each names a condition that
can genuinely clear on a later pass, and those cards must keep the transient-defer behaviour.
*/
export const MAX_POST_MERGE_GATE_RESEED_ATTEMPTS = 3;

export type PostMergeGateReseedReason =
  | "seeded"
  | "no-merge-proof"
  | "no-missing-gate"
  | "no-post-merge-node"
  | "workspace"
  | "operator-held"
  | "engine-paused"
  | "finalize-blocked"
  | "checkout-lease"
  | "execution-live"
  | "gate-not-resumable"
  | "selection-drift"
  | "rerun-budget-exhausted"
  | "active-continuation"
  | "task-state-changed"
  | "unsupported-store"
  | "durable-read-unavailable";

export interface PostMergeGateReseedResult {
  /** `seeded` means a new idle continuation was installed; nothing else claims a verdict. */
  outcome: "seeded" | "not-seeded";
  /** Why the seam did or did not seed. Never a sentence, never a verdict. */
  reason: PostMergeGateReseedReason;
  /** The gate this pass targeted, when the gate itself was identifiable. */
  workflowStepId?: string;
  /** Seeds already recorded for this (task, gate) BEFORE this attempt; 0 when unmeasured. */
  priorAttemptCount?: number;
}

const TERMINAL_POST_MERGE_RESEED_REFUSALS = new Set<PostMergeGateReseedReason>([
  "workspace",
  "no-post-merge-node",
  "rerun-budget-exhausted",
  "unsupported-store",
]);

/** True when no future pass through this seam can produce the missing post-merge evidence row. */
export function isTerminalPostMergeReseedRefusal(reason: PostMergeGateReseedReason): boolean {
  return TERMINAL_POST_MERGE_RESEED_REFUSALS.has(reason);
}

/*
FNXC:PostMergeReseedBudget 2026-10-03-08:13 (RUFU-502 review, finding F2):
The durable budget read fails closed on purpose, but a thrown read must not cancel a recovery BATCH. Four
of the five callers awaited this seam bare: the two self-healing passes were guarded only by a try around
their whole for-loop whose catch logs and returns 0, so ONE card whose durable row throws (`TaskNotFoundError`
is the real missing-row shape that loop itself expects) cancelled every later card in the batch and reported
a result indistinguishable from "nothing to recover", with no card row and no run-audit.

The seam therefore never throws: an unreadable budget becomes the NAMED refusal `durable-read-unavailable`
and the pass moves on to the next card. The fail-closed decision is unchanged — no proof of the budget means
no seed — only its delivery is. This is also why the reason is not swallowed into a boolean: callers own
reporting it, and `isTerminalPostMergeReseedRefusal` plus the lane log lines are where an operator sees it.
*/
export async function resumeMissingPostMergeGate(
  store: TaskStore,
  task: Task,
  options: Parameters<typeof runPostMergeGateResume>[2],
): Promise<PostMergeGateReseedResult> {
  try {
    return await runPostMergeGateResume(store, task, options);
  } catch {
    return { outcome: "not-seeded", reason: "durable-read-unavailable" };
  }
}

/** Counts persisted resume markers for one gate, hydrating the log when the row came slimmed. */

/*
FNXC:UnrunPostMergeGateRecovery 2026-10-01-09:01:
The budget is read from durable task-log lines, not memory, because the lanes that resume are separate
processes on separate timers. Upstream's success sentence is counted alongside our own marker so the
rename does not reset the budget for cards that already hold seeds from the earlier build.
*/
/**
 * The durable marker this seam writes on a successful resume. Exported because the budget is READ from the
 * task log, so anything that seeds a card by hand (a test, an operator repair) must write this exact shape
 * or it will not be counted — and a resume that is not counted is a resume without a bound.
 */
export function postMergeGateReseedLogMarker(gateId: string): string {
  return `[post-merge] Resuming missing verification at '${gateId}'`;
}

/** Our pre-sync sentence, still counted so a card seeded by the earlier build does not get a fresh budget. */
const LEGACY_RESEED_LOG_MARKER = "[post-merge-gate-reseed] gate";

/*
FNXC:PostMergeReseedBudget 2026-10-03-07:12 (RUFU-502):
The budget counts from the DURABLE row, never from the `task` projection the caller handed us. An empty
log is a PROJECTION, not an absence: `listTasks({ slim: true })`, the modified-since prelude and search
all answer `log: []` for a card whose durable log still holds every marker, so the original
`Array.isArray(task.log) ? task.log : hydrate` arm was dead code — the array test passed, the store arm
never ran, and the counter read zero attempts forever. Measured provenance of the two lanes that feed
slim rows: `self-healing.ts:3827` (card from `stuckById`, built by `listTasks({ slim: true })`) and
`self-healing.ts:3968` (card straight from `listTasks({ slim: true })`). The three hydrated callers
(`auto-merge-finalization.ts:423`, `self-healing.ts:4256`, `self-healing.ts:17488`) already worked, which
is why the bound looked live from the finalize lane while the recovery lanes deferred without limit.
Same defect, same shape as RUFU-452's fix on the pre-merge counter.

A REJECTED read is fail-closed: the error propagates instead of being swallowed to zero attempts, so an
unreadable durable row seeds nothing — a lane whose whole failure mode is re-seeding on false evidence of
a fresh budget must not treat a flaky read as a fresh budget. A `null` row (fake/legacy store shape)
remains decision-neutral and counts zero, exactly like the pre-fix `?.log ?? []` arm; the real store's
missing-row shape is a `TaskNotFoundError` throw and takes the rejection path.

The bound is the retained window, stated rather than assumed: the activity log keeps only its most recent
1,000 entries (`logEntryImpl` splices the front on append), so a card churning past that after its
markers can earn one further re-seed. That is bounded degradation of a ceiling, not the unbounded loop
this read replaces. `store.getTask` is safe off-lock here: it takes the non-reentrant per-task advisory
lock and no stack that reaches this seam holds it — `withTaskLock` call sites are triage, agent-tools and
`moves.ts`, none of which call `resumeMissingPostMergeGate`.
*/
async function countReseedAttempts(store: TaskStore, task: Task, gateId: string): Promise<number> {
  // No `.catch`: a rejected read must not be mistaken for "no attempts" — see the FNXC note above.
  const live = await store.getTask(task.id);
  const log = Array.isArray(live?.log) ? live.log : [];
  const quoted = `'${gateId}'`;
  return log.filter((entry) => {
    const action = typeof entry.action === "string" ? entry.action : "";
    return (action.startsWith(postMergeGateReseedLogMarker(gateId)) || action.startsWith(LEGACY_RESEED_LOG_MARKER))
      && action.includes(quoted);
  }).length;
}

const DEFAULT_CHECKOUT_LEASE_GRACE_MS = 10 * 60_000;
const CHECKOUT_LEASE_STALENESS_MULTIPLIER = 3;

/** A fresh durable checkout lease is live ownership even when this process holds no session (FN-9442). */
function hasFreshCheckoutLease(
  task: { checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null },
  settings: { taskStuckTimeoutMs?: number },
): boolean {
  const leaseAge = task.checkoutLeaseRenewedAt
    ? Date.now() - Date.parse(task.checkoutLeaseRenewedAt)
    : Number.POSITIVE_INFINITY;
  const graceMs = (settings.taskStuckTimeoutMs ?? DEFAULT_CHECKOUT_LEASE_GRACE_MS)
    * CHECKOUT_LEASE_STALENESS_MULTIPLIER;
  return !!task.checkoutRunId && Number.isFinite(leaseAge) && leaseAge >= 0 && leaseAge < graceMs;
}

const EXHAUSTED_PREFIX = "Post-merge verification needs remediation";

/**
 * A card an earlier build terminalized over repeated rejected evidence (FN-9442's own exhaustion park).
 * FN-9502 treats it as stale state to clear, not as a durable verdict: the gate result and its completion
 * timestamp, not this sentence, govern approval and retry timing.
 */
function hasLegacyRecoveryFailure(task: Pick<Task, "status" | "error">): boolean {
  return task.status === "failed" && task.error?.startsWith(`${EXHAUSTED_PREFIX}:`) === true;
}

/** Element type of the work-item read, derived the same way `RequiredPostMergeEvidenceDecision` is above. */
type GateWorkItem = Awaited<ReturnType<TaskStore["listWorkflowWorkItemsForTask"]>>[number];

/**
 * Floor below which a `running` gate continuation with no live lease is treated as abandoned work.
 * Measured 2026-10-09 on the 5 such rows that existed board-wide: 6,6 / 7,8 / 9,5 / 10,7 h since their last
 * write, every one of them on a card with no session. Two hours leaves an order of magnitude of headroom
 * over a real reviewer step and still clears the stuck state within one maintenance pass.
 */
export const STALE_RUNNING_CONTINUATION_FLOOR_MS = 2 * 60 * 60_000;

/**
 * Find the gate's own `running` continuations that no owner can reach any more.
 *
 * FNXC:PostMergeRecovery 2026-10-09-15:20 (RUFU-610):
 * A dispatcher claims a work item by writing `state='running'` plus a `leaseOwner` and, for these five rows,
 * NO `leaseExpiresAt` at all. That single NULL makes the row invisible to both of its owners: the scheduler's
 * claim predicate looks for `runnable`/`retrying`, and the idle-seed predicate that guards this seam treats
 * ANY `running` row as an active continuation. Nothing reclaims it, so the card is pinned forever — measured
 * on RUFU-290/319/323/325, whose `post-merge-verification` rows sat `running` for 6,6-10,7 h while their
 * sibling rows for the same node accumulated to 20 `failed` entries, and every `fn task reconcile` answered
 * `post-merge-continuation-not-idle`. This is the work-item-layer twin of the `in-progress` capacity-slot
 * leak the board monitor's own note names.
 *
 * The predicate is deliberately narrow, because the safety here cannot come from the write primitive: the
 * sanctioned replacement helper retires EVERY active task continuation of the card and drops the seed's
 * `expectedWorkflowSelection` / `expectedTaskUpdatedAt` fences. So instead of loosening what counts as idle
 * (which would put a second active row on `idx_workflow_work_items_one_active_task_continuation` and raise),
 * only a row that is (a) this gate's own node, (b) `running`, (c) leaseless or lease-expired, and (d) past
 * the floor is reclaimed — one row at a time, transitioned to `failed` so the merge gate stays shut. A live
 * reviewer for another node, a `held` row, or a fresh lease keeps the card exactly as stuck as it was.
 */
export function findStaleRunningGateContinuations(
  items: GateWorkItem[],
  gateId: string,
  nowMs = Date.now(),
): GateWorkItem[] {
  const activeForTask = items.filter(
    (item) => item.kind === "task" && ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state as never),
  );
  if (activeForTask.length === 0) return [];
  const blockingThisGate = activeForTask.filter((item) => item.nodeId === gateId);
  if (blockingThisGate.length === 0 || blockingThisGate.length !== activeForTask.length) return [];
  return blockingThisGate.filter((item) => {
    if (item.state !== "running") return false;
    const hasLiveLease = !!item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) > nowMs;
    if (hasLiveLease) return false;
    const wroteAt = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
    return Number.isFinite(wroteAt) && nowMs - wroteAt > STALE_RUNNING_CONTINUATION_FLOOR_MS;
  });
}

/** Distinct from `postMergeGateReseedLogMarker` on purpose: a reclaim is not an attempt and must not charge the reseed budget. */
export const STALE_CONTINUATION_RECLAIM_LOG_MARKER = "[post-merge stale continuation reclaimed]";

/*
FNXC:ReviewRecovery 2026-10-04-02:24:
Post-merge reviewers can run before hosted CI finishes. Revisit rejected evidence after 15 minutes,
then 30 and 60 minutes, with further checks capped at one per hour. CI and follow-up fixes can
arrive after the early retries; a total attempt cap would strand their evidence permanently.
Durable result history survives restart and task-log updates cannot shorten the wait. Missing
timestamps, duplicate evidence and live owners fail closed.
*/
function isRejectedGateRecheckDue(result: WorkflowStepResult): boolean {
  const failures = (result.priorAttempts ?? []).filter((entry) => entry.status === "failed").length;
  const completedAt = Date.parse(result.completedAt ?? "");
  return result.status === "failed" && Number.isFinite(completedAt)
    && Date.now() - completedAt >= 15 * 60_000 * 2 ** Math.min(failures, 2);
}

export function isPostMergeGateRecoveryDue(
  task: Pick<Task, "workflowStepResults" | "status" | "error">,
  decision: RequiredPostMergeEvidenceDecision,
): boolean {
  if (hasLegacyRecoveryFailure(task)) return true;
  if (decision.outcome === "resumable") return true;
  if (decision.outcome !== "blocked" || decision.reason !== "failed") return false;
  const result = task.workflowStepResults?.find((entry) => entry.workflowStepId === decision.gateId);
  return !!result && isRejectedGateRecheckDue(result);
}

/**
 * Put a landed card back in front of the required post-merge gate that produced no result row.
 *
 * The idle continuation fence is the only write: the card keeps its column, existing results (including
 * REVISE) stay authoritative, and no verdict is fabricated. `contract` is required — see the core seam —
 * because a derived demand must be read with the same fact the finalizer used to decide it is missing.
 */
async function runPostMergeGateResume(
  store: TaskStore,
  incomingTask: Task,
  options: {
    source: "self-healing" | "auto-merge" | "manual-reconcile";
    contract: PostMergeEvidenceContract | undefined;
    /**
     * FN-9502: an explicit landed reconciliation (Retry / `manual-reconcile`) may recheck rejected evidence
     * immediately instead of waiting out the revisit schedule. Never set by a timed recovery pass.
     */
    manualRetry?: boolean;
    /**
     * FN-9502: the owning merge body's fence. The legacy-park clear below is this seam's only task
     * mutation, so it is fence-guarded exactly as upstream guarded it; a lane that supplies no fence owns
     * the whole call externally (as `auto-merge-finalization.ts` does around this function).
     */
    fence?: MergeWriteFence;
  },
): Promise<PostMergeGateReseedResult> {
  const fence = options.fence ?? createMergeWriteFence({ taskId: incomingTask.id });
  let task = incomingTask;
  /*
  FNXC:PostMergeGateDeliveryShape 2026-09-30-13:09 (RUFU-429):
  This refusal is a backstop, not the reason workspace cards stall: the requirement itself resolves to
  `not-applicable` for a workspace-shaped absence in core, so the finalizer completes and never reaches
  this seam. The guard stays because the SANE-507 loop is a live failure mode.
  */
  if (isWorkspaceTask(task)) return { outcome: "not-seeded", reason: "workspace" };
  /*
  FNXC:PostMergeRecovery 2026-10-01-09:01 (upstream FN-9442 adopted):
  `mergeConfirmed` is the guard, matching upstream — the commitSha requirement our seam added is NOT added
  back, because every caller proves landing before asking: the finalizer runs `hasDurableMergeProof` and the
  zero-commit delivery door first, and `reconcileLandedReviewTask` proves the trailer on the base branch.
  Re-checking a SHA here would only re-litigate a fact the caller already fenced, and it silently refused
  cards whose proof is a PR number rather than a local SHA. An empty merge-shaped object still refuses.

  FNXC:UnrunPostMergeGateRecovery 2026-10-07-13:25 (RUFU-306):
  `commitSha` must never return as a proof requirement. RUFU-220 hung 41 h in review and RUFU-289 deferred
  on `[post-merge gate reseed: no-merge-proof]` precisely for the class that carries no local sha: a
  squash-merge cleanup or PR-only land writes `{ mergeConfirmed: true, mergedAt }` (sometimes with
  `noOpMerge: true`) after the branch and worktree are already gone, so a sha check asks for evidence that
  the successful landing deliberately deleted. Both sides of this key are pinned by the proof-class pair in
  `post-merge-gate-reseed.test.ts` — confirmation without a sha seeds, a bare unconfirmed sha refuses before
  any workflow read — so re-adding the condition turns those cases red instead of quietly re-wedging cards.
  */
  if (!task.mergeDetails?.mergeConfirmed) return { outcome: "not-seeded", reason: "no-merge-proof" };
  if (
    task.userPaused
    || task.deletedAt
    || (task.paused === true && task.pausedReason !== IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON)
  ) {
    return { outcome: "not-seeded", reason: "operator-held" };
  }

  const settings = await store.getSettings();
  /*
  FNXC:PostMergeCloseout 2026-10-13-07:51 (merge origin/main):
  Auto-merge authorization decides whether Fusion may LAND work, not whether the graph-owned verification
  of a landing already proven durable may run — so no per-card `autoMerge` veto is consulted here, and
  `operator-held` names pause/deletion only. Project auto-merge Off and an open manual PR stay fenced below
  through `allowsAutoMergeProcessing`, because under that setting the lane is human-owned end to end. The
  refusal taxonomy (RUFU-370) still names every withheld arm, so a withheld seeding remains observable.
  */
  if (settings.globalPause || settings.enginePaused || !allowsAutoMergeProcessing(task, settings)) {
    return { outcome: "not-seeded", reason: "engine-paused" };
  }
  if (getPostMergeFinalizeBlocker(task)) return { outcome: "not-seeded", reason: "finalize-blocked" };
  if (hasFreshCheckoutLease(task, settings)) return { outcome: "not-seeded", reason: "checkout-lease" };
  if (isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock })) {
    return { outcome: "not-seeded", reason: "execution-live" };
  }
  /*
   * Checked only once the card itself is eligible: a workspace card is refused by this seam by
   * construction, and naming the store's missing capability instead would hide the real reason (the
   * RUFU-370 refusal taxonomy exists precisely so the reported cause is the actionable one).
   */
  if (typeof store.seedWorkspaceCodeReviewContinuationIfIdle !== "function"
    || typeof store.listWorkflowWorkItemsForTask !== "function") {
    return { outcome: "not-seeded", reason: "unsupported-store" };
  }

  /*
  FNXC:ReviewRecovery 2026-10-04-02:24 (adopted from origin/main with the fork's refusal names):
  FN-9442's own exhaustion park outlived its writer. Clear ONLY that owned diagnostic — the gate result,
  its verdict, and its completion timestamp stay, because they are what `isRejectedGateRecheckDue` reads
  and what approval depends on. A concurrent operator hold, a committed Reset, a live checkout lease, live
  execution, or a queued continuation each refuse the clear and are reported as the actionable reason
  rather than collapsing into one boolean.
  */
  if (hasLegacyRecoveryFailure(task)) {
    // Old recovery marked waiting reviews failed. Clear only its owned diagnostic;
    // the gate result and completion timestamp still govern approval and retry timing.
    const snapshot = task;
    let cleared = false;
    let heldByLiveWorkItem = false;
    const updated = await fence.write("finalization", () => store.updateTaskAtomic(task.id, async (live) => {
      if (live.updatedAt !== snapshot.updatedAt || live.column !== snapshot.column
        || live.status !== snapshot.status || live.error !== snapshot.error
        || live.paused || live.userPaused || live.deletedAt
        || !live.mergeDetails?.mergeConfirmed
        || hasFreshCheckoutLease(live, settings)
        || isTaskExecutionLive(live.id, { activeSessionRegistry, executingTaskLock })) return null;
      const items = await store.listWorkflowWorkItemsForTask(task.id);
      if (items.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) {
        heldByLiveWorkItem = true;
        return null;
      }
      fence.assertOwned("finalization");
      cleared = true;
      return { status: null as unknown as Task["status"], error: null as unknown as Task["error"] };
    }, undefined, () => !fence.isOrphaned(), {
      expectedUpdatedAt: snapshot.updatedAt,
      expectedCheckedOutBy: snapshot.checkedOutBy ?? null,
      expectedCheckoutNodeId: snapshot.checkoutNodeId ?? null,
      expectedCheckoutLeaseEpoch: snapshot.checkoutLeaseEpoch ?? 0,
    }));
    if (!cleared || !updated || updated.status != null || updated.error != null) {
      // A live continuation is a different operator action from a card that moved under the fence.
      return {
        outcome: "not-seeded",
        reason: heldByLiveWorkItem ? "active-continuation" : "task-state-changed",
      };
    }
    task = updated;
  }

  // A gate that already holds a result — approved, REVISE, or failed — is authoritative; never seed over it.
  const irForGate = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
  const statuses = getPostMergeEvidenceGateStatuses(task, irForGate.ir, options.contract);

  const decision = await getRequiredPostMergeEvidenceDecision(store, task, options.contract);
  const manualRetry = options.manualRetry === true && decision.outcome === "blocked" && decision.reason === "failed";
  /*
  FNXC:PostMergeRecovery 2026-10-05-09:31:
  Two arms reach a seed and each is bounded by the mechanism its own requirement names. The MISSING arm
  (`decision.outcome === "resumable"`, i.e. this board really owes the gate and no row exists) is bounded by
  the durable per-(task, gate) budget below. The REJECTED-EVIDENCE arm (`blocked`/`failed` whose revisit is
  due, or an explicit Retry) is bounded by upstream's 15/30/60-then-hourly schedule INSTEAD of that budget,
  because hosted CI can land after the early retries and a total cap would strand its evidence permanently.
  Anything else — an approval, a pending row, a duplicate, a requirement this board cannot report
  (RUFU-429 delivery shape, RUFU-430 no-reporter) — is refused without touching the graph, and seeding over
  it would overwrite a real verdict.
  */
  if (decision.outcome === "finalizable" || (!manualRetry && !isPostMergeGateRecoveryDue(task, decision))) {
    return { outcome: "not-seeded", reason: "gate-not-resumable" };
  }
  /*
  FNXC:PostMergeRecovery 2026-10-08-01:54 (RUFU-319):
  The second admission test is per-GATE, not per-BOARD. The guard it replaces demanded that SOME gate on
  the card carry state `missing`. The MISSING arm always satisfies that, and the REJECTED-EVIDENCE arm
  never can: a card whose gate already reported a failed REVISE has that gate's row, so its status is
  `not-approved` and no `missing` entry exists anywhere on the card. The guard therefore refused the very
  arm the ladder above had just admitted as due, and FN-9502's 15/30/60-then-hourly revisit of rejected
  evidence could only ever fire through an explicit Retry. Measured on the merged tree: a 61-minute-old
  REVISE with zero prior attempts satisfied `isPostMergeGateRecoveryDue` while the seam answered
  `gate-not-resumable`, which also made `recheckRejectedEvidence` and its "Rechecking rejected evidence"
  log line unreachable. Asking the question the arm actually needs — is THIS gate's report owed, and in
  one of the two seedable states — preserves every refusal the fork layered on: a requirement this board
  cannot report (`not-applicable`, RUFU-429 delivery shape / RUFU-430 no reporter) and any non-seedable
  row state (an approval, a `pending` row, a duplicate) still refuse without touching the graph.
  */
  const owedGateStatus = statuses.find((status) => status.gateId === decision.gateId);
  const rejectedEvidenceArm = decision.outcome === "blocked" && decision.reason === "failed";
  if (!owedGateStatus || owedGateStatus.state === "not-applicable"
    || (decision.outcome !== "resumable" && !rejectedEvidenceArm)) {
    return { outcome: "not-seeded", reason: "gate-not-resumable" };
  }
  const gateId = decision.gateId;
  const recheckRejectedEvidence = decision.outcome === "blocked";

  const priorAttemptCount = await countReseedAttempts(store, task, gateId);
  if (!recheckRejectedEvidence && priorAttemptCount >= MAX_POST_MERGE_GATE_RESEED_ATTEMPTS) {
    return { outcome: "not-seeded", reason: "rerun-budget-exhausted", workflowStepId: gateId, priorAttemptCount };
  }

  const selection = await store.getTaskWorkflowSelectionAsync(task.id);
  const resolved = irForGate;
  if (resolved.source === "default" && !resolved.selectionAbsent) {
    return { outcome: "not-seeded", reason: "selection-drift", workflowStepId: gateId };
  }
  const { ir } = resolved;
  const node = ir.version === "v2" ? ir.nodes.find((candidate) => candidate.id === gateId) : undefined;
  if (!node) return { outcome: "not-seeded", reason: "no-post-merge-node", workflowStepId: gateId };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-08:00 (RUFU-457):
  This lane seeds the NODE id, never prompt text — the reviewer's instructions are materialised when the node
  dispatches (`executor/run-graph-custom-node.ts` via `executor/post-merge-prompt.ts`), so a reseed picks up
  whatever evidence contract the board resolves at that moment and nothing here can drift from that wording.
  */
  /*
  FNXC:PostMergeRecovery 2026-10-08-02:01 (RUFU-319): upstream's fence coverage around the seed, restored.
  The sync merge narrowed this seam's fence to the legacy-park clear alone, on the reasoning that the clear
  is the only TASK mutation. The reasoning holds for task rows and fails for the card's work: the idle
  continuation insert below is a durable write that starts a reviewer run, and `merge-write-fence.ts`'s own
  contract is that "abort is asynchronous, so ownership is read immediately before each individual mutation
  or irreversible action; a closure, loop, or function-entry check cannot cover a later write". The outer
  wrap in `auto-merge-finalization.ts` cannot substitute for it: that check runs BEFORE `resume()` is
  entered, and the abort that matters lands DURING the resume — between the work-item read and the insert —
  which is precisely the window origin's `fence.write("finalization", seed)` closed. Measured on the merged
  tree, an aborted lane still inserted the continuation and still wrote its log line, so a merge body that
  no longer owned the card could schedule work on it. The suppressed write is reported as the already
  existing transient `finalize-blocked` refusal: the lane lost ownership, a later pass owns the card.
  */
  /*
  FNXC:PostMergeRecovery 2026-10-09-15:20 (RUFU-610):
  Retire the gate's own abandoned `running` continuation before asking the idle seed, or the card stays pinned
  behind a row no owner can reach (see `findStaleRunningGateContinuations`). This sits behind the same write
  fence as the seed itself — ownership is read before every individual mutation, not once per pass — and
  behind a liveness proof, because an in-process session is the only evidence that separates a leaseless row
  owned by a live reviewer from one left by a dispatcher that never ran. The retired row goes to `failed`,
  never deleted: the merge gate blocks on a missing/failed result, so deleting it would silently satisfy the
  gate (FN-8492's lesson).
  */
  const staleRunning = findStaleRunningGateContinuations(items, node.id);
  if (staleRunning.length > 0 && !isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock })) {
    const reclaimed = await fence.write("finalization", async () => {
      for (const stale of staleRunning) {
        await store.transitionWorkflowWorkItem(stale.id, "failed", {
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: "stale-running-continuation-reclaimed",
        });
      }
      return staleRunning.length;
    });
    if (reclaimed) {
      await fence.write("log", () => store.logEntry(
        task.id,
        `${STALE_CONTINUATION_RECLAIM_LOG_MARKER} ${node.id}: retired ${reclaimed} abandoned running continuation(s); no live lease, no session`,
      ));
    }
  }
  const seeded = await fence.write("finalization", () => store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:post-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection: selection ?? null,
    expectedTaskUpdatedAt: task.updatedAt,
  }));
  if (!seeded) {
    // A suppressed fenced write means this lane no longer owns the card: nothing was seeded.
    return { outcome: "not-seeded", reason: "finalize-blocked", workflowStepId: gateId };
  }
  if (!seeded.seeded) {
    /*
    FNXC:PostMergeRecovery 2026-10-01-10:58: the idle-seed primitive names THREE refusals, and collapsing
    them into one made production unanswerable — RUFU-286 deferred on a ~90s cadence reporting
    `post-merge-continuation-not-idle` while its three continuations were all `succeeded`, so the named
    cause was simply false. Carry the primitive's reason: a live continuation, a selection that moved
    under the fence, and a card that changed while we were deciding are three different operator actions.
    */
    const refusal = seeded.reason === "workflow-selection-changed"
      ? "selection-drift"
      : seeded.reason === "task-state-changed"
        ? "task-state-changed"
        : "active-continuation";
    return { outcome: "not-seeded", reason: refusal, workflowStepId: gateId };
  }

  /*
  FNXC:PostMergeRecovery 2026-10-05-09:31 (upstream's two sentences, one durable write):
  Each arm names what it actually did, because the sentence is what an operator reads and what the budget
  matches. The missing arm keeps the counted marker and its attempt ordinal — upstream's own sentence is
  exactly this marker's prefix, so a card seeded by either build stays countable. The rejected-evidence arm
  deliberately does NOT write the counted marker: FN-9502's schedule, not the seed budget, bounds it.
  */
  await fence.write("log", () => store.logEntry(
    task.id,
    recheckRejectedEvidence
      ? `[post-merge] Rechecking rejected evidence at '${node.id}'; already-landed implementation and merge will not run again.`
      : `${postMergeGateReseedLogMarker(node.id)}; already-landed implementation and merge `
        + `will not run again (reseed ${priorAttemptCount + 1} of ${MAX_POST_MERGE_GATE_RESEED_ATTEMPTS})`,
  ));
  /*
  FNXC:RunAudit 2026-10-01-09:01 (FN-9175 seam kept through the upstream adoption):
  Handing a card back to the graph is an ACTION on the card, so it is countable: `task:merge-unrun-post-
  merge-gate-reseeded` is how an operator distinguishes "the gate is running now" from "the card is
  parked", and the attempt count is what makes the bounded budget auditable. Metadata stays ids / counts /
  fixed enums; an absent, throwing, or hanging sink cannot alter the seed.
  */
  await emitBoundedRunAudit(store, {
    taskId: task.id,
    agentId: "self-healing",
    runId: `${task.id}:unrun-post-merge-gate-reseed:${node.id}`,
    domain: "database",
    mutationType: "task:merge-unrun-post-merge-gate-reseeded",
    target: task.id,
    metadata: {
      taskId: task.id,
      nodeId: node.id,
      workflowStepId: gateId,
      source: options.source,
      outcome: "seeded",
      attempt: priorAttemptCount + 1,
      maxAttempts: MAX_POST_MERGE_GATE_RESEED_ATTEMPTS,
    },
  // No sink-side logging wanted here: the refusal and the seed are both on the card's own log line.
  }, { log: { warn: () => {} } });
  return { outcome: "seeded", reason: "seeded", workflowStepId: gateId, priorAttemptCount };
}

/*
FNXC:PostMergeRecovery 2026-10-01-09:01:
`reseedUnrunPostMergeGate` (RUFU-306) is DELETED. Its callers call `resumeMissingPostMergeGate` with the
same source label, and its invariants are listed in the header above. Do not re-add a second post-merge
seed function: the two implementations disagreeing in one file is what produced the merge-time collision
this resolution removed.
*/
