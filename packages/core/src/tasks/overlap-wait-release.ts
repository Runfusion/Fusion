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

/*
FNXC:OverlapWaitRelease 2026-11-04-02:10 (RUFU-373):
Both sentences that mean "this card is waiting on a file-scope predecessor" are recoverable, and they stay
recoverable AFTER the heartbeat acquisition cap has wrapped one of them. SANE-436's live row read
`Worktree acquisition failed after 3 heartbeat attempts for branch "fusion/sane-436": Delivered file evidence
is not yet available for overlap synchronization`; the exact-match version of this predicate could not see
it, so neither the released-overlap-waits sweep nor the heartbeat retry-cap gate could resume a card whose
wait had already composed out — permanently, even after its predecessor landed.

The wrapper is stripped by SHAPE, not by matching the message body, and only a worktree-acquisition wrapper
is stripped: a non-overlap exhaustion message ("fatal: not a git repository") must stay unrecoverable so an
ordinary broken checkout still gets its bounded retries. The inner sentence is then compared exactly, keeping
the predicate's existing no-substring semantics.
*/
const WORKTREE_ACQUISITION_WRAPPER = /^Worktree acquisition failed after \d+ heartbeat attempts for branch "[^"]*":\s*(.+)$/;

export function isRecoverableOverlapWaitFailure(error: string | null | undefined): boolean {
  if (typeof error !== "string") return false;
  const unwrapped = WORKTREE_ACQUISITION_WRAPPER.exec(error)?.[1] ?? error;
  return unwrapped === OVERLAP_DELIVERY_UNAVAILABLE_ERROR
    || /^Overlap synchronization episode [\w-]+ changed before (claim|publication)$/.test(unwrapped);
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
