import {
  CONTENT_UNVERIFIABLE_REFUSAL,
  emitBoundedRunAudit,
  evaluateZeroCommitLandingProof,
  hasDurableLandingProof,
  isUncommittedWorkHold,
  resolvePreMergeGateForTask,
  type DeliveryUnprovenMarker,
  type LandingProof,
  type MergeDetails,
  type NoCommitsNoOpFinalizeEvidence,
  type Task,
  type TaskStore,
  type UncommittedWorkRefusalCode,
  type WorktreeContentState,
  type ZeroCommitLandingProofVerdict,
} from "@fusion/core";
import {
  classifyTaskWorktreeContent,
  isCommitContainedInBranch,
  measureAheadCommitCount,
  type TaskWorktreeContentEvidence,
} from "../worktree/worktree-backend.js";
import { findActiveWorktreeOwner, type ActiveWorktreesMap } from "../executor/worktree-ownership.js";
import type { MergeWriteFence } from "./merge-write-fence.js";

/*
FNXC:ZeroCommitLandingProof 2026-09-25-11:48 (RUFU-274):
The one landing-proof door every finalization lane passes through.

RUFU-262 is the motivating loss: the branch was 0 commits ahead of `main` and its tip was an ancestor of
`main`, so every lane reasoning from revision walks concluded "nothing to merge"; the worktree still held
the work as uncommitted files, and the card reached `done` while the cleanup sweep was already refusing
to delete that tree as "modified". Independent writers could each have produced that outcome, so a guard
in any single lane is insufficient — six review-lane finalization doors plus the shared finalize
primitive call this instead of deciding on their own.

Rules this file owns:
  • The lane's own `mergeConfirmed` / no-op flag is the claim under test, never an input. Only recorded
    delivery evidence that git can corroborate counts as landing proof.
  • A refusal writes the durable hold marker that `getTaskMergeBlocker` reads, so the row states the
    hold on its face and every later door answers the same way until a human acts.
  • A refusal is a human WAIT, never a failure: no `status` is written, so nothing can render this as
    `merge-failed` or spend a retry budget on it.
  • Evidence, not content: path counts plus a capped path list are recorded; file contents never are.
*/

/** Where the guard was called from, recorded on the audit row and the task log. */
export type ZeroCommitGuardSource =
  | "merge-runner"
  | "merge-ai-empty-lane"
  | "merge-ai-branch-missing"
  | "merge-ai-workspace"
  | "finalize-proven-auto-merge"
  | "self-healing-landed-cleanup"
  | "self-healing-no-op-finalize"
  /*
  FNXC:ZeroCommitEmptyInputContentProof 2026-11-03-18:35 (RUFU-384):
  The FN-9304 landed-review fence discharging a SINGULAR zero-commit card whose branch and worktree are gone.
  Neither existing self-healing source described it: `self-healing-no-op-finalize` is the no-op finalize sweep
  and the workspace obligation-free door (both already have producers, so reusing it would make an operator's
  `source` query unable to tell which lane held the card), and `self-healing-landed-cleanup` has had no
  producer since RUFU-274 declared it — a lane cannot inherit the semantics of a literal nothing writes.
  This is the ONLY edit this card makes to this union, and it names a lane that now actually exists.
  */
  | "self-healing-reconcile-commit-free"
  | "project-engine-merge-confirmed"
  | "workflow-merge-primitive"
  | "post-landing-cleanup";

export interface ZeroCommitFinalizationGuardInput {
  store: TaskStore;
  task: Task;
  /** Repository root the branch lives in (the sub-repo root for a workspace task's repo). */
  repoDir: string;
  /** Integration branch the lane would land onto. */
  integrationBranch: string;
  source: ZeroCommitGuardSource;
  /**
   * Evidence this lane already collected via `collectZeroCommitFinalizeEvidence`. When present, this door
   * reads it verbatim and touches no git — the point is that both authorities in one lane answer from the
   * same observation.
   */
  preCollected?: ZeroCommitCollectedEvidence;
  /** In-memory active-worktree map, when the caller has one, for singular-checkout ownership. */
  activeWorktrees?: ActiveWorktreesMap;
  /**
   * Durable proof the lane already verified live (e.g. a workspace repo whose recorded sha is reachable
   * in its own sub-repo). Omitted, the guard derives it from `mergeDetails` and confirms the sha's
   * containment in `repoDir` itself. Pass `null` explicitly to assert "there is none".
   */
  recordedProof?: LandingProof | null;
  /** Content evidence the lane already collected (workspace per-repo probes). */
  contentOverride?: TaskWorktreeContentEvidence;
  /**
   * Trust `recordedProof`/`contentOverride` instead of reading git. For tests and for lanes that
   * already probed in this pass; never a default, because a skipped probe is an absent probe.
   */
  skipEvidenceCollection?: boolean;
  /**
   * The calling lane's merge-generation fence, when it runs behind one (the AI-merge lanes always do).
   * A hold is a row write like any other, so a generation an abort superseded must not be able to stamp
   * — or clear — a hold on a card its successor now owns.
   */
  fence?: MergeWriteFence;
}

export type ZeroCommitFinalizationGuardOutcome =
  /** Landing is proven, or the card legitimately had nothing to deliver. Safe to finalize. */
  | { disposition: "allow"; verdict: ZeroCommitLandingProofVerdict; evidence: TaskWorktreeContentEvidence; aheadCommitCount: number | null }
  /** Zero-ness or content could not be proven. Do not finalize and do not fail — try again later. */
  | { disposition: "retry"; verdict: ZeroCommitLandingProofVerdict; evidence: TaskWorktreeContentEvidence; aheadCommitCount: number | null; reason: string }
  /**
   * Automatic finalization refused and the durable manual-merge hold written. `refusal` is the canonical
   * sentence the caller may surface on its own result; the durable row copy lives in
   * `mergeDetails.uncommittedWorkHold.reason`, so lane and row cannot state the refusal differently.
   */
  | { disposition: "held"; verdict: ZeroCommitLandingProofVerdict; evidence: TaskWorktreeContentEvidence; aheadCommitCount: number | null; refusal: string };

/**
 * Decide whether a card may be finalised from durable/observable evidence alone, and make the decision
 * durable when it refuses.
 */
export async function enforceZeroCommitLandingProof(
  input: ZeroCommitFinalizationGuardInput,
): Promise<ZeroCommitFinalizationGuardOutcome> {
  const { store, task, source, fence } = input;

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-26-02:10 (RUFU-274):
  One probe per lane, shared by BOTH authorities. A lane that calls the shared finalize guard and this
  door must not ask git twice — two `git status` runs can disagree (a dev commits between them), and a
  finalize guard that saw dirty while the landing-proof door saw clean is exactly the kind of disagreement
  that makes a refusal unauditable. A lane therefore collects once and hands the same bundle to both.
  */
  const collected = input.preCollected ?? (await collectZeroCommitEvidence(input));
  const { aheadCommitCount, landingProof: recordedProof, content: evidence } = collected;

  const verdict = evaluateZeroCommitLandingProof({
    aheadCommitCount,
    landingProof: recordedProof,
    worktreeContent: evidence.content,
    noCommitsExpected: task.noCommitsExpected === true,
  });

  if (verdict.kind === "proven" || verdict.kind === "proven-legitimate-noop") {
    // Whatever the hold described is gone — the human committed, or discarded and the card legitimately
    // has nothing to deliver. Clearing here is what keeps a hold from outliving its cause.
    if (isUncommittedWorkHold(task.mergeDetails)) {
      await clearZeroCommitUncommittedWorkHold(store, task, source, fence);
    }
    return { disposition: "allow", verdict, evidence, aheadCommitCount };
  }

  if (verdict.kind === "retry") {
    const reason = `zero-commit landing proof deferred: ${verdict.reason}`;
    await logZeroCommitGuardEvent(store, task, source, `DEFERRED ${reason}`, `contentBasis=${evidence.basis}`);
    emitZeroCommitAudit(store, task.id, "task:zero-commit-landing-proof-deferred", {
      source,
      reason: verdict.reason,
      contentState: verdict.contentState,
      contentBasis: evidence.basis,
      aheadCommitCount: aheadCommitCount ?? "unreadable",
    });
    return { disposition: "retry", verdict, evidence, aheadCommitCount, reason };
  }

  const refusal = verdict.reason;

  await applyZeroCommitUncommittedWorkHold({
    store,
    task,
    source,
    refusal,
    code: verdict.code,
    contentState: verdict.contentState,
    modifiedCount: verdict.modifiedCount,
    untrackedCount: verdict.untrackedCount,
    uncommittedPaths: [...verdict.uncommittedPaths],
    contentBasis: evidence.basis,
    aheadCommitCount,
    fence,
  });
  return { disposition: "held", verdict, evidence, aheadCommitCount, refusal };
}

/*
FNXC:ZeroCommitDeliveryProof 2026-09-26-02:10 (RUFU-274):
The evidence bundle a finalization lane must assemble before it may ask either question — "is this card's
step ledger clean enough to finalize?" and "is delivery actually proven?". Step 2 made the content
classification a REQUIRED argument on the shared guard precisely so a lane that has not looked at its
worktree cannot compile; this collector is the one place that knows how to look, so no lane re-derives
the recipe and each lane's call site stays readable.
*/
export interface ZeroCommitEvidenceInput {
  store: TaskStore;
  task: Task;
  /** Repository root the branch lives in (the sub-repo root for a workspace task's repo). */
  repoDir: string;
  /** Integration branch the lane would land onto. */
  integrationBranch: string;
  /** In-memory active-worktree map, when the caller has one, for singular-checkout ownership. */
  activeWorktrees?: ActiveWorktreesMap;
  /** Declared proof override. `undefined` = derive from the row and corroborate it; `null` = assert none. */
  recordedProof?: LandingProof | null;
  /** Content evidence the lane already collected (workspace per-repo probes). */
  contentOverride?: TaskWorktreeContentEvidence;
  /** Trust the overrides instead of reading git. Never a default: a skipped probe is an absent probe. */
  skipEvidenceCollection?: boolean;
}

export interface ZeroCommitCollectedEvidence {
  aheadCommitCount: number | null;
  landingProof: LandingProof | null;
  content: TaskWorktreeContentEvidence;
}

/** Read the three facts the zero-commit finalization decision is made of. Never returns "assumed clean". */
export async function collectZeroCommitEvidence(
  input: ZeroCommitEvidenceInput,
): Promise<ZeroCommitCollectedEvidence> {
  const { store, task, repoDir, integrationBranch } = input;

  const aheadCommitCount = input.skipEvidenceCollection || !task.branch
    ? null
    : await measureAheadCommitCount({ repoDir, integrationBranch, branch: task.branch });

  const recordedProof = input.recordedProof !== undefined
    ? input.recordedProof
    : input.skipEvidenceCollection
      ? null
      : await confirmRecordedLandingProof({ task, repoDir, integrationBranch });

  const content = input.contentOverride ?? (input.skipEvidenceCollection
    ? unverifiableEvidence()
    : await classifyTaskWorktreeContent({
        rootDir: repoDir,
        taskId: task.id,
        worktreePath: task.worktree,
        branch: task.branch,
        // A checkout shared with the project root is this card's evidence only while no other live task
        // or session claims it; `findActiveWorktreeOwner` names the other claimant.
        proveExclusiveSingularCheckout: async (worktreePath) =>
          (await findActiveWorktreeOwner(input.activeWorktrees ?? new Map(), store, worktreePath, task.id)) === null,
      }));

  return { aheadCommitCount, landingProof: recordedProof, content };
}

/*
FNXC:PreMergeGateResolution 2026-09-29-17:17 (RUFU-274, review finding ae5d844d):
The required-gate set that the zero-commit finalize guard demands comes from the canonical
`resolvePreMergeGateForTask` — the same classification the ordinary merge door already blocks with.
Its three per-lane predecessors returned `undefined` whenever the store's selection reader came back
empty, and an absent selection is this project's NORMAL shape (measured 2026-09-27: 0 of 91 cards
updated in the previous three days carried a `workflowId` or `workflowSelection`), so the guard's
`missingRequiredGate` arm could never fire while the guard claimed to check it. `RUFU-337` — enabled
`code-review`, zero result rows, finalized `done` — is that dead branch's live row shape; the identical
shape (`RUFU-225`) was refused at the merge door precisely because the door uses this resolver.
`resolvePreMergeGateForTask` keeps the carve-out honest: only `not-workflow-aware` (a store with no
selection reader at all — legacy embedders and test doubles) yields the empty set and retains the
historical result-only semantics, while `no-selection` computes the default workflow's default-on
gates (`builtin:coding` ships `code-review` default-on), and a `read-failed` classification gets those
same default gates rather than an empty set — the stricter direction the merge doors themselves take by
rejecting the write outright. Resolution itself never throws: a missing or corrupt definition degrades to
the built-in IR rather than raising.
*/
/** The required pre-merge gate ids a zero-commit finalize must see a terminal result for. */
export async function resolveNoOpFinalizeGateIds(store: TaskStore, task: Task): Promise<ReadonlySet<string>> {
  const gate = await resolvePreMergeGateForTask(store, task.id, task.enabledWorkflowSteps, task);
  return gate.requiredPreMergeStepIds;
}

/**
 * The shape the shared finalize guard (`evaluateNoCommitsNoOpFinalize`) now demands, assembled from the
 * same observation this file's door uses. Lanes call this, pass the result to both authorities, and cannot
 * reach a finalize without having looked.
 */
export async function collectZeroCommitFinalizeEvidence(
  input: ZeroCommitEvidenceInput & { requiredVerificationStepIds?: ReadonlySet<string> },
): Promise<NoCommitsNoOpFinalizeEvidence & ZeroCommitCollectedEvidence> {
  const collected = await collectZeroCommitEvidence(input);
  return {
    // Spread first, explicit keys after: `collected` names `aheadCommitCount`/`landingProof` too, and a
    // duplicate literal key here would silently overwrite the value the bundle just measured.
    ...collected,
    worktreeContent: collected.content.content,
    ...(input.requiredVerificationStepIds
      ? { requiredVerificationStepIds: input.requiredVerificationStepIds }
      : {}),
  };
}

/*
FNXC:ZeroCommitDeliveryProof 2026-09-26-02:15 (RUFU-274):
What a refusing lane may put on its `MergeResult`. Only the `held` disposition earns the marker:
`decline` wrote no durable record (nothing was at risk), and `retry`/`allow` are not refusals at all.
The marker is therefore derived from the outcome rather than assembled at six call sites, so no lane can
claim "refusal recorded" without the hold having been written, and no lane can report the worktree
preserved while its own cleanup pass deleted it — a lane that has already cleaned up never calls this.
*/
export function zeroCommitDeliveryUnprovenMarker(
  outcome: ZeroCommitFinalizationGuardOutcome,
): DeliveryUnprovenMarker | undefined {
  if (outcome.disposition !== "held") return undefined;
  const { verdict } = outcome;
  if (verdict.kind !== "refuse") return undefined;
  return {
    contentState: verdict.contentState,
    modifiedCount: verdict.modifiedCount,
    untrackedCount: verdict.untrackedCount,
    worktreePathPreserved: true,
    refusalRecorded: true,
  };
}

/**
 * A probe that never ran. Reported as the worst content state rather than `clean`, because
 * `skipEvidenceCollection` exists for lanes that already probed elsewhere in the pass and for tests —
 * defaulting it to "nothing to see" is the exact assumption RUFU-262 proves unsafe.
 */
function unverifiableEvidence(): TaskWorktreeContentEvidence {
  return { content: { state: "unverifiable", probeDetail: "evidence-collection-skipped" }, basis: "status-probe-failed" };
}

/**
 * Corroborate the row's recorded delivery evidence against git before the predicate may use it.
 *
 * A `commitSha` on the row is proof only if that commit is actually contained in the integration branch.
 * A sha that is not contained describes a merge that never landed, and honouring it is how a card gets
 * finalised on a remembered string.
 */
export async function confirmRecordedLandingProof(input: {
  task: Task;
  repoDir: string;
  integrationBranch: string;
}): Promise<LandingProof | null> {
  const derived = hasDurableLandingProof(input.task.mergeDetails);
  if (!derived.proven || !derived.proof) return null;
  if (derived.proof.kind === "durable-commit-sha" && derived.proof.sha) {
    const contained = await isCommitContainedInBranch({
      repoDir: input.repoDir,
      commitSha: derived.proof.sha,
      integrationBranch: input.integrationBranch,
    });
    return contained ? derived.proof : null;
  }
  return derived.proof;
}

/** The capped number of uncommitted paths the row is allowed to carry. */
const MAX_HELD_UNCOMMITTED_PATHS = 25;

/** Row-visible refusal plus the queue-level manual hold. Preserves every delivery pointer. */
export async function applyZeroCommitUncommittedWorkHold(input: {
  store: TaskStore;
  task: Task;
  source: ZeroCommitGuardSource;
  refusal: string;
  code: UncommittedWorkRefusalCode;
  contentState: WorktreeContentState;
  modifiedCount: number;
  untrackedCount: number;
  uncommittedPaths: string[];
  contentBasis: TaskWorktreeContentEvidence["basis"];
  aheadCommitCount: number | null;
  /**
   * The caller's merge-generation fence, when the lane runs behind one (the AI-merge lanes always do).
   * A hold is still a row write, and RUFU-146 requires every generation-owned write to be fenced: a
   * superseded generation must not stamp a hold onto a card its successor is now merging.
   */
  fence?: MergeWriteFence;
}): Promise<void> {
  const { store, task, source, refusal, code, contentState, modifiedCount, untrackedCount, uncommittedPaths, contentBasis, aheadCommitCount, fence } = input;
  if (fence?.isOrphaned()) return;
  const existing = task.mergeDetails ?? {};

  /*
  FNXC:ZeroCommitLandingProof 2026-09-25-11:48 (RUFU-274):
  The write is additive on purpose. `branch`, `worktree`, `modifiedFiles`, `baseBranch`, and any real
  landed-file record stay exactly where they are: the refusal says "come back with this committed", and
  the row is the only place a human can find the tree that still holds it. `mergeConfirmed` and
  `noOpMerge` are forced false, because a refused row must never keep the claim that would let the next
  lane finalise it without re-proving anything. No `status` is written — a wait that arrives as `failed`
  gets retried, replanned, or bypassed instead of fixed.
  */
  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 6):
  Snapshot any park that is NOT already ours before stamping ours on top of it. The refusal has to be the
  row-visible sentence while it is live (that is the point of the pause pair), so a foreign park is recorded
  in the marker and restored verbatim on release rather than left on the row — otherwise this lane's landing
  proof would both overwrite an exhausted-retry park and then unpause a card another owner is holding.
  */
  const foreignPark = task.paused === true || Boolean(task.error && !task.error.startsWith(DELIVERY_UNPROVEN_ERROR_PREFIX));
  // Snapshot only what the row model carries; the pause's own source metadata has no row field to return to.
  const priorRowHold = foreignPark
    ? {
        paused: task.paused ?? false,
        pausedReason: task.pausedReason ?? null,
        error: task.error ?? null,
      }
    : undefined;

  const mergeDetails: MergeDetails = {
    ...existing,
    mergeConfirmed: false,
    noOpMerge: false,
    uncommittedWorkHold: {
      at: new Date().toISOString(),
      code,
      source,
      contentState,
      modifiedCount,
      untrackedCount,
      pathCount: uncommittedPaths.length,
      ...(uncommittedPaths.length > 0 ? { paths: uncommittedPaths.slice(0, MAX_HELD_UNCOMMITTED_PATHS) } : {}),
      ...(task.worktree ? { worktree: task.worktree } : {}),
      ...(task.branch ? { branch: task.branch } : {}),
      ...(priorRowHold ? { priorRowHold } : {}),
      reason: refusal,
    },
  };

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 6):
  The row must be classifiable by an operator who never opens History, so the hold writes the pause pair the
  shipped engine parks write (`paused: true` + a free-text `pausedReason`, with `pausedReasonSource` naming the
  lane per the field's own convention) and puts the machine-prefixed sentence in `error`, on the
  `AUTO_MERGE_RETRY_REJECTED:` prefix pattern — a prefix a classifier can match and a sentence a human can act
  on. The queue half of the hold is separate and already real: `upsertZeroCommitManualMergeHold` files the
  work item as `manual-required`, which is what the lane-on re-queue in `workflow-workitems-ops` turns back
  into a `merge` item later the same night.
  What stays untouched is the point of the change: no `status` write, no `mergeRetries` burn, and every
  delivery pointer (`branch`, `worktree`, `modifiedFiles`) survives. A pause is a WAIT with a named remedy;
  `failed` is a verdict about the code, and it is exactly the status the symptom row must never acquire —
  `failed` is what invites retry, replan, and bypass, each of which can still discard the tree.
  */
  const pausePatch = {
    paused: true,
    pausedReason: "manual-hold",
    pausedReasonSource: `zero-commit-landing-proof:${source}`,
    error: `${DELIVERY_UNPROVEN_ERROR_PREFIX} ${refusal}`,
  };

  const guarded = (write: () => Promise<unknown>): Promise<unknown> =>
    fence ? fence.write("lifecycle", write) : write();
  await guarded(() => store.updateTask(task.id, { mergeDetails, ...pausePatch }));
  await guarded(() => upsertZeroCommitManualMergeHold(store, task.id, refusal));
  await guarded(() => logZeroCommitGuardEvent(store, task, source, `REFUSED ${refusal}`, `code=${code} contentBasis=${contentBasis}`));
  emitZeroCommitAudit(store, task.id, "task:zero-commit-landing-proof-refused", {
    source,
    code,
    contentState,
    modifiedCount,
    untrackedCount,
    pathCount: uncommittedPaths.length,
    contentBasis,
    aheadCommitCount: aheadCommitCount ?? "unreadable",
    pointersPreserved: Boolean(task.branch && task.worktree),
  });
}

/** Row-`error` prefix for a delivery-unproven refusal, on the `AUTO_MERGE_RETRY_REJECTED:` pattern. */
export const DELIVERY_UNPROVEN_ERROR_PREFIX = "DELIVERY_UNPROVEN:";

/** Remove the durable hold once a re-evaluation shows its cause is gone. */
export async function clearZeroCommitUncommittedWorkHold(
  store: TaskStore,
  task: Task,
  source: ZeroCommitGuardSource,
  fence?: MergeWriteFence,
): Promise<void> {
  const existing = task.mergeDetails;
  if (!existing || !isUncommittedWorkHold(existing)) return;
  if (fence?.isOrphaned()) return;
  const { uncommittedWorkHold: _cleared, ...rest } = existing;
  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 6):
  Clearing releases exactly what the hold stamped — the marker, the pause pair, and its prefixed `error`
  sentence — and nothing else. The release keys on the prefix rather than on `error` being non-empty, so a
  sentence another owner wrote (an exhausted auto-merge retry park) is never erased by an unrelated landing
  proof arriving.
  */
  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 6):
  Release restores the pre-refusal state when the hold recorded one, so a card someone else was holding stays
  held. Only a refusal that found an unheld, unaired row produced the pause it now removes.
  */
  const restore = existing.uncommittedWorkHold?.priorRowHold;
  const releasePatch = restore
    ? {
        paused: restore.paused,
        pausedReason: restore.pausedReason ?? null,
        pausedReasonSource: null,
        error: restore.error ?? null,
      }
    : task.error?.startsWith(DELIVERY_UNPROVEN_ERROR_PREFIX)
      ? { paused: false, pausedReason: null, pausedAt: null, pausedReasonSource: null, error: null }
      : {};
  const write = () => store.updateTask(task.id, { mergeDetails: rest as MergeDetails, ...releasePatch });
  await (fence ? fence.write("lifecycle", write) : write());
  await logZeroCommitGuardEvent(store, task, source, "zero-commit landing proof obtained; manual-merge hold cleared");
  emitZeroCommitAudit(store, task.id, "task:zero-commit-landing-proof-cleared", {
    source,
    priorCode: existing.uncommittedWorkHold?.code ?? "unknown",
  });
}

/**
 * Write the queue-level manual hold. A direct upsert, never `transitionMergeRequestState`: that state
 * machine has no edge into `manual-required` and throws instead of recording the hold. The scheduler, the
 * drain, and the shadow dequeue already treat `manual-required` as terminal-for-automation, and the graph
 * classifier maps it to `manual-required` rather than `merge-failed`.
 */
export async function upsertZeroCommitManualMergeHold(store: TaskStore, taskId: string, refusal: string): Promise<void> {
  try {
    await store.upsertMergeRequestRecord(taskId, {
      state: "manual-required",
      now: new Date().toISOString(),
      lastError: refusal,
    });
  } catch {
    // The row-visible hold marker is already durable, so the card still refuses every door. Losing the
    // queue-level hold costs a redundant merge attempt, not safety.
  }
}

async function logZeroCommitGuardEvent(
  store: TaskStore,
  task: Task,
  source: ZeroCommitGuardSource,
  action: string,
  outcome?: string,
): Promise<void> {
  try {
    await store.logEntry(task.id, `[${source}] ${action}`, outcome);
  } catch {
    // Telemetry must never change a merge decision.
  }
}

function emitZeroCommitAudit(
  store: TaskStore,
  taskId: string,
  mutationType: "task:zero-commit-landing-proof-refused" | "task:zero-commit-landing-proof-deferred" | "task:zero-commit-landing-proof-cleared",
  metadata: Record<string, unknown>,
): void {
  emitBoundedRunAudit(store, {
    taskId,
    agentId: "merger",
    runId: `merge-${taskId}`,
    domain: "git",
    mutationType,
    target: taskId,
    metadata,
  });
}

/**
 * The refusal sentence a held row carries. Falls back to the canonical unverifiable-content sentence for
 * a hold written without one, so no caller has to invent its own wording.
 */
export function readZeroCommitUncommittedWorkHold(task: Task): string | undefined {
  const hold = task.mergeDetails?.uncommittedWorkHold;
  if (!hold) return undefined;
  return hold.reason?.trim() || CONTENT_UNVERIFIABLE_REFUSAL;
}
