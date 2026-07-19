import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeChatPanel } from "../ComposeChatPanel";

const createSession = vi.fn();
const archiveSession = vi.fn();
const selectSession = vi.fn();
const sendMessage = vi.fn();
const chat = {
  activeSession: null as { id: string } | null,
  archiveSession,
  createSession,
  isStreaming: false,
  selectSession,
  messages: [{ id: "assistant", role: "assistant", content: "Drafted narrative", sessionId: "scratch", createdAt: "now" }],
  sendMessage,
  streamingText: "",
};

vi.mock("../../hooks/useChat", () => ({
  FN_AGENT_ID: "__fusion__",
  useChat: () => chat,
}));

describe("ComposeChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.activeSession = null;
    createSession.mockImplementation(async () => {
      chat.activeSession = { id: "scratch" };
      return { id: "scratch" };
    });
    archiveSession.mockResolvedValue(undefined);
    selectSession.mockReset();
  });

  it("creates an FN scratch session before sending embed-aware context and archives it on close", async () => {
    const onClose = vi.fn();
    const props = { embeds: [{ kind: "mission" as const, id: "M-1", label: "Launch" }], draftBody: "", onUseDraft: vi.fn(), onClose };
    const { rerender, unmount } = render(<ComposeChatPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ agentId: "__fusion__", title: "compose-mail-scratch" }));
    // Model useChat's state-driven active-session render after createSession resolves.
    rerender(<ComposeChatPanel {...props} />);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("mission: Launch (M-1)")));
    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith("scratch");
  });

  it("waits for the initial scratch session selection and prevents double session creation", async () => {
    let resolveSession!: (session: { id: string }) => void;
    createSession.mockImplementation(() => new Promise((resolve) => {
      resolveSession = (session) => {
        chat.activeSession = session;
        resolve(session);
      };
    }));
    const props = { embeds: [] as never[], draftBody: "", onUseDraft: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<ComposeChatPanel {...props} />);

    const draft = screen.getByRole("button", { name: "Draft" });
    fireEvent.click(draft);
    fireEvent.click(draft);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    resolveSession({ id: "scratch" });
    rerender(<ComposeChatPanel {...props} />);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });

  it("restores the prior active chat session after closing the scratch session", async () => {
    const prior = { id: "user-session", title: "Existing chat" };
    chat.activeSession = prior;
    createSession.mockImplementation(async () => {
      chat.activeSession = { id: "scratch" };
      return { id: "scratch" };
    });
    const { rerender } = render(<ComposeChatPanel embeds={[]} draftBody="" onUseDraft={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    rerender(<ComposeChatPanel embeds={[]} draftBody="" onUseDraft={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith("scratch"));
    expect(selectSession).toHaveBeenCalledWith("user-session", prior);
  });

  it("returns generated text through Use draft", () => {
    const onUseDraft = vi.fn();
    render(<ComposeChatPanel embeds={[]} draftBody="Existing text" onUseDraft={onUseDraft} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use draft" }));
    expect(onUseDraft).toHaveBeenCalledWith("Drafted narrative");
  });
});
