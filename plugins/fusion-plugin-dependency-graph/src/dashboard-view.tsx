import type { Task, TaskDetail } from "@fusion/core";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { createElement } from "react";
import { DependencyGraph } from "./DependencyGraph.js";

/*
FNXC:PluginInteropDrift 2026-07-31-08:30:
`createWorkflowStepNameLookup` and the `workflowStepNameLookup` prop are DELETED, not moved.

`TaskCard` had that prop when FN-2466/FN-7039 added this threading; the dashboard removed it later
and nothing propagated the removal to this plugin's hand-written `dashboard-interop.d.ts`. The map
was still built from `context.workflowSteps` on every render, threaded through two components, and
discarded by a `TaskCard` that has no such prop.

Behaviour-preserving: the value never reached anything. Found by check-plugin-interop-drift the first
time it compared interfaces, which is the case that check exists for.
*/

export function DependencyGraphDashboardView({ context }: { context?: PluginDashboardViewContext }) {
  return createElement(DependencyGraph, {
    tasks: context?.tasks ?? [],
    projectId: context?.projectId,
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-15:30: the board's resolved traits, now that the host
       context carries them. Absent (remote rows, older host) degrades to the legacy ids as before. */
    columnFlagsByTaskId: context?.columnFlagsByTaskId,
    onOpenDetail: context?.openTaskDetail as ((task: Task | TaskDetail) => void) | undefined,
  });
}

export default DependencyGraphDashboardView;

export { DependencyGraph };
