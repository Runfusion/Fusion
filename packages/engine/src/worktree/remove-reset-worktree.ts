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

export interface ReconcileTaskResetSessionRootInput {
  sessionRootPath: string;
  taskId: string;
  liveOwnerProbe?: LiveBindingProbe;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  settleTooRecent?: boolean;
}

export class ResetWorktreeForeignSessionError extends Error {
  constructor(public readonly details: { worktreePath: string; holderTaskId: string; holderKind: string }) {
    super(`worktree ${details.worktreePath} is held by ${details.holderTaskId} (${details.holderKind})`);
  }
}

async function reconcileTaskResetRegistration(
  path: string,
  taskId: string,
  options: Pick<ReconcileTaskResetSessionRootInput, "liveOwnerProbe" | "now" | "wait" | "settleTooRecent">,
): Promise<void> {
  const probe = options.liveOwnerProbe ?? ((_path: string, id: string) => executingTaskLock.has(id) || isPlanningLive(id));
  const processActiveProbe = (id: string) => executingTaskLock.has(id);
  const reconcile = () => reconcileSelfOwnedActiveSessionForRemoval(
    activeSessionRegistry, path, taskId, probe, { processActiveProbe, now: options.now },
  );
  let outcome = reconcile();
  if (outcome.action === "too-recent-refuses" && options.settleTooRecent !== false) {
    const waitMs = Math.max(0, Math.min(DEFAULT_SELF_OWNED_MIN_IDLE_MS, outcome.minIdleMs - outcome.ageMs));
    await (options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(waitMs);
    outcome = reconcile();
  }
  if (outcome.action === "foreign-task") {
    const record = activeSessionRegistry.lookupByPath(path);
    throw new ResetWorktreeForeignSessionError({ worktreePath: path, holderTaskId: outcome.ownerTaskId, holderKind: record?.kind ?? "unknown" });
  }
  if (outcome.action === "live-binding-refuses" || outcome.action === "process-active-refuses" || outcome.action === "too-recent-refuses") {
    const record = activeSessionRegistry.lookupByPath(path);
    throw new ActiveSessionWorktreeRemovalError({ worktreePath: path, taskId: outcome.ownerTaskId, kind: record?.kind ?? "unknown", ownerKey: record?.ownerKey ?? "unknown", reason: RemovalReason.TaskReset });
  }
}

/*
FNXC:TaskReset 2026-08-28-08:09:
A new-layout workspace session is registered at its non-Git coordinator directory. Reset must apply the same live, foreign, process-active, and idle classification there because probing only repository children makes those refusals structurally unreachable for the session root.
*/
export async function reconcileTaskResetSessionRoot(input: ReconcileTaskResetSessionRootInput): Promise<void> {
  await reconcileTaskResetRegistration(input.sessionRootPath, input.taskId, input);
}

/*
FNXC:TaskReset 2026-08-22-04:45:
The reset fence proves only registrations it released. A surviving self-owned entry still needs the normal idle and liveness gates: treating it as dead would let Reset remove a live planner worktree.
*/
export async function removeTaskResetWorktree(input: RemoveTaskResetWorktreeInput): Promise<WorktreeRemoveOutcome> {
  const probe = input.liveOwnerProbe ?? ((_path: string, id: string) => executingTaskLock.has(id) || isPlanningLive(id));
  const reconcileForRemoval = () => reconcileTaskResetRegistration(input.worktreePath, input.taskId, input);
  await reconcileForRemoval();
  const remove = input.remove ?? removeWorktree;
  const options = {
    worktreePath: input.worktreePath, rootDir: input.rootDir, settings: input.settings, taskId: input.taskId, audit: input.audit,
    reason: RemovalReason.TaskReset, expectedOwnerTaskId: input.taskId, liveOwnerProbe: probe,
    processActiveProbe: (id: string) => executingTaskLock.has(id),
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
