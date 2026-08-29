import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { TodoView } from "./dashboard/TodoView.js";
/* FNXC:TodoPluginOwnership 2026-08-03-15:16: Adapt host callbacks once at the plugin boundary; the Todo component and API remain plugin-owned. */
export function TodoDashboardView({ context }: { context?: PluginDashboardViewContext }) { return <TodoView projectId={context?.projectId} addToast={context?.addToast ?? (() => undefined)} onPlanningMode={context?.openPlanningMode} onTaskCreated={context?.onTaskCreated} />; }
