import { createHash } from "node:crypto";
import type { OverlapWaitDeliverySnapshot, OverlapWaitReceipt, Task, TaskOverlapWait, TaskStore } from "@fusion/core";
import { releaseFileScopeWaitingContinuations } from "../runtimes/in-process-runtime.js";
import { executorLog } from "../logger.js";

/*
FNXC:OverlapWaitSynchronization 2026-09-17-00:50:
Reimplementation of FN-332's graph-owned resume gate for a durable overlap-wait episode. A post-
commit wake (the blocker landing) makes a suspended continuation ELIGIBLE to run again, but does
not by itself authorize resuming ordinary work: this module claims the pending episode, derives
what the blocker actually delivered, and persists exactly one deterministic decision —
`resume` (no overlap with anything this task touches), `briefing` (overlap exists but the delivery
is proven fresh, so the resuming session gets a factual context note instead of re-planning), or
`revalidate` (overlap exists and freshness cannot be proven — the resuming plan needs an explicit
human/graph-owned re-approval before it may touch shared files again).

Scope note: the full FN-332 graph nodes ("Overlap Delta Plan Revalidation" / "Overlap Delta
Targeted Plan Repair") that let a `revalidate` decision drive an in-graph REVISE/repair loop before
the original node resumes depend on workflow-graph node kinds this reimplementation does not add
(out of this task's explicit scope — see AGENTS/task instructions). A `revalidate` decision is
still persisted and left `revalidation-pending` here; wiring it to an actual graph repair loop is a
deferred follow-up (TODO), not silently dropped.
*/

/** True when a task has at least one file-scope/dependency wait that is not yet delivered/cancelled. */
export async function hasPendingOverlapWaits(store: TaskStore, taskId: string): Promise<boolean> {
  if (typeof store.listTaskOverlapWaits !== "function") return false;
  const pending = await store.listTaskOverlapWaits(taskId, { pendingOnly: true }).catch(() => []);
  return pending.length > 0;
}

function commonFilesFor(episode: TaskOverlapWait): string[] {
  const deliveries = (episode.observation as { deliveries?: OverlapWaitDeliverySnapshot[] } | undefined)?.deliveries ?? [];
  const files = new Set<string>();
  for (const delivery of deliveries) {
    for (const path of delivery.paths ?? []) files.add(path.path);
  }
  return [...files].sort();
}

function freshnessFor(episode: TaskOverlapWait): OverlapWaitReceipt["freshness"] {
  const deliveries = (episode.observation as { deliveries?: OverlapWaitDeliverySnapshot[] } | undefined)?.deliveries ?? [];
  if (deliveries.length === 0) return "not-required";
  if (deliveries.some((delivery) => delivery.evidence === "unavailable")) return "unavailable";
  return deliveries.every((delivery) => Boolean(delivery.landedSha) || delivery.noOp === true) ? "proven" : "pending";
}

function buildBriefing(episode: TaskOverlapWait, commonFiles: string[]): string {
  const deliveries = (episode.observation as { deliveries?: OverlapWaitDeliverySnapshot[] } | undefined)?.deliveries ?? [];
  const lines = deliveries
    .filter((delivery) => (delivery.paths ?? []).some((path) => commonFiles.includes(path.path)))
    .map((delivery) => `${episode.blockerTaskId} delivered ${(delivery.paths ?? []).map((p) => p.path).join(", ")} to ${delivery.repository}${delivery.landedSha ? ` @ ${delivery.landedSha}` : ""}`);
  return `OVERLAP_WAIT_CONTEXT:\n${lines.join("\n")}`;
}

export interface OverlapWaitResolution {
  episodeId: string;
  blockerTaskId: string;
  decision: OverlapWaitReceipt["decision"];
  receipt: OverlapWaitReceipt;
}

/**
 * Claims and resolves every pending overlap-wait episode for a task. Best-effort per episode: a
 * lost claim race (another owner already has it) or a completion refusal (the task's plan/checkout
 * identity moved since the claim) is skipped rather than thrown, since the next pass will retry.
 */
export async function resolvePendingOverlapWaits(input: {
  store: TaskStore;
  task: Pick<Task, "id" | "lineageId" | "prompt" | "worktree" | "branch" | "checkoutLeaseEpoch" | "overlapBlockedBy">;
  owner: string;
  kick?: () => void;
}): Promise<OverlapWaitResolution[]> {
  const { store, task, owner } = input;
  if (typeof store.listTaskOverlapWaits !== "function" || typeof store.claimTaskOverlapWait !== "function" || typeof store.completeTaskOverlapWait !== "function") {
    return [];
  }
  const pending = await store.listTaskOverlapWaits(task.id, { pendingOnly: true }).catch(() => []);
  const resolved: OverlapWaitResolution[] = [];
  for (const episode of pending) {
    const claim = await store.claimTaskOverlapWait({
      taskId: task.id,
      episodeId: episode.episodeId,
      expectedRevision: episode.revision,
      owner,
      checkoutEpoch: task.checkoutLeaseEpoch !== undefined && task.checkoutLeaseEpoch !== null ? String(task.checkoutLeaseEpoch) : undefined,
      executionIdentity: {
        taskLineageId: task.lineageId,
        worktree: task.worktree,
        branch: task.branch,
      },
    }).catch(() => null);
    if (!claim) continue;

    const commonFiles = commonFilesFor(claim);
    const freshness = freshnessFor(claim);
    const decision: OverlapWaitReceipt["decision"] = commonFiles.length === 0
      ? "resume"
      : freshness === "proven"
        ? "briefing"
        : "revalidate";
    const receipt: OverlapWaitReceipt = {
      decision,
      freshness,
      commonFiles,
      deliveryProofs: ((claim.observation as { deliveries?: OverlapWaitDeliverySnapshot[] } | undefined)?.deliveries ?? []).map((delivery) => ({
        repository: delivery.repository,
        target: delivery.target,
        landedSha: delivery.landedSha,
        landedFiles: (delivery.paths ?? []).map((p) => p.path),
        noOp: delivery.noOp,
        evidence: delivery.evidence,
        freshness,
      })),
      decisionFingerprint: createHash("sha256").update(`${claim.episodeId}:${claim.revision}:${decision}`).digest("hex"),
      ...(decision === "briefing" ? { briefing: buildBriefing(claim, commonFiles) } : {}),
      ...(decision === "revalidate" ? { reason: `${commonFiles.length} file(s) overlap with ${episode.blockerTaskId}'s delivery and freshness is ${freshness}` } : {}),
      decidedAt: new Date().toISOString(),
      contextDeliveredAt: decision !== "revalidate" ? new Date().toISOString() : undefined,
    };
    const phase = decision === "revalidate" ? "revalidation-pending" : "delivered";
    const completed = await store.completeTaskOverlapWait({
      taskId: task.id,
      episodeId: claim.episodeId,
      expectedRevision: claim.revision,
      owner,
      phase,
      receipt,
    }).catch(() => null);
    if (!completed) continue;
    resolved.push({ episodeId: claim.episodeId, blockerTaskId: episode.blockerTaskId, decision, receipt });

    if (decision !== "revalidate") {
      /*
      FNXC:OverlapWaitSynchronization 2026-09-17-00:55:
      A resume/briefing decision retires the episode; wake any workflow continuation that this
      same task parked `held` behind this exact blocker (see FILE_SCOPE_CONTINUATION_WAIT_PREFIX
      in in-process-runtime.ts) so it re-enters the due window instead of waiting for the next
      periodic drain tick.
      */
      try {
        await releaseFileScopeWaitingContinuations(store, [{ taskId: task.id, blockerId: episode.blockerTaskId }]);
        input.kick?.();
      } catch (error) {
        executorLog.debug(`[overlap-wait] ${task.id} release-continuation best-effort failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return resolved;
}
