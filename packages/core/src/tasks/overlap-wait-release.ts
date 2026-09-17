import type { Task } from "../types.js";
import type { OverlapWaitDeliverySnapshot, TaskOverlapWait } from "../types/task/task-overlap-wait.js";

/*
FNXC:OverlapWaitRelease 2026-09-17-06:29:
A file-scope wait is not a promise that its predecessor will deliver. Reset, deletion and completion
release that scheduling dependency. Preserve concrete landed evidence for checkout synchronization,
but retire an abandoned execution with no delivery instead of waiting forever for files it cannot publish.
Explicit task.dependencies remain operator intent; only stale scheduling indicators are cleared.
*/
export const OVERLAP_DELIVERY_UNAVAILABLE_ERROR = "Delivered file evidence is not yet available for overlap synchronization";
export type OverlapPredecessorRelease = "reset" | "deleted" | "complete" | "missing";

export function isRecoverableOverlapWaitFailure(error: string | null | undefined): boolean {
  return error === OVERLAP_DELIVERY_UNAVAILABLE_ERROR
    || /^Overlap synchronization episode [\w-]+ changed before (claim|publication)$/.test(error ?? "");
}

export function overlapDeliverySnapshots(task: Pick<Task, "id" | "lineageId" | "mergeDetails" | "summary">): OverlapWaitDeliverySnapshot[] {
  const details = task.mergeDetails;
  if (!details) return [];
  const repositories = [...new Set([...Object.keys(details.workspaceLandedShas ?? {}), ...Object.keys(details.workspaceLandedFiles ?? {})])];
  if (repositories.length) return repositories.map((repository) => {
    const landedSha = details.workspaceLandedShas?.[repository];
    const files = details.workspaceLandedFiles?.[repository];
    return {
      blockerTaskId: task.id, blockerLineageId: task.lineageId, repository, landedSha,
      target: details.mergeTargetBranch, summary: task.summary,
      paths: files?.map((path) => ({ repository, path, status: "modified" as const })),
      noOp: Array.isArray(files) && files.length === 0 && !landedSha,
      evidence: "workspace-landing" as const,
    };
  });
  return [{
    blockerTaskId: task.id, blockerLineageId: task.lineageId, repository: ".", landedSha: details.commitSha,
    target: details.mergeTargetBranch, summary: task.summary,
    paths: details.landedFiles?.map((path) => ({ repository: ".", path, status: "modified" as const })),
    noOp: details.noOpVerifiedShortCircuit === true || details.noOpMerge === true,
    evidence: details.landedFilesCaptureFallback === "attribution-failed" ? "unavailable" : "merge-details",
  }];
}

export function hasConcreteOverlapDelivery(delivery: OverlapWaitDeliverySnapshot): boolean {
  return Boolean(delivery.landedSha) || Array.isArray(delivery.paths) || delivery.noOp === true;
}

// FNXC:OverlapWaitRelease 2026-09-17-06:38: Partial workspace/no-op metadata must not replace stronger delivery proof already captured for the waiter.
export function mergeOverlapDeliverySnapshots(captured: OverlapWaitDeliverySnapshot[], incoming: OverlapWaitDeliverySnapshot[]): OverlapWaitDeliverySnapshot[] {
  const strength = (delivery: OverlapWaitDeliverySnapshot) => delivery.landedSha ? 3 : delivery.paths?.length ? 2 : hasConcreteOverlapDelivery(delivery) ? 1 : 0;
  const byRepository = new Map(captured.map((delivery) => [delivery.repository, delivery]));
  for (const delivery of incoming) {
    const prior = byRepository.get(delivery.repository);
    if (!prior || strength(delivery) >= strength(prior)) byRepository.set(delivery.repository, delivery);
  }
  return [...byRepository.values()];
}

export function observedOverlapDeliveries(episode: Pick<TaskOverlapWait, "observation">): OverlapWaitDeliverySnapshot[] {
  const deliveries = episode.observation?.deliveries;
  return Array.isArray(deliveries) ? deliveries.filter((value): value is OverlapWaitDeliverySnapshot =>
    value !== null && typeof value === "object" && typeof value.repository === "string") : [];
}

export function overlapPredecessorRelease(
  episode: Pick<TaskOverlapWait, "observedAt" | "observation">,
  blocker: Task | undefined,
  completeColumns: ReadonlySet<string>,
): OverlapPredecessorRelease | undefined {
  if (typeof episode.observation?.blockerResetAt === "string") return "reset";
  if (!blocker) return "missing";
  // FNXC:OverlapWaitRelease 2026-09-17-06:29: Pre-fix Reset has no epoch stamp. Its retained lifecycle log is the upgrade proof, never the current planning column alone.
  if ((blocker.log ?? []).some((entry) => Date.parse(entry.timestamp) > Date.parse(episode.observedAt)
    && /^Reset replaced the original description/.test(entry.action))) return "reset";
  if (blocker.deletedAt) return "deleted";
  if (completeColumns.has(blocker.column)) return "complete";
  return undefined;
}
