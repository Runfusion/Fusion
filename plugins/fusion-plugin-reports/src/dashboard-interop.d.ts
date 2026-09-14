/*
FNXC:StandardizedPluginViews 2026-09-13-22:40:
Reports adopts the cooperative dashboard plugin header. Like every other bundled plugin, it declares the host
bridge locally instead of depending on dashboard internals, so its build and typecheck stay self-contained.
*/
declare module "@fusion/dashboard/app/plugins/PluginDashboardViewHeader" {
  import type { ComponentType, ReactNode } from "react";
  import type { LucideProps } from "lucide-react";

  export interface PluginDashboardViewHeaderProps {
    icon?: ComponentType<LucideProps>;
    title: ReactNode;
    actions?: ReactNode;
    titleId?: string;
  }

  export function PluginDashboardViewHeader(props: PluginDashboardViewHeaderProps): ReactNode;
}
