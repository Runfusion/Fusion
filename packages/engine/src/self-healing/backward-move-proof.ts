/**
 * FNXC:CodeOrganization 2026-08-10-04:05:
 * Triple-proof backward-move gate + no-action emit peeled from SelfHealingManager (U5 / wave19 Slice B).
 *
 * FNXC:Workspace 2026-06-22-09:30:
 * evaluateBackwardMoveTripleProof keys non-workspace liveness off the singular task.worktree /
 * working branch. Workspace reconcilers use isWorkspaceTaskLive instead of this gate.
 *
 * FNXC:CodeOrganization 2026-08-23-22:38:
 * Main landed workspaceMode / durable workspace liveness (FNXC:WorkspaceRootRouting) after the
 * U5 peel. Keep that production path in this extracted helper so the class wrapper cannot drift.
 */
import type { Task, TaskStore } from "@fusion/core";
import { isWorkspaceTask } from "@fusion/core";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import {
  classifyTaskWorktree,
  getRegisteredWorktreeBranchMap,
  getRegisteredWorktreePaths,
} from "../worktree/worktree-pool.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { createRunAuditor, generateSyntheticRunId, type DatabaseMutationType } from "../util/run-audit.js";
import { getActiveNotificationService } from "../util/notifier.js";
import { describeSelfHealingNoActionWedge } from "../notification/task-wedge-notification.js";
import { createLogger } from "../logger.js";

const log = createLogger("self-healing");

export type BackwardMoveProofDeps = {
  store: TaskStore;
  rootDir: string;
  isTaskActive?: (taskId: string) => boolean;
  isWorkspaceTaskLiveDurably?: (task: Task) => Promise<{ live: boolean; livePaths: string[] }>;
};

export type BackwardMoveProofInput = {
  stage: string;
  graceMs: number;
  stalenessAnchor: string | null | undefined;
  reason: string;
  extra?: Record<string, unknown>;
  workspaceMode?: boolean;
};

export type BackwardMoveProof = {
  ok: boolean;
  stalenessMs: number;
  reason: string;
  metadata: Record<string, unknown>;
};

export async function hasRecentWorktreeIncompleteDetected(
  store: TaskStore,
  taskId: string,
  graceMs: number,
): Promise<boolean> {
  if (!Number.isFinite(graceMs) || graceMs <= 0) return false;
  let events: Array<{ timestamp?: string | null }> = [];
  try {
    events = await store.getRunAuditEventsAsync({ taskId, mutationType: "worktree:incomplete-detected", limit: 20 });
  } catch {
    return false;
  }
  if (!Array.isArray(events) || events.length === 0) return false;
  const cutoff = Date.now() - graceMs;
  return events.some((event) => {
    const ts = Date.parse(event.timestamp ?? "");
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

export async function evaluateBackwardMoveTripleProof(
  deps: BackwardMoveProofDeps,
  task: Task,
  input: BackwardMoveProofInput,
): Promise<BackwardMoveProof> {
  const livePaths = activeSessionRegistry.pathsForTask(task.id);
  const hasActiveRegisteredPath = livePaths.some((path) => activeSessionRegistry.isPathActive(path));
  const workspaceTask = input.workspaceMode ?? isWorkspaceTask(task);
  const workspaceLiveness = workspaceTask && deps.isWorkspaceTaskLiveDurably
    ? await deps.isWorkspaceTaskLiveDurably(task)
    : undefined;
  const sessionDead = workspaceTask
    ? !(workspaceLiveness?.live ?? true)
    : !hasActiveRegisteredPath && !executingTaskLock.has(task.id) && deps.isTaskActive?.(task.id) !== true;

  let worktreeUnusable = true;
  let worktreeClassification: { ok: boolean; classification?: string; reason?: string };
  if (workspaceTask) {
    /*
    FNXC:WorkspaceRootRouting 2026-08-19-12:15:
    Triple proof for a workspace review failure treats only the stale singular/root route as
    unusable. Valid sub-repository entries are preserved and are not evidence that implementation
    work was lost; active sub-repository liveness still blocks the backward move above.
    */
    worktreeClassification = {
      ok: false,
      classification: "workspace-root-routing",
      reason: "singular workspace-root worktree metadata is not a managed repository checkout",
    };
    worktreeUnusable = true;
  } else if (task.worktree) {
    const cls = await classifyTaskWorktree(deps.rootDir, task.worktree);
    worktreeClassification = cls.ok
      ? { ok: true }
      : { ok: false, classification: cls.classification, reason: cls.reason };
    worktreeUnusable = !cls.ok;
  } else {
    const expected = resolveTaskWorkingBranch(task);
    const registeredPaths = await getRegisteredWorktreePaths(deps.rootDir);
    const registeredBranchMap = await getRegisteredWorktreeBranchMap(deps.rootDir);
    const matchingRegisteredPaths = [...registeredPaths].filter((path) => {
      const branch = registeredBranchMap.get(path);
      return typeof branch === "string" && branch.trim().toLowerCase() === expected;
    });
    worktreeClassification = matchingRegisteredPaths.length === 0
      ? { ok: false, classification: "missing", reason: "task.worktree is null and no registered fusion worktree exists" }
      : { ok: true, reason: "registered fusion worktree exists while task.worktree is null" };
    worktreeUnusable = matchingRegisteredPaths.length === 0;
  }

  const anchorMs = input.stalenessAnchor ? Date.parse(input.stalenessAnchor) : Number.NaN;
  const stalenessMs = Number.isFinite(anchorMs) ? Math.max(0, Date.now() - anchorMs) : Number.POSITIVE_INFINITY;
  const noRecentActivity = stalenessMs >= input.graceMs && !(await hasRecentWorktreeIncompleteDetected(deps.store, task.id, input.graceMs));

  const ok = sessionDead && worktreeUnusable && noRecentActivity;
  return {
    ok,
    stalenessMs,
    reason: input.reason,
    metadata: {
      priorWorktree: task.worktree ?? null,
      priorBranch: task.branch ?? null,
      hadWorktree: Boolean(task.worktree),
      stalenessMs,
      graceMs: input.graceMs,
      sessionDead,
      worktreeUnusable,
      noRecentActivity,
      livePaths,
      hasExecutingTaskLock: executingTaskLock.has(task.id),
      taskActive: deps.isTaskActive?.(task.id) === true,
      worktreeClassification,
      ...input.extra,
    },
  };
}

export async function emitBackwardMoveNoAction(
  deps: { store: TaskStore },
  task: Task,
  stage: string,
  mutationType: string,
  proof: { stalenessMs: number; reason: string; metadata: Record<string, unknown> },
): Promise<void> {
  try {
    await createRunAuditor(deps.store, {
      runId: generateSyntheticRunId(`self-healing-${stage}`, task.id),
      agentId: "self-healing",
      taskId: task.id,
      taskLineageId: task.lineageId,
      phase: stage,
    }).database({
      type: mutationType as DatabaseMutationType,
      target: task.id,
      metadata: proof.metadata,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[${stage}] ${task.id}: no-action audit emission failed: ${message}`);
  }

  /*
  FNXC:TaskWedgeNotifications 2026-07-22-14:30:
  No-action reconciles do not always write `failed` or `paused`, so task-updated
  classification cannot see them. Deliver only the bounded ownerless stages
  through NotificationService; its durable CAS suppresses repeated sweeps.
  */
  const descriptor = describeSelfHealingNoActionWedge(task, stage, proof.metadata);
  if (descriptor) {
    try {
      await getActiveNotificationService()?.notifyTaskWedge(task, descriptor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[${stage}] ${task.id}: wedge notification failed: ${message}`);
    }
  }
  log.debug(`[${stage}] ${task.id}: triple-proof not satisfied — no action (operator-decides)`);
}
