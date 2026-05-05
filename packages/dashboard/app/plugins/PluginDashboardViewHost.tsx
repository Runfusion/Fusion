import { PluginDashboardViewHost as RegistryPluginDashboardViewHost } from "./pluginViewRegistry";
import type { PluginTaskView } from "./pluginViewRegistry";

export function PluginDashboardViewHost({ taskView }: { taskView: PluginTaskView; context?: unknown }) {
  return <RegistryPluginDashboardViewHost viewId={taskView} />;
}
