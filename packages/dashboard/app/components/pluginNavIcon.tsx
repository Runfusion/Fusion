import { Activity, Bot, Boxes, Brain, CheckSquare, Clock, FileText, Folder, GitBranch, Grid3X3, LayoutGrid, Mail, Map, MessageSquare, Monitor, Search, Sparkles, Target, Workflow, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PluginDashboardViewEntry } from "../api";

/*
FNXC:Navigation 2026-06-28-00:00:
Compound Engineering must not reuse Sparkles because Insights already owns that left-sidebar glyph. Register Boxes so plugin desktop and mobile nav render the distinct icon instead of the Grid3X3 fallback.
*/
const PLUGIN_NAV_ICON_MAP: Record<string, LucideIcon> = {
  activity: Activity,
  bot: Bot,
  boxes: Boxes,
  brain: Brain,
  checksquare: CheckSquare,
  clock: Clock,
  filetext: FileText,
  folder: Folder,
  gitbranch: GitBranch,
  grid3x3: Grid3X3,
  layoutgrid: LayoutGrid,
  mail: Mail,
  map: Map,
  messagesquare: MessageSquare,
  monitor: Monitor,
  search: Search,
  sparkles: Sparkles,
  target: Target,
  workflow: Workflow,
  zap: Zap,
};

function normalizeIconName(iconName?: string): string {
  return (iconName ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
}

const COMPOUND_ENGINEERING_PLUGIN_ID = "fusion-plugin-compound-engineering";

export function getPluginNavIcon(iconName?: string): LucideIcon {
  return PLUGIN_NAV_ICON_MAP[normalizeIconName(iconName)] ?? Grid3X3;
}

export function getPluginDashboardViewNavIcon(entry: Pick<PluginDashboardViewEntry, "pluginId" | "view">): LucideIcon {
  /*
  FNXC:Navigation 2026-06-28-00:00:
  Compound Engineering's in-view header can update from the rebuilt dashboard bundle while the sidebar still receives a stale dashboardViews.icon from plugin loader state or bundled install output. Pin the plugin-id-specific nav icon to Boxes so desktop and mobile sidebars match the agreed header glyph even when incoming metadata has not refreshed yet.
  */
  if (entry.pluginId === COMPOUND_ENGINEERING_PLUGIN_ID) return Boxes;
  return getPluginNavIcon(entry.view.icon);
}
