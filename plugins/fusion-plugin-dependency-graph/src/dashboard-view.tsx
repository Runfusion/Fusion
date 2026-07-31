import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { createElement } from "react";
import { DependencyGraph } from "./DependencyGraph.js";

function createWorkflowStepNameLookup(workflowSteps: WorkflowStep[] | undefined): ReadonlyMap<string, string> {
  return new Map((workflowSteps ?? []).map((step) => [step.id, step.name] as const));
}

export function DependencyGraphDashboardView({ context }: { context?: PluginDashboardViewContext }) {
  return createElement(DependencyGraph, {
    tasks: context?.tasks ?? [],
    projectId: context?.projectId,
    workflowStepNameLookup: createWorkflowStepNameLookup(context?.workflowSteps),
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-15:30: the board's resolved traits, now that the host
       context carries them. Absent (remote rows, older host) degrades to the legacy ids as before. */
    columnFlagsByTaskId: context?.columnFlagsByTaskId,
    onOpenDetail: context?.openTaskDetail as ((task: Task | TaskDetail) => void) | undefined,
  });
}

export default DependencyGraphDashboardView;

export { DependencyGraph };
