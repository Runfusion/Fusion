import type { TaskView } from "../hooks/useViewState";
import type { OverflowViewKey } from "../components/overflowViewRegistry";

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
FN-426 removes the right dock from the set of surfaces a tool can REQUIRE. Every destination that used to be reachable
only through the dock now has a canonical host, and this module is the single decider that maps a requested view id —
current, legacy, or persisted — onto that host.

It exists because the same mapping is consumed by several unrelated callers (App's view-change interception, deep links,
navigation history restoration, and the mobile navigation inventory). Duplicating the branch in each of them is exactly
how `pull-requests` and `secrets` ended up with two competing owners before this task.

The resolver is PURE and knows nothing about availability: whether the right dock is mounted is decided by
`rightSidebarEnabled` in App, never here.
*/

/** The right dock, when an operator opts back into it, offers exactly these four shortcuts. */
export const OPTIONAL_RIGHT_DOCK_TOOLS = ["files", "chat", "list", "notes"] as const satisfies readonly OverflowViewKey[];

export type ToolSurfaceRoute =
  /** Navigate to a real main-content destination. */
  | { kind: "view"; view: TaskView }
  /** Navigate to Git Manager and select its Pull Requests section. */
  | { kind: "git-pull-requests" }
  /** Open Settings at the project Secrets section instead of a standalone page. */
  | { kind: "settings-section"; section: "secrets" };

/*
FNXC:ToolSurfaces 2026-09-15-16:04:
Legacy ids stay RECOGNIZED (a bookmark, a persisted view, a restored history entry, or a customized mobile item may
still carry them) while no longer being OFFERED. Returning a route rather than silently rewriting the id keeps the
caller responsible for its own history/selection bookkeeping.
*/
export function resolveToolSurfaceRoute(view: TaskView): ToolSurfaceRoute {
  if (view === "pull-requests") return { kind: "git-pull-requests" };
  if (view === "secrets") return { kind: "settings-section", section: "secrets" };
  return { kind: "view", view };
}

/** True when the requested id is a legacy tool destination that no longer has a page of its own. */
export function isRedirectedToolSurface(view: TaskView): boolean {
  return resolveToolSurfaceRoute(view).kind !== "view";
}

/**
 * FNXC:ToolSurfaces 2026-09-15-16:04:
 * A dock selection persisted before FN-426 can name a tool the dock no longer hosts (`git-manager`, `activity-log`,
 * `secrets`, `pull-requests`, `devserver`, or any `plugin:*`). Those tools did not disappear — they moved — so a stale
 * selection must resolve to the dock's own Files fallback instead of leaving the panel blank.
 */
export function isOptionalRightDockTool(key: string): key is (typeof OPTIONAL_RIGHT_DOCK_TOOLS)[number] {
  return (OPTIONAL_RIGHT_DOCK_TOOLS as readonly string[]).includes(key);
}
