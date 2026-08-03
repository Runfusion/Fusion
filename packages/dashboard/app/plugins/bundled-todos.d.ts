declare module "@fusion-plugin-examples/todos/dashboard-view" {
  import type { ComponentType } from "react";
  import type { PluginDashboardViewContext } from "./types";
  export const TodoDashboardView: ComponentType<{ context?: PluginDashboardViewContext }>;
}
