import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoppedOutChatEntry } from "../../hooks/usePoppedOutChats";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";

const viewportModeMock = vi.hoisted(() => ({ value: "desktop" as "desktop" | "tablet" | "mobile" }));
const chatViewPropsMock = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  isFullScreenSheetViewport: () => viewportModeMock.value === "mobile",
  isShortViewport: () => false,
  isTabletTouchViewport: () => false,
  useViewportMode: () => viewportModeMock.value,
}));

vi.mock("../ChatView", () => ({
  ChatView: (props: {
    active: boolean;
    findActive: boolean;
    initialDirectSession: { id: string };
  }) => {
    chatViewPropsMock(props);
    return (
      <div
        data-testid={`chat-${props.initialDirectSession.id}`}
        data-active={String(props.active)}
        data-find-active={String(props.findActive)}
      />
    );
  },
}));

const entry = (id: string, cascadeSlot: number, minimized: boolean): PoppedOutChatEntry => ({
  projectId: "project-a",
  session: {
    id,
    agentId: "agent-1",
    title: id,
    status: "active",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
  focusNonce: 1,
  cascadeSlot,
  minimized,
});

const sharedProps = {
  projectId: "project-a",
  addToast: vi.fn(),
  onOpenSessionInNewWindow: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  viewportModeMock.value = "desktop";
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
});

describe("PoppedOutChatWindows minimize", () => {
  it("keeps every hidden window mounted at the same geometry and stacking order", () => {
    const onClose = vi.fn();
    const visibleEntries = [entry("first", 0, false), entry("second", 1, false)];
    const { rerender } = render(
      <PoppedOutChatWindows {...sharedProps} entries={visibleEntries} onClose={onClose} />,
    );
    const firstOverlay = screen.getByTestId("floating-window-overlay-chat-window-project-a-first");
    const secondOverlay = screen.getByTestId("floating-window-overlay-chat-window-project-a-second");
    const firstPanel = screen.getByTestId("floating-window-chat-window-project-a-first");
    const secondPanel = screen.getByTestId("floating-window-chat-window-project-a-second");
    const firstGeometry = {
      left: firstPanel.style.left,
      top: firstPanel.style.top,
      width: firstPanel.style.width,
      height: firstPanel.style.height,
    };
    const secondGeometry = {
      left: secondPanel.style.left,
      top: secondPanel.style.top,
      width: secondPanel.style.width,
      height: secondPanel.style.height,
    };
    expect(Number(secondPanel.style.zIndex)).toBeGreaterThan(Number(firstPanel.style.zIndex));

    rerender(
      <PoppedOutChatWindows
        {...sharedProps}
        entries={visibleEntries.map((current) => ({ ...current, minimized: true }))}
        onClose={onClose}
      />,
    );

    for (const overlay of [firstOverlay, secondOverlay]) {
      expect(overlay).toHaveClass("floating-window-overlay--hidden");
      expect(overlay).toHaveAttribute("aria-hidden", "true");
    }
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <PoppedOutChatWindows {...sharedProps} entries={visibleEntries} onClose={onClose} />,
    );

    expect(screen.getByTestId("floating-window-overlay-chat-window-project-a-first")).toBe(firstOverlay);
    expect(screen.getByTestId("floating-window-overlay-chat-window-project-a-second")).toBe(secondOverlay);
    expect(firstOverlay).not.toHaveAttribute("aria-hidden");
    expect(secondOverlay).not.toHaveAttribute("aria-hidden");
    expect({
      left: firstPanel.style.left,
      top: firstPanel.style.top,
      width: firstPanel.style.width,
      height: firstPanel.style.height,
    }).toEqual(firstGeometry);
    expect({
      left: secondPanel.style.left,
      top: secondPanel.style.top,
      width: secondPanel.style.width,
      height: secondPanel.style.height,
    }).toEqual(secondGeometry);
    expect(Number(secondPanel.style.zIndex)).toBeGreaterThan(Number(firstPanel.style.zIndex));
  });

  it("releases ChatView activity and Find ownership while minimized", () => {
    render(
      <PoppedOutChatWindows
        {...sharedProps}
        entries={[entry("minimized", 0, true), entry("visible", 1, false)]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("chat-minimized")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("chat-minimized")).toHaveAttribute("data-find-active", "false");
    expect(screen.getByTestId("chat-visible")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("chat-visible")).toHaveAttribute("data-find-active", "true");
  });

  it("uses the same inert hidden-overlay contract on mobile", () => {
    viewportModeMock.value = "mobile";
    const onClose = vi.fn();
    render(
      <PoppedOutChatWindows
        {...sharedProps}
        entries={[entry("mobile", 0, true)]}
        onClose={onClose}
      />,
    );

    const overlay = screen.getByTestId("floating-window-overlay-chat-window-project-a-mobile");
    expect(overlay).toHaveClass("floating-window-overlay--hidden");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });
});
