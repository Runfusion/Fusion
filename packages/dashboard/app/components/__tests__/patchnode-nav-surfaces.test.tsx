import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeftSidebarNav } from "../LeftSidebarNav";
import { MobileNavBar } from "../MobileNavBar";
import { Header } from "../Header";
import { AlphaDesktopActionBar } from "../AlphaDesktopActionBar";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

vi.mock("../../api", () => ({ fetchScripts: vi.fn().mockResolvedValue({}) }));

function mobileProps() {
  return {
    view: "board" as const,
    onChangeView: vi.fn(),
    footerVisible: true,
    modalOpen: false,
    onOpenSettings: vi.fn(),
    onOpenActivityLog: vi.fn(),
    onOpenMailbox: vi.fn(),
    onOpenGitManager: vi.fn(),
    onOpenWorkflowEditor: vi.fn(),
    onOpenSchedules: vi.fn(),
    onOpenScripts: vi.fn(),
    onToggleTerminal: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenGitHubImport: vi.fn(),
    onOpenPlanning: vi.fn(),
    onResumePlanning: vi.fn(),
    onOpenUsage: vi.fn(),
    onViewAllProjects: vi.fn(),
    onRunScript: vi.fn(),
  };
}

describe("Patchnode navigation surfaces", () => {
  it("navigates from the desktop sidebar", () => {
    const onChangeView = vi.fn();
    render(<LeftSidebarNav view="board" onChangeView={onChangeView} onOpenSettings={vi.fn()} />);
    expect(screen.getByTestId("sidebar-nav-patchnode")).toHaveTextContent("History");
    fireEvent.click(screen.getByTestId("sidebar-nav-patchnode"));
    expect(onChangeView).toHaveBeenCalledWith("patchnode");
  });

  it("renders in mobile More by default and as a promoted tab", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width: 768px"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const defaults = mobileProps();
    const first = render(<MobileNavBar {...defaults} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-patchnode")).toHaveTextContent("History");
    fireEvent.click(screen.getByTestId("mobile-more-item-patchnode"));
    expect(defaults.onChangeView).toHaveBeenCalledWith("patchnode");
    first.unmount();

    const promoted = mobileProps();
    render(<MobileNavBar {...promoted} mobileNavPrimaryItems={["patchnode"]} />);
    expect(screen.getByTestId("mobile-nav-tab-patchnode")).toHaveTextContent("History");
    fireEvent.click(screen.getByTestId("mobile-nav-tab-patchnode"));
    expect(promoted.onChangeView).toHaveBeenCalledWith("patchnode");
  });

  it("retire History de la navigation mobile Alpha mais l’expose dans la barre desktop Alpha", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width: 768px"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const mobile = render(<MobileNavBar {...mobileProps()} alphaUpdatesEnabled alphaMenuOpenRequest={1} />);
    expect(screen.queryByTestId("mobile-nav-tab-patchnode")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-patchnode")).toBeNull();
    mobile.unmount();

    const sidebar = render(<LeftSidebarNav view="board" onChangeView={vi.fn()} alphaUpdatesEnabled />);
    expect(screen.queryByTestId("sidebar-nav-patchnode")).toBeNull();
    sidebar.unmount();

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    render(<Header onOpenSettings={vi.fn()} onOpenGitHubImport={vi.fn()} onChangeView={vi.fn()} showSkillsTab alphaUpdatesEnabled />);
    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    expect(screen.queryByTestId("view-overflow-patchnode")).toBeNull();

    const onOpenPilot = vi.fn();
    render(<AlphaDesktopActionBar entries={buildDashboardNavigationEntries({ view: "board", onChangeView: vi.fn(), onOpenPilot })} activeId="board" />);
    fireEvent.click(screen.getByTestId("alpha-desktop-nav-patchnode"));
    expect(onOpenPilot).toHaveBeenCalledWith("patchnode");
  });

  it("navigates from Header overflow and closes the menu", () => {
    const onChangeView = vi.fn();
    render(<Header onOpenSettings={vi.fn()} onOpenGitHubImport={vi.fn()} onChangeView={onChangeView} showSkillsTab />);
    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));
    expect(screen.getByTestId("view-overflow-patchnode")).toHaveTextContent("History");
    fireEvent.click(screen.getByTestId("view-overflow-patchnode"));
    expect(onChangeView).toHaveBeenCalledWith("patchnode");
    expect(screen.queryByTestId("view-overflow-patchnode")).toBeNull();
  });
});
