import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findOverflowViewEntry,
  getVisibleOverflowViewEntries,
  isOverflowViewKeyVisible,
  type OverflowViewRenderProps,
} from "../overflowViewRegistry";
import { readStoredRightDockView, RIGHT_DOCK_VIEW_STORAGE_KEY } from "../RightDock";
import type { ChatViewProps } from "../ChatView";

vi.mock("../ChatView", () => ({
  ChatView: ({ projectId, addToast, floating, compactLayout, onPopOut, onMaximize, onMinimize, onClose }: ChatViewProps) => (
    <div
      data-testid="mock-chat-view"
      data-project-id={projectId}
      data-has-toast={String(typeof addToast === "function")}
      data-compact-layout={String(compactLayout === true)}
      data-has-dock-chrome-props={String(Boolean(floating || onPopOut || onMaximize || onMinimize || onClose))}
    >
      Chat dock view
    </div>
  ),
}));

const renderProps: OverflowViewRenderProps = {
  projectId: "project-chat",
  addToast: vi.fn(),
};

describe("overflowViewRegistry chat entry", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("registers Chat as an always-visible inline right-dock entry", () => {
    const chatEntry = getVisibleOverflowViewEntries({}).find((entry) => entry.key === "chat");

    expect(chatEntry).toBeTruthy();
    expect(chatEntry?.testId).toBe("right-dock-tab-chat");
    expect(chatEntry?.render).toBeTypeOf("function");
    expect(chatEntry?.onActivate).toBeUndefined();
    expect(getVisibleOverflowViewEntries({}).map((entry) => entry.key)).toContain("chat");
  });

  it("resolves Chat through registry helpers as a renderable visible view", () => {
    const chatEntry = findOverflowViewEntry("chat");

    expect(chatEntry?.key).toBe("chat");
    expect(chatEntry?.render).toBeTypeOf("function");
    expect(chatEntry?.onActivate).toBeUndefined();
    expect(isOverflowViewKeyVisible("chat")).toBe(true);
  });

  it("renders ChatView for both compact dock and expanded pop-out surfaces", async () => {
    const chatEntry = findOverflowViewEntry("chat");
    if (!chatEntry?.render) throw new Error("Expected chat registry entry to render inline");

    const compact = render(<>{chatEntry.render({ ...renderProps, surface: "dock", dockWidth: 360 })}</>);
    const compactChat = await screen.findByTestId("mock-chat-view");
    expect(compactChat).toHaveAttribute("data-project-id", "project-chat");
    expect(compactChat).toHaveAttribute("data-has-toast", "true");
    expect(compactChat).toHaveAttribute("data-compact-layout", "true");
    expect(compactChat).toHaveAttribute("data-has-dock-chrome-props", "false");
    compact.unmount();

    const wideDock = render(<>{chatEntry.render({ ...renderProps, surface: "dock", dockWidth: 900 })}</>);
    const wideDockChat = await screen.findByTestId("mock-chat-view");
    expect(wideDockChat).toHaveAttribute("data-compact-layout", "false");
    wideDock.unmount();

    render(<>{chatEntry.render({ ...renderProps, surface: "expand" })}</>);
    const expandedChat = await screen.findByTestId("mock-chat-view");
    expect(expandedChat).toHaveAttribute("data-project-id", "project-chat");
    expect(expandedChat).toHaveAttribute("data-has-toast", "true");
    expect(expandedChat).toHaveAttribute("data-compact-layout", "false");
    expect(expandedChat).toHaveAttribute("data-has-dock-chrome-props", "false");
  });

  it("keeps Files as the default right-dock view when no selection is persisted", () => {
    expect(window.localStorage.getItem(RIGHT_DOCK_VIEW_STORAGE_KEY)).toBeNull();
    expect(readStoredRightDockView({})).toBe("files");
  });
});
