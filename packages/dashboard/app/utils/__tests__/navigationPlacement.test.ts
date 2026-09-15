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

  it("leaves mobile entirely to the bottom navigation bar for both placements", () => {
    for (const navigationPlacement of PLACEMENTS) {
      const surfaces = resolveNavigationSurfaces({ viewportMode: "mobile", projectShellPresent: true, navigationPlacement });
      expect(surfaces.sidebarActive).toBe(false);
      expect(surfaces.footerNavActive).toBe(false);
      expect(surfaces.desktopPilotActive).toBe(false);
      expect(surfaces.executorFooterVisible).toBe(false);
      expect(surfaces.headerPrimaryNavSuppressed).toBe(false);
    }
  });

  it("gives the footer placement the wide bottom bar and keeps the desktop pilot desktop-only", () => {
    expect(resolveNavigationSurfaces({ viewportMode: "tablet", projectShellPresent: true, navigationPlacement: "footer" })).toEqual({
      sidebarActive: false,
      footerNavActive: true,
      desktopPilotActive: false,
      executorFooterVisible: false,
      headerPrimaryNavSuppressed: true,
    });
    expect(resolveNavigationSurfaces({ viewportMode: "desktop", projectShellPresent: true, navigationPlacement: "footer" })).toEqual({
      sidebarActive: false,
      footerNavActive: true,
      desktopPilotActive: true,
      executorFooterVisible: false,
      headerPrimaryNavSuppressed: true,
    });
  });

  it("gives the sidebar placement the left column and removes every bottom bar", () => {
    for (const viewportMode of ["tablet", "desktop"] as const) {
      expect(
        resolveNavigationSurfaces({ viewportMode, projectShellPresent: true, navigationPlacement: "sidebar" }),
        viewportMode,
      ).toEqual({
        sidebarActive: true,
        footerNavActive: false,
        desktopPilotActive: false,
        executorFooterVisible: false,
        headerPrimaryNavSuppressed: true,
      });
    }
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
        expect(resolveChatHost({ mobileDrawerActive: true, rightDockActive, navigationPlacement })).toBe("mobile-page");
      }
    }
  });

  it("routes the sidebar placement to the main page even when a dock exists", () => {
    expect(resolveChatHost({ mobileDrawerActive: false, rightDockActive: true, navigationPlacement: "sidebar" })).toBe("sidebar-page");
    expect(resolveChatHost({ mobileDrawerActive: false, rightDockActive: false, navigationPlacement: "sidebar" })).toBe("sidebar-page");
  });

  it("keeps the dock hand-off for the footer placement and falls through when no dock exists", () => {
    expect(resolveChatHost({ mobileDrawerActive: false, rightDockActive: true, navigationPlacement: "footer" })).toBe("dock");
    expect(resolveChatHost({ mobileDrawerActive: false, rightDockActive: false, navigationPlacement: "footer" })).toBe("none");
  });

  it("returns exactly one host for every input combination", () => {
    for (const mobileDrawerActive of [true, false]) {
      for (const rightDockActive of [true, false]) {
        for (const navigationPlacement of PLACEMENTS) {
          const host = resolveChatHost({ mobileDrawerActive, rightDockActive, navigationPlacement });
          expect(["mobile-page", "sidebar-page", "dock", "none"]).toContain(host);
        }
      }
    }
  });
});
