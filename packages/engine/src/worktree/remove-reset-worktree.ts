import type { Settings } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock, reconcileSelfOwnedActiveSessionForRemoval, DEFAULT_SELF_OWNED_MIN_IDLE_MS, type LiveBindingProbe } from "../agents/active-session-registry.js";
import { isPlanningLive } from "../agents/planning-liveness.js";
import { ActiveSessionWorktreeRemovalError, removeWorktree, RemovalReason, type WorktreeRemoveOutcome } from "./worktree-backend.js";

export interface RemoveTaskResetWorktreeInput {
  worktreePath: string;
  rootDir: string;
  settings: Partial<Settings>;
  taskId: string;
  audit?: Parameters<typeof removeWorktree>[0]["audit"];
  liveOwnerProbe?: LiveBindingProbe;
  remove?: (input: Parameters<typeof removeWorktree>[0]) => Promise<WorktreeRemoveOutcome>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export class ResetWorktreeForeignSessionError extends Error {
  constructor(public readonly details: { worktreePath: string; holderTaskId: string; holderKind: string }) {
    super(`worktree ${details.worktreePath} is held by ${details.holderTaskId} (${details.holderKind})`);
  }
}

/*
FNXC:TaskReset 2026-08-22-04:45:
The reset fence proves only registrations it released. A surviving self-owned entry still needs the normal idle and liveness gates: treating it as dead would let Reset remove a live planner worktree.
*/
export async function removeTaskResetWorktree(input: RemoveTaskResetWorktreeInput): Promise<WorktreeRemoveOutcome> {
  const probe = input.liveOwnerProbe ?? ((_path: string, id: string) => executingTaskLock.has(id) || isPlanningLive(id));
  const processActiveProbe = (id: string) => executingTaskLock.has(id);
  const reconcile = () => reconcileSelfOwnedActiveSessionForRemoval(
    activeSessionRegistry, input.worktreePath, input.taskId, probe, { processActiveProbe, now: input.now },
  );
  const reconcileForRemoval = async () => {
    let outcome = reconcile();
    if (outcome.action === "too-recent-refuses") {
      const waitMs = Math.max(0, Math.min(DEFAULT_SELF_OWNED_MIN_IDLE_MS, outcome.minIdleMs - outcome.ageMs));
      await (input.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(waitMs);
      outcome = reconcile();
    }
    if (outcome.action === "foreign-task") {
      const record = activeSessionRegistry.lookupByPath(input.worktreePath);
      throw new ResetWorktreeForeignSessionError({ worktreePath: input.worktreePath, holderTaskId: outcome.ownerTaskId, holderKind: record?.kind ?? "unknown" });
    }
    if (outcome.action === "live-binding-refuses" || outcome.action === "process-active-refuses" || outcome.action === "too-recent-refuses") {
      const record = activeSessionRegistry.lookupByPath(input.worktreePath);
      throw new ActiveSessionWorktreeRemovalError({ worktreePath: input.worktreePath, taskId: outcome.ownerTaskId, kind: record?.kind ?? "unknown", ownerKey: record?.ownerKey ?? "unknown", reason: RemovalReason.TaskReset });
    }
  };
  await reconcileForRemoval();
  const remove = input.remove ?? removeWorktree;
  const options = {
    worktreePath: input.worktreePath, rootDir: input.rootDir, settings: input.settings, taskId: input.taskId, audit: input.audit,
    reason: RemovalReason.TaskReset, expectedOwnerTaskId: input.taskId, liveOwnerProbe: probe, processActiveProbe,
  };
  try {
    return await remove(options);
  } catch (error) {
    if (!(error instanceof ActiveSessionWorktreeRemovalError) || error.details.taskId !== input.taskId) throw error;
    // A new holder can appear after the first reconcile. Re-apply every normal gate before
    // the sole retry; ignoring this result would turn a live or fresh registration into deletion.
    await reconcileForRemoval();
    return await remove(options);
  }
}
