declare module "@fusion-plugin-examples/dependency-graph/dashboard-view" {
  import type { ComponentType } from "react";
  import type { PluginDashboardViewContext } from "@fusion/core";

  const DependencyGraphDashboardView: ComponentType<{ context?: PluginDashboardViewContext }>;
  export default DependencyGraphDashboardView;
  export { DependencyGraphDashboardView };
}
