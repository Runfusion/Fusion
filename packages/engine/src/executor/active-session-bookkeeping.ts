/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * set/delete active session, step-executor, and workflow-step session bookkeeping
 * peeled from TaskExecutor (U4).
 *
 * FNXC:Workspace 2026-06-21-12:00 / 2026-06-24-15:45 (KTD2):
 * Delete paths unregister EVERY held worktree path (or an explicit path) via the
 * task-scoped sessionRegistryPath key so workspace browse-root synthetic keys
 * are the ones cleared.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { activeSessionRegistry, type ActiveSessionKind } from "../agents/active-session-registry.js";
import type { StepSessionExecutor } from "../execution/step-session-executor.js";
import { sessionRegistryPath } from "./session-registry-path.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- session state shape is executor-private
type ActiveExecutorSessionState = any;

export type ActiveSessionBookkeepingDeps = {
  rootDir: string;
  activeSessions: Map<string, ActiveExecutorSessionState>;
  activeStepExecutors: Map<string, StepSessionExecutor>;
  activeStepExecutorSeenSteeringIds: Map<string, Set<string>>;
  activeWorkflowStepSessions: Map<string, AgentSession>;
  activeWorkflowStepSessionSeenSteeringIds: Map<string, Set<string>>;
  effectiveColumnAgentByTask: Map<string, unknown>;
  graphRouting: Set<string>;
  graphExecuteSelfRequeued: Set<string>;
  getActiveWorktreePaths: (taskId: string) => string[];
  acquireSessionRegistryPath: (
    taskId: string,
    registryPath: string,
    kind: ActiveSessionKind,
    ownerKey: string,
  ) => void;
};

export function setActiveSession(
  deps: ActiveSessionBookkeepingDeps,
  taskId: string,
  sessionState: ActiveExecutorSessionState,
  worktreePath: string,
): void {
  deps.activeSessions.set(taskId, sessionState);
  deps.acquireSessionRegistryPath(
    taskId,
    sessionRegistryPath(deps.rootDir, taskId, worktreePath),
    "executor",
    taskId,
  );
}

export function markGraphExecuteSelfRequeued(
  deps: ActiveSessionBookkeepingDeps,
  taskId: string,
): void {
  if (deps.graphRouting.has(taskId)) {
    deps.graphExecuteSelfRequeued.add(taskId);
  }
}

export function deleteActiveSession(
  deps: ActiveSessionBookkeepingDeps,
  taskId: string,
  worktreePath?: string,
): void {
  deps.activeSessions.delete(taskId);
  // U5: drop the effective column-agent principal for this task's session.
  deps.effectiveColumnAgentByTask.delete(taskId);
  // FNXC:Workspace 2026-06-21-12:00: KTD2 — when no explicit path is given, unregister EVERY worktree path the task holds (a workspace task holds N sub-repo paths); single-repo tasks resolve a one-element set.
  const resolvedWorktreePaths = worktreePath ? [worktreePath] : deps.getActiveWorktreePaths(taskId);
  for (const path of resolvedWorktreePaths) {
    // FNXC:Workspace 2026-06-24-15:45: map through sessionRegistryPath so the task-scoped synthetic
    // session key registered for the shared workspace browse-root is the one we unregister (the
    // in-memory Set holds the REAL root). Non-workspace/sub-repo paths pass through unchanged.
    activeSessionRegistry.unregisterPath(sessionRegistryPath(deps.rootDir, taskId, path));
  }
}

export function setActiveStepExecutor(
  deps: ActiveSessionBookkeepingDeps,
  taskId: string,
  stepExecutor: StepSessionExecutor,
  worktreePath: string,
  seenSteeringIds = new Set<string>(),
): void {
  deps.activeStepExecutors.set(taskId, stepExecutor);
  deps.activeStepExecutorSeenSteeringIds.set(taskId, seenSteeringIds);
  deps.acquireSessionRegistryPath(
    taskId,
    sessionRegistryPath(deps.rootDir, taskId, worktreePath),
    "step-session",
    `${taskId}#step-session`,
  );
}

export function deleteActiveStepExecutor(
  deps: ActiveSessionBookkeepingDeps,
  taskId: string,
  worktreePath?: string,
): void {
  deps.activeStepExecutors.delete(taskId);
  deps.activeStepExecutorSeenSteeringIds.delete(taskId);
  // U5: drop the effective column-agent principal for this task's step session.
  deps.effectiveColumnAgentByTask.delete(taskId);
  // FNXC:Workspace 2026-06-21-12:00: KTD2 — unregister every held worktree path (Set), not one.
  const resolvedWorktreePaths = worktreePath ? [worktreePath] : deps.getActiveWorktreePaths(taskId);
  for (const path of resolvedWorktreePaths) {
    // FNXC:Workspace 2026-06-24-15:45: map through sessionRegistryPath so the task-scoped synthetic
    // session key registered for the shared workspace browse-root is the one we unregister (the
    // in-memory Set holds the REAL root). Non-workspace/sub-repo paths pass through unchanged.
    activeSessionRegistry.unregisterPath(sessionRegistryPath(deps.rootDir, taskId, path));
  }
}

export function setActiveWorkflowStepSession(
  deps: ActiveSessionBookkeepingDeps,
  taskId: string,
  session: AgentSession,
  worktreePath: string,
  seenSteeringIds = new Set<string>(),
): void {
  deps.activeWorkflowStepSessions.set(taskId, session);
  deps.activeWorkflowStepSessionSeenSteeringIds.set(taskId, seenSteeringIds);
  deps.acquireSessionRegistryPath(
    taskId,
    sessionRegistryPath(deps.rootDir, taskId, worktreePath),
    "workflow-step",
    `${taskId}#workflow-step`,
  );
}

export function deleteActiveWorkflowStepSession(
  deps: ActiveSessionBookkeepingDeps,
  taskId: string,
  worktreePath?: string,
): void {
  deps.activeWorkflowStepSessions.delete(taskId);
  deps.activeWorkflowStepSessionSeenSteeringIds.delete(taskId);
  // FNXC:Workspace 2026-06-21-12:00: KTD2 — unregister every held worktree path (Set), not one.
  const resolvedWorktreePaths = worktreePath ? [worktreePath] : deps.getActiveWorktreePaths(taskId);
  for (const path of resolvedWorktreePaths) {
    // FNXC:Workspace 2026-06-24-15:45: map through sessionRegistryPath so the task-scoped synthetic
    // session key registered for the shared workspace browse-root is the one we unregister (the
    // in-memory Set holds the REAL root). Non-workspace/sub-repo paths pass through unchanged.
    activeSessionRegistry.unregisterPath(sessionRegistryPath(deps.rootDir, taskId, path));
  }
}
