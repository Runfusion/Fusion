export type NodeOverrideBlockReason = "task-in-progress";

export interface NodeOverrideValidationResult {
  allowed: boolean;
  reason?: NodeOverrideBlockReason;
  message?: string;
}

export function validateNodeOverrideChange(
  task: { column: string; nodeId?: string; id: string },
  newNodeId: string | null | undefined,
): NodeOverrideValidationResult {
  if (newNodeId === undefined) {
    return { allowed: true };
  }

  if (task.column === "in-progress") {
    return {
      allowed: false,
      reason: "task-in-progress",
      message: `Cannot change node override for ${task.id} while it is in progress. The task is currently executing and routing cannot be changed mid-flight. Wait for the task to complete, or pause/stop it first before changing the node assignment.`,
    };
  }

  return { allowed: true };
}
