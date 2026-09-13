import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileNavBar } from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";

vi.mock("../../api", () => ({
  fetchScripts: vi.fn().mockResolvedValue({}),
  normalizeScriptCatalog: vi.fn().mockReturnValue([]),
}));

function mockViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mode === "mobile" && (query === MOBILE_MEDIA_QUERY || query.includes("max-width: 768px")),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const createDefaultProps = () => ({
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
  projectId: "project-1",
});

function OfficialMobileShell(props: Partial<React.ComponentProps<typeof MobileNavBar>> = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <MobileNavBar {...createDefaultProps()} {...props} alphaMenuOpen={menuOpen} onAlphaMenuOpenChange={setMenuOpen} />;
}

describe("MobileNavBar official mobile shell", () => {
  beforeEach(() => mockViewport("mobile"));
  afterEach(() => document.documentElement.style.removeProperty("--mobile-nav-height"));

  it("renders the fixed pill destinations and no legacy tabs", () => {
    const { container } = render(<OfficialMobileShell />);
    expect(Array.from(container.querySelectorAll<HTMLElement>(".mobile-nav-tab")).map((tab) => tab.dataset.testid)).toEqual([
      "mobile-nav-tab-command-center",
      "mobile-nav-tab-planning",
      "mobile-nav-tab-chat",
      "mobile-nav-tab-mailbox",
    ]);
    expect(container.querySelector(".mobile-nav-bar")).toHaveClass("mobile-nav-bar--alpha");
    expect(screen.queryByTestId("mobile-nav-tab-tasks")).toBeNull();
    expect(screen.queryByTestId("mobile-nav-tab-more")).toBeNull();
  });

  it("opens the single navigation menu, routes List, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    render(<OfficialMobileShell {...props} />);
    const trigger = screen.getByTestId("alpha-mobile-menu-trigger");
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Navigate" })).toHaveClass("alpha-mobile-navigation-popover");
    fireEvent.click(screen.getByTestId("mobile-more-item-list"));
    expect(props.onChangeView).toHaveBeenCalledWith("list");

    await user.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Navigate" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps Whiteboard absent until its independent flag is enabled", () => {
    const disabled = render(<OfficialMobileShell experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("alpha-mobile-menu-trigger"));
    expect(screen.queryByTestId("mobile-more-item-whiteboard")).toBeNull();
    disabled.unmount();

    render(<OfficialMobileShell experimentalFeatures={{ whiteboardView: true }} />);
    fireEvent.click(screen.getByTestId("alpha-mobile-menu-trigger"));
    expect(screen.getByTestId("mobile-more-item-whiteboard")).toHaveTextContent("Alpha");
  });

  it("preserves unread and planning indicators on official destinations", () => {
    render(<OfficialMobileShell chatHasUnreadResponse mailboxUnreadCount={3} mailboxPendingApprovalCount={1} planningNeedsInput />);
    expect(screen.getByLabelText("Unread chat response")).toHaveClass("status-dot");
    expect(screen.getByLabelText("Pending approvals")).toHaveClass("status-dot");
    expect(screen.getByLabelText("Planning needs your input")).toHaveClass("status-dot");
    expect(screen.getByText("3")).toHaveClass("mobile-nav-tab-badge");
  });

  it("hides for modal, keyboard-independent hidden state, and non-mobile viewports", () => {
    const view = render(<OfficialMobileShell modalOpen />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    view.rerender(<OfficialMobileShell hidden />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    view.unmount();
    mockViewport("desktop");
    render(<OfficialMobileShell />);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
  });

  it("routes direct destinations exactly once", () => {
    const props = createDefaultProps();
    render(<OfficialMobileShell {...props} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-chat"));
    expect(props.onChangeView).toHaveBeenCalledTimes(1);
    expect(props.onChangeView).toHaveBeenCalledWith("chat");
  });
});
