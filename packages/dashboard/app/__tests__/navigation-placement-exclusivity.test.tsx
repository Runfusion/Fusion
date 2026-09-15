/**
 * FN-419 — Navigation placement exclusivity matrix.
 *
 * Complementary coverage: the AUTHORITATIVE symptom proof renders the real `<App />` in
 * `app/components/__tests__/App.test.tsx` (`describe("placement du menu de navigation")`). This suite exhausts the
 * cartesian product of viewport tier x placement x legacy `leftSidebarNav` flag against the same shared resolver the
 * shell consumes, asserting that exactly ONE primary navigation surface ever mounts.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileNavBar } from "../components/MobileNavBar";
import { Header } from "../components/Header";
import { LeftSidebarNav } from "../components/LeftSidebarNav";
import { DesktopActionBar } from "../components/DesktopActionBar";
import { resolveNavigationSurfaces, type NavigationPlacement } from "../utils/navigationPlacement";
import type { ViewportMode } from "../hooks/useViewportMode";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchExecutorStats: vi.fn().mockResolvedValue({ runningTaskCount: 0, maxConcurrent: 3 }),
  fetchGlobalConcurrency: vi.fn().mockResolvedValue({ maxConcurrent: 3 }),
  updateGlobalConcurrency: vi.fn().mockResolvedValue({ maxConcurrent: 3 }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue({}),
}));

/** MobileNavBar and Header read the real media queries, so every matrix cell publishes its tier first. */
function mockViewport(mode: ViewportMode) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)";
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1024px)";
      return {
        matches: mode === "mobile" ? isMobileQuery : mode === "tablet" ? isTabletQuery : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

const projects = [
  {
    id: "proj_1",
    name: "Project One",
    path: "/path/one",
    status: "active" as const,
    isolationMode: "in-process" as const,
    createdAt: "",
    updatedAt: "",
  },
];

const mobileNavProps = {
  view: "board" as const,
  onChangeView: vi.fn(),
  footerVisible: false,
  modalOpen: false,
  onOpenSettings: vi.fn(),
  onOpenActivityLog: vi.fn(),
  onOpenMailbox: vi.fn(),
  mailboxUnreadCount: 0,
  onOpenGitManager: vi.fn(),
  onOpenWorkflowEditor: vi.fn(),
  onOpenSchedules: vi.fn(),
  onOpenScripts: vi.fn(),
  onToggleTerminal: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenGitHubImport: vi.fn(),
  onOpenPlanning: vi.fn(),
  onResumePlanning: vi.fn(),
  activePlanningSessionCount: 0,
  onOpenUsage: vi.fn(),
  onRunScript: vi.fn(),
  projectId: "proj_1",
};

/**
 * FNXC:Navigation 2026-09-15-14:41:
 * The harness mirrors App's composition order but derives every surface flag from `resolveNavigationSurfaces`, so a
 * regression in the resolver — the single decider App also uses — fails here across the whole matrix.
 */
function NavigationShellHarness({
  viewportMode,
  navigationPlacement,
  leftSidebarNavFlag,
}: {
  viewportMode: ViewportMode;
  navigationPlacement: NavigationPlacement;
  leftSidebarNavFlag?: boolean;
}) {
  const isMobile = viewportMode === "mobile";
  const surfaces = resolveNavigationSurfaces({ viewportMode, projectShellPresent: true, navigationPlacement });

  return (
    <>
      <Header
        view="board"
        onChangeView={vi.fn()}
        mobileNavEnabled={isMobile}
        showAgentsTab={true}
        leftSidebarNavActive={surfaces.headerPrimaryNavSuppressed}
        experimentalFeatures={{ leftSidebarNav: leftSidebarNavFlag !== false }}
      />
      {surfaces.sidebarActive ? (
        <LeftSidebarNav
          view="board"
          onChangeView={vi.fn()}
          onOpenSettings={vi.fn()}
          projects={projects}
          currentProject={projects[0]}
          onSelectProject={vi.fn()}
          onViewAllProjects={vi.fn()}
          footerVisible={surfaces.executorFooterVisible || surfaces.footerNavActive}
        />
      ) : null}
      {surfaces.footerNavActive ? (
        <DesktopActionBar entries={[]} tasks={[]} projectId="proj_1" onToggleTerminal={vi.fn()} />
      ) : null}
      {isMobile ? <MobileNavBar {...mobileNavProps} /> : null}
    </>
  );
}

const VIEWPORTS: ViewportMode[] = ["mobile", "tablet", "desktop"];
const PLACEMENTS: NavigationPlacement[] = ["footer", "sidebar"];
const FLAGS: Array<{ label: string; value?: boolean }> = [
  { label: "absent", value: undefined },
  { label: "true", value: true },
  { label: "false", value: false },
];

describe("navigation placement exclusivity", () => {
  it("mounts exactly one primary navigation surface for every tier x placement x legacy flag", () => {
    for (const viewportMode of VIEWPORTS) {
      for (const navigationPlacement of PLACEMENTS) {
        for (const flag of FLAGS) {
          const label = `${viewportMode}/${navigationPlacement}/leftSidebarNav=${flag.label}`;
          mockViewport(viewportMode);
          const { container, unmount } = render(
            <NavigationShellHarness
              viewportMode={viewportMode}
              navigationPlacement={navigationPlacement}
              leftSidebarNavFlag={flag.value}
            />,
          );

          const sidebar = screen.queryByTestId("left-sidebar-nav");
          const footer = screen.queryByTestId("desktop-action-bar");
          const mobileBar = container.querySelector(".mobile-nav-bar");
          const mounted = [sidebar, footer, mobileBar].filter(Boolean);

          expect(mounted.length, `${label} mounted surface count`).toBe(1);

          if (viewportMode === "mobile") {
            expect(mobileBar, `${label} mobile owner`).not.toBeNull();
            expect(sidebar, `${label} no sidebar on mobile`).toBeNull();
            expect(footer, `${label} no wide footer on mobile`).toBeNull();
          } else if (navigationPlacement === "sidebar") {
            expect(sidebar, `${label} sidebar owner`).not.toBeNull();
            expect(footer, `${label} no footer in sidebar placement`).toBeNull();
            // No residual reservation shell: with no bottom bar, the sidebar never carries the footer modifier.
            expect(sidebar?.className).not.toContain("left-sidebar-nav--with-footer");
          } else {
            expect(footer, `${label} footer owner`).not.toBeNull();
            expect(sidebar, `${label} no sidebar in footer placement`).toBeNull();
          }

          unmount();
        }
      }
    }
  });

  it("suppresses the Header view shortcuts in both wide placements and restores them on mobile only", () => {
    for (const navigationPlacement of PLACEMENTS) {
      for (const viewportMode of ["tablet", "desktop"] as const) {
        mockViewport(viewportMode);
        const { unmount } = render(
          <NavigationShellHarness viewportMode={viewportMode} navigationPlacement={navigationPlacement} />,
        );
        expect(screen.queryByTitle("Board view"), `${viewportMode}/${navigationPlacement}`).toBeNull();
        expect(screen.queryByTestId("view-toggle-overflow-trigger"), `${viewportMode}/${navigationPlacement}`).toBeNull();
        unmount();
      }
    }
  });
});
