import { useContext, useState, type ComponentType, type ReactNode } from "react";
import type { LucideProps } from "lucide-react";
import { PluginDashboardViewHost as RegistryPluginDashboardViewHost } from "./pluginViewRegistry";
import type { PluginTaskView } from "./pluginViewRegistry";
import type { PluginDashboardViewContext } from "./types";
import { ViewActionButton, type ViewActionButtonProps } from "../components/ViewActionButton";
import { ViewHeader } from "../components/ViewHeader";
import { ViewLayout } from "../components/ViewLayout";
import { ViewSidebar } from "../components/ViewSidebar";
import { PluginDashboardChromeContext, PluginDashboardHostChromeContext } from "./PluginDashboardViewHeader";

export interface PluginDashboardViewLayout {
  /** Host-owned destination identity. Plugin views keep owning their data and body. */
  title: ReactNode;
  icon?: ComponentType<LucideProps>;
  actions?: ReactNode;
  /** Canonical create/action control for plugin resources; arbitrary secondary actions stay in `actions`. */
  primaryAction?: ViewActionButtonProps;
  /** Optional collection rail for plugin views that expose a master/detail controller. */
  sidebar?: ReactNode;
  sidebarLabel?: string;
  mobilePane?: "list" | "detail";
  contentOwnsScroll?: boolean;
}

export interface PluginDashboardViewHostProps {
  taskView: PluginTaskView;
  context?: PluginDashboardViewContext;
  /**
   * Optional so third-party hosts and older callers retain the unframed plugin contract.
   * Full dashboard destinations provide this to share the canonical dashboard chrome.
   */
  layout?: PluginDashboardViewLayout;
}

/*
FNXC:StandardizedPluginViews 2026-09-13-16:50:
Full-page plugin destinations receive their title, bounded content, and optional collection rail from the host's ViewLayout primitives. The contract remains optional for external and dock hosts, and it never registers a route or makes an unavailable plugin view reachable.

FNXC:StandardizedPluginActions 2026-09-13-16:50:
The host must not hide plugin-owned refresh, run, create, or stage controls merely to remove a duplicate title. Cooperative plugin headers render normally outside this host and portal only their live action subtree into the one host header here, preserving callback and loading state ownership without a second title row.
*/
export function PluginDashboardViewHost({ taskView, context, layout }: PluginDashboardViewHostProps) {
  const [pluginActionTarget, setPluginActionTarget] = useState<HTMLDivElement | null>(null);
  /*
  FNXC:StandardizedPluginViews 2026-09-13-22:40:
  A drawer or window host that already renders the destination title keeps header ownership, so this host
  contributes the bounded body and its action target without a competing title row.
  */
  const { hostOwnsHeader } = useContext(PluginDashboardHostChromeContext);
  const registryView = <RegistryPluginDashboardViewHost viewId={taskView} context={context} />;
  if (!layout) return registryView;

  const headerActions = (
    <>
      {layout.actions}
      <div className="plugin-dashboard-view-layout__actions" ref={setPluginActionTarget} />
      {layout.primaryAction == null ? null : <ViewActionButton {...layout.primaryAction} />}
    </>
  );
  const sidebar = layout.sidebar == null ? undefined : (
    <ViewSidebar
      ariaLabel={layout.sidebarLabel ?? (typeof layout.title === "string" ? `${layout.title} navigation` : "Plugin navigation")}
      hostIdentity={taskView}
    >
      {layout.sidebar}
    </ViewSidebar>
  );

  return (
    <PluginDashboardChromeContext.Provider value={{ actionTarget: pluginActionTarget }}>
      <ViewLayout
        className="plugin-dashboard-view-layout"
        data-plugin-view={taskView}
        header={hostOwnsHeader ? <>{headerActions}</> : <ViewHeader icon={layout.icon} title={layout.title} actions={headerActions} />}
        sidebar={sidebar}
        mobilePane={layout.mobilePane}
        contentOwnsScroll={layout.contentOwnsScroll ?? false}
      >
        {registryView}
      </ViewLayout>
    </PluginDashboardChromeContext.Provider>
  );
}
