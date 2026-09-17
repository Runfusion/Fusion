import type { ViewportMode } from "../hooks/useViewportMode";

/*
FNXC:Navigation 2026-09-15-14:41:
FN-419 makes the primary navigation surface an explicit project choice instead of a breakpoint side effect.
Before this module, `App.tsx` derived the wide footer from `viewportMode !== "mobile"` while the left sidebar
was only suppressed on `desktop`, so the `tablet` tier mounted BOTH primary navigation surfaces at once.

`resolveNavigationSurfaces` is now the single decider. Exclusivity is STRUCTURAL, not asserted: `footerNavActive`
and `sidebarActive` read the same normalized placement through mutually exclusive equality branches, so no input
combination can make both true.

The legacy `experimentalFeatures.leftSidebarNav` flag deliberately does NOT enter this computation. It used to
gate the sidebar; keeping it as a gate on top of an explicit `"sidebar"` placement would leave an operator with
zero navigation surfaces (footer suppressed by the placement, sidebar suppressed by the stale flag) — a dead end
with no in-product way out. The flag survives only as part of the `experimentalFeatures` payload handed to Header.
*/

export type NavigationPlacement = "footer" | "sidebar";

/**
 * FNXC:Navigation 2026-09-15-14:41:
 * Persisted settings can come from older project files or external writers, so only the exact `"sidebar"` value
 * opts into the left column; everything else (absent, null, `"left"`, numbers) fails closed to the footer default.
 */
export function normalizeNavigationPlacement(value: unknown): NavigationPlacement {
  return value === "sidebar" ? "sidebar" : "footer";
}

export interface NavigationSurfacesInput {
  viewportMode: ViewportMode;
  projectShellPresent: boolean;
  navigationPlacement: NavigationPlacement;
}

export interface NavigationSurfaces {
  /** Left column navigation is the owner of primary routing. Never true together with `footerNavActive`. */
  sidebarActive: boolean;
  /** Bottom `DesktopActionBar` is the owner of primary routing. Never true together with `sidebarActive`. */
  footerNavActive: boolean;
  /** Desktop pilot windows/routing stay bound to the footer placement only. */
  desktopPilotActive: boolean;
  /** Legacy `ExecutorStatusBar` bottom bar; only when no wide primary surface owns the shell chrome. */
  executorFooterVisible: boolean;
  /** Header must not re-render its view shortcuts while any wide surface owns navigation. */
  headerPrimaryNavSuppressed: boolean;
}

/**
 * FNXC:Navigation 2026-09-16-19:44:
 * FN-468 : le shell mobile couvre désormais 0–1023.98 px, téléphone ET tablette. Les deux surfaces larges ne
 * peuvent donc mounter qu'en `desktop` (1024 px et plus), quelle que soit la placement persistée ; toute la
 * bande tablette appartient à `MobileNavBar`. Attention : ce décideur est le PREMIER des deux verrous. Retirer
 * les surfaces larges de la tablette sans élargir aussi le prédicat de montage de `MobileNavBar` laisserait la
 * tablette sans AUCUNE navigation primaire.
 *
 * FNXC:Navigation 2026-09-15-14:41:
 * Le shell mobile appartient toujours à `MobileNavBar`, donc aucune surface large ne peut y mounter.
 * In `sidebar` placement the shell has NO bottom bar at all (`footerNavActive` and `executorFooterVisible` are both
 * false), which is what removes the `--with-footer` height reservations from the content, sidebar, and right dock.
 */
export function resolveNavigationSurfaces(input: NavigationSurfacesInput): NavigationSurfaces {
  const { viewportMode, projectShellPresent } = input;
  const placement = normalizeNavigationPlacement(input.navigationPlacement);
  const wideShell = projectShellPresent && viewportMode === "desktop";
  const footerNavActive = wideShell && placement === "footer";
  const sidebarActive = wideShell && placement === "sidebar";
  return {
    sidebarActive,
    footerNavActive,
    desktopPilotActive: footerNavActive && viewportMode === "desktop",
    executorFooterVisible: wideShell && !footerNavActive && !sidebarActive,
    headerPrimaryNavSuppressed: sidebarActive || footerNavActive,
  };
}

export type ChatHost = "mobile-page" | "sidebar-page" | "dock" | "none";

export interface ChatHostInput {
  mobileDrawerActive: boolean;
  /**
   * FNXC:ChatSurfaceUnification 2026-09-16-20:16:
   * FN-468: true when the mobile navigation shell (phone OR tablet) owns routing AND a project shell is mounted.
   * The tablet band no longer has a right dock or a left column, so without this input `resolveChatHost` answered
   * `"none"` between 769px and 1023px and the pill's Chat destination rendered an empty main panel.
   */
  mobileShellActive: boolean;
  rightDockActive: boolean;
  navigationPlacement: NavigationPlacement;
}

/**
 * FNXC:Navigation 2026-09-15-14:41:
 * FN-419 requirement 3: opening Chat from the LEFT sidebar must show the conversation in the main page, exactly like
 * Notes, instead of hijacking the right dock. Mobile keeps its existing page presentation, footer placement keeps the
 * dock hand-off, and a shell with neither a drawer nor a dock resolves to `"none"` so the caller falls through to its
 * ordinary route. Exactly one host is ever returned, preserving the FN-392 single-primary-Chat-host invariant.
 *
 * FNXC:Navigation 2026-09-16-20:16:
 * FN-468 extends the page host to the WHOLE mobile shell. `"mobile-page"` names the HOST, not the drawer wrapper:
 * the phone drawer wrapper stays strictly `mobileDrawerActive`/`mobileDrawerEnabled` downstream, while the tablet
 * gets the same in-page Chat route with ordinary page presentation.
 */
export function resolveChatHost(input: ChatHostInput): ChatHost {
  if (input.mobileDrawerActive || input.mobileShellActive) return "mobile-page";
  if (normalizeNavigationPlacement(input.navigationPlacement) === "sidebar") return "sidebar-page";
  if (input.rightDockActive) return "dock";
  return "none";
}
