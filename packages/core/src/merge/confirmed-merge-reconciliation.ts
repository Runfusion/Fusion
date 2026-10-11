import { isWorkspaceTask, type Task, type WorkflowStepResult } from "../types.js";
import { resolveWorkflowIrForTask, type WorkflowIrResolverStore } from "../workflows/workflow-ir-resolver.js";
import { isWorkflowOptionalGroupEnabled } from "../workflows/workflow-optional-steps.js";
import { authoredPostMergeEvidenceKindOf, postMergeEvidenceDemandsCi, resolvePostMergeEvidenceKind } from "../workflows/builtin-post-merge-group.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { BLOCKING_TASK_STATUSES, clearMergeConfirmedTransientStatus } from "./task-merge.js";
import { isAuditedOperatorBypass } from "./pre-merge-approval.js";
import { isWorkflowStepNotRun } from "../workflows/workflow-step-results.js";
import { isPostMergeEvidenceUnreportable, type PostMergeEvidenceContract } from "./post-merge-evidence-contract.js";

export type ConfirmedMergeChecklistReconciliation = {
  skippedStepIndexes: number[];
  reconciledWorkflowStepIds: string[];
};

export type RequiredPostMergeEvidenceDecision =
  | { outcome: "finalizable" }
  | { outcome: "resumable"; gateId: string }
  | { outcome: "blocked"; gateId: string; reason: "duplicate" | "pending" | "failed" | "skipped" | "not-approved" };

/*
FNXC:ConfirmedMergeFinalization 2026-08-23-07:42:
FN-180 requires a confirmed integration merge to finalize even when a concurrent
review bounce left a stale checklist. Post-merge checks deliberately exclude
steps and review verdicts; only independent task blocking states may defer.

FNXC:ConfirmedMergeFinalization 2026-08-28-11:05:
A failed status cannot block post-merge finalization because all consumers establish durable merge
or landing proof before calling this helper: the shared finalizer uses hasDurableMergeProof, the
project-engine fast path verifies mergeConfirmed reachability, and self-healing proves the landed
commit. getTaskHardMergeBlocker already neutralizes failed for the same FN-9193 failure shape. This
is not a laundering path: keeping proven-landed work out of completion cannot un-merge it and only
leaves a permanently failed board card; every independent operator and planning status still blocks.
*/
export function getPostMergeFinalizeBlocker(task: Pick<Task, "status" | "error">): string | undefined {
  const status = clearMergeConfirmedTransientStatus(task.status);
  if (status && status !== "failed" && BLOCKING_TASK_STATUSES.has(status)) {
    return task.error ? `task is marked '${status}': ${task.error}` : `task is marked '${status}'`;
  }
  return undefined;
}

/*
FNXC:PostMergeRecovery 2026-10-04-07:38:
A confirmed landing is not completion when an enabled post-merge gate has no durable result. The
shared decision exposes that one resumable state structurally: resumable means exactly zero results,
so pending, duplicate, skipped (including archived or bypassed history), failed, and non-approved
evidence remain visible blockers rather than permission to reseed or finalize.
*/

/** The enabled gate-mode post-merge groups a task must still satisfy, in IR order. */
export function resolveRequiredPostMergeGateIds(
  task: Pick<Task, "enabledWorkflowSteps">,
  ir: WorkflowIr,
): string[] {
  if (ir.version !== "v2") return [];
  return ir.nodes.flatMap((node) => {
    if (node.kind !== "optional-group" || node.config?.phase !== "post-merge") return [];
    const template = node.config.template as { nodes?: Array<{ config?: { gateMode?: unknown } }> } | undefined;
    const gateMode = template?.nodes?.some((inner) => inner.config?.gateMode === "gate");
    return gateMode && isWorkflowOptionalGroupEnabled(task.enabledWorkflowSteps, node.id, node.config.defaultOn === true)
      ? [node.id]
      : [];
  });
}

/*
FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
Two states hide behind the one blocker sentence, and only one of them is repairable by re-running
the gate. `missing` means the node never reported at all — nothing was ever evaluated, so the graph
can still be seeded with it. `not-approved` means a verdict exists and was negative: that is a
review decision, and re-seeding it would be a machine overruling a gate. The engine's recovery
route is allowed to see this distinction; the blocker TEXT deliberately stays the single sentence
operators already recognise, so no consumer changes shape.
*/
/*
FNXC:PostMergeGateDeliveryShape 2026-09-30-13:09 (RUFU-429):
A required gate whose lane CANNOT report it is not a violation; it is a requirement this delivery shape
never had. `not-applicable` names that third case: the IR still requires the gate and the operator escape
hatch still sees it, but no blocker, no re-seed, and no deferred-finalization claim may be built on an
absence the lane was never able to fill. Measured before this: zero workspace cards in any project had
ever produced a `post-merge-verification` row, while `reseedUnrunPostMergeGate` refuses workspace cards by
construction (`reason: "workspace"`) — so every landed workspace card was held out of `done` by a gate that
could only be lifted by a human waiver (eleven of them on 2026-09-29 alone).
*/
export type PostMergeEvidenceGateState = "missing" | "not-approved" | "not-applicable";

/*
FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
`not-applicable` now has two independent causes, and an operator reading one board needs to know which.
`delivery-shape` is RUFU-429 (a workspace lane cannot report); `no-evidence-reporter` is this card (the
project has no CI reporter at all); `verdict-precedes-contract` is the history case below. The reason is
carried on the status so a caller can name it in a log or audit row without re-deriving anything — the
blocker TEXT stays one sentence per state, so no consumer's wording contract changes.
*/
export type PostMergeEvidenceNotApplicableReason =
  | "delivery-shape"
  | "no-evidence-reporter"
  | "verdict-precedes-contract";

/*
FNXC:PostMergeCiRepository 2026-10-11-03:59 (RUFU-375, Code Review finding P0):
A `skipped` row carrying an honest `notRunReason` is a gate that REFUSED TO RUN, not a gate that reported.
Reading it as `not-approved` gave it the merge veto of a verdict it never authored, and the veto was
permanently unlift-able by the very operator the refusal names: `blocked` reaches neither
`isPostMergeGateRecoveryDue` nor the finalizer's `state === "missing"` deferral, so `retry`/Retry could not
re-seed the gate and the card dead-ended after the guard had already told a human to "set the setting, then
use Retry". Measured shape: RUFU-348's twelve `postMergeCiRepo` refusals each produce exactly this row on a
card whose merge is already confirmed.

The three exclusions are what keep this from laundering a real decision into completion:
  - `bypassedBy` — an audited human waiver still resolves through `isAuditedOperatorBypass` one step later
    (RUFU-408), so a waiver row is never reinterpreted as an absence and re-run over the operator's decision;
  - `verdict` — a row that both authored a verdict and named a not-run cause is a report, so it keeps the
    verdict's veto (`skipped` + `verdict: "REVISE"` stays `not-approved`, as the pinned contract demands);
  - `remediationArchivedAt` — an FN-295 archived carrier is an unconditional veto whose owned remedy is
    `reconcile-collateral-archived-review-gate` restoring its pre-archive status, not a re-seed.
Exported rather than inlined so the classifier is one named fact the engine's re-seed lane and the tests can
cite, instead of a shape each consumer re-derives (RUFU-179's offer == accept lesson).
*/
export function isNotRunPostMergeEvidence(result: WorkflowStepResult): boolean {
  return isWorkflowStepNotRun(result) && !result.verdict && !result.bypassedBy && !result.remediationArchivedAt;
}

export interface PostMergeEvidenceGateStatus {
  gateId: string;
  state: PostMergeEvidenceGateState;
  /** Present only for `not-applicable`, naming which fact made the gate inapplicable. */
  notApplicableReason?: PostMergeEvidenceNotApplicableReason;
}

/** Per-gate evidence state for every required post-merge gate, in IR order. */
export function getPostMergeEvidenceGateStatuses(
  task: Pick<Task, "enabledWorkflowSteps" | "workflowStepResults" | "workspaceWorktrees">,
  ir: WorkflowIr,
  contract?: PostMergeEvidenceContract,
): PostMergeEvidenceGateStatus[] {
  const workspaceShaped = isWorkspaceTask(task);
  const unreportable = isPostMergeEvidenceUnreportable(contract);
  /*
  FNXC:PostMergeEvidenceRequirement 2026-09-30-22:51 (RUFU-430):
  Whether the reporter fact exempts a gate depends on what THAT gate asks for, and that is authored per
  workflow node. An `integration-only` gate is still owed by a board with no CI — it asks for the landed SHA
  and a read of the landed content, both of which such a board can produce. Only a contract that names CI
  artifacts is exempt when no reporter exists. Absence of the config keeps the historical full-suite reading.
  */
  /*
  FNXC:PostMergeEvidenceContract 2026-10-01-06:36 (RUFU-457):
  The kind is resolved through the provider-aware resolver, so the question this seam answers stays
  "what does THIS gate ask for, given the reporter this board really has" rather than "which host is the
  remote on". Concretely: an OneDev/GitLab contract is reportable, so its CI-shaped gate stays OWED
  (`missing`, blocker names it) instead of being exempted the way RUFU-430 exempted a board with no
  reporter at all; a `none` contract still takes the `no-evidence-reporter` path untouched; and an authored
  `integration-only` gate stays owed on any board because it asks for no run.
  Every consumer below reads these statuses rather than re-deriving a kind anywhere:
  `getRequiredPostMergeEvidenceBlocker` (this file), the engine finalizer's pending-evidence claim
  (`merge/auto-merge-finalization.ts`), the RUFU-306 re-seed lane (`merge/post-merge-gate-reseed.ts`),
  the three `self-healing.ts` call sites, and the dashboard/store bypass target
  (`merge/review-bypass-target.ts`). That single derivation is the RUFU-179 offer == accept invariant: a
  locally re-derived kind is how an affordance and an acceptance gate start disagreeing.
  */
  const evidenceKindByGate = new Map(
    ir.nodes
      .filter((node) => node.kind === "optional-group")
      .map((node) => [
        node.id,
        resolvePostMergeEvidenceKind({
          authored: authoredPostMergeEvidenceKindOf(node.config as { evidence?: { kind?: unknown } } | undefined),
          provider: contract?.provider,
        }),
      ]),
  );
  return resolveRequiredPostMergeGateIds(task, ir).flatMap((gateId): PostMergeEvidenceGateStatus[] => {
    const result = (task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === gateId);
    /*
    FNXC:PostMergeGateDeliveryShape 2026-09-30-13:09 (RUFU-429):
    Only an ABSENCE becomes not-applicable. A durable negative verdict on a workspace card still reports
    `not-approved`, so exempting the shape never launders a real gate decision into completion; and the
    required-gate list itself is left untouched, which keeps the operator bypass target resolvable for a
    workspace card that ever does need one. Fixing the invariant here rather than in the engine keeps the
    blocker text, the re-seed lane, the finalizer's deferred-evidence claim, and the dashboard's bypass
    affordance asking about the same gates (the RUFU-179 offer==accept invariant).
    */
    /*
    FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
    Same shape as the delivery-shape exemption one line below, one cause earlier: on a board with no CI
    reporter the absence was never a violation either. Measured before this fact existed, 66 of 98 durable
    post-merge refusals across the fleet said the repo has no CI pipeline, and every saneca landing cost
    one operator waiver (11 on 2026-09-29 alone) to release a card whose gate could not be rung.
    */
    /*
    FNXC:PostMergeCiRepository 2026-10-11-03:59 (RUFU-375, Code Review finding P0):
    An honest not-run carrier is judged by the SAME requirement ladder as a row that was never written, so a
    gate that refused to run cannot acquire a stricter status than a gate that never got the chance. Keeping
    it in this ladder rather than returning `missing` directly also preserves RUFU-429/RUFU-430: a workspace
    lane or a reporter-less board is still `not-applicable` for such a row, which matters because the
    re-seed seam refuses workspace cards by construction and an unconditional `missing` would have it retry
    forever against a refusal it can never satisfy.
    */
    if (!result || isNotRunPostMergeEvidence(result)) {
      const demandsCi = postMergeEvidenceDemandsCi(evidenceKindByGate.get(gateId) ?? resolvePostMergeEvidenceKind({ authored: undefined, provider: contract?.provider }));
      if (unreportable && demandsCi) {
        return [{ gateId, state: "not-applicable", notApplicableReason: "no-evidence-reporter" }];
      }
      if (workspaceShaped) return [{ gateId, state: "not-applicable", notApplicableReason: "delivery-shape" }];
      return [{ gateId, state: "missing" }];
    }
    /*
    FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
    An audited operator waiver satisfies the post-merge gate, exactly as it satisfies the pre-merge door
    (`evaluatePreMergeApprovals`' `auditedOperatorWaiver` class). Without this, the bypass the RUFU-370
    notice names as the remedy rewrote the row to `skipped` and the finalizer STILL refused: `skipped`
    is not `passed`, so the waiver closed one door and left the other shut, and the landed card stayed
    in `in-review` forever with a recorded human decision on it. This is not a verdict — no reviewer
    approval is fabricated; the row keeps `bypassedBy`/`bypassedAt`/`bypassReason` and the
    `task:bypass-review` audit row, and the shared `isAuditedOperatorBypass` predicate refuses every
    automated actor, so only a named human waiver clears the gate.
    */
    if (isAuditedOperatorBypass(result)) return [];
    if (result.status !== "passed" || (result.verdict !== "APPROVE" && result.verdict !== "APPROVE_WITH_NOTES")) {
      /*
      FNXC:PostMergeEvidenceContract 2026-09-30-22:29 (RUFU-430):
      A durable negative verdict is a real gate decision and is never laundered — that is RUFU-429's own
      boundary, and it holds here. The one honest exception is history: a REVISE recorded BEFORE this
      project's reporter was observed to be missing is a verdict ABOUT AN IMPOSSIBLE CONTRACT, not about
      the delivery (vllm-rocm carries 38 such rows, dgx_spark 23). A refusal recorded AFTER the observation
      is actionable, because by then the gate ran knowing the reporter was absent. Only a DERIVED contract
      carries that cutoff; an operator who declares `none` explicitly is taking the declaration back in
      time, so their declaration exempts absences but never overwrites a recorded refusal.
      */
      if (unreportable && contract?.source === "derived" && postMergeEvidenceDemandsCi(evidenceKindByGate.get(gateId) ?? resolvePostMergeEvidenceKind({ authored: undefined, provider: contract?.provider }))) {
        const recordedAt = Date.parse(result.completedAt ?? result.startedAt ?? "");
        const observedAt = Date.parse(contract.observedAt);
        if (Number.isFinite(recordedAt) && Number.isFinite(observedAt) && recordedAt < observedAt) {
          return [{ gateId, state: "not-applicable", notApplicableReason: "verdict-precedes-contract" }];
        }
      }
      return [{ gateId, state: "not-approved" as const }];
    }
    return [];
  });
}

/*
FNXC:PostMergeRecovery 2026-10-01-09:01 (upstream FN-9442 adopted, RUFU-429 / RUFU-430 layered on top):
Upstream made the gate decision the single loop and derived the blocker SENTENCE from it, which is better
than the two independent loops the fork had: the blocker can no longer disagree with the recovery route.
Their classification is kept verbatim — an absent row is resumable, while duplicate / pending / failed /
skipped / non-approved rows all block, because each names a durable result the graph already produced.
What is layered on top is the requirement side: which gates are required, and which of them this board can
report at all, comes from `getPostMergeEvidenceGateStatuses` (delivery shape RUFU-429, evidence reporter
RUFU-430). A gate whose requirement is `not-applicable` is neither resumable nor blocking; reading raw rows
for it would resurrect the waiver-per-landing defect on every board that has no CI reporter.
*/
export async function getRequiredPostMergeEvidenceDecision(
  store: WorkflowIrResolverStore,
  task: Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults" | "workspaceWorktrees">,
  contract?: PostMergeEvidenceContract,
): Promise<RequiredPostMergeEvidenceDecision> {
  const reader = store as Partial<WorkflowIrResolverStore>;
  if (typeof reader.getTaskWorkflowSelection !== "function") return { outcome: "finalizable" };

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const statuses = new Map(getPostMergeEvidenceGateStatuses(task, ir, contract).map((status) => [status.gateId, status]));
  for (const gateId of resolveRequiredPostMergeGateIds(task, ir)) {
    const results = (task.workflowStepResults ?? []).filter((entry) => entry.workflowStepId === gateId);
    /*
     * Duplicates are checked BEFORE the requirement, on purpose: two rows for one gate means the graph
     * reported twice, and no lane may pick the convenient one — even on a board whose requirement is
     * inapplicable, where silently choosing would hide a broken workflow definition.
     */
    if (results.length > 1) return { outcome: "blocked", gateId, reason: "duplicate" };
    const status = statuses.get(gateId);
    // No status means nothing is owed here: the gate is disabled, already approved, or inapplicable to
    // this delivery shape / reporter set (RUFU-429, RUFU-430).
    if (!status || status.state === "not-applicable") continue;
    /*
    FNXC:PostMergeCiRepository 2026-10-11-03:59 (RUFU-375, Code Review finding P0):
    The STATUS, not the row count, decides whether this gate is owed a run — the two loops asking the same
    question independently is exactly what this module's own doctrine forbids, and here it is the difference
    between a recoverable deferral and a permanent park: a not-run carrier HAS a row (so the old row-count
    test called it a report) while the status reader above already classified it as the absence it is.
    `state === "missing"` therefore covers both the never-written row and the refused-to-run row, and every
    downstream arm — the finalizer's `deferredPostMergeEvidence` deferral instead of a fatal block on a
    published landing, and `isPostMergeGateRecoveryDue` handing the card back to the gate on the next pass —
    follows without a per-surface edit. The re-seed remains bounded by the engine's per-(task, gate) budget.
    */
    if (results.length === 0 || status.state === "missing") return { outcome: "resumable", gateId };
    const [result] = results;
    if (result.status === "pending") return { outcome: "blocked", gateId, reason: "pending" };
    if (result.status === "failed") return { outcome: "blocked", gateId, reason: "failed" };
    if (result.status === "skipped") return { outcome: "blocked", gateId, reason: "skipped" };
    if (result.status !== "passed" || (result.verdict !== "APPROVE" && result.verdict !== "APPROVE_WITH_NOTES")) {
      return { outcome: "blocked", gateId, reason: "not-approved" };
    }
  }
  return { outcome: "finalizable" };
}

/*
FNXC:PostMergeEvidence 2026-10-01-09:01:
The blocker sentence is now DERIVED from the decision above, so the two can never disagree. `contract` is
threaded because the sentence is the one string every lane compares and logs; a caller that resolved a
per-board contract must pass it or the sentence describes the GitHub-Actions default, not this board.
*/
export async function getRequiredPostMergeEvidenceBlocker(
  store: WorkflowIrResolverStore,
  task: Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults" | "workspaceWorktrees">,
  contract?: PostMergeEvidenceContract,
): Promise<string | undefined> {
  const decision = await getRequiredPostMergeEvidenceDecision(store, task, contract);
  if (decision.outcome === "finalizable") return undefined;
  if (decision.outcome === "resumable") return `required post-merge evidence gate '${decision.gateId}' has not reported`;
  return `required post-merge evidence gate '${decision.gateId}' is not approved`;
}


export function planConfirmedMergeChecklistReconciliation(
  task: Pick<Task, "steps" | "workflowStepResults">,
): ConfirmedMergeChecklistReconciliation {
  /*
  FNXC:ConfirmedMergeFinalization 2026-09-01-05:49:
  `steps` is typed non-optional, but a row can still reach here without it — an older row, a partial
  projection, a store path that does not populate it. This function runs on the merge-CONFIRMED
  fast path, i.e. after the work has already landed, so a TypeError here abandons the finalize and
  leaves a merged task un-finalized. Tolerating the absence costs nothing; asserting the type does
  not make the row real. Measured: a task whose row carried no `steps` threw
  "Cannot read properties of undefined (reading 'map')" and the landed merge never finalized.
  */
  return {
    skippedStepIndexes: (task.steps ?? [])
      .map((step, index) => step.status === "pending" || step.status === "in-progress" ? index : -1)
      .filter((index) => index >= 0),
    reconciledWorkflowStepIds: (task.workflowStepResults ?? [])
      .filter((result: WorkflowStepResult) => result.status === "pending")
      .map((result) => result.workflowStepId),
  };
}
