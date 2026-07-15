/**
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Execute-node self-requeue loop signature helpers peeled from executor.ts.
 */
import type { TaskDetail, Task } from "@fusion/core";
import { TaskDeletedError } from "@fusion/core";
import { resolve as resolvePath } from "node:path";

/** Maximum no-progress execute-node self-requeues before terminalizing the loop. */
export const MAX_EXECUTE_REQUEUE_LOOP_CYCLES = 6;
/** Low-water mark for surfacing a visible warning before loop terminalization. */
export const EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD = 3;

function countExecuteRequeueTerminalSteps(live: TaskDetail): number {
  return live.steps?.filter((step) => step.status === "done" || step.status === "skipped").length ?? 0;
}

function parseExecuteRequeueLoopProgressSignature(signature: string | null | undefined): { terminalStepCount: number; totalSteps: number } | null {
  if (!signature) return null;
  try {
    const parsed = JSON.parse(signature) as { terminalStepCount?: unknown; totalSteps?: unknown };
    if (typeof parsed.terminalStepCount !== "number" || typeof parsed.totalSteps !== "number") return null;
    return {
      terminalStepCount: parsed.terminalStepCount,
      totalSteps: parsed.totalSteps,
    };
  } catch {
    return null;
  }
}

export function buildExecuteRequeueLoopSignature(live: TaskDetail): string {
  /*
  FNXC:WorkflowLifecycle 2026-07-13-07:42:
  FN-7941: human reports #2043/#2045/#2046/#2047 showed that FN-7863's raw currentStep/status signature could drift on every execute self-requeue while no step reached a terminal state, resetting the loop counter to 1 forever. Anchor the bounded streak to monotonic terminal-step progress instead: pending/in-progress/currentStep oscillation still counts toward exhaustion, while real done/skipped progress resets the streak and FN-7926 still diverts completed-blocked work before this guard can fail it.
  */
  return JSON.stringify({
    terminalStepCount: countExecuteRequeueTerminalSteps(live),
    totalSteps: live.steps?.length ?? 0,
  });
}

export function buildExecuteRequeueLoopHighWaterSignature(live: TaskDetail, previousSignature: string | null | undefined): { signature: string; madeForwardProgress: boolean } {
  // FNXC:WorkflowLifecycle 2026-07-13-08:20: derive current terminal-step
  // progress by parsing buildExecuteRequeueLoopSignature's own output rather
  // than duplicating countExecuteRequeueTerminalSteps/totalSteps inline, so
  // the two functions cannot silently drift out of sync.
  const current = parseExecuteRequeueLoopProgressSignature(buildExecuteRequeueLoopSignature(live));
  const currentTerminalStepCount = current?.terminalStepCount ?? countExecuteRequeueTerminalSteps(live);
  const totalSteps = current?.totalSteps ?? (live.steps?.length ?? 0);
  const previous = parseExecuteRequeueLoopProgressSignature(previousSignature);
  const previousTerminalStepCount = previous?.terminalStepCount ?? currentTerminalStepCount;
  const madeForwardProgress = previous != null && currentTerminalStepCount > previousTerminalStepCount;
  return {
    madeForwardProgress,
    signature: JSON.stringify({
      terminalStepCount: Math.max(previousTerminalStepCount, currentTerminalStepCount),
      totalSteps,
    }),
  };
}

const INVALID_ASSISTANT_CONTINUATION_PATTERN = /cannot continue from message role:\s*assistant/i;

export function isInvalidAssistantContinuationErrorMessage(errorMessage: string): boolean {
  return INVALID_ASSISTANT_CONTINUATION_PATTERN.test(errorMessage);
}

export const TRANSIENT_WORKTREE_TASK_JSON_ENOENT_PATTERN = /ENOENT:\s+no such file or directory,\s+open\s+'([^']+\/\.fusion\/tasks\/([^/]+)\/task\.json)'/;

export function isTransientMissingTaskJsonError(error: unknown, task: Pick<Task, "id" | "worktree">): boolean {
  if (error instanceof TaskDeletedError) {
    return false;
  }
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";
  const match = TRANSIENT_WORKTREE_TASK_JSON_ENOENT_PATTERN.exec(message);
  if (!match) {
    return false;
  }
  const [, filePath, taskIdFromPath] = match;
  if (taskIdFromPath !== task.id) {
    return false;
  }
  if (typeof task.worktree !== "string" || task.worktree.length === 0) {
    return false;
  }
  const normalizedWorktree = resolvePath(task.worktree);
  const normalizedTaskJsonPath = resolvePath(filePath);
  return normalizedTaskJsonPath.startsWith(`${normalizedWorktree}/`);
}
