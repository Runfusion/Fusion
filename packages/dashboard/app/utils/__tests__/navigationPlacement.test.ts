import { describe, expect, it } from "vitest";
import {
  normalizeNavigationPlacement,
  resolveChatHost,
  resolveNavigationSurfaces,
  type NavigationPlacement,
} from "../navigationPlacement";
import type { ViewportMode } from "../../hooks/useViewportMode";

const VIEWPORTS: ViewportMode[] = ["mobile", "tablet", "desktop"];
const PLACEMENTS: NavigationPlacement[] = ["footer", "sidebar"];

describe("normalizeNavigationPlacement", () => {
  it("accepts only the exact sidebar value and fails closed to footer", () => {
    expect(normalizeNavigationPlacement("sidebar")).toBe("sidebar");
    expect(normalizeNavigationPlacement("footer")).toBe("footer");
    expect(normalizeNavigationPlacement(undefined)).toBe("footer");
    expect(normalizeNavigationPlacement(null)).toBe("footer");
    expect(normalizeNavigationPlacement("left")).toBe("footer");
    expect(normalizeNavigationPlacement("SIDEBAR")).toBe("footer");
    expect(normalizeNavigationPlacement(42)).toBe("footer");
    expect(normalizeNavigationPlacement({})).toBe("footer");
  });
});

describe("resolveNavigationSurfaces", () => {
  it("never reports both primary navigation surfaces active", () => {
    for (const viewportMode of VIEWPORTS) {
      for (const navigationPlacement of PLACEMENTS) {
        for (const projectShellPresent of [true, false]) {
          const surfaces = resolveNavigationSurfaces({ viewportMode, projectShellPresent, navigationPlacement });
          expect(
            surfaces.sidebarActive && surfaces.footerNavActive,
            `${viewportMode}/${navigationPlacement}/shell=${projectShellPresent}`,
          ).toBe(false);
        }
      }
    }
  });

  it("mounts no wide surface without a project shell", () => {
    for (const viewportMode of VIEWPORTS) {
      for (const navigationPlacement of PLACEMENTS) {
        expect(resolveNavigationSurfaces({ viewportMode, projectShellPresent: false, navigationPlacement })).toEqual({
          sidebarActive: false,
          footerNavActive: false,
          desktopPilotActive: false,
          executorFooterVisible: false,
          headerPrimaryNavSuppressed: false,
        });
      }
    }
  });

  /* FN-468 : le shell mobile couvre téléphone ET tablette ; aucune surface large ne peut y mounter. */
  it("leaves the whole mobile shell (phone and tablet) to the bottom navigation bar for both placements", () => {
    for (const viewportMode of ["mobile", "tablet"] as const) {
    for (const navigationPlacement of PLACEMENTS) {
      const surfaces = resolveNavigationSurfaces({ viewportMode, projectShellPresent: true, navigationPlacement });
      expect(surfaces.sidebarActive).toBe(false);
      expect(surfaces.footerNavActive).toBe(false);
      expect(surfaces.desktopPilotActive).toBe(false);
      expect(surfaces.executorFooterVisible).toBe(false);
      expect(surfaces.headerPrimaryNavSuppressed).toBe(false);
    }
    }
  });

  it("gives the footer placement the wide bottom bar on desktop only", () => {
    expect(resolveNavigationSurfaces({ viewportMode: "desktop", projectShellPresent: true, navigationPlacement: "footer" })).toEqual({
      sidebarActive: false,
      footerNavActive: true,
      desktopPilotActive: true,
      executorFooterVisible: false,
      headerPrimaryNavSuppressed: true,
    });
  });

  it("gives the sidebar placement the left column on desktop and removes every bottom bar", () => {
    expect(
      resolveNavigationSurfaces({ viewportMode: "desktop", projectShellPresent: true, navigationPlacement: "sidebar" }),
    ).toEqual({
      sidebarActive: true,
      footerNavActive: false,
      desktopPilotActive: false,
      executorFooterVisible: false,
      headerPrimaryNavSuppressed: true,
    });
  });

  it("treats an invalid persisted placement exactly like the footer default", () => {
    for (const viewportMode of VIEWPORTS) {
      const invalid = resolveNavigationSurfaces({
        viewportMode,
        projectShellPresent: true,
        navigationPlacement: "left" as unknown as NavigationPlacement,
      });
      expect(invalid, viewportMode).toEqual(
        resolveNavigationSurfaces({ viewportMode, projectShellPresent: true, navigationPlacement: "footer" }),
      );
    }
  });
});

describe("resolveChatHost", () => {
  it("keeps mobile on its page presentation regardless of placement and dock availability", () => {
    for (const navigationPlacement of PLACEMENTS) {
      for (const rightDockActive of [true, false]) {
        expect(resolveChatHost({ mobileDrawerActive: true, mobileShellActive: true, rightDockActive, navigationPlacement })).toBe("mobile-page");
      }
    }
  });

  /*
  FN-468: the tablet band has neither a dock nor a sidebar, so without a page host the pill's Chat destination
  rendered an empty main panel. The mobile shell (phone OR tablet) now always resolves to the page host.
  */
  it("gives the whole mobile shell a page host even without a phone drawer", () => {
    for (const navigationPlacement of PLACEMENTS) {
      for (const rightDockActive of [true, false]) {
        expect(resolveChatHost({ mobileDrawerActive: false, mobileShellActive: true, rightDockActive, navigationPlacement })).toBe("mobile-page");
      }
    }
  });

  it("routes the sidebar placement to the main page even when a dock exists", () => {
    expect(resolveChatHost({ mobileDrawerActive: false, mobileShellActive: false, rightDockActive: true, navigationPlacement: "sidebar" })).toBe("sidebar-page");
    expect(resolveChatHost({ mobileDrawerActive: false, mobileShellActive: false, rightDockActive: false, navigationPlacement: "sidebar" })).toBe("sidebar-page");
  });

  it("keeps the dock hand-off for the footer placement and falls through when no dock exists", () => {
    expect(resolveChatHost({ mobileDrawerActive: false, mobileShellActive: false, rightDockActive: true, navigationPlacement: "footer" })).toBe("dock");
    expect(resolveChatHost({ mobileDrawerActive: false, mobileShellActive: false, rightDockActive: false, navigationPlacement: "footer" })).toBe("none");
  });

  it("returns exactly one host for every input combination", () => {
    for (const mobileDrawerActive of [true, false]) {
      for (const mobileShellActive of [true, false]) {
        for (const rightDockActive of [true, false]) {
          for (const navigationPlacement of PLACEMENTS) {
            const host = resolveChatHost({ mobileDrawerActive, mobileShellActive, rightDockActive, navigationPlacement });
            expect(["mobile-page", "sidebar-page", "dock", "none"]).toContain(host);
          }
        }
      }
    }
  });
});
