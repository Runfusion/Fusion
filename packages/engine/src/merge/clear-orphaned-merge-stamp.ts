import type { Task, TaskStore } from "@fusion/core";
import {
  DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS,
  isStaleMergeActiveStatus,
  shouldClearOrphanedMergeStamp,
} from "./merge-active-status.js";

export type OwnedMergeStampSource = "MergeAborted" | "MergeQueue";

type MergeStampStore = Pick<TaskStore, "getTask" | "updateTask" | "logEntry"> & {
  updateTaskAtomic?: TaskStore["updateTaskAtomic"];
};

/*
FNXC:MergeReliability 2026-08-20-02:00:
Authorization B lets an owner that has ended its own in-process generation clear its transient
stamp even though that generation's abort fence now rejects lifecycle writes. The atomic re-read
only preserves concurrently finalized or confirmed rows; it cannot distinguish two identical
`merging` stamps and is never a successor guard. The accepted limitation is that a different
process can claim in the tiny abort-to-clear window, matching ProjectEngine's existing owner path.

Authorization C has no owner proof, so it additionally requires age evidence before a manual door
can clear residue from a hard kill. This avoids yanking a fresh stamp written by another process.
*/

const messageFor = (source: OwnedMergeStampSource, status: string) =>
  source === "MergeAborted"
    ? `Auto-recovered: cleared stale '${status}' status`
    : `Auto-recovered: reconciled orphaned '${status}' merge status`;

async function clearWhen(
  store: MergeStampStore,
  taskId: string,
  mayClear: (task: Task) => boolean,
): Promise<string | undefined> {
  let clearedStatus: string | undefined;
  try {
    if (typeof store.updateTaskAtomic === "function") {
      await store.updateTaskAtomic(taskId, (live) => {
        if (!mayClear(live)) return null;
        clearedStatus = live.status ?? undefined;
        return { status: null };
      });
    } else {
      const live = await store.getTask(taskId);
      if (!mayClear(live)) return undefined;
      clearedStatus = live.status ?? undefined;
      await store.updateTask(taskId, { status: null });
    }
  } catch {
    return undefined;
  }
  return clearedStatus;
}

/** Clear an ended local generation's stamp (authorization B). */
export async function clearOwnedMergeStamp(
  store: MergeStampStore,
  taskId: string,
  source: OwnedMergeStampSource,
): Promise<boolean> {
  const clearedStatus = await clearWhen(store, taskId, shouldClearOrphanedMergeStamp);
  if (!clearedStatus) return false;
  await store.logEntry(taskId, messageFor(source, clearedStatus), source).catch(() => undefined);
  return true;
}

/** Clear only age-proven residue when this caller has no merge-owner proof (authorization C). */
export async function reconcileUnownedStaleMergeStamp(
  store: MergeStampStore,
  taskId: string,
  opts: { nowMs?: number; minAgeMs?: number } = {},
): Promise<boolean> {
  const minAgeMs = opts.minAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS;
  const clearedStatus = await clearWhen(store, taskId, (task) =>
    shouldClearOrphanedMergeStamp(task)
    && isStaleMergeActiveStatus(task, { nowMs: opts.nowMs ?? Date.now(), minAgeMs }),
  );
  return Boolean(clearedStatus);
}
