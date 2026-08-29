import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatFocusSelector } from "../ChatFocusSelector";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  updateChatSession: vi.fn(),
}));

import { updateChatSession } from "../../api";

const mockUpdateChatSession = vi.mocked(updateChatSession);
const originalInnerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");

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

  afterEach(() => {
    document.head.querySelector("[data-testid='chat-focus-selector-css']")?.remove();
    if (originalInnerWidthDescriptor) {
      Object.defineProperty(window, "innerWidth", originalInnerWidthDescriptor);
    }
  });

  it("shows the active topic on the chip when the session has a focus", () => {
    renderSelector({ memoryFocus: "auth-northstar" });
    expect(screen.getByTestId("chat-focus-chip")).toHaveTextContent("auth-northstar");
  });

  it.each([null, "", "all", "*"])("renders memoryFocus=%j as an icon-only whole-project control", (memoryFocus) => {
    renderSelector({ memoryFocus });
    const chip = screen.getByRole("button", { name: "Memory focus topic" });

    expect(chip.textContent?.trim()).toBe("");
    expect(chip).not.toHaveTextContent(/Focus/);
    expect(chip.querySelector("svg")).toBeTruthy();
    expect(chip).toHaveClass("chat-focus-chip--icon-only");
  });

  it("keeps the disabled no-session control icon-only and accessible", () => {
    renderSelector({ sessionId: null });
    const chip = screen.getByRole("button", { name: "Memory focus topic" });

    expect(chip).toBeDisabled();
    expect(chip.textContent?.trim()).toBe("");
    expect(chip).not.toHaveTextContent(/Focus/);
  });

  it("preserves a set topic verbatim (whitespace-trimmed active chip)", () => {
    renderSelector({ memoryFocus: "  spaced topic  " });
    const chip = screen.getByTestId("chat-focus-chip");
    expect(chip).toHaveTextContent("spaced topic");
    expect(chip).toHaveClass("chat-focus-chip--active");
  });

  it.each(["desktop", "mobile"])("keeps the icon-only chip square without label spacing at the %s cascade", (viewport) => {
    Object.defineProperty(window, "innerWidth", { value: viewport === "mobile" ? 768 : 1024, configurable: true });
    const style = document.createElement("style");
    style.dataset.testid = "chat-focus-selector-css";
    style.textContent = loadAllAppCss();
    document.head.appendChild(style);
    renderSelector({ memoryFocus: null });

    const computed = getComputedStyle(screen.getByTestId("chat-focus-chip"));
    expect(computed.paddingLeft).toBe("0px");
    expect(computed.paddingRight).toBe("0px");
    expect(computed.gap).toBe("0px");
    expect(computed.inlineSize).toContain("var(--chat-input-control-size");
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

})