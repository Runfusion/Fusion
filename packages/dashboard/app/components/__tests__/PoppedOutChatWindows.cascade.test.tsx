import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLOATING_WINDOW_CASCADE_STEP_PX } from "../FloatingWindow";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";

vi.mock("../ChatView", () => ({
  ChatView: ({ initialDirectSession }: { initialDirectSession: { id: string } }) => <div>{initialDirectSession.id}</div>,
}));

const entry = (id: string, cascadeSlot: number, projectId = "project-a") => ({
  projectId,
  session: {
    id,
    agentId: "agent-1",
    title: id,
    status: "active" as const,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
  focusNonce: 1,
  cascadeSlot,
  minimized: false,
});

describe("PoppedOutChatWindows cascade", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
  });

  it("offsets stacked chat windows from their shared persisted geometry", () => {
    localStorage.setItem("kb-dashboard-chat-floating-window", JSON.stringify({
      size: { width: 900, height: 620 }, position: { x: 120, y: 96 },
    }));
    render(
      <PoppedOutChatWindows
        entries={[entry("first", 0), entry("second", 1)]}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />,
    );

    const first = screen.getByTestId("floating-window-chat-window-project-a-first");
    const second = screen.getByTestId("floating-window-chat-window-project-a-second");
    expect(Number.parseFloat(second.style.left) - Number.parseFloat(first.style.left)).toBe(FLOATING_WINDOW_CASCADE_STEP_PX);
    expect(Number.parseFloat(second.style.top) - Number.parseFloat(first.style.top)).toBe(FLOATING_WINDOW_CASCADE_STEP_PX);
    expect(second.style.left).not.toBe(first.style.left);
    expect(second.style.top).not.toBe(first.style.top);
  });

  it("separates near-viewport chat windows without persisting their shrunken presentation geometry", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    const baseGeometry = {
      size: { width: 1408, height: 868 },
      position: { x: 16, y: 16 },
    };
    localStorage.setItem("kb-dashboard-chat-floating-window", JSON.stringify(baseGeometry));

    render(
      <PoppedOutChatWindows
        entries={[entry("first", 0), entry("second", 1)]}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />,
    );

    const first = screen.getByTestId("floating-window-chat-window-project-a-first");
    const second = screen.getByTestId("floating-window-chat-window-project-a-second");
    expect(first.style.left).not.toBe(second.style.left);
    expect(first.style.top).not.toBe(second.style.top);
    expect(first.style.width).toBe(`${1408 - FLOATING_WINDOW_CASCADE_STEP_PX}px`);
    expect(second.style.width).toBe(`${1408 - FLOATING_WINDOW_CASCADE_STEP_PX * 2}px`);
    expect(JSON.parse(localStorage.getItem("kb-dashboard-chat-floating-window") ?? "{}")).toEqual(baseGeometry);
  });

  it("filters another project while preserving the surviving slot offset", () => {
    localStorage.setItem("kb-dashboard-chat-floating-window", JSON.stringify({
      size: { width: 900, height: 620 }, position: { x: 120, y: 96 },
    }));
    render(
      <PoppedOutChatWindows
        entries={[entry("visible", 1), entry("hidden", 0, "project-b")]}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("floating-window-chat-window-project-b-hidden")).toBeNull();
    expect(screen.getByTestId("floating-window-chat-window-project-a-visible").style.left).toBe(`${120 + FLOATING_WINDOW_CASCADE_STEP_PX * 2}px`);
  });
});
