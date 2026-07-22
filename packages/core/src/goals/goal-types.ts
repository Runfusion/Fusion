export type GoalStatus = "active" | "archived";

export const ACTIVE_GOAL_LIMIT = 5;

export interface Goal {
  id: string;
  title: string;
  description?: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GoalCreateInput {
  title: string;
  description?: string;
}

export interface GoalUpdateInput {
  title?: string;
  description?: string;
}

export interface GoalListFilter {
  status?: GoalStatus;
}

export class ActiveGoalLimitExceededError extends Error {
  public readonly code = "ACTIVE_GOAL_LIMIT_EXCEEDED" as const;

  public constructor(
    public readonly limit: number,
    public readonly currentActive: number,
  ) {
    super(`Active goal limit exceeded: ${currentActive}/${limit}`);
    this.name = "ActiveGoalLimitExceededError";
  }
}
