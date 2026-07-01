import type { TaskDetail } from "@fusion/core";

import type { PlanningSessionResult, RuntimePrimitiveResult, WorkflowPrimitiveContext } from "./runtime-primitives.js";

/*
FNXC:WorkflowPlanning 2026-07-01-00:00:
Workflow planning nodes use this service boundary instead of embedding planning-session behavior in TaskExecutor primitive construction. The current graph path preserves pre-specified tasks; later triage extraction can replace this implementation without changing node runners.
*/
export class WorkflowPlanningService {
  public async runPlanningSession(
    _ctx: WorkflowPrimitiveContext,
    _task: TaskDetail,
  ): Promise<RuntimePrimitiveResult<PlanningSessionResult>> {
    return {
      outcome: "success",
      value: "pre-specified",
      data: {
        approved: true,
        artifactKeys: [],
      },
    };
  }
}
