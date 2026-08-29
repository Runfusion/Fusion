import type {TaskStore} from "../store.js";
import type {Task} from "../types.js";
import {isActiveMergeStatus} from "../merge/active-merge-status.js";
import {columnsWithFlag, declaresAnyLifecycleTrait} from "../workflows/workflow-lifecycle-traits.js";
import {resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";

export type ArchiveLivenessReason = "wip-lane" | "active-merge-status";
export type ArchiveLivenessVerdict = {live: boolean; reasons: ArchiveLivenessReason[]};

/*
FNXC:WorkflowLifecycle 2026-08-15-06:35:
Archive from an executor-less CLI or extension process must fail closed against durable task-row
signals: WIP lanes and active merge statuses. A pause does not prove another process has stopped.
The in-process activeSessionRegistry/executingTaskLock and AgentStore heartbeat evidence are deliberately
excluded: neither is available to this core archive path. The transaction fence is authoritative; these
helpers provide its pure decision and advisory caller messaging.
*/
export function decideArchiveLiveness(input: {column: string; status?: string | null; wipLanes: ReadonlySet<string>}): ArchiveLivenessVerdict {
  const reasons: ArchiveLivenessReason[] = [];
  if (input.wipLanes.has(input.column)) reasons.push("wip-lane");
  if (isActiveMergeStatus(input.status)) reasons.push("active-merge-status");
  return {live: reasons.length > 0, reasons};
}

export async function resolveArchiveLivenessWipLanes(store: TaskStore, taskId: string): Promise<ReadonlySet<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    if (ir && declaresAnyLifecycleTrait(ir)) return new Set(columnsWithFlag(ir, "countsTowardWip"));
  } catch { /* degraded-but-protective legacy fallback */ }
  return new Set(["in-progress"]);
}

/** Advisory only: callers must rely on the archive transaction's re-read for authority. */
export async function evaluateArchiveTaskLiveness(store: TaskStore, task: Pick<Task, "id" | "column" | "status">): Promise<ArchiveLivenessVerdict> {
  return decideArchiveLiveness({column: task.column, status: task.status, wipLanes: await resolveArchiveLivenessWipLanes(store, task.id)});
}

export function describeArchiveLiveness(taskId: string, verdict: ArchiveLivenessVerdict, extra?: {workspaceWorktreeCount?: number}): string {
  const reasons = verdict.reasons.map((reason) => reason === "wip-lane" ? "in a WIP lane" : "has an active merge pipeline").join(" and ");
  const workspace = extra?.workspaceWorktreeCount ? `; ${extra.workspaceWorktreeCount} workspace worktree${extra.workspaceWorktreeCount === 1 ? "" : "s"} may be destroyed` : "";
  return `Refusing to archive live task ${taskId}: it is ${reasons}${workspace}. Use \`fn task archive ${taskId} --force\` to override.`;
}

export class TaskIsLiveError extends Error {
  constructor(readonly taskId: string, readonly reasons: ArchiveLivenessReason[]) {
    super(`Task ${taskId} is live: ${reasons.join(", ")}`);
    this.name = "TaskIsLiveError";
  }
}

export class LiveTaskWorktreeRemovalRefusedError extends Error {
  constructor(readonly taskId: string, readonly repoRel: string, readonly worktreePath: string, readonly reasons: ArchiveLivenessReason[]) {
    super(`Refusing to remove live task ${taskId} worktree ${worktreePath}: ${reasons.join(", ")}`);
    this.name = "LiveTaskWorktreeRemovalRefusedError";
  }
}
