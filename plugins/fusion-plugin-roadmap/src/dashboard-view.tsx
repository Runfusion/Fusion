import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { RoadmapsView } from "./dashboard/RoadmapsView.js";

/*
FNXC:RoadmapsNavigation 2026-07-19-12:00:
The dashboard host loads this stable wrapper for the manifest-advertised roadmaps destination.
Adapt only host context to RoadmapsView props; roadmap data remains plugin-owned.
*/
export function RoadmapDashboardView({ context }: { context?: PluginDashboardViewContext }) {
  return <RoadmapsView projectId={context?.projectId} addToast={context?.addToast ?? (() => undefined)} />;
}
