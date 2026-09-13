import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fetchScripts } from "../../api";
import { createMobileNavGeometryStyle, MobileNavBar } from "../MobileNavBar";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(),
}));

const initialClientHeightDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");

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

const COMPONENT_GEOMETRY = {
  layoutViewportHeight: 844,
  visualViewportHeight: 504,
  viewportOffsetTop: 40,
  systemOffset: 16,
  floatingGap: 8,
  pillHeight: 44,
  popoverGap: 4,
  safeTopInset: 12,
  minimumItemHeight: 36,
} as const;

function readRenderedLength(element: HTMLElement, property: string): number {
  const value = element.style.getPropertyValue(property);
  if (!/^-?\d+(?:\.\d+)?px$/.test(value)) {
    throw new Error(`Expected a concrete ${property} on ${element.className}, received ${JSON.stringify(value)}.`);
  }
  return Number.parseFloat(value);
}

/*
FNXC:MobilePillPopover 2026-09-13-10:03:
Scripts-state coverage resolves the pill and popover independently from the complete geometry style emitted by MobileNavBar. No rectangle is injected; a missing sibling lift therefore moves only the popover and makes the numerical non-overlap check fail.
*/
function resolveRenderedPopover(nav: HTMLElement, popover: HTMLElement) {
  const navLift = readRenderedLength(nav, "--mobile-nav-keyboard-lift");
  const popoverLift = readRenderedLength(popover, "--mobile-nav-keyboard-lift");
  const navViewportTop = readRenderedLength(nav, "--mobile-nav-viewport-offset-top");
  const popoverViewportTop = readRenderedLength(popover, "--mobile-nav-viewport-offset-top");
  const expectedStyle = createMobileNavGeometryStyle(navLift, navViewportTop);
  for (const property of [
    "--mobile-nav-floating-gap",
    "--mobile-nav-keyboard-lift",
    "--mobile-nav-viewport-offset-top",
    "--mobile-nav-pill-bottom",
    "--mobile-nav-popover-bottom",
  ] as const) {
    expect(nav.style.getPropertyValue(property)).toBe(expectedStyle[property]);
    expect(popover.style.getPropertyValue(property)).toBe(expectedStyle[property]);
  }
  expect(popoverViewportTop).toBe(navViewportTop);

  const pillBottom = COMPONENT_GEOMETRY.layoutViewportHeight
    - COMPONENT_GEOMETRY.systemOffset
    - COMPONENT_GEOMETRY.floatingGap
    - navLift;
  const pillTop = pillBottom - COMPONENT_GEOMETRY.pillHeight;
  const popoverBottom = COMPONENT_GEOMETRY.layoutViewportHeight
    - COMPONENT_GEOMETRY.systemOffset
    - COMPONENT_GEOMETRY.floatingGap
    - popoverLift
    - COMPONENT_GEOMETRY.pillHeight
    - COMPONENT_GEOMETRY.popoverGap;
  const popoverMaxHeight = popoverBottom - popoverViewportTop - COMPONENT_GEOMETRY.safeTopInset;
  const items = Array.from(popover.querySelectorAll<HTMLElement>(".mobile-more-item"));
  const lastItem = items.at(-1);
  if (!lastItem) throw new Error("The production popover must contain a final navigation destination.");
  const contentHeight = items.length * COMPONENT_GEOMETRY.minimumItemHeight;
  const renderedPopoverHeight = Math.min(contentHeight, popoverMaxHeight);
  const popoverTop = popoverBottom - renderedPopoverHeight;
  const terminalScrollTop = Math.max(0, contentHeight - renderedPopoverHeight);
  const terminalItemBottom = popoverTop + contentHeight - terminalScrollTop;

  return {
    lastItem,
    navLift,
    pill: { top: pillTop, bottom: pillBottom },
    popover: { top: popoverTop, bottom: popoverBottom, maxHeight: popoverMaxHeight },
    popoverLift,
    viewportOffsetTop: popoverViewportTop,
    terminalItemBottom,
    terminalScrollTop,
  };
}

describe("MobileNavBar official mobile shell", () => {
  beforeEach(() => {
    mockViewport("mobile");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 844 });
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--mobile-nav-height");
    document.documentElement.style.removeProperty("--mobile-nav-pill-height");
    if (initialClientHeightDescriptor) {
      Object.defineProperty(document.documentElement, "clientHeight", initialClientHeightDescriptor);
    } else {
      delete (document.documentElement as { clientHeight?: number }).clientHeight;
    }
  });

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

  it.each(["empty", "loading", "populated"] as const)("keeps %s Scripts content inside the production-resolved popover above the pill", async (scriptsState) => {
    if (scriptsState === "loading") {
      vi.mocked(fetchScripts).mockReturnValue(new Promise(() => undefined));
    } else if (scriptsState === "populated") {
      vi.mocked(fetchScripts).mockResolvedValue([
        { name: "build", command: "pnpm build" },
        { name: "verify", command: "pnpm verify:fast", description: "Verify changes" },
      ]);
    }

    const { container } = render(<OfficialMobileShell keyboardOpen keyboardMetrics={{ keyboardOverlap: 300, viewportHeight: COMPONENT_GEOMETRY.visualViewportHeight, viewportOffsetTop: COMPONENT_GEOMETRY.viewportOffsetTop }} />);
    const trigger = screen.getByTestId("alpha-mobile-menu-trigger");
    expect(trigger).toHaveAttribute("aria-controls", "alpha-mobile-navigation-popover");
    fireEvent.click(trigger);
    const popover = screen.getByRole("menu", { name: "Navigate" });
    fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

    if (scriptsState === "loading") {
      await waitFor(() => expect(screen.getByTestId("mobile-more-scripts-loading")).toBeInTheDocument());
    } else if (scriptsState === "populated") {
      await waitFor(() => expect(screen.getByTestId("mobile-more-script-item-verify")).toBeInTheDocument());
    } else {
      await waitFor(() => expect(screen.getByText("No scripts — add one…")).toBeInTheDocument());
    }

    const geometry = resolveRenderedPopover(container.querySelector<HTMLElement>(".mobile-nav-bar")!, popover);
    expect(geometry.navLift).toBe(300);
    expect(geometry.popoverLift).toBe(geometry.navLift);
    expect(geometry.viewportOffsetTop).toBe(COMPONENT_GEOMETRY.viewportOffsetTop);
    expect(geometry.pill.top).toBeGreaterThanOrEqual(COMPONENT_GEOMETRY.viewportOffsetTop);
    expect(geometry.pill.bottom).toBeLessThanOrEqual(COMPONENT_GEOMETRY.viewportOffsetTop + COMPONENT_GEOMETRY.visualViewportHeight);
    expect(geometry.popover.top).toBeGreaterThanOrEqual(COMPONENT_GEOMETRY.viewportOffsetTop + COMPONENT_GEOMETRY.safeTopInset);
    expect(geometry.popover.bottom).toBeLessThan(geometry.pill.top);
    expect(geometry.pill.top - geometry.popover.bottom).toBe(COMPONENT_GEOMETRY.popoverGap);
    expect(geometry.popover.maxHeight).toBeGreaterThan(0);
    expect(geometry.terminalScrollTop).toBeGreaterThan(0);
    expect(geometry.terminalItemBottom).toBeLessThanOrEqual(geometry.popover.bottom);
    expect(geometry.lastItem).toBe(screen.getByTestId("mobile-more-item-settings"));
    expect(popover).toHaveAttribute("id", "alpha-mobile-navigation-popover");
    expect(container.querySelector(".mobile-more-sheet-backdrop")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
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
