import { PluginDashboardViewHost as RegistryPluginDashboardViewHost } from "./pluginViewRegistry";
import type { PluginTaskView } from "./pluginViewRegistry";
import type { PluginDashboardViewContext } from "./types";

export function PluginDashboardViewHost({ taskView, context }: { taskView: PluginTaskView; context?: PluginDashboardViewContext }) {
  return <RegistryPluginDashboardViewHost viewId={taskView} context={context} />;
}
