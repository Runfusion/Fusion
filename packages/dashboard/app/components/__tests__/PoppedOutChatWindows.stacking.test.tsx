import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";
import { FloatingWindow } from "../FloatingWindow";

vi.mock("../ChatView", () => ({
  ChatView: ({ initialDirectSession }: any) => <div data-testid={`chat-${initialDirectSession.id}`} />,
}));

const entry = (id: string, focusNonce = 1, projectId = "project-a", cascadeSlot = 0) => ({
  projectId,
  focusNonce,
  cascadeSlot,
  session: { id, agentId: "agent-1", title: id, status: "active" as const, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" },
});

describe("PoppedOutChatWindows stacking", () => {
  it("re-raises the mounted chat window without remounting and filters other projects", () => {
    const props = { projectId: "project-a", addToast: vi.fn(), onClose: vi.fn(), onOpenSessionInNewWindow: vi.fn() };
    const { rerender } = render(<><FloatingWindow windowKey="peer" title="Peer" onClose={() => {}} layer="task-detail"><div>peer</div></FloatingWindow><PoppedOutChatWindows {...props} entries={[entry("a"), entry("hidden", 1, "project-b")]} /></>);
    const chatOverlay = screen.getByTestId("floating-window-overlay-chat-window-project-a-a");
    const peer = screen.getByTestId("floating-window-peer");
    expect(screen.queryByTestId("chat-hidden")).not.toBeInTheDocument();
    expect(Number(chatOverlay.style.zIndex)).toBeGreaterThan(Number(peer.style.zIndex));
    const originalOverlay = chatOverlay;

    fireEvent.pointerDown(peer);
    expect(Number(peer.style.zIndex)).toBeGreaterThan(Number(chatOverlay.style.zIndex));
    rerender(<><FloatingWindow windowKey="peer" title="Peer" onClose={() => {}} layer="task-detail"><div>peer</div></FloatingWindow><PoppedOutChatWindows {...props} entries={[entry("a", 2)]} /></>);
    expect(screen.getByTestId("floating-window-overlay-chat-window-project-a-a")).toBe(originalOverlay);
    expect(Number(chatOverlay.style.zIndex)).toBeGreaterThan(Number(peer.style.zIndex));
  });
});
