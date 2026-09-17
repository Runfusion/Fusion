/**
 * FN-468 — Frontière « shell mobile / shell ordinateur » à 1024 px.
 *
 * Preuve symptomatique : à 1000 px et 1023 px (tablette) le shell doit rendre la pill flottante AVEC ses onglets et
 * ne rendre ni colonne de gauche, ni pied de page large, ni dock droit ; à 1024 px le comportement ordinateur actuel
 * est intégralement préservé. La bande tablette avait DEUX verrous indépendants (le décideur de surfaces et le
 * prédicat de montage de `MobileNavBar`) : cette suite exerce les deux déciders PARTAGÉS que le shell consomme, donc
 * une régression dans l'un ou l'autre échoue ici.
 *
 * Complément : le montage isolé de `MobileNavBar` (cas u/v) est couvert dans
 * `app/components/__tests__/MobileNavBar.test.tsx`.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MobileNavBar } from "../components/MobileNavBar";
import { Header } from "../components/Header";
import { LeftSidebarNav } from "../components/LeftSidebarNav";
import { DesktopActionBar } from "../components/DesktopActionBar";
import { resolveDrawerPresentation } from "../components/ViewDrawer";
import { resolveNavigationSurfaces, type NavigationPlacement } from "../utils/navigationPlacement";
import { resolveChatListShortcutTarget } from "../utils/dashboardShortcutToggles";
import { isMobileShellMode, TABLET_MEDIA_QUERY, type ViewportMode } from "../hooks/useViewportMode";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchExecutorStats: vi.fn().mockResolvedValue({ runningTaskCount: 0, maxConcurrent: 3 }),
  fetchGlobalConcurrency: vi.fn().mockResolvedValue({ maxConcurrent: 3 }),
  updateGlobalConcurrency: vi.fn().mockResolvedValue({ maxConcurrent: 3 }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue({}),
}));

/** Pilote les VRAIES requêtes média du classificateur pour une largeur mesurée donnée. */
function mockViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "screen", { configurable: true, value: { width, height: 800 } });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)" || query === "(max-width: 767.98px)"
          ? width <= 768
          : query === "(max-width: 600px)"
            ? width <= 600
            : query === TABLET_MEDIA_QUERY
              ? width >= 769 && width <= 1023.98
              : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
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
 * Reproduit l'ordre de composition d'App en dérivant CHAQUE surface des deux déciders partagés
 * (`resolveNavigationSurfaces` pour les surfaces larges, `isMobileShellMode` pour la pill et le dock droit).
 */
function ShellHarness({
  viewportMode,
  navigationPlacement,
  rightDockEnabled = true,
}: {
  viewportMode: ViewportMode;
  navigationPlacement: NavigationPlacement;
  rightDockEnabled?: boolean;
}) {
  const surfaces = resolveNavigationSurfaces({ viewportMode, projectShellPresent: true, navigationPlacement });
  const mobileShellActive = isMobileShellMode(viewportMode);
  const rightDockActive = rightDockEnabled && !mobileShellActive;

  return (
    <>
      <Header
        view="board"
        onChangeView={vi.fn()}
        mobileNavEnabled={mobileShellActive}
        showAgentsTab={true}
        leftSidebarNavActive={surfaces.headerPrimaryNavSuppressed}
        rightDockAvailable={rightDockActive}
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
      {rightDockActive ? <div data-testid="right-dock-slot" /> : null}
      {mobileShellActive ? <MobileNavBar {...mobileNavProps} /> : null}
    </>
  );
}

const PLACEMENTS: NavigationPlacement[] = ["footer", "sidebar"];

describe("FN-468 mobile shell breakpoint", () => {
  // Cas (d) : l'ordinateur conserve exactement le comportement actuel pour les deux placements.
  it("preserves the desktop behaviour of both placements at 1440px", () => {
    expect(resolveNavigationSurfaces({ viewportMode: "desktop", projectShellPresent: true, navigationPlacement: "footer" })).toEqual({
      sidebarActive: false,
      footerNavActive: true,
      desktopPilotActive: true,
      executorFooterVisible: false,
      headerPrimaryNavSuppressed: true,
    });
    expect(resolveNavigationSurfaces({ viewportMode: "desktop", projectShellPresent: true, navigationPlacement: "sidebar" })).toEqual({
      sidebarActive: true,
      footerNavActive: false,
      desktopPilotActive: false,
      executorFooterVisible: false,
      headerPrimaryNavSuppressed: true,
    });

    mockViewportWidth(1440);
    const { container, unmount } = render(<ShellHarness viewportMode="desktop" navigationPlacement="footer" />);
    expect(screen.getByTestId("desktop-action-bar")).toBeDefined();
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
    unmount();
  });

  // Cas (e) : en mode tablet, aucun drapeau de surface large n'est vrai, quelle que soit la placement.
  it("reports no wide surface for the tablet tier in either placement", () => {
    for (const navigationPlacement of PLACEMENTS) {
      const surfaces = resolveNavigationSurfaces({ viewportMode: "tablet", projectShellPresent: true, navigationPlacement });
      expect(surfaces, navigationPlacement).toEqual({
        sidebarActive: false,
        footerNavActive: false,
        desktopPilotActive: false,
        executorFooterVisible: false,
        headerPrimaryNavSuppressed: false,
      });
    }
    // Le dock droit est une surface large : il suit le même prédicat de shell.
    expect(isMobileShellMode("tablet")).toBe(true);
    expect(isMobileShellMode("desktop")).toBe(false);
  });

  /*
  Cas (f) — preuve symptomatique : à 1000 px et 1023 px la pill est RENDUE AVEC SES ONGLETS et les trois surfaces
  larges sont absentes ; à 1024 px c'est exactement l'inverse.
  */
  it("gives tablet widths the pill and desktop widths the wide surfaces", () => {
    for (const navigationPlacement of PLACEMENTS) {
      for (const width of [1000, 1023]) {
        const label = `${navigationPlacement}@${width}`;
        mockViewportWidth(width);
        const { container, unmount } = render(
          <ShellHarness viewportMode="tablet" navigationPlacement={navigationPlacement} />,
        );

        const pill = container.querySelector(".mobile-nav-bar");
        expect(pill, `${label} pill mounted`).not.toBeNull();
        expect(container.querySelectorAll(".mobile-nav-tab").length, `${label} pill tabs`).toBeGreaterThan(0);
        expect(screen.queryByTestId("left-sidebar-nav"), `${label} no sidebar`).toBeNull();
        expect(screen.queryByTestId("desktop-action-bar"), `${label} no wide footer`).toBeNull();
        expect(screen.queryByTestId("right-dock-slot"), `${label} no right dock`).toBeNull();
        unmount();
      }

      mockViewportWidth(1024);
      const { container, unmount } = render(
        <ShellHarness viewportMode="desktop" navigationPlacement={navigationPlacement} />,
      );
      expect(container.querySelector(".mobile-nav-bar"), `${navigationPlacement}@1024 no pill`).toBeNull();
      expect(screen.getByTestId("right-dock-slot"), `${navigationPlacement}@1024 right dock`).toBeDefined();
      if (navigationPlacement === "sidebar") expect(screen.getByTestId("left-sidebar-nav")).toBeDefined();
      else expect(screen.getByTestId("desktop-action-bar")).toBeDefined();
      unmount();
    }
  });

  /*
  Cas (g) : la tablette n'est PAS transformée en téléphone. La présentation en tiroir plein écran reste réservée au
  mode `mobile`, même quand l'opt-in `data-mobile-drawers` est publié sur l'élément racine.
  */
  it("keeps phone drawer presentation out of the tablet tier", () => {
    document.documentElement.dataset.mobileDrawers = "true";
    try {
      expect(resolveDrawerPresentation({ viewportMode: "mobile" })).toBe(true);
      expect(resolveDrawerPresentation({ viewportMode: "tablet" })).toBe(false);
      expect(resolveDrawerPresentation({ viewportMode: "desktop" })).toBe(false);
    } finally {
      delete document.documentElement.dataset.mobileDrawers;
    }
  });

  // Cas (h) : sur tablette le Header ne rend aucun bouton de navigation de vues.
  it("removes the Header view navigation on tablet so the pill is the only primary surface", () => {
    for (const navigationPlacement of PLACEMENTS) {
      mockViewportWidth(1000);
      const { unmount } = render(<ShellHarness viewportMode="tablet" navigationPlacement={navigationPlacement} />);
      expect(screen.queryByTitle("Board view"), navigationPlacement).toBeNull();
      expect(screen.queryByTitle("List view"), navigationPlacement).toBeNull();
      expect(screen.queryByTestId("view-toggle-overflow-trigger"), navigationPlacement).toBeNull();
      unmount();
    }
  });

  // Cas (i) : exactement un `#header-workflow-slot` sur tablette (les deux producteurs ne peuvent pas coexister).
  it("renders exactly one header workflow slot on tablet for the board view", () => {
    for (const navigationPlacement of PLACEMENTS) {
      mockViewportWidth(1000);
      const { container, unmount } = render(
        <ShellHarness viewportMode="tablet" navigationPlacement={navigationPlacement} />,
      );
      expect(container.querySelectorAll("#header-workflow-slot").length, navigationPlacement).toBe(1);
      unmount();
    }
  });

  // Cas (j) : le raccourci liste de conversations suit la même frontière.
  it("routes the chat-list shortcut to the drawer across the whole mobile shell", () => {
    for (const mode of ["mobile", "tablet"] as const) {
      expect(
        resolveChatListShortcutTarget({ hasProject: true, mobileShellActive: isMobileShellMode(mode) }),
        mode,
      ).toBe("drawer");
    }
    expect(resolveChatListShortcutTarget({ hasProject: true, mobileShellActive: isMobileShellMode("desktop") })).toBe("popover");
    for (const mode of ["mobile", "tablet", "desktop"] as const) {
      expect(
        resolveChatListShortcutTarget({ hasProject: false, mobileShellActive: isMobileShellMode(mode) }),
        mode,
      ).toBe("none");
    }
  });
});
