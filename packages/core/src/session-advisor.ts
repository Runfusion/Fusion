/**
 * FNXC:PlannerOversight 2026-07-14-18:11:
 * Session advisor (LLM overseer agent) enable inheritance mirrors GitHub tracking:
 * per-task override wins, else project default, else workflow flag (backward compat),
 * else off. Pure resolver — no I/O — so UI, API, and engine share one contract.
 */
import type { ProjectSettings, Task } from "./types.js";

export interface ResolvedTaskSessionAdvisor {
  enabled: boolean;
  source: "task" | "project" | "workflow" | "default";
}

/**
 * Resolve whether the session advisor (LLM overseer agent) is enabled for a task.
 *
 * Precedence:
 * 1. `task.sessionAdvisorEnabled` when boolean (explicit on/off for this task)
 * 2. `projectSettings.sessionAdvisorEnabledByDefault` when true
 * 3. Workflow `plannerOverseerAdvisorEnabled` when true (legacy / workflow-settings path)
 * 4. Default false
 */
export function resolveTaskSessionAdvisorEnabled(
  task: Pick<Task, "sessionAdvisorEnabled">,
  projectSettings?: Pick<ProjectSettings, "sessionAdvisorEnabledByDefault">,
  workflowAdvisorEnabled?: boolean,
): ResolvedTaskSessionAdvisor {
  if (typeof task.sessionAdvisorEnabled === "boolean") {
    return { enabled: task.sessionAdvisorEnabled, source: "task" };
  }
  if (projectSettings?.sessionAdvisorEnabledByDefault === true) {
    return { enabled: true, source: "project" };
  }
  if (workflowAdvisorEnabled === true) {
    return { enabled: true, source: "workflow" };
  }
  return { enabled: false, source: "default" };
}
