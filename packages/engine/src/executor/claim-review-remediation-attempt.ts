import { randomUUID } from "node:crypto";
import {
  classifyRemediationAttemptClaim,
  type Task,
  type TaskStore,
  type WorkflowStepResult,
} from "@fusion/core";
import { reviewInputSignature } from "./request-pre-merge-optional-step-fix.js";

export type ReviewRemediationClaim = {
  workflowStepId: string;
  signature: string;
  owner: string;
};

/*
FNXC:LifecycleContainment 2026-08-30-19:52:
Every outcome here is REPORTED, because the caller's decision to stay silent is only safe when some
other writer owns the narrative. `superseded`, `held`, and `refused` each have such an owner: the
newer round, the live claimant, or the refusal already recorded once. `unavailable` has none — it
means the claim could not be written at all — so collapsing it into those three made an unexplained
bookkeeping failure mute the card, which is the exact stranding this claim protocol exists to remove.
Measured on FN-270: a failed Code Review produced no fix steps, no claim marker, and zero remediation
log entries; the card could not explain its own state.
*/
export type ClaimReviewRemediationAttemptResult =
  | { kind: "claimed"; claim: ReviewRemediationClaim; task: Task; result: WorkflowStepResult }
  | { kind: "unkeyable"; task: Task }
  | { kind: "superseded" | "held" | "refused" | "missing" }
  | { kind: "unavailable"; reason: string };

type ClaimStore = TaskStore & {
  updateWorkflowStepResultsFenced?: TaskStore["updateWorkflowStepResultsFenced"];
  updateWorkflowStepResultsWithLogFenced?: TaskStore["updateWorkflowStepResultsWithLogFenced"];
};

/*
FNXC:LifecycleContainment 2026-08-30-12:57:
FN-267 deliberately mirrors, rather than reuses, the graph result writer. The first tier is a
PostgreSQL advisory-lock CAS; minimal stores fall back to updateTaskAtomic then direct writes for
unit compatibility. Only the first tier serializes across engine processes, so callers treat it as
the correctness boundary and lower tiers as deterministic test/legacy compatibility.
*/
async function fencedMutation(
  store: ClaimStore,
  taskId: string,
  compute: (current: Task) => { workflowStepResults: WorkflowStepResult[] } | null,
): Promise<{ applied: boolean; task?: Task; unavailable?: boolean; reason?: string }> {
  if (typeof store.updateWorkflowStepResultsFenced === "function") {
    const outcome = await store.updateWorkflowStepResultsFenced(taskId, compute);
    if (outcome.applied) return { applied: true, task: outcome.task };
    if (outcome.reason !== "unavailable") return { applied: false, reason: outcome.reason };
  }
  if (typeof store.updateTaskAtomic === "function") {
    let applied = false;
    const task = await store.updateTaskAtomic(taskId, (current) => {
      const patch = compute(current);
      if (patch) applied = true;
      return patch;
    });
    return applied ? { applied: true, task } : { applied: false };
  }
  const current = await store.getTask(taskId);
  if (!current) return { applied: false, unavailable: true };
  const patch = compute(current);
  if (!patch) return { applied: false };
  await store.updateTask(taskId, patch);
  return { applied: true, task: { ...current, ...patch } };
}

function replaceResult(results: readonly WorkflowStepResult[] | undefined, stepId: string, replacement: WorkflowStepResult): WorkflowStepResult[] {
  return (results ?? []).map((result) => result.workflowStepId === stepId ? replacement : result);
}

export async function claimRemediationAttempt(
  store: ClaimStore,
  taskId: string,
  target: WorkflowStepResult,
  source: string = "self-healing",
  fallbackTask?: Task,
): Promise<ClaimReviewRemediationAttemptResult> {
  const signature = reviewInputSignature(target);
  if (!signature) {
    const task = fallbackTask ?? await store.getTask(taskId);
    return task ? { kind: "unkeyable", task } : { kind: "missing" };
  }
  const claim: ReviewRemediationClaim = {
    workflowStepId: target.workflowStepId,
    signature,
    owner: `${source}:${randomUUID()}`,
  };
  let claimedResult: WorkflowStepResult | undefined;
  /* Why admission was declined, so the caller can tell "someone else owns this" from "nobody does". */
  let declined: "superseded" | "held" | "refused" | "missing" | undefined;
  const applied = await fencedMutation(store, taskId, (current) => {
    const live = current.workflowStepResults?.find((result) => result.workflowStepId === claim.workflowStepId);
    const liveSignature = live ? reviewInputSignature(live) : undefined;
    /*
    FNXC:LifecycleContainment 2026-08-30-13:36:
    The core classifier collapses two different mismatches into `signature-moved`, and admission
    must separate them. A runner whose OWN snapshot no longer matches the in-transaction row has
    lost and is refused here. A mismatch against the PERSISTED claim means that claim (including a
    retained refusal) belongs to a review round that no longer exists, so the live round must be
    admitted and the stale fields overwritten — otherwise a refusal would silence not just its own
    round but every future one, stranding the card exactly as this task's own defect did.
    */
    if (!live) {
      declined = "missing";
      return null;
    }
    if (liveSignature !== claim.signature) {
      declined = "superseded";
      return null;
    }
    const disposition = classifyRemediationAttemptClaim(current.workflowStepResults, {
      workflowStepId: claim.workflowStepId,
      signature: claim.signature,
      liveSignature,
      owner: claim.owner,
      now: Date.now(),
    });
    const admissible = disposition.kind === "claimable"
      || disposition.kind === "reclaimable"
      || disposition.kind === "signature-moved";
    if (!admissible) {
      declined = disposition.kind === "refused" ? "refused"
        : disposition.kind === "held" ? "held"
        : disposition.kind === "absent" ? "missing"
        : "superseded";
      return null;
    }
    claimedResult = {
      ...live,
      remediationAttemptSignature: claim.signature,
      remediationAttemptOwner: claim.owner,
      remediationAttemptClaimedAt: new Date().toISOString(),
      remediationRefusedReason: undefined,
    };
    return { workflowStepResults: replaceResult(current.workflowStepResults, claim.workflowStepId, claimedResult) };
  });
  if (applied.applied && applied.task && claimedResult) {
    return { kind: "claimed", claim, task: applied.task, result: claimedResult };
  }
  /* The compute ran and declined: an owner exists, so this runner is right to stay quiet. */
  if (declined) return { kind: declined };
  if (applied.reason === "task-missing" || applied.reason === "task-deleted") return { kind: "missing" };
  /* The compute never ran, or its write was lost. Nobody owns the narrative — say so. */
  return { kind: "unavailable", reason: applied.unavailable ? "store-unavailable" : applied.reason ?? "write-lost" };
}

export async function reassertRemediationAttempt(
  store: ClaimStore,
  taskId: string,
  claim: ReviewRemediationClaim,
): Promise<{ applied: boolean; task?: Task }> {
  return fencedMutation(store, taskId, (current) => {
    const live = current.workflowStepResults?.find((result) => result.workflowStepId === claim.workflowStepId);
    const disposition = classifyRemediationAttemptClaim(current.workflowStepResults, {
      workflowStepId: claim.workflowStepId,
      signature: claim.signature,
      liveSignature: live ? reviewInputSignature(live) : undefined,
      owner: claim.owner,
      now: Date.now(),
    });
    if (disposition.kind !== "owned" || !live) return null;
    return { workflowStepResults: replaceResult(current.workflowStepResults, claim.workflowStepId, {
      ...live,
      remediationAttemptClaimedAt: new Date().toISOString(),
    }) };
  });
}

/*
FNXC:LifecycleContainment 2026-08-30-13:36:
A retained refusal has TWO durable effects — the marker that suppresses future attempts and the
entry that explains the card to an operator — and validating ownership before them still leaves a
check-then-act gap: a newer round can land between the check and the write, letting an overtaken
runner explain an obsolete review. Both effects therefore happen inside ONE ownership-checked
mutation, under the same task lock the log writer itself uses, so there is no interval to lose the
claim in. Stores without the atomic seam fall back to the previous two-step form, which remains
correct for the single-runner case they model.
*/
export async function retainRefusalWithNarration(
  store: ClaimStore,
  taskId: string,
  claim: ReviewRemediationClaim,
  reason: NonNullable<WorkflowStepResult["remediationRefusedReason"]>,
  entry: { action: string; outcome?: string },
): Promise<boolean> {
  const ownedPatch = (current: Task) => {
    const live = current.workflowStepResults?.find((result) => result.workflowStepId === claim.workflowStepId);
    const disposition = classifyRemediationAttemptClaim(current.workflowStepResults, {
      workflowStepId: claim.workflowStepId,
      signature: claim.signature,
      liveSignature: live ? reviewInputSignature(live) : undefined,
      owner: claim.owner,
      now: Date.now(),
    });
    if (disposition.kind !== "owned" || !live || live.status !== "failed") return null;
    return replaceResult(current.workflowStepResults, claim.workflowStepId, {
      ...live,
      remediationRefusedReason: reason,
    });
  };

  /* Tier 1 — one advisory-locked transaction across processes: both effects, or neither. */
  if (typeof store.updateWorkflowStepResultsWithLogFenced === "function") {
    const outcome = await store.updateWorkflowStepResultsWithLogFenced(taskId, (current) => {
      const workflowStepResults = ownedPatch(current);
      if (!workflowStepResults) return null;
      return {
        workflowStepResults,
        logEntry: { timestamp: new Date().toISOString(), action: entry.action, outcome: entry.outcome },
      };
    });
    if (outcome.applied || outcome.reason !== "unavailable") return outcome.applied;
  }
  if (typeof store.updateTaskAtomic !== "function") {
    const reasserted = await reassertRemediationAttempt(store, taskId, claim);
    if (!reasserted.applied) return false;
    await store.logEntry(taskId, entry.action, entry.outcome);
    const retained = await resolveRemediationAttempt(store, taskId, claim, "retain", reason);
    return retained.applied;
  }
  let applied = false;
  await store.updateTaskAtomic(taskId, (current) => {
    const live = current.workflowStepResults?.find((result) => result.workflowStepId === claim.workflowStepId);
    const disposition = classifyRemediationAttemptClaim(current.workflowStepResults, {
      workflowStepId: claim.workflowStepId,
      signature: claim.signature,
      liveSignature: live ? reviewInputSignature(live) : undefined,
      owner: claim.owner,
      now: Date.now(),
    });
    if (disposition.kind !== "owned" || !live || live.status !== "failed") return null;
    applied = true;
    return {
      workflowStepResults: replaceResult(current.workflowStepResults, claim.workflowStepId, {
        ...live,
        remediationRefusedReason: reason,
      }),
      log: [...(current.log ?? []), {
        timestamp: new Date().toISOString(),
        action: entry.action,
        outcome: entry.outcome,
      }],
    };
  });
  return applied;
}

export async function resolveRemediationAttempt(
  store: ClaimStore,
  taskId: string,
  claim: ReviewRemediationClaim,
  resolution: "release" | "retain",
  reason?: WorkflowStepResult["remediationRefusedReason"],
): Promise<{ applied: boolean; task?: Task }> {
  return fencedMutation(store, taskId, (current) => {
    const live = current.workflowStepResults?.find((result) => result.workflowStepId === claim.workflowStepId);
    const disposition = classifyRemediationAttemptClaim(current.workflowStepResults, {
      workflowStepId: claim.workflowStepId,
      signature: claim.signature,
      liveSignature: live ? reviewInputSignature(live) : undefined,
      owner: claim.owner,
      now: Date.now(),
    });
    if (disposition.kind !== "owned" || !live) return null;
    if (resolution === "retain" && live.status !== "failed") return null;
    const replacement: WorkflowStepResult = resolution === "release"
      ? (() => {
          const {
            remediationAttemptSignature: _signature,
            remediationAttemptOwner: _owner,
            remediationAttemptClaimedAt: _claimedAt,
            remediationRefusedReason: _reason,
            ...released
          } = live;
          return released;
        })()
      : { ...live, remediationRefusedReason: reason ?? "appender-declined" };
    return { workflowStepResults: replaceResult(current.workflowStepResults, claim.workflowStepId, replacement) };
  });
}
