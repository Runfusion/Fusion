import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";

vi.mock("../FloatingWindow", () => ({
  FloatingWindow: ({ children, onClose, windowKey, raiseToFrontSignal }: any) => <section data-testid={`window-${windowKey}`} data-raise-signal={raiseToFrontSignal}><button onClick={onClose}>close</button>{children}</section>,
}));
vi.mock("../ChatView", () => ({
  ChatView: ({ initialDirectSession, initialDirectSessionNonce, onOpenSessionInNewWindow }: any) => <div data-testid={`chat-${initialDirectSession.id}`} data-session-nonce={initialDirectSessionNonce} onClick={() => onOpenSessionInNewWindow(initialDirectSession)} />,
}));

const entry = (id: string, focusNonce = 1, cascadeSlot = 0) => ({ projectId: "project-a", session: { id, agentId: "agent-1", title: id, status: "active" as const, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" }, focusNonce, cascadeSlot, minimized: false });

describe("PoppedOutChatWindows", () => {
  it("renders independent selected chats and closes only the requested entry", () => {
    const onClose = vi.fn();
    const onOpenSessionInNewWindow = vi.fn();
    render(<PoppedOutChatWindows entries={[entry("a", 2, 0), entry("b", 7, 1), { ...entry("other"), projectId: "project-b" }]} projectId="project-a" addToast={vi.fn()} onClose={onClose} onOpenSessionInNewWindow={onOpenSessionInNewWindow} />);
    expect(screen.getByTestId("chat-a")).toHaveAttribute("data-session-nonce", "2");
    expect(screen.getByTestId("chat-b")).toHaveAttribute("data-session-nonce", "7");
    expect(screen.getByTestId("window-chat-window-project-a-a")).toHaveAttribute("data-raise-signal", "2");
    expect(screen.getByTestId("window-chat-window-project-a-b")).toHaveAttribute("data-raise-signal", "7");
    expect(screen.queryByTestId("chat-other")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-a"));
    expect(onOpenSessionInNewWindow).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    fireEvent.click(screen.getByTestId("window-chat-window-project-a-b").querySelector("button")!);
    expect(onClose).toHaveBeenCalledWith("project-a", "b");
  });
});
