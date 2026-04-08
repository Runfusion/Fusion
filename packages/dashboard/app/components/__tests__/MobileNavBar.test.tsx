import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MobileNavBar } from "../MobileNavBar";

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

const createDefaultProps = () => ({
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

describe("MobileNavBar", () => {
  beforeEach(() => {
    mockViewport("mobile");
  });

  it("renders four tab buttons", () => {
    render(<MobileNavBar {...createDefaultProps()} />);

    expect(screen.getByTestId("mobile-nav-tab-board")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-agents")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-activity")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-more")).toBeDefined();
  });

  it("active tab is highlighted", () => {
    render(<MobileNavBar {...createDefaultProps()} view="agents" />);

    expect(screen.getByTestId("mobile-nav-tab-agents").className).toContain("mobile-nav-tab--active");
    expect(screen.getByTestId("mobile-nav-tab-board").className).not.toContain("mobile-nav-tab--active");
  });

  it("board/list label changes based on current view", () => {
    const props = createDefaultProps();
    const { rerender } = render(<MobileNavBar {...props} view="board" />);
    expect(screen.getByText("Board")).toBeDefined();

    rerender(<MobileNavBar {...props} view="list" />);
    expect(screen.getByText("List")).toBeDefined();
  });

  it("shows activity badge with combined planning + mailbox count", () => {
    const { container } = render(
      <MobileNavBar
        {...createDefaultProps()}
        activePlanningSessionCount={2}
        mailboxUnreadCount={3}
      />,
    );

    const activityTab = screen.getByTestId("mobile-nav-tab-activity");
    const badge = activityTab.querySelector(".mobile-nav-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("5");
    expect(container.querySelectorAll(".mobile-nav-badge")).toHaveLength(1);
  });

  it("hides badge when combined count is zero", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} mailboxUnreadCount={0} activePlanningSessionCount={0} />);
    expect(container.querySelector(".mobile-nav-badge")).toBeNull();
  });

  it("caps badge at 99+", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxUnreadCount={75} activePlanningSessionCount={75} />);
    expect(screen.getByText("99+")).toBeDefined();
  });

  it("opens and toggles the more sheet", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("sheet contains expected navigation items", () => {
    render(<MobileNavBar {...createDefaultProps()} />);
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

  it("closes sheet and calls handler when item is clicked", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-settings"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("closes sheet on backdrop click", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    const backdrop = container.querySelector(".mobile-more-sheet-backdrop");
    expect(backdrop).not.toBeNull();

    fireEvent.click(backdrop!);
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("closes sheet on Escape", async () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });
  });

  it("returns null when modalOpen is true", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} modalOpen={true} />);
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
  });

  it("tab click calls onChangeView", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-agents"));
    expect(props.onChangeView).toHaveBeenCalledWith("agents");
  });

  it("applies footer-visible class when footer is shown", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} footerVisible={true} />);
    expect(container.querySelector(".mobile-nav-bar--with-footer")).not.toBeNull();
  });

  it("returns null on desktop viewport", () => {
    mockViewport("desktop");
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
  });
});
