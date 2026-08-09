import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { RoadmapsView, type RoadmapsViewProps } from "./dashboard/RoadmapsView.js";

/*
FNXC:RoadmapsNavigation 2026-07-19-12:00:
The dashboard host loads this stable wrapper for the manifest-advertised roadmaps destination.
Adapt only host context to RoadmapsView props; roadmap data remains plugin-owned.
*/
export function RoadmapDashboardView({ context }: { context?: PluginDashboardViewContext }) {
  // FNXC:RoadmapNativeStructureDrag 2026-08-09-05:13: bundled plugin builds may resolve the prior
  // host declaration while the workspace is rebuilding; retain the optional injection seam at runtime.
  const beginNativeStructureDrag = (context as (PluginDashboardViewContext & Pick<RoadmapsViewProps, "beginNativeStructureDrag">) | undefined)?.beginNativeStructureDrag;
  return <RoadmapsView projectId={context?.projectId} addToast={context?.addToast ?? (() => undefined)} beginNativeStructureDrag={beginNativeStructureDrag} />;
}
