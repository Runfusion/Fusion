import {
  evaluateWakeCapabilityBind,
  hasNoCommitReviewExclusion,
  hasRecordedCodeReviewVerdict,
  hasWorkflowRoleCapability,
  isCodeReviewExcluded,
  resolvePreMergeGateForTask,
} from "@fusion/core";
import type {
  Agent,
  WakeCapabilityBindContext,
  WakePurpose,
  Task,
  TaskStore,
} from "@fusion/core";

/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
The reviewer lane was woken on cards whose lifecycle cannot carry an open `code-review` gate, and the wake text
stated a gate the card never had. Measured instances: RUFU-350 (`column: done`, `status: done`, content landed,
its `code-review` lane approved at 07:22:33Z — 19 min before the wake, and a `post-merge-verification` REVISE at
07:41:46Z that is NOT a code-review gate) and RUFU-365 / RUFU-366 (`column: todo`, `status: todo`, 0 of 8 steps
run, `**No commits expected:** true`, the card never executed, so no review subject existed). The common defect
is that the wake path asserted a review gate without ever asking whether the card's lifecycle has one.

Before this module the two questions the wake needed had no shared owner: "is this card's lane a review lane"
lived in the dashboard mirror (`core/column-roles.ts`) and the narrow merge-blocker set the review-dispatch sweep
uses, while "has a verdict already been recorded" lived privately inside that sweep. A reviewer-lane bind that
survived claim-time (or a card in a lane that is not implementation-class, which the bind revalidation lets
through) therefore reached `executeHeartbeat` with no candidacy check at all, and `executeHeartbeat` opened a
session that could not produce the thing it was told to produce — after U10 a heartbeat reviewer session has no
verdict surface, review belongs exclusively to workflow-graph nodes.

`evaluateWakeTaskBind` is now the single admission owner at the wake seam for BOTH verdict and column role: the
reviewer-candidacy arm is evaluated before the capability arm (RUFU-766's `evaluateWakeCapabilityBind`), and the
same core predicates the review-dispatch sweep and the merge door read answer it. A withheld wake is a refusal for
that wake only: the binding, the lane, the branch, and every step stay untouched, because
`reconcile-lane-capability-misbind` is the sole mutation owner for a mis-bound card.
*/

/** Named decline code for a reviewer wake withheld on card candidacy — distinct from a role/policy mismatch. */
export const REVIEW_CANDIDACY_DECLINE_CODE = "review-candidacy-mismatch" as const;

/**
 * Fail-open test for "this card has reviewable work".
 *
 * Only a DURABLE counter-record returns false, deliberately: the caller is deciding whether to suppress a
 * review, and the review-dispatch sweep itself never inspects commits (`findReviewLaneCandidates` reads
 * `store.listTasks({slim: true})` plus the reviewer-run ledger). Requiring positive commit evidence here would
 * make the wake stricter than the dispatcher, and a false negative is not a neutral answer — it silences the
 * review of a card that does have a branch (RUFU-396 measured cards whose `branch` field was misbound while
 * their content was on `main`).
 *
 * The record that does count is the card's own zero-commit authorization: a plan-declared
 * `**No commits expected:** true` is what `merge/zero-commit-landing-proof.ts` accepts as "git has nothing to
 * show" and what `merge/no-commits-finalize-guard.ts` lets a zero-diff lane finalize WITHOUT an approved code
 * review. RUFU-365 and RUFU-366 both carried it.
 */
export function hasReviewableWork(task: Pick<Task, "noCommitsExpected">): boolean {
  return !hasNoCommitReviewExclusion(task);
}

/** Card fields the candidacy decision reads — every one of them durable board state. */
/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
`executionMode` / `humanPlanApproval` are carried so the shared gate resolver receives the same fast-lane inputs
every other one of its call sites passes — a Fast card's route is part of the truth about which lanes and gates
its lifecycle can hold, and the wake must not resolve them from a narrower row than the merge door reads.
*/
export type WakeCandidacyTask = Pick<
  Task,
  | "id"
  | "column"
  | "noCommitsExpected"
  | "reviewLevel"
  | "enabledWorkflowSteps"
  | "workflowStepResults"
  | "executionMode"
  | "humanPlanApproval"
>;

export interface WakeReviewCandidacyContext {
  /** Review-class lanes of the card's own workflow (`resolveReviewColumns`: orchestration, merge-blocker, human-review). */
  reviewColumns: ReadonlySet<string>;
  /** False when the card's workflow could not be resolved; candidacy is then UNKNOWN, never a decline. */
  resolvable: boolean;
}

/**
 * Resolves the candidacy context from the card's own workflow through the SAME gate resolver the merge door
 * and the store hydration sites use, so the wake and the door can never disagree about which gates exist.
 */
export async function resolveWakeReviewCandidacyContext(
  store: TaskStore,
  task: WakeCandidacyTask,
): Promise<WakeReviewCandidacyContext> {
  const gate = await resolvePreMergeGateForTask(store, task.id, task.enabledWorkflowSteps, task);
  /*
  FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
  `not-workflow-aware` and `read-failed` mean the workflow behind the gate set is unknown. Withholding a wake
  on an unknown is the fail-closed direction this seam must never take — the pre-existing wake behavior stays
  authoritative, exactly as the lane-capability revalidation already fails open on an unreadable card row.
  */
  return {
    reviewColumns: gate.reviewColumns,
    resolvable: gate.resolution === "selection" || gate.resolution === "no-selection",
  };
}

/** Candidacy result: `unknown` never declines; a non-candidate carries the verified facts for the log line. */
export type WakeReviewCandidacy =
  | { known: false }
  | { known: true; candidate: true }
  | { known: true; candidate: false; facts: string[] };

/**
 * The one reviewer-candidacy predicate: a card is reviewer work only when its lifecycle can actually hold an
 * open `code-review` gate. Each conjunct is durable board state shared with an existing authority.
 */
/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
The review-class lane test is deliberately the card's own lane vocabulary, NOT `resolveRequiredPreMergeStepIds`.
That set lists only a workflow's OPTIONAL groups, so a custom workflow whose review gate is a plain prompt node
resolves to an empty set and every legitimate review wake on it would be refused — the RUFU-682 over-refusal class
again, one layer down. A lane the card's own IR does not call review-class (RUFU-350's `done`, RUFU-365's and
RUFU-366's `todo`) is itself the durable fact that no review can be owed there.
*/
export function isReviewWakeCandidate(
  task: WakeCandidacyTask,
  context: WakeReviewCandidacyContext,
): WakeReviewCandidacy {
  if (!context.resolvable) return { known: false };

  const facts: string[] = [];
  if (!context.reviewColumns.has(task.column)) {
    facts.push(`lane "${task.column}" is not a review-class lane of this card's workflow`);
  }
  if (isCodeReviewExcluded(task)) {
    facts.push(`the card excludes code review (reviewLevel=${String(task.reviewLevel ?? "unset")}, enabledWorkflowSteps=${task.enabledWorkflowSteps ? task.enabledWorkflowSteps.join(",") : "unset"})`);
  }
  if (!hasReviewableWork(task)) {
    facts.push(`the card declares "No commits expected", so it has no diff to review`);
  }
  if (hasRecordedCodeReviewVerdict(task)) {
    facts.push(`a code-review verdict is already recorded`);
  }

  return facts.length === 0
    ? { known: true, candidate: true }
    : { known: true, candidate: false, facts };
}

export interface WakeTaskBindContext extends Omit<WakeCapabilityBindContext, "purpose" | "reviewColumn"> {
  /**
   * FNXC:LaneCapabilityWake 2026-10-22-15:47 (RUFU-766): which capability BAR scores the bound card. Omitted
   * means `"implementation"`, i.e. the verdict `evaluateImplementationTaskBind` already produced.
   */
  purpose?: WakePurpose;
  /** The card's workflow-declared review lane; `undefined` fails closed to the implementation bar. */
  reviewColumn?: string | undefined | null;
  /** The caller's resolved candidacy decision for this card; `{known:false}` performs no candidacy decline. */
  reviewCandidacy: WakeReviewCandidacy;
  /** The review-dispatch sweep already adjudicates an automation wake; the wake seam must not swallow it. */
  automationCorroborated?: boolean;
  /** This wake was caused by fresh comment delivery, which is never declined by card candidacy. */
  freshCommentWake?: boolean;
}

export type WakeTaskBindVerdict =
  | { allowed: true }
  | { allowed: false; code: typeof REVIEW_CANDIDACY_DECLINE_CODE | "lane-capability-mismatch"; reason: string };

/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
"Reviewer-only" is a question about the LANE, never about the card. `canAgentTakeImplementationTaskForExplicitRouting`
answers the opposite (it returns true for any non-implementation lane, because there is no implementation work to
protect there), so using it here would make the arm vanish for exactly the `in-review` and `done` cards it exists
for. The lane test is whether the lane could run implementation work AT ALL: a lane tagged executor or engineer
legitimately wakes on a `todo` card, and refusing that is the RUFU-682 over-refusal class — SANE-484's 24
dispatches came from refusing a lane for work it was never meant to run and then re-offering it.
*/
export function wakeLaneIsReviewerOnly(agent: Agent): boolean {
  return hasWorkflowRoleCapability(agent, "reviewer")
    && !hasWorkflowRoleCapability(agent, "executor", { allowEngineerAsExecutor: true });
}

/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
Ordering is the whole design. The candidacy arm runs BEFORE the capability arm because the lane this catches is
precisely the one the capability arm waves through: a review-class or terminal lane is not implementation-class,
so the capability bar returns `allowed` for it whatever role the lane holds — which is how RUFU-350's `done` card
reached a reviewer session and was told to "supply your verdict".

FNXC:LaneCapabilityWake 2026-10-22-15:47 (RUFU-766):
The capability half delegates to `evaluateWakeCapabilityBind`, the ONE core wake entry point, so a review-purpose
wake on a review-owned card is scored by the reviewer bar rather than the implementation floor. Candidacy is
resolved first and independently of the bar: which question the card owes this lane is not a function of which
bar the wake is being scored by.
*/
export function evaluateWakeTaskBind(
  agent: Agent,
  task: WakeCandidacyTask,
  context: WakeTaskBindContext,
): WakeTaskBindVerdict {
  const adjudicateCandidacy =
    // A lane that can also execute implementation work is not making a review claim by waking on this card.
    wakeLaneIsReviewerOnly(agent)
    && context.reviewCandidacy.known
    && context.reviewCandidacy.candidate === false
    // An automation wake IS the sweep's adjudication: a decline here would write a suppression witness on the
    // attempt the sweep just opened, and RUFU-682/SANE-484 proved an over-broad refusal at this seam can
    // suppress legitimate reviews for every reviewer in the pool.
    && !context.automationCorroborated
    // A human comment outranks card candidacy: the operator asked, and swallowing a comment wake is the
    // invisible-failure class RUFU-259 was filed for.
    && !context.freshCommentWake;

  if (adjudicateCandidacy && context.reviewCandidacy.known && context.reviewCandidacy.candidate === false) {
    return {
      allowed: false,
      code: REVIEW_CANDIDACY_DECLINE_CODE,
      reason:
        `reviewer lane declined ${task.id} for this wake: the card has no open code-review gate — ` +
        `${context.reviewCandidacy.facts.join("; ")}.`,
    };
  }

  const capabilityVerdict = evaluateWakeCapabilityBind(agent, task, {
    ...context,
    purpose: context.purpose ?? "implementation",
    reviewColumn: context.reviewColumn,
  });
  return capabilityVerdict.allowed
    ? { allowed: true }
    : { allowed: false, code: "lane-capability-mismatch", reason: capabilityVerdict.reason };
}

/** Where the comment ids that a wake is about to advertise came from. */
export type WakeCommentProvenance = "fresh" | "carried" | "none";

export interface WakeCommentIds {
  /** Ids safe to read bodies for. `carried` ids are context, never proof of a new comment. */
  ids: string[] | undefined;
  origin: WakeCommentProvenance;
}

/*
FNXC:ReviewerWakeCandidacy 2026-10-19-12:40 (RUFU-369):
`effectiveTriggeringCommentIds` was `triggeringCommentIds ?? contextSnapshot?.triggeringCommentIds`, and the
result was re-stamped into the new run's snapshot, retitled "New comments since last run", and turned the wake
reason into `comment_*`. A carried id therefore became a fresh one on the next wake and stayed fresh forever:
each run re-published the previous run's ids as its own, so a card's comment count and headings could never
fall. The two sources have different meanings — the parameter is this wake's delivery, the snapshot is a
previous wake's — so the distinction is now resolved once, at the seam, and carried downstream.
*/
export function resolveWakeCommentIds(input: {
  paramIds: readonly string[] | undefined;
  snapshotIds: readonly string[] | undefined;
}): WakeCommentIds {
  const clean = (ids: readonly string[] | undefined): string[] | undefined => {
    if (!Array.isArray(ids)) return undefined;
    const kept = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    return kept.length > 0 ? kept : undefined;
  };
  const paramIds = clean(input.paramIds);
  if (paramIds) return { ids: paramIds, origin: "fresh" };
  const snapshotIds = clean(input.snapshotIds);
  if (snapshotIds) return { ids: snapshotIds, origin: "carried" };
  return { ids: undefined, origin: "none" };
}
