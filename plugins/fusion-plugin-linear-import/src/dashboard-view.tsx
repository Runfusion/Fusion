import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { createElement } from "react";
import { LinearImportView } from "./LinearImportView.js";

export function LinearImportDashboardView({ context }: { context?: PluginDashboardViewContext }) {
  return createElement(LinearImportView, { context });
}

export default LinearImportDashboardView;
export { LinearImportView };
