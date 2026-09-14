import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findOverflowViewEntry,
  getVisibleOverflowViewEntries,
  isOverflowViewEntryExpandable,
  isOverflowViewEntryInline,
  isOverflowViewKeyVisible,
  type OverflowViewRenderProps,
} from "../overflowViewRegistry";
import { readStoredRightDockView, RIGHT_DOCK_VIEW_STORAGE_KEY } from "../RightDock";
import type { ChatViewProps } from "../ChatView";

vi.mock("../ChatView", () => ({
  ChatView: ({ projectId, addToast, floating, compactLayout, listOnly, openChatWindows, onPopOut, onMaximize, onClose, onOpenSessionInNewWindow, initialComposerDraft, onSendAsReport }: ChatViewProps) => (
    <div
      data-testid="mock-chat-view"
      data-project-id={projectId}
      data-has-toast={String(typeof addToast === "function")}
      data-compact-layout={String(compactLayout === true)}
      data-list-only={String(listOnly === true)}
      data-open-window-count={String(openChatWindows?.size ?? 0)}
      data-has-dock-chrome-props={String(Boolean(floating || onPopOut || onMaximize || onClose))}
      data-has-open-window={String(typeof onOpenSessionInNewWindow === "function")}
      data-prefill={initialComposerDraft}
      data-has-report={String(typeof onSendAsReport === "function")}
    >
      Chat window view
    </div>
  ),
}));

const renderProps: OverflowViewRenderProps = {
  projectId: "project-chat",
  addToast: vi.fn(),
  onOpenSessionInNewWindow: vi.fn(),
  experimentalFeatures: {},
  openChatWindows: new Set(["session-1"]),
  onSendAsReport: vi.fn(),
};

describe("overflowViewRegistry chat entry", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392 symptom: FN-390 turned the dock's Chat list into a launcher for an expanded window. Chat must be an inline,
  selectable, NON-expandable dock tool again on both wide hosts, so no route, stored preference, or programmatic
  request can ever produce a Chat expand modal.
  */
  it("registers Chat as an always-visible inline, non-expandable dock tool in every wide host", () => {
    const chatEntry = getVisibleOverflowViewEntries({}).find((entry) => entry.key === "chat");

    expect(chatEntry).toBeTruthy();
    expect(chatEntry?.testId).toBe("right-dock-tab-chat");
    expect(chatEntry?.render).toBeTypeOf("function");
    expect(chatEntry?.onActivate).toBeUndefined();
    expect(isOverflowViewEntryInline(chatEntry, {})).toBe(true);
    expect(isOverflowViewEntryInline(chatEntry, { hostMode: "alpha-desktop" })).toBe(true);
    expect(isOverflowViewEntryExpandable(chatEntry, {})).toBe(false);
    expect(isOverflowViewEntryExpandable(chatEntry, { hostMode: "alpha-desktop" })).toBe(false);
    expect(isOverflowViewKeyVisible("chat")).toBe(true);
  });

  it("uses the real registry renderer for a compact list that delegates conversations to dedicated windows", async () => {
    const chatEntry = findOverflowViewEntry("chat");
    if (!chatEntry?.render) throw new Error("Expected the Chat registry entry to render");

    render(<>{chatEntry.render({ ...renderProps, surface: "dock" })}</>);
    const chat = await screen.findByTestId("mock-chat-view");
    expect(chat).toHaveAttribute("data-project-id", "project-chat");
    expect(chat).toHaveAttribute("data-has-toast", "true");
    expect(chat).toHaveAttribute("data-compact-layout", "true");
    expect(chat).toHaveAttribute("data-list-only", "true");
    expect(chat).toHaveAttribute("data-open-window-count", "1");
    expect(chat).toHaveAttribute("data-has-dock-chrome-props", "false");
    expect(chat).toHaveAttribute("data-has-open-window", "true");
    expect(chat).toHaveAttribute("data-has-report", "true");
    // The list owns no composer, so it must never receive an external prefill: that belongs to the opened window.
    expect(chat).not.toHaveAttribute("data-prefill");
  });

  it("keeps Files as the default while restoring a persisted inline Chat selection", () => {
    expect(readStoredRightDockView({})).toBe("files");
    window.localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "chat");
    expect(readStoredRightDockView({})).toBe("chat");
    expect(readStoredRightDockView({ hostMode: "alpha-desktop" })).toBe("chat");
  });
});
