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
import { Header } from "../components/Header";

function mockViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === "(max-width: 768px)";
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1024px)";
      return {
        matches: mode === "mobile" ? isMobileQuery : false,
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
  onOpenWorkflowSteps: vi.fn(),
  onOpenMissions: vi.fn(),
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

    const listTab = screen.getByTestId("mobile-nav-tab-list");
    expect(listTab.textContent).toContain("List");

    fireEvent.click(listTab);
    expect(props.onChangeView).toHaveBeenCalledWith("list");
  });

  it("board view is accessible via mobile nav bar", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} view="board" />);

    const boardTab = screen.getByTestId("mobile-nav-tab-board");
    expect(boardTab.textContent).toContain("Board");

    fireEvent.click(boardTab);
    expect(props.onChangeView).toHaveBeenCalledWith("board");
  });

  it("agents view is accessible via mobile nav bar", () => {
    const props = createDefaultMobileNavProps();
    render(<MobileNavBar {...props} />);

    const agentsTab = screen.getByTestId("mobile-nav-tab-agents");
    expect(agentsTab).toBeDefined();

    fireEvent.click(agentsTab);
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

    expect(screen.getByTestId("mobile-more-item-mailbox")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-missions")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-git")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-terminal")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-files")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-planning")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-workflow")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-schedules")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-github")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-usage")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-settings")).toBeDefined();
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

  it("header view toggle fallback renders on mobile when mobile nav is disabled", () => {
    render(
      <Header
        view="board"
        onChangeView={vi.fn()}
        mobileNavEnabled={false}
      />,
    );

    expect(screen.getByTitle("Board view")).toBeDefined();
    expect(screen.getByTitle("List view")).toBeDefined();
    expect(screen.getByTitle("Agents view")).toBeDefined();
  });

  it("all three task views remain reachable from mobile navigation surfaces", () => {
    const mobileNavOnChangeView = vi.fn();
    const mobileNav = render(
      <MobileNavBar
        {...createDefaultMobileNavProps()}
        onChangeView={mobileNavOnChangeView}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-nav-tab-board"));
    fireEvent.click(screen.getByTestId("mobile-nav-tab-agents"));

    expect(mobileNavOnChangeView).toHaveBeenCalledWith("board");
    expect(mobileNavOnChangeView).toHaveBeenCalledWith("agents");

    mobileNav.unmount();

    const headerOnChangeView = vi.fn();
    render(
      <Header
        view="board"
        onChangeView={headerOnChangeView}
        mobileNavEnabled={false}
      />,
    );

    fireEvent.click(screen.getByTitle("List view"));
    expect(headerOnChangeView).toHaveBeenCalledWith("list");
  });
});
