import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ViewHeader, type ViewHeaderProps } from "../components/ViewHeader";

export interface PluginDashboardChromeContextValue {
  actionTarget: HTMLElement | null;
}

export const PluginDashboardChromeContext = createContext<PluginDashboardChromeContextValue | null>(null);

/**
 * FNXC:StandardizedPluginViews 2026-09-13-22:40:
 * A surrounding host (mobile drawer, dock, or window) that already paints the destination title owns the
 * header for that surface. The plugin host then contributes only its actions and body, so a framed plugin
 * destination never stacks a second title row under the host's own.
 */
export const PluginDashboardHostChromeContext = createContext<{ hostOwnsHeader: boolean }>({ hostOwnsHeader: false });

/**
 * FNXC:StandardizedPluginActions 2026-09-13-16:55:
 * A plugin header renders canonical standalone chrome, but inside a full-page plugin host it yields title ownership and portals only its live business actions into the host header. Keeping this bridge browser-only and dependency-light lets bundled and third-party plugin views adopt it without importing dashboard routing internals.
 */
export function PluginDashboardViewHeader(props: ViewHeaderProps): ReactNode {
  const chrome = useContext(PluginDashboardChromeContext);
  if (!chrome) return <ViewHeader {...props} />;
  if (!props.actions || !chrome.actionTarget) return null;
  return createPortal(props.actions, chrome.actionTarget);
}
