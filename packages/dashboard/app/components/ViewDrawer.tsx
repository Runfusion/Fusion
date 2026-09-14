import type { HTMLAttributes } from "react";
import "./ViewDrawer.css";

export interface ViewDrawerHandleProps extends HTMLAttributes<HTMLDivElement> {
  barClassName?: string;
}

/*
FNXC:StandardizedDrawers 2026-09-13-16:30:
Every phone drawer exposes one shared drag handle before its Header → Tabs? → Content → Footer? zones. Hosts keep dismissal and focus ownership; this primitive owns only the token-based hit target and visible bar so nested drawers cannot add a second header, scroller, or safe-area reserve.
*/
export function ViewDrawerHandle({ className, barClassName, ...props }: ViewDrawerHandleProps) {
  return (
    <div
      {...props}
      className={["view-drawer__handle-target", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <span className={["view-drawer__handle", barClassName].filter(Boolean).join(" ")} />
    </div>
  );
}
