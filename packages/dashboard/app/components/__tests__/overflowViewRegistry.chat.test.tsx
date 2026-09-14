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
  chatComposerPrefill: { text: "Review this issue", nonce: 2 },
  onSendAsReport: vi.fn(),
};

describe("overflowViewRegistry chat entry", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("registers Chat as an always-visible launcher-only expandable entry in every wide host", () => {
    const chatEntry = getVisibleOverflowViewEntries({}).find((entry) => entry.key === "chat");

    expect(chatEntry).toBeTruthy();
    expect(chatEntry?.testId).toBe("right-dock-tab-chat");
    expect(chatEntry?.render).toBeTypeOf("function");
    expect(chatEntry?.onActivate).toBeUndefined();
    expect(isOverflowViewEntryInline(chatEntry, {})).toBe(false);
    expect(isOverflowViewEntryInline(chatEntry, { hostMode: "alpha-desktop" })).toBe(false);
    expect(isOverflowViewEntryExpandable(chatEntry, {})).toBe(true);
    expect(isOverflowViewEntryExpandable(chatEntry, { hostMode: "alpha-desktop" })).toBe(true);
    expect(isOverflowViewKeyVisible("chat")).toBe(true);
  });

  it("uses the real registry renderer for the canonical expanded Chat with prefill, report, and detached-window state", async () => {
    const chatEntry = findOverflowViewEntry("chat");
    if (!chatEntry?.render) throw new Error("Expected the Chat registry entry to render");

    render(<>{chatEntry.render({ ...renderProps, surface: "expand" })}</>);
    const chat = await screen.findByTestId("mock-chat-view");
    expect(chat).toHaveAttribute("data-project-id", "project-chat");
    expect(chat).toHaveAttribute("data-has-toast", "true");
    expect(chat).toHaveAttribute("data-compact-layout", "false");
    expect(chat).toHaveAttribute("data-list-only", "false");
    expect(chat).toHaveAttribute("data-open-window-count", "1");
    expect(chat).toHaveAttribute("data-has-dock-chrome-props", "false");
    expect(chat).toHaveAttribute("data-has-open-window", "true");
    expect(chat).toHaveAttribute("data-prefill", "Review this issue");
    expect(chat).toHaveAttribute("data-has-report", "true");
  });

  it("keeps Files as the default and rejects a persisted legacy inline Chat selection", () => {
    expect(readStoredRightDockView({})).toBe("files");
    window.localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "chat");
    expect(readStoredRightDockView({})).toBe("files");
  });
});
