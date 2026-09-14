import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeftSidebarNav } from "../LeftSidebarNav";
import { MobileNavBar } from "../MobileNavBar";
import { Header } from "../Header";
import { AlphaDesktopActionBar } from "../AlphaDesktopActionBar";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchScripts: vi.fn().mockResolvedValue({}),
  });
});

function mobileProps() {
  return {
    view: "board" as const,
    onChangeView: vi.fn(),
    footerVisible: false,
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
  it("keeps History out of official general navigation surfaces", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width: 768px"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const mobile = render(<MobileNavBar {...mobileProps()} />);
    expect(screen.queryByTestId("mobile-nav-tab-patchnode")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-patchnode")).toBeNull();
    mobile.unmount();

    const sidebar = render(<LeftSidebarNav view="board" onChangeView={vi.fn()} />);
    expect(screen.queryByTestId("sidebar-nav-patchnode")).toBeNull();
    sidebar.unmount();

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    const header = render(<Header onOpenSettings={vi.fn()} onOpenGitHubImport={vi.fn()} onChangeView={vi.fn()} showSkillsTab />);
    expect(screen.queryByTestId("view-overflow-patchnode")).toBeNull();
    header.unmount();

    render(<AlphaDesktopActionBar entries={buildDashboardNavigationEntries({ view: "board", onChangeView: vi.fn() })} activeId="board" tasks={[]} />);
    expect(screen.queryByTestId("alpha-desktop-nav-patchnode")).toBeNull();
  });
});
