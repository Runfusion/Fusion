import { resolvePluginDashboardView, MissingPluginDashboardView, parsePluginTaskViewId } from "./pluginViewRegistry";
import type { PluginDashboardHostContext, PluginTaskView } from "./pluginViewRegistry";

export function PluginDashboardViewHost({
  taskView,
  context,
}: {
  taskView: PluginTaskView;
  context: PluginDashboardHostContext;
}) {
  const parsed = parsePluginTaskViewId(taskView);
  if (!parsed) return null;

  const ViewComponent = resolvePluginDashboardView(parsed.pluginId, parsed.viewId);
  if (!ViewComponent) {
    return <>{MissingPluginDashboardView({ pluginId: parsed.pluginId, viewId: parsed.viewId })}</>;
  }

  return <ViewComponent context={context} />;
}
