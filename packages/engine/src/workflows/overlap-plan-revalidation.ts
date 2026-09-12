import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { OverlapWaitReceipt, Task, TaskOverlapWait, TaskStore, WorkflowStep } from "@fusion/core";
import type { WorkflowStepOutcome } from "../executor/workflow-step-verdict.js";

const execFileAsync = promisify(execFile);

export type OverlapDeltaVerdict = "APPROVE" | "REVISE" | "UNAVAILABLE";
export interface OverlapDeltaReviewResult {
  verdict: OverlapDeltaVerdict;
  feedback?: string;
  invalidatedPromise?: string;
}

export function buildOverlapDeltaReviewPrompt(input: {
  task: Pick<Task, "id" | "prompt" | "steps" | "currentStep">;
  receipt: OverlapWaitReceipt;
}): string {
  return [
    "OVERLAP_DELTA_PLAN_REVALIDATION:",
    "Review only whether the delivered delta invalidates an explicit promise in the already-approved plan.",
    "Do not judge the current implementation, rewrite the whole plan, or infer a failure from unavailable evidence.",
    `Task: ${input.task.id}`,
    `Current step: ${input.task.currentStep ?? 0}; completed progress must be preserved.`,
    `Decision fingerprint: ${input.receipt.decisionFingerprint}`,
    `Affected delivered files:\n${input.receipt.commonFiles.map((path) => `- ${path}`).join("\n")}`,
    `Delivery facts:\n${input.receipt.deliveryProofs.map((proof) => `- ${proof.repository}@${proof.landedSha ?? proof.evidence ?? "unknown"}`).join("\n")}`,
    `Approved plan:\n${input.task.prompt ?? "(unavailable)"}`,
    "Return APPROVE when the existing promises remain true. Return REVISE only with the exact invalidated promise and a targeted repair. Return UNAVAILABLE for missing evidence, timeout, cancellation, or transport failure.",
  ].join("\n\n");
}

function normalizeVerdict(result: unknown): OverlapDeltaReviewResult {
  if (!result || typeof result !== "object") return { verdict: "UNAVAILABLE" };
  const candidate = result as { verdict?: unknown; feedback?: unknown; invalidatedPromise?: unknown };
  if (candidate.verdict !== "APPROVE" && candidate.verdict !== "REVISE") return { verdict: "UNAVAILABLE" };
  if (candidate.verdict === "REVISE" && (typeof candidate.invalidatedPromise !== "string" || !candidate.invalidatedPromise.trim())) {
    return { verdict: "UNAVAILABLE" };
  }
  return {
    verdict: candidate.verdict,
    ...(typeof candidate.feedback === "string" ? { feedback: candidate.feedback } : {}),
    ...(typeof candidate.invalidatedPromise === "string" ? { invalidatedPromise: candidate.invalidatedPromise } : {}),
  };
}

/**
 * Graph-owned delta review primitive. Callers retain their real graph node/continuation and use
 * the combined identity as the cache key; an ordinary plan approval can never satisfy it.
 */
export async function runOverlapPlanRevalidation(input: {
  task: Pick<Task, "id" | "prompt" | "steps" | "currentStep">;
  receipt: OverlapWaitReceipt;
  expectedIdentity: string;
  readCurrentIdentity: () => Promise<string | null>;
  review: (prompt: string, options: { cacheKey: string; nested: true }) => Promise<unknown>;
}): Promise<OverlapDeltaReviewResult> {
  if (input.receipt.decision !== "revalidate") return { verdict: "APPROVE" };
  if (await input.readCurrentIdentity() !== input.expectedIdentity) return { verdict: "UNAVAILABLE" };
  let raw: unknown;
  try {
    raw = await input.review(buildOverlapDeltaReviewPrompt(input), { cacheKey: input.expectedIdentity, nested: true });
  } catch {
    return { verdict: "UNAVAILABLE" };
  }
  const verdict = normalizeVerdict(raw);
  if (verdict.verdict === "UNAVAILABLE") return verdict;
  if (await input.readCurrentIdentity() !== input.expectedIdentity) return { verdict: "UNAVAILABLE" };
  return verdict;
}

export type OverlapGraphRevalidationOutcome = "not-required" | "approved" | "revise" | "unavailable" | "superseded";

function currentDeltaIdentity(task: Pick<Task, "prompt">, receipt: OverlapWaitReceipt): string {
  return createHash("sha256").update(`${task.prompt ?? ""}\0${receipt.decisionFingerprint}`).digest("hex");
}

/**
 * FNXC:OverlapWaitSynchronization 2026-09-10-00:52:
 * A structural overlap decision is a graph-owned sub-phase of the real resume node. The graph must
 * persist APPROVE before dispatching that node, while REVISE and unavailable transports retain the
 * same continuation and never authorize ordinary work.
 */
export async function revalidatePendingOverlapWaitsAtGraphNode(input: {
  task: Task;
  store: Pick<TaskStore, "listTaskOverlapWaits" | "claimTaskOverlapWait" | "completeTaskOverlapWait" | "getTask">;
  nodeId: string;
  review: (step: WorkflowStep) => Promise<WorkflowStepOutcome>;
  repair: (input: { episode: TaskOverlapWait; invalidatedPromise: string; feedback: string }) => Promise<boolean>;
  /** Internal fence: one graph admission may repair and revalidate once, never spin indefinitely. */
  allowInlineRepairRevalidation?: boolean;
}): Promise<OverlapGraphRevalidationOutcome> {
  if (typeof input.store.listTaskOverlapWaits !== "function") return "not-required";
  const pending = await input.store.listTaskOverlapWaits(input.task.id, { pendingOnly: true });
  if (!Array.isArray(pending)) return "not-required";
  const candidates = pending
    .filter((episode): episode is TaskOverlapWait & { receipt: OverlapWaitReceipt; owner: string } =>
      (episode.phase === "revalidation-pending" || episode.phase === "repair-required")
      && episode.receipt?.decision === "revalidate"
      && typeof episode.owner === "string"
      && episode.owner.length > 0,
    );
  if (candidates.length === 0) return "not-required";

  for (const candidate of candidates) {
    let episode = candidate;
    if (candidate.phase === "repair-required") {
      const live = await input.store.getTask(input.task.id);
      const repairedPlanFingerprint = live?.prompt
        ? createHash("sha256").update(live.prompt).digest("hex")
        : undefined;
      if (!live || !repairedPlanFingerprint || repairedPlanFingerprint === candidate.planFingerprint) return "revise";
      /*
      FNXC:OverlapWaitSynchronization 2026-09-10-03:18:
      A targeted repair is not authorization to resume. Once the safe plan writer has published a
      genuinely new plan, reclaim the same durable episode against that plan/check-out generation
      and run the delta review again before the original graph node may dispatch.
      */
      const priorExecutionIdentity = candidate.observation?.executionIdentity as import("@fusion/core").OverlapWaitExecutionIdentity | undefined;
      let currentHeadSha = priorExecutionIdentity?.headSha;
      if (live.worktree) {
        try {
          currentHeadSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: live.worktree, encoding: "utf8" })).stdout.trim();
        } catch {
          return "superseded";
        }
      }
      /*
      FNXC:OverlapWaitSynchronization 2026-09-10-04:52:
      Reclaim after targeted plan repair must preserve repository, target and graph-incarnation fences,
      while recapturing the current checkout HEAD before the claim. The exact same complete identity is
      then used to re-arm and publish approval, so the inter-process CAS accepts only this generation.
      */
      const repairedExecutionIdentity: import("@fusion/core").OverlapWaitExecutionIdentity = {
        ...priorExecutionIdentity,
        ...(live.lineageId ? { taskLineageId: live.lineageId } : {}),
        planFingerprint: repairedPlanFingerprint,
        ...(live.checkoutLeaseEpoch != null ? { checkoutEpoch: String(live.checkoutLeaseEpoch) } : {}),
        ...(live.worktree ? { worktree: live.worktree } : {}),
        ...(live.branch ? { branch: live.branch } : {}),
        ...(currentHeadSha ? { headSha: currentHeadSha } : {}),
      };
      const reclaimed = await input.store.claimTaskOverlapWait({
        taskId: input.task.id,
        episodeId: candidate.episodeId,
        expectedRevision: candidate.revision,
        owner: candidate.owner,
        ...(live.checkoutLeaseEpoch != null ? { checkoutEpoch: String(live.checkoutLeaseEpoch) } : {}),
        executionIdentity: repairedExecutionIdentity,
      });
      if (!reclaimed) return "superseded";
      const {
        revalidationVerdict: _priorVerdict,
        invalidatedPromise: _priorInvalidatedPromise,
        revalidationFeedback: _priorFeedback,
        ...repairedReceipt
      } = candidate.receipt;
      const rearmed = await input.store.completeTaskOverlapWait({
        taskId: input.task.id,
        episodeId: reclaimed.episodeId,
        expectedRevision: reclaimed.revision,
        owner: candidate.owner,
        phase: "revalidation-pending",
        executionIdentity: reclaimed.observation?.executionIdentity as import("@fusion/core").OverlapWaitExecutionIdentity | undefined,
        receipt: repairedReceipt,
      });
      if (!rearmed) return "superseded";
      episode = rearmed as typeof episode;
    }
    const expectedIdentity = currentDeltaIdentity(input.task, episode.receipt);
    const result = await runOverlapPlanRevalidation({
      task: input.task,
      receipt: episode.receipt,
      expectedIdentity,
      readCurrentIdentity: async () => {
        const live = await input.store.getTask(input.task.id);
        if (!live || live.deletedAt || live.paused || live.userPaused) return null;
        const pendingCurrent = await input.store.listTaskOverlapWaits(input.task.id, { pendingOnly: true });
        const current = Array.isArray(pendingCurrent)
          ? pendingCurrent.find((candidate) => candidate.episodeId === episode.episodeId)
          : undefined;
        if (!current || current.revision !== episode.revision || current.phase !== "revalidation-pending") return null;
        return currentDeltaIdentity(live, episode.receipt);
      },
      review: async (prompt) => {
        const now = new Date().toISOString();
        const step: WorkflowStep = {
          id: input.nodeId,
          name: "Overlap Delta Plan Revalidation",
          description: "Targeted review of delivered overlap changes against the approved plan.",
          mode: "prompt",
          phase: "pre-merge",
          gateMode: "gate",
          prompt,
          toolMode: "readonly",
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        const outcome = await input.review(step);
        if (outcome.verdict === "APPROVE" || outcome.verdict === "APPROVE_WITH_NOTES") return { verdict: "APPROVE" };
        if (outcome.verdict === "REVISE") {
          const invalidatedPromise = outcome.notes?.trim() || outcome.output?.trim();
          return invalidatedPromise ? { verdict: "REVISE", invalidatedPromise, feedback: outcome.notes } : { verdict: "UNAVAILABLE" };
        }
        return { verdict: "UNAVAILABLE" };
      },
    });
    if (result.verdict === "UNAVAILABLE") return "unavailable";
    const liveForCompletion = await input.store.getTask(input.task.id);
    /*
    FNXC:OverlapWaitSynchronization 2026-09-12-20:30:
    Settle on the identity the episode was CLAIMED with. This node runs at pre-merge, so the claim it is
    settling was taken by the pre-execution resume gate: between the two, the task legitimately commits its
    work and its spec may be rewritten. Recapturing `headSha` and re-hashing the live prompt here therefore
    guaranteed a compare-and-set mismatch for any task that actually did something — the store rejected the
    write, this function reported `superseded`, the node failed without recording a step result, and stranded
    -completed recovery re-dispatched the whole review. Measured 2026-09-12 on FN-359/FN-362: the reviewer
    returned APPROVE on every pass while `headSha` moved 175a23486 -> bff6bb6a2 and the plan hash moved
    63ca92d6 -> 812f7948, so the verdict was discarded and the pair looped for hours.

    The fences that matter at this stage are intact: `completeTaskOverlapWait` still checks the live row's
    lineage, worktree, branch, checkout epoch and node incarnation against the claim, the revision/owner CAS
    still rejects another generation, and `readCurrentIdentity` above still aborts when the episode moves
    DURING the review. Only the two facts the task's own progress is expected to change were removed.

    The repair branch above keeps its recapture, because it re-CLAIMS a new generation: there the recaptured
    HEAD becomes the stored identity, so publication still compares like with like.
    */
    const claimedIdentity = episode.observation?.executionIdentity as import("@fusion/core").OverlapWaitExecutionIdentity | undefined;
    const completionIdentity = claimedIdentity;
    if (claimedIdentity && liveForCompletion?.worktree) {
      // Liveness probe only: a vanished execution checkout is a real supersession, not a settleable review.
      try {
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: liveForCompletion.worktree, encoding: "utf8" });
      } catch {
        return "superseded";
      }
    }
    if (result.verdict === "REVISE") {
      /*
      FNXC:OverlapWaitSynchronization 2026-09-10-02:22:
      A delta REVISE is first made durable on the overlap episode, then handed to the existing
      graph remediation publisher. This prevents an ordinary node failure edge from consuming the
      verdict and makes a crash retry observe repair-required rather than dispatching another review.
      */
      const repairRequired = await input.store.completeTaskOverlapWait({
        taskId: input.task.id,
        episodeId: episode.episodeId,
        expectedRevision: episode.revision,
        owner: episode.owner,
        phase: "repair-required",
        executionIdentity: completionIdentity,
        receipt: {
          ...episode.receipt,
          revalidationVerdict: "REVISE",
          invalidatedPromise: result.invalidatedPromise,
          revalidationFeedback: result.feedback,
        },
      });
      if (!repairRequired) return "superseded";
      const scheduled = await input.repair({
        episode: repairRequired,
        invalidatedPromise: result.invalidatedPromise!,
        feedback: result.feedback?.trim() || result.invalidatedPromise!,
      });
      if (!scheduled) return "unavailable";
      /*
      FNXC:OverlapWaitSynchronization 2026-09-10-04:21:
      A targeted delta repair stays inside the graph-owned resume admission. Re-read the safely
      published plan and revalidate this same episode once before the original node can run; a
      repeated REVISE remains repair-required for the next bounded graph attempt rather than
      entering the ordinary Plan Review replan lane or looping in one admission.
      */
      if (input.allowInlineRepairRevalidation === false) return "revise";
      const repairedTask = await input.store.getTask(input.task.id);
      if (!repairedTask) return "superseded";
      return revalidatePendingOverlapWaitsAtGraphNode({
        ...input,
        task: repairedTask,
        allowInlineRepairRevalidation: false,
      });
    }
    const updated = await input.store.completeTaskOverlapWait({
      taskId: input.task.id,
      episodeId: episode.episodeId,
      expectedRevision: episode.revision,
      owner: episode.owner,
      phase: "ready",
      executionIdentity: completionIdentity,
      receipt: { ...episode.receipt, revalidationVerdict: "APPROVE" },
    });
    if (!updated) return "superseded";
  }
  return "approved";
}
