import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { ReportsView } from "./dashboard/ReportsView.js";

export function ReportsDashboardView({ context }: { context?: PluginDashboardViewContext }) {
  return <ReportsView projectId={context?.projectId} addToast={context?.addToast ?? (() => undefined)} />;
}
