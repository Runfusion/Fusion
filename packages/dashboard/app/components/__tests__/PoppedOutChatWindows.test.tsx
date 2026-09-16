import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";
import { usePoppedOutChats } from "../../hooks/usePoppedOutChats";
import type { ChatSessionInfo } from "../../hooks/useChat";

vi.mock("../FloatingWindow", () => ({
  /* FNXC:ChatWindows 2026-09-15-04:01: FN-401 — the host reads the shared standard task-window size from this module, so the mock must expose it. */
  FLOATING_WINDOW_TASK_STANDARD_WIDTH: 800,
  FLOATING_WINDOW_TASK_STANDARD_HEIGHT: 680,
  FloatingWindow: ({ children, onClose, windowKey, raiseToFrontSignal, title, ariaLabel }: any) => <section data-testid={`window-${windowKey}`} data-raise-signal={raiseToFrontSignal} data-window-title={title} data-window-aria-label={ariaLabel}><button onClick={onClose}>close</button>{children}</section>,
}));
vi.mock("../ChatView", () => ({
  ChatView: ({ initialDirectSession, initialDirectSessionNonce, onOpenSessionInNewWindow, onActiveSessionChange }: any) => <div data-testid={`chat-${initialDirectSession.id}`} data-session-nonce={initialDirectSessionNonce} data-session-title={initialDirectSession.title} onClick={() => onOpenSessionInNewWindow(initialDirectSession)}><button data-testid={`sync-${initialDirectSession.id}`} onClick={() => onActiveSessionChange?.({ ...initialDirectSession, title: "Nouveau" })}>sync</button></div>,
}));

const entry = (id: string, focusNonce = 1, cascadeSlot = 0) => ({ projectId: "project-a", session: { id, agentId: "agent-1", title: id, status: "active" as const, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" }, focusNonce, cascadeSlot });

/*
FNXC:ChatWindows 2026-09-16-05:32:
FN-455 (C4): end-to-end host wiring for a conversation detached BEFORE the server generated its
title. The window opens on the "Chat" fallback name; once the hosted conversation republishes its
live identity, the window title and accessible name must follow without re-raising the window
(focusNonce) or reseeding the composer prefill an operator may be typing.
*/
const untitled: ChatSessionInfo = { id: "a", agentId: "agent-1", title: null, status: "active", createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z" };

function UntitledWindowHost() {
  const { entries, popOut, syncSession } = usePoppedOutChats();
  return (
    <>
      <button data-testid="open" onClick={() => popOut("project-a", untitled, { composerPrefill: "brouillon" })}>open</button>
      <button data-testid="generate" onClick={() => syncSession("project-a", { ...untitled, title: "Titre généré" })}>generate</button>
      <PoppedOutChatWindows
        entries={entries}
        projectId="project-a"
        addToast={vi.fn()}
        experimentalFeatures={{}}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />
      <span data-testid="prefill">{entries[0]?.composerPrefill?.text ?? ""}</span>
      <span data-testid="prefill-nonce">{entries[0]?.composerPrefill?.nonce ?? ""}</span>
    </>
  );
}

describe("PoppedOutChatWindows", () => {
  it("renders independent selected chats and closes only the requested entry", () => {
    const onClose = vi.fn();
    const onOpenSessionInNewWindow = vi.fn();
    render(<PoppedOutChatWindows entries={[entry("a", 2, 0), entry("b", 7, 1), { ...entry("other"), projectId: "project-b" }]} projectId="project-a" addToast={vi.fn()} experimentalFeatures={{}} onClose={onClose} onOpenSessionInNewWindow={onOpenSessionInNewWindow} />);
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

  /*
  FNXC:ChatWindows 2026-09-14-23:48:
  FN-396 symptom regression: renaming a detached conversation must repaint its window header and accessible name
  in place. The window must not remount (same windowKey) and must not be re-raised (raiseToFrontSignal unchanged).
  */
  it("repaints the window title and accessible name after a rename without remounting", () => {
    const renamedEntry = { ...entry("a", 2, 0), session: { ...entry("a", 2, 0).session, title: "Nouveau" } };
    const view = render(<PoppedOutChatWindows entries={[entry("a", 2, 0)]} projectId="project-a" addToast={vi.fn()} experimentalFeatures={{}} onClose={vi.fn()} onOpenSessionInNewWindow={vi.fn()} />);
    const before = screen.getByTestId("window-chat-window-project-a-a");
    expect(before).toHaveAttribute("data-window-title", "a");
    expect(before).toHaveAttribute("data-window-aria-label", "a");

    view.rerender(<PoppedOutChatWindows entries={[renamedEntry]} projectId="project-a" addToast={vi.fn()} experimentalFeatures={{}} onClose={vi.fn()} onOpenSessionInNewWindow={vi.fn()} />);

    const after = screen.getByTestId("window-chat-window-project-a-a");
    expect(after).toBe(before);
    expect(after).toHaveAttribute("data-window-title", "Nouveau");
    expect(after).toHaveAttribute("data-window-aria-label", "Nouveau");
    expect(after).toHaveAttribute("data-raise-signal", "2");
    expect(screen.getByTestId("chat-a")).toHaveAttribute("data-session-nonce", "2");
  });

  it("repaints an untitled detached window when the generated title arrives", () => {
    render(<UntitledWindowHost />);
    act(() => { fireEvent.click(screen.getByTestId("open")); });

    const before = screen.getByTestId("window-chat-window-project-a-a");
    expect(before).toHaveAttribute("data-window-title", "Chat");
    expect(before).toHaveAttribute("data-window-aria-label", "Chat");
    expect(before).toHaveAttribute("data-raise-signal", "1");

    act(() => { fireEvent.click(screen.getByTestId("generate")); });

    const after = screen.getByTestId("window-chat-window-project-a-a");
    expect(after).toBe(before);
    expect(after).toHaveAttribute("data-window-title", "Titre généré");
    expect(after).toHaveAttribute("data-window-aria-label", "Titre généré");
    // No re-raise, and the operator's in-progress draft is untouched.
    expect(after).toHaveAttribute("data-raise-signal", "1");
    expect(screen.getByTestId("chat-a")).toHaveAttribute("data-session-nonce", "1");
    expect(screen.getByTestId("prefill")).toHaveTextContent("brouillon");
    expect(screen.getByTestId("prefill-nonce")).toHaveTextContent("1");
  });

  it("forwards the hosted conversation's live session identity to its owner", () => {
    const onSessionSynced = vi.fn();
    render(<PoppedOutChatWindows entries={[entry("a", 2, 0), { ...entry("other"), projectId: "project-b" }]} projectId="project-a" addToast={vi.fn()} experimentalFeatures={{}} onClose={vi.fn()} onOpenSessionInNewWindow={vi.fn()} onSessionSynced={onSessionSynced} />);

    fireEvent.click(screen.getByTestId("sync-a"));

    expect(onSessionSynced).toHaveBeenCalledTimes(1);
    expect(onSessionSynced).toHaveBeenCalledWith("project-a", expect.objectContaining({ id: "a", title: "Nouveau" }));
  });
});
