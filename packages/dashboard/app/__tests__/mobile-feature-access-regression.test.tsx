/**
 * Mobile Feature Access Regression Guard
 *
 * This test suite ensures that core dashboard features remain accessible on mobile
 * viewports. It was created after mobile UI changes inadvertently removed access to
 * the list view and project navigation (FN-1291, FN-1301).
 *
 * Any test failure here means a core feature has become unreachable on mobile.
 * Do NOT remove or weaken these assertions without explicit product approval.
 *
 * Protected features:
 * - List view toggle
 * - Board view toggle
 * - Agents view toggle
 * - Project overview / "All Projects" navigation
 * - Secondary features via "More" sheet (settings, git, terminal, etc.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MobileNavBar } from "../components/MobileNavBar";
import { Header, useViewportMode } from "../components/Header";
import { isMobileShellMode } from "../hooks/useViewportMode";
import { LeftSidebarNav } from "../components/LeftSidebarNav";
import { resolveNavigationSurfaces, type NavigationPlacement } from "../utils/navigationPlacement";

function mockViewport(mode: "mobile" | "tablet" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)";
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1023.98px)";
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

const createDefaultMobileNavProps = () => ({
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
});

/*
 * FNXC:Navigation 2026-09-15-14:41:
 * FN-419: these harnesses used to DUPLICATE App's sidebar gate (and therefore asserted the removed
 * `experimentalFeatures.leftSidebarNav` placement semantics). They now consume the same shared resolver App does,
 * so the placement setting — not the legacy flag — decides which single surface mounts.
 */
function LeftSidebarAppGateHarness({ navigationPlacement }: { navigationPlacement: NavigationPlacement }) {
  const mode = useViewportMode();
  const currentProject = createProjects()[0];
  const { sidebarActive } = resolveNavigationSurfaces({
    viewportMode: mode,
    projectShellPresent: !!currentProject,
    navigationPlacement,
  });

  return sidebarActive ? (
    <LeftSidebarNav
      view="board"
      onChangeView={vi.fn()}
      onOpenSettings={vi.fn()}
      projects={createProjects()}
      currentProject={currentProject}
      onSelectProject={vi.fn()}
      onViewAllProjects={vi.fn()}
    />
  ) : null;
}

function PrimaryNavigationSurfaceHarness({ navigationPlacement }: { navigationPlacement: NavigationPlacement }) {
  const mode = useViewportMode();
  /* FN-468 : la pill possède la navigation primaire sur tout le shell mobile (téléphone ET tablette). */
  const mobileShellActive = isMobileShellMode(mode);
  const currentProject = createProjects()[0];
  const { headerPrimaryNavSuppressed } = resolveNavigationSurfaces({
    viewportMode: mode,
    projectShellPresent: !!currentProject,
    navigationPlacement,
  });

  return (
    <>
      <Header
        view="board"
        onChangeView={vi.fn()}
        mobileNavEnabled={mobileShellActive}
        showAgentsTab={true}
        leftSidebarNavActive={headerPrimaryNavSuppressed}
      />
      <LeftSidebarAppGateHarness navigationPlacement={navigationPlacement} />
      <MobileNavBar {...createDefaultMobileNavProps()} />
    </>
  );
}

const createProjects = () => [
  {
    id: "proj_1",
    name: "Project One",
    path: "/path/one",
    status: "active" as const,
    isolationMode: "in-process" as const,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "proj_2",
    name: "Project Two",
    path: "/path/two",
    status: "active" as const,
    isolationMode: "in-process" as const,
    createdAt: "",
    updatedAt: "",
  },
];

describe("Mobile Feature Access Regression Guard", () => {
  beforeEach(() => {
    mockViewport("mobile");
    document.documentElement.style.removeProperty("--mobile-nav-height");
  });

  /*
   * FN-480 : le bouton List codé en dur du menu est supprimé ; le producteur téléphone est le slot d'accès rapide
   * `tasks`, rendu ici dans le menu (`mobile-more-item-tasks`) car la sélection ne le contient pas.
   */
  it("keeps List accessible from the official mobile navigation menu", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} view="board" navigationMenuOpen quickAccessItems={["planning"]} />);

    expect(screen.queryByTestId("mobile-more-item-list")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-more-item-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("list");
  });

  /*
   * FNXC:ToolSurfaces 2026-09-16-23:06:
   * FN-437 cas (d) : le Header mobile ne rend plus Liste, Notes ni Activité. Ce garde-fou prouve que les trois
   * destinations restent atteignables depuis le menu du pied de page, qui en est désormais le propriétaire unique.
   */
  it("garde Liste, Notes et Activité atteignables depuis le menu de la barre du bas", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} view="board" navigationMenuOpen quickAccessItems={["planning"]} />);

    fireEvent.click(screen.getByTestId("mobile-more-item-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("list");

    fireEvent.click(screen.getByTestId("mobile-more-item-notes"));
    expect(props.onChangeView).toHaveBeenCalledWith("notes");

    fireEvent.click(screen.getByTestId("mobile-more-item-activity"));
    expect(props.onOpenActivityLog).toHaveBeenCalled();
  });

  /*
   * FN-437 cas croisé : un seul propriétaire par destination sur téléphone. Le même test asserte l'absence des trois
   * déclencheurs du Header ET la présence des trois entrées du menu, de sorte qu'aucun retrait ne peut rendre une
   * destination inaccessible et qu'aucune restauration ne peut recréer un doublon sans casser ce garde-fou.
   */
  it("attribue Liste, Notes et Activité au seul menu du pied de page sur téléphone", () => {
    const navProps = createDefaultMobileNavProps();
    render(
      <>
        <Header
          mobileNavEnabled
          projectId="proj_1"
          onChangeView={vi.fn()}
          onOpenActivityPanel={vi.fn()}
          onOpenNotesPanel={vi.fn()}
        />
        <MobileNavBar {...navProps} view="board" navigationMenuOpen quickAccessItems={["planning"]} />
      </>,
    );

    expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
    expect(screen.queryByTestId("header-activity-panel-btn")).toBeNull();
    expect(screen.queryByTestId("header-notes-panel-btn")).toBeNull();

    expect(screen.queryByTestId("mobile-more-item-list")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-more-item-notes")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-more-item-activity")).toBeInTheDocument();
  });

  /*
   * FN-480 cas (e) : sur téléphone, List a EXACTEMENT un producteur. Le slot d'accès rapide `tasks` le rend, en onglet
   * direct quand il est sélectionné et en entrée de menu sinon — jamais les deux, jamais zéro — le bouton codé en dur
   * `mobile-more-item-list` n'existe plus, `header-list-view-btn` reste absent, et le hamburger reste dernier enfant.
   */
  it("rend List dans exactement une surface de navigation selon la sélection", () => {
    for (const selection of [["tasks", "planning"], ["planning"]]) {
      const props = createDefaultMobileNavProps();
      const view = render(
        <>
          <Header mobileNavEnabled projectId="proj_1" onChangeView={vi.fn()} />
          <MobileNavBar {...props} view="list" navigationMenuOpen quickAccessItems={selection} />
        </>,
      );

      const tab = screen.queryByTestId("mobile-nav-tab-tasks");
      const menuEntry = screen.queryByTestId("mobile-more-item-tasks");
      expect([tab, menuEntry].filter(Boolean)).toHaveLength(1);
      expect(screen.queryByTestId("mobile-more-item-list")).toBeNull();
      expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
      expect(document.querySelector(".mobile-nav-bar--native")?.lastElementChild).toBe(screen.getByTestId("mobile-menu-trigger"));

      fireEvent.click((tab ?? menuEntry)!);
      expect(props.onChangeView).toHaveBeenCalledWith("list");
      expect(props.onChangeView).not.toHaveBeenCalledWith("board");
      view.unmount();
    }
  });

  it("mobile Header exposes New Task without the retired view toggle", () => {
    const onNewTask = vi.fn();
    render(<Header projectId="proj_1" mobileNavEnabled onNewTask={onNewTask} />);

    expect(screen.queryByTestId("mobile-view-toggle")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-header-new-task"));
    expect(onNewTask).toHaveBeenCalledOnce();
  });

  it("agents view is accessible via the mobile navigation menu", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} navigationMenuOpen />);

    fireEvent.click(screen.getByTestId("mobile-more-item-agents"));
    expect(props.onChangeView).toHaveBeenCalledWith("agents");
  });

  it("project list is accessible via header overflow menu on mobile", () => {
    const projects = createProjects();
    const onViewAllProjects = vi.fn();
    const { container } = render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onSelectProject={vi.fn()}
        onViewAllProjects={onViewAllProjects}
        onOpenSettings={vi.fn()}
        mobileNavEnabled={false}
      />,
    );

    const overflowTrigger = container.querySelector(".compact-overflow-trigger");
    expect(overflowTrigger).not.toBeNull();

    fireEvent.click(screen.getByTitle("More header actions"));

    const projectsButton = screen.getByTestId("overflow-project-selector-btn");
    expect(projectsButton.textContent).toContain("Projects");

    fireEvent.click(projectsButton);
    expect(onViewAllProjects).toHaveBeenCalledOnce();
  });

  it("official menu provides access to secondary mobile features", () => {
    render(<MobileNavBar {...createDefaultMobileNavProps()} navigationMenuOpen />);

    expect(screen.getByTestId("mobile-nav-tab-mailbox")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-mailbox")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-git")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-terminal")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-files")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-planning")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-workflow")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-schedules")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-github")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-usage")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-reliability")).toBeNull();
    /* FN-467 : Chat n'étant pas promouvable en accès rapide, le menu en est désormais le propriétaire unique. */
    expect(screen.getByTestId("mobile-more-item-chat")).toBeDefined();
    expect(screen.queryByTestId("mobile-nav-tab-chat")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-nodes")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-settings")).toBeDefined();
  });

  it("keeps enabled official destinations reachable without persisted footer customization", () => {
    render(<MobileNavBar {...createDefaultMobileNavProps()} navigationMenuOpen showSkillsTab={false} experimentalFeatures={{ insights: false, memoryView: false }} />);
    /* FN-467 : sans sélection persistée, Missions fait partie des cinq destinations par défaut de la rangée directe. */
    expect(screen.getByTestId("mobile-nav-tab-missions")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-more-item-missions")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-skills")).toBeNull();
  });

  it("reliability is no longer a mobile More item and is reached via Command Center", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} />);

    expect(screen.queryByTestId("mobile-more-item-reliability")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-command-center"));
    expect(props.onChangeView).toHaveBeenCalledWith("command-center");
  });

  it("nodes is no longer a mobile More item and is reached via Command Center", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} />);

    expect(screen.queryByTestId("mobile-more-item-nodes")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-command-center"));
    expect(props.onChangeView).toHaveBeenCalledWith("command-center");
  });

  /*
   * FN-467 : Chat n'est pas une destination promouvable en accès rapide (décision FN-446), il vit donc désormais dans
   * le menu de navigation du téléphone, qui en est le propriétaire unique. Naviguer depuis le menu referme le menu.
   */
  it("chat reste joignable une seule fois, depuis le menu de navigation", () => {
    const props = createDefaultMobileNavProps();
    const onUiMenuOpenChange = vi.fn();
    render(<MobileNavBar {...props} view="board" navigationMenuOpen onUiMenuOpenChange={onUiMenuOpenChange} />);

    expect(screen.queryByTestId("mobile-nav-tab-chat")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-more-item-chat"));
    expect(props.onChangeView).toHaveBeenCalledWith("chat");
    expect(onUiMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("mobile nav bar renders only on mobile viewport and hides for modal, desktop, or project overview", () => {
    const mobileRender = render(<MobileNavBar {...createDefaultMobileNavProps()} hidden={false} />);
    expect(mobileRender.container.querySelector(".mobile-nav-bar")).not.toBeNull();
    mobileRender.unmount();

    const hiddenRender = render(<MobileNavBar {...createDefaultMobileNavProps()} hidden />);
    expect(hiddenRender.container.querySelector(".mobile-nav-bar")).toBeNull();
    hiddenRender.unmount();

    mockViewport("desktop");
    const desktopRender = render(<MobileNavBar {...createDefaultMobileNavProps()} />);
    expect(desktopRender.container.querySelector(".mobile-nav-bar")).toBeNull();
    desktopRender.unmount();

    mockViewport("mobile");
    const modalRender = render(<MobileNavBar {...createDefaultMobileNavProps()} modalOpen={true} />);
    expect(modalRender.container.querySelector(".mobile-nav-bar")).toBeNull();
  });

  it("clears the published mobile-nav height when the overview hides the bar", () => {
    const hiddenRender = render(<MobileNavBar {...createDefaultMobileNavProps()} hidden />);
    expect(document.documentElement.style.getPropertyValue("--mobile-nav-height")).toBe("");
    hiddenRender.unmount();

    const { rerender, unmount } = render(<MobileNavBar {...createDefaultMobileNavProps()} hidden={false} />);
    expect(document.documentElement.style.getPropertyValue("--mobile-nav-height")).toMatch(/^[1-9]\d*px$/);

    rerender(<MobileNavBar {...createDefaultMobileNavProps()} hidden />);
    expect(document.documentElement.style.getPropertyValue("--mobile-nav-height")).toBe("");
    unmount();
  });

  it("desktop and tablet header view navigation is suppressed when left sidebar is active", () => {
    for (const tier of ["desktop", "tablet"] as const) {
      mockViewport(tier);
      const { unmount } = render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          mobileNavEnabled={false}
          showAgentsTab={true}
          leftSidebarNavActive={true}
        />,
      );

      expect(screen.queryByTitle("Board view")).toBeNull();
      expect(screen.queryByTestId("view-toggle-overflow-trigger")).toBeNull();
      unmount();
    }
  });

  it("desktop and tablet More views remain a dropdown rather than a Header right-dock toggle", () => {
    for (const tier of ["desktop", "tablet"] as const) {
      mockViewport(tier);
      const { unmount } = render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          mobileNavEnabled={false}
          showAgentsTab={true}
        />,
      );

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-chevron-down")).toBeTruthy();
      expect(trigger.querySelector(".lucide-panel-right")).toBeNull();
      fireEvent.click(trigger);
      expect(screen.getByRole("menu", { name: "More views" })).toBeInTheDocument();
      unmount();
    }
  });

  it("left sidebar nav leaves no duplicate Header right-dock toggle", () => {
    for (const tier of ["desktop", "tablet"] as const) {
      mockViewport(tier);
      const { unmount } = render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          mobileNavEnabled={false}
          showAgentsTab={true}
          leftSidebarNavActive={true}
        />,
      );

      expect(screen.queryByTestId("view-toggle-overflow-trigger")).toBeNull();
      expect(document.querySelector(".header-right-dock-toggle")).toBeNull();
      unmount();
    }
  });

  it("desktop and tablet header view navigation remains intact when left sidebar is inactive", () => {
    for (const tier of ["desktop", "tablet"] as const) {
      mockViewport(tier);
      const { unmount } = render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          mobileNavEnabled={false}
          showAgentsTab={true}
        />,
      );

      expect(screen.getByTitle("Board view")).toBeDefined();
      /*
       * FN-426 supersedes FN-382's dock-only List: the right sidebar is optional now, so the header toggle offers
       * List again — exactly once — on every host that renders this group.
       */
      expect(screen.getAllByTitle("List view")).toHaveLength(1);
      expect(screen.getByTestId("view-toggle-overflow-trigger")).toBeDefined();
      unmount();
    }
  });

  it("keeps the desktop and tablet More views chevron dropdown when the right dock is unavailable", () => {
    for (const tier of ["desktop", "tablet"] as const) {
      mockViewport(tier);
      const { unmount } = render(
        <Header
          view="board"
          onChangeView={vi.fn()}
          mobileNavEnabled={false}
          showAgentsTab={true}
        />,
      );

      const trigger = screen.getByTestId("view-toggle-overflow-trigger");
      expect(trigger.querySelector(".lucide-chevron-down")).toBeTruthy();
      fireEvent.click(trigger);
      expect(screen.getByRole("menu", { name: "More views" })).toBeInTheDocument();
      unmount();
    }
  });

  it("left sidebar app gate follows the project navigation placement and never renders in the mobile shell", () => {
    /*
     * Surface Enumeration checklist asserted here (FN-468 : la bande tablette appartient au shell mobile) :
     * - navigationPlacement "sidebar" -> la colonne ne rend QUE sur ordinateur.
     * - navigationPlacement "footer" -> aucune colonne ; le pied de page large possède la navigation sur ordinateur,
     *   donc les raccourcis de vues du Header restent supprimés.
     * - téléphone ET tablette ne rendent jamais la colonne, quelle que soit la placement : `MobileNavBar` possède la
     *   navigation et le Header n'ajoute aucune troisième surface.
     */
    const placements = [
      { label: "sidebar", navigationPlacement: "sidebar" as const, sidebarExpected: true },
      { label: "footer", navigationPlacement: "footer" as const, sidebarExpected: false },
    ];

    for (const { label, navigationPlacement, sidebarExpected } of placements) {
      mockViewport("desktop");
      {
        const { unmount } = render(<PrimaryNavigationSurfaceHarness navigationPlacement={navigationPlacement} />);
        expect(screen.queryByTestId("left-sidebar-nav"), `${label} placement on desktop`).toBe(
          sidebarExpected ? screen.getByTestId("left-sidebar-nav") : null,
        );
        // Either wide surface owns routing, so the Header never re-adds a third navigation.
        expect(screen.queryByTitle("Board view"), `${label} placement header board shortcut on desktop`).toBeNull();
        expect(screen.queryByTestId("view-toggle-overflow-trigger"), `${label} placement overflow on desktop`).toBeNull();
        unmount();
      }

      for (const tier of ["mobile", "tablet"] as const) {
        mockViewport(tier);
        const { container, unmount } = render(<PrimaryNavigationSurfaceHarness navigationPlacement={navigationPlacement} />);
        expect(screen.queryByTestId("left-sidebar-nav"), `${label} placement on ${tier}`).toBeNull();
        expect(container.querySelector(".mobile-nav-bar"), `${label} placement mobile nav on ${tier}`).not.toBeNull();
        expect(screen.queryByTitle("Board view"), `${label} placement header board shortcut on ${tier}`).toBeNull();
        unmount();
      }
    }
  });

  /*
   * FN-437 : Liste n'est plus un déclencheur du Header sur téléphone (le menu du pied de page en est le propriétaire
   * unique, cf. le garde-fou « garde Liste, Notes et Activité atteignables… »). Le repli du Header reste vérifié pour
   * Board et Agents, qui n'ont pas changé de propriétaire.
   */
  it("left sidebar suppression does not affect the mobile header fallback", () => {
    mockViewport("mobile");
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        mobileNavEnabled={false}
        showAgentsTab={true}
        leftSidebarNavActive={true}
      />,
    );

    expect(screen.getByTitle("Board view")).toBeDefined();
    expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
  });

  it("header view toggle fallback renders on mobile when mobile nav is disabled", () => {
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        mobileNavEnabled={false}
        showAgentsTab={true}
      />,
    );

    expect(screen.getByTitle("Board view")).toBeDefined();
    expect(screen.getByTitle("Agents view")).toBeDefined();
    expect(screen.queryByTestId("header-list-view-btn")).toBeNull();
  });

  it("all three task views remain reachable across mobile navigation surfaces", () => {
    const mobileNavOnChangeView = vi.fn();
    const mobileNav = render(
      <MobileNavBar
        {...createDefaultMobileNavProps()}
        view="missions"
        onChangeView={mobileNavOnChangeView}
        navigationMenuOpen
        quickAccessItems={["planning"]}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-more-item-tasks"));
    expect(mobileNavOnChangeView).toHaveBeenCalledWith("list");
    fireEvent.click(screen.getByTestId("mobile-more-item-agents"));
    expect(mobileNavOnChangeView).toHaveBeenCalledWith("agents");

    mobileNav.unmount();

    const headerOnChangeView = vi.fn();
    render(
      <Header
        view="board"
        onChangeView={headerOnChangeView}
        mobileNavEnabled={false}
        showAgentsTab={true}
      />,
    );

    // FN-437 : sur téléphone, seul le menu du pied de page route vers Liste ; le Header garde Board et Agents.
    expect(screen.queryByTitle("List view")).toBeNull();
    fireEvent.click(screen.getByTitle("Agents view"));
    expect(headerOnChangeView).toHaveBeenCalledWith("agents");
  });
});
