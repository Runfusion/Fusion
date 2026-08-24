import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatFocusSelector } from "../ChatFocusSelector";

vi.mock("../../api", () => ({
  updateChatSession: vi.fn(),
}));

import { updateChatSession } from "../../api";

const mockUpdateChatSession = vi.mocked(updateChatSession);

/*
FNXC:ChatMemoryFocusSelectorTest 2026-08-13:
The per-chat memory-focus selector renders the session's active topic when set and a
cleared/absent chip (never a dangling topic chip) when focus is null/empty. Set/clear
persist via updateChatSession (PATCH /api/chat/sessions/:id -> chat_sessions.
memory_focus) so the topic survives reconnect; recall scoping is server-side (WITHIN-
project read filter via searchProjectMemory -> backend.search -> Stash REST topic
param), never a client post-query filter. A whole-project collapse value ("all"/"*")
shows the cleared state, matching how the engine treats it.
*/

const addToast = vi.fn();

function renderSelector(props: Partial<Parameters<typeof ChatFocusSelector>[0]> = {}) {
  return render(
    <ChatFocusSelector
      sessionId="SES-1"
      projectId="proj-123"
      memoryFocus={null}
      onPersist={vi.fn()}
      addToast={addToast}
      {...props}
    />,
  );
}

describe("ChatFocusSelector", () => {
  beforeEach(() => {
    mockUpdateChatSession.mockReset();
    addToast.mockReset();
  });

  it("shows the active topic on the chip when the session has a focus", () => {
    renderSelector({ memoryFocus: "auth-northstar" });
    expect(screen.getByTestId("chat-focus-chip")).toHaveTextContent("auth-northstar");
  });

  it("shows a cleared/absent state when the session focus is null (no dangling topic chip)", () => {
    renderSelector({ memoryFocus: null });
    const chip = screen.getByTestId("chat-focus-chip");
    expect(chip).toHaveTextContent("Focus");
    expect(chip).not.toHaveTextContent("auth-northstar");
  });

  it("treats an empty-string and whole-project-collapse focus as cleared", () => {
    renderSelector({ memoryFocus: "" });
    expect(screen.getByTestId("chat-focus-chip")).toHaveTextContent("Focus");
    // "all" and "*" collapse to whole-project scope on display.
    const { unmount } = renderSelector({ memoryFocus: "all" });
    unmount();
    void renderSelector({ memoryFocus: "*" });
    expect(screen.getAllByTestId("chat-focus-chip")[0]).toHaveTextContent("Focus");
  });

  it("preserves a set topic verbatim (whitespace-trimmed active chip)", () => {
    renderSelector({ memoryFocus: "  spaced topic  " });
    expect(screen.getByTestId("chat-focus-chip")).toHaveTextContent("spaced topic");
  });

  it("persists a typed topic via updateChatSession and reflects the persisted state", async () => {
    const onPersist = vi.fn();
    mockUpdateChatSession.mockResolvedValueOnce({ session: { id: "SES-1", memoryFocus: "auth-northstar" } } as any);
    renderSelector({ memoryFocus: null, onPersist });

    await userEvent.click(screen.getByTestId("chat-focus-chip"));
    await userEvent.type(screen.getByTestId("chat-focus-input"), "auth-northstar");
    await userEvent.click(screen.getByTestId("chat-focus-save"));

    await waitFor(() => expect(mockUpdateChatSession).toHaveBeenCalledWith("SES-1", { memoryFocus: "auth-northstar" }, "proj-123"));
    expect(onPersist).toHaveBeenCalledWith("auth-northstar");
  });

  it("clears to whole-project scope via the clear button when a topic is set", async () => {
    const onPersist = vi.fn();
    mockUpdateChatSession.mockResolvedValueOnce({ session: { id: "SES-1", memoryFocus: null } } as any);
    renderSelector({ memoryFocus: "auth-northstar", onPersist });

    await userEvent.click(screen.getByTestId("chat-focus-chip"));
    await userEvent.click(screen.getByTestId("chat-focus-clear"));

    await waitFor(() => expect(mockUpdateChatSession).toHaveBeenCalledWith("SES-1", { memoryFocus: null }, "proj-123"));
    expect(onPersist).toHaveBeenCalledWith(null);
  });

  it("clears to null when the draft is submitted empty", async () => {
    const onPersist = vi.fn();
    mockUpdateChatSession.mockResolvedValueOnce({ session: { id: "SES-1", memoryFocus: null } } as any);
    renderSelector({ memoryFocus: "auth-northstar", onPersist });

    await userEvent.click(screen.getByTestId("chat-focus-chip"));
    await userEvent.clear(screen.getByTestId("chat-focus-input"));
    await userEvent.click(screen.getByTestId("chat-focus-save"));

    await waitFor(() => expect(mockUpdateChatSession).toHaveBeenCalledWith("SES-1", { memoryFocus: null }, "proj-123"));
  });

  it("is hidden/disabled when there is no session id", () => {
    renderSelector({ sessionId: null });
    expect(screen.getByTestId("chat-focus-chip")).toBeDisabled();
  });
})