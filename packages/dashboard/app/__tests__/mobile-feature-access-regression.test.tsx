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
import { LeftSidebarNav } from "../components/LeftSidebarNav";

function mockViewport(mode: "mobile" | "tablet" | "desktop") {
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

function LeftSidebarAppGateHarness({ leftSidebarNavFlag }: { leftSidebarNavFlag?: boolean }) {
  const mode = useViewportMode();
  const isMobile = mode === "mobile";
  const viewMode = "project";
  const currentProject = createProjects()[0];
  const leftSidebarNavEnabled = leftSidebarNavFlag !== false;
  const sidebarActive = leftSidebarNavEnabled && !isMobile && viewMode === "project" && !!currentProject;

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

function PrimaryNavigationSurfaceHarness({ leftSidebarNavFlag }: { leftSidebarNavFlag?: boolean }) {
  const mode = useViewportMode();
  const isMobile = mode === "mobile";
  const currentProject = createProjects()[0];
  const leftSidebarNavEnabled = leftSidebarNavFlag !== false;
  const sidebarActive = leftSidebarNavEnabled && !isMobile && !!currentProject;

  return (
    <>
      <Header
        view="board"
        onChangeView={vi.fn()}
        mobileNavEnabled={isMobile}
        showAgentsTab={true}
        leftSidebarNavActive={sidebarActive}
      />
      <LeftSidebarAppGateHarness leftSidebarNavFlag={leftSidebarNavFlag} />
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
  });

  it("list view is accessible via mobile nav bar", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} view="board" />);

    const tasksTab = screen.getByTestId("mobile-nav-tab-tasks");
    expect(tasksTab.textContent).toContain("Tasks");

    fireEvent.click(tasksTab);
    expect(props.onChangeView).toHaveBeenCalledWith("board");
  });

  it("board view is accessible via mobile nav bar", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} view="list" />);

    const tasksTab = screen.getByTestId("mobile-nav-tab-tasks");
    expect(tasksTab.textContent).toContain("Tasks");

    fireEvent.click(tasksTab);
    expect(props.onChangeView).toHaveBeenCalledWith("list");
  });

  it("agents view is accessible via mobile nav bar", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-agents"));
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

  it("more sheet provides access to secondary mobile features", () => {
    render(<MobileNavBar {...createDefaultMobileNavProps()} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

    expect(screen.getByTestId("mobile-nav-tab-mailbox")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-mailbox")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-git")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-terminal")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-files")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-planning")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-workflow")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-schedules")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-github")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-usage")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-reliability")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-chat")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-nodes")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-settings")).toBeDefined();
  });

  it("keeps every configurable destination reachable when a custom footer omits one", () => {
    render(
      <MobileNavBar
        {...createDefaultMobileNavProps()}
        mobileNavPrimaryItems={["command-center", "tasks", "agents", "planning", "chat", "mailbox", "skills"]}
        showSkillsTab={false}
        experimentalFeatures={{ insights: false, memoryView: false }}
      />,
    );

    expect(screen.queryByTestId("mobile-nav-tab-missions")).toBeNull();
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-more")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-missions")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-more-item-skills")).toBeNull();
  });

  it("reliability is no longer a mobile More item and is reached via Command Center", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-reliability")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-command-center"));
    expect(props.onChangeView).toHaveBeenCalledWith("command-center");
  });

  it("nodes is no longer a mobile More item and is reached via Command Center", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-nodes")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-command-center"));
    expect(props.onChangeView).toHaveBeenCalledWith("command-center");
  });

  it("chat is accessible via the bottom nav while remaining absent from the More sheet", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} view="board" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-chat"));
    expect(props.onChangeView).toHaveBeenCalledWith("chat");

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-chat")).toBeNull();
  });

  it("mobile nav bar renders only on mobile viewport and hides for modal or desktop", () => {
    const mobileRender = render(<MobileNavBar {...createDefaultMobileNavProps()} />);
    expect(mobileRender.container.querySelector(".mobile-nav-bar")).not.toBeNull();
    mobileRender.unmount();

    mockViewport("desktop");
    const desktopRender = render(<MobileNavBar {...createDefaultMobileNavProps()} />);
    expect(desktopRender.container.querySelector(".mobile-nav-bar")).toBeNull();
    desktopRender.unmount();

    mockViewport("mobile");
    const modalRender = render(<MobileNavBar {...createDefaultMobileNavProps()} modalOpen={true} />);
    expect(modalRender.container.querySelector(".mobile-nav-bar")).toBeNull();
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
      expect(screen.getByTitle("List view")).toBeDefined();
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

  it("left sidebar app gate renders by default on desktop and tablet, honors explicit opt-out, and never renders on mobile", () => {
    /*
     * Surface Enumeration checklist asserted here:
     * - leftSidebarNav unset/undefined -> sidebar renders on desktop and tablet.
     * - leftSidebarNav true -> sidebar renders on desktop and tablet.
     * - leftSidebarNav false -> sidebar does not render and legacy Header nav returns.
     * - mobile never renders the sidebar for any flag state; MobileNavBar owns navigation.
     * - active sidebar state suppresses Header view-toggle and overflow shells.
     */
    const flagStates = [
      { label: "unset", leftSidebarNavFlag: undefined, sidebarExpected: true },
      { label: "true", leftSidebarNavFlag: true, sidebarExpected: true },
      { label: "false", leftSidebarNavFlag: false, sidebarExpected: false },
    ] as const;

    for (const { label, leftSidebarNavFlag, sidebarExpected } of flagStates) {
      for (const tier of ["desktop", "tablet"] as const) {
        mockViewport(tier);
        const { unmount } = render(<PrimaryNavigationSurfaceHarness leftSidebarNavFlag={leftSidebarNavFlag} />);
        expect(screen.queryByTestId("left-sidebar-nav"), `${label} flag on ${tier}`).toBe(
          sidebarExpected ? screen.getByTestId("left-sidebar-nav") : null,
        );
        expect(screen.queryByTitle("Board view"), `${label} flag header board shortcut on ${tier}`).toBe(
          sidebarExpected ? null : screen.getByTitle("Board view"),
        );
        expect(screen.queryByTestId("view-toggle-overflow-trigger"), `${label} flag overflow on ${tier}`).toBe(
          sidebarExpected ? null : screen.getByTestId("view-toggle-overflow-trigger"),
        );
        unmount();
      }

      mockViewport("mobile");
      const { container, unmount } = render(<PrimaryNavigationSurfaceHarness leftSidebarNavFlag={leftSidebarNavFlag} />);
      expect(screen.queryByTestId("left-sidebar-nav"), `${label} flag on mobile`).toBeNull();
      expect(container.querySelector(".mobile-nav-bar"), `${label} flag mobile nav`).not.toBeNull();
      unmount();
    }
  });

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
    expect(screen.getByTitle("List view")).toBeDefined();
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
    expect(screen.getByTitle("List view")).toBeDefined();
    expect(screen.getByTitle("Agents view")).toBeDefined();
  });

  it("all three task views remain reachable across mobile navigation surfaces", () => {
    const mobileNavOnChangeView = vi.fn();
    const mobileNav = render(
      <MobileNavBar
        {...createDefaultMobileNavProps()}
        view="missions"
        onChangeView={mobileNavOnChangeView}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));

    expect(mobileNavOnChangeView).toHaveBeenCalledWith("board");
    fireEvent.click(screen.getByTestId("mobile-nav-tab-agents"));
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

    fireEvent.click(screen.getByTitle("List view"));
    fireEvent.click(screen.getByTitle("Agents view"));
    expect(headerOnChangeView).toHaveBeenCalledWith("list");
    expect(headerOnChangeView).toHaveBeenCalledWith("agents");
  });
});
