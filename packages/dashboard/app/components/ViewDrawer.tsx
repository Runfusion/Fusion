import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import "./ViewDrawer.css";

export interface ViewDrawerHandleProps extends HTMLAttributes<HTMLDivElement> {
  barClassName?: string;
}

export interface ResolveDrawerPresentationInput {
  /** Resolved viewport mode of the host surface. */
  viewportMode: string | undefined;
  /** Host-local opt-out (setup wizard, onboarding, confirmations are never drawers). */
  excluded?: boolean;
}

/*
FNXC:StandardizedDrawers 2026-09-15-04:56:
FN-406: "am I presented as a phone drawer?" had two byte-identical copies (FloatingWindow, TerminalModal) and was
unreachable from content-owned headers, so FileBrowser drew its own grab bar AND kept a close button while the shared
shell already rendered a ViewDrawerHandle. This predicate is the single definition: phone viewport, the
`data-mobile-drawers` opt-in published on the document element, and no host-local exclusion. Keep it pure so hosts can
call it during render and publish the result through DrawerPresentationProvider.
*/
export function resolveDrawerPresentation({ viewportMode, excluded }: ResolveDrawerPresentationInput): boolean {
  return viewportMode === "mobile"
    && typeof document !== "undefined"
    && document.documentElement.dataset.mobileDrawers === "true"
    && !excluded;
}

/*
FNXC:StandardizedDrawers 2026-09-15-04:56:
FN-406: drawer presentation is host state that hosted CONTENT must read, because the chrome a drawer must suppress
(the canonical close) is frequently owned by the content's own ViewHeader rather than by the shell. Default false so
every surface rendered outside a drawer host keeps its close control unchanged.
*/
const DrawerPresentationContext = createContext(false);

export function DrawerPresentationProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <DrawerPresentationContext.Provider value={value}>{children}</DrawerPresentationContext.Provider>;
}

/** True when the calling subtree is rendered inside a phone drawer presentation. */
export function useDrawerPresentation(): boolean {
  return useContext(DrawerPresentationContext);
}

/*
FNXC:StandardizedDrawers 2026-09-15-04:56:
FN-406: a host that renders its OWN FloatingWindow sits ABOVE the provider, so calling `useDrawerPresentation()` in that
host body always reads false — the chrome it wants to suppress is an element it passes DOWN into the drawer. This
wrapper reads the context at the position where the chrome actually renders, which is the only correct read for
content-owned headers, and keeps the suppression rule in one module instead of per host.
*/
export function HideInDrawer({ children }: { children: ReactNode }) {
  return useDrawerPresentation() ? null : <>{children}</>;
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
