/**
 * Capacity risk signals are based on a strict todo threshold.
 * The warning only fires when todoCount is greater than (not equal to) the threshold
 * and there are zero idle non-ephemeral agents available to drain the queue.
 */
export const DEFAULT_CAPACITY_RISK_TODO_THRESHOLD = 20;

export interface CapacityRiskSignal {
  atRisk: boolean;
  todoCount: number;
  inProgressCount: number;
  inReviewCount: number;
  idleNonEphemeralAgentCount: number;
  threshold: number;
  reason: "todo-exceeds-threshold-and-no-idle-agents" | "ok";
}

export function computeCapacityRisk(input: {
  todoCount: number;
  inProgressCount: number;
  inReviewCount: number;
  idleNonEphemeralAgentCount: number;
  threshold: number;
}): CapacityRiskSignal {
  const atRisk =
    input.todoCount > input.threshold && input.idleNonEphemeralAgentCount === 0;

  return {
    atRisk,
    todoCount: input.todoCount,
    inProgressCount: input.inProgressCount,
    inReviewCount: input.inReviewCount,
    idleNonEphemeralAgentCount: input.idleNonEphemeralAgentCount,
    threshold: input.threshold,
    reason: atRisk ? "todo-exceeds-threshold-and-no-idle-agents" : "ok",
  };
}
