import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";

vi.mock("../FloatingWindow", () => ({
  FloatingWindow: ({ children, onClose, windowKey }: any) => <section data-testid={`window-${windowKey}`}><button onClick={onClose}>close</button>{children}</section>,
}));
vi.mock("../ChatView", () => ({
  ChatView: ({ initialDirectSession, onOpenSessionInNewWindow }: any) => <div data-testid={`chat-${initialDirectSession.id}`} onClick={() => onOpenSessionInNewWindow(initialDirectSession)} />,
}));

const entry = (id: string) => ({ projectId: "project-a", session: { id, agentId: "agent-1", title: id, status: "active" as const, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" } });

describe("PoppedOutChatWindows", () => {
  it("renders independent selected chats and closes only the requested entry", () => {
    const onClose = vi.fn();
    const onOpenSessionInNewWindow = vi.fn();
    render(<PoppedOutChatWindows entries={[entry("a"), entry("b"), { ...entry("other"), projectId: "project-b" }]} projectId="project-a" addToast={vi.fn()} onClose={onClose} onOpenSessionInNewWindow={onOpenSessionInNewWindow} />);
    expect(screen.getByTestId("chat-a")).toBeInTheDocument();
    expect(screen.getByTestId("chat-b")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-other")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("window-chat-window-project-a-b").querySelector("button")!);
    expect(onClose).toHaveBeenCalledWith("project-a", "b");
  });
});
