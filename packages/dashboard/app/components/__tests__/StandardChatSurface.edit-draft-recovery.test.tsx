/*
FNXC:ChatMessageEdit 2026-09-16-05:58:
FN-459. When an edit is rejected the surface reloads authoritative rows; the target row's id changes,
the transcript keys by message id, so the row unmounts and the inline editor's local `editedText` —
the operator's typed correction — was destroyed. These tests pin the rescue contract: a republished
draft reopens the editor pre-filled, is consumed exactly once, and survives a remount under a new id.

Room surfaces are covered here as a negative case: they pass neither `canEdit` nor `onEditMessage`,
so no edit affordance exists for their `temp-<ts>` ids at all.
*/
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StandardChatMessageItem } from "../StandardChatSurface";
import type { ChatMessageInfo } from "../../hooks/chatTypes";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));

const shared = {
  forcePlain: false,
  agentName: "Assistant",
  hideAssistantIdentity: false,
  showAssistantModelTag: false,
  activeModelTag: null,
  activeModelProvider: null,
  activeSessionId: "chat-87bb623c",
};

function userMessage(overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo {
  return {
    id: "msg-ab12cd34",
    sessionId: "chat-87bb623c",
    role: "user",
    content: "bonjour",
    createdAt: "2026-09-16T00:00:01.000Z",
    ...overrides,
  };
}

function editorTextarea(messageId: string): HTMLTextAreaElement {
  return screen.getByTestId(`chat-message-edit-editor-${messageId}`).querySelector("textarea") as HTMLTextAreaElement;
}

describe("StandardChatMessageItem edit draft recovery (FN-459)", () => {
  it("(a) reopens the editor pre-filled and consumes the draft exactly once", () => {
    const onEditDraftConsumed = vi.fn();
    const { rerender } = render(
      <StandardChatMessageItem
        {...shared}
        message={userMessage()}
        canEdit
        onEditMessage={vi.fn()}
        initialEditDraft="bonjour corrigé"
        onEditDraftConsumed={onEditDraftConsumed}
      />,
    );

    expect(editorTextarea("msg-ab12cd34").value).toBe("bonjour corrigé");
    expect(onEditDraftConsumed).toHaveBeenCalledTimes(1);
    expect(onEditDraftConsumed).toHaveBeenCalledWith("msg-ab12cd34");

    // The owner clears the draft after consuming it; the editor must stay open with the operator's
    // in-progress text rather than being reopened/reset again.
    fireEvent.change(editorTextarea("msg-ab12cd34"), { target: { value: "bonjour corrigé encore" } });
    rerender(
      <StandardChatMessageItem
        {...shared}
        message={userMessage()}
        canEdit
        onEditMessage={vi.fn()}
        initialEditDraft={undefined}
        onEditDraftConsumed={onEditDraftConsumed}
      />,
    );

    expect(editorTextarea("msg-ab12cd34").value).toBe("bonjour corrigé encore");
    expect(onEditDraftConsumed).toHaveBeenCalledTimes(1);
  });

  it("(b) restores the correction after the rejected edit remounts the row under a new id", () => {
    const onEditDraftConsumed = vi.fn();
    // Before the rejection: the operator types a correction into the row the server knew as msg-ab12cd34.
    const { unmount } = render(
      <StandardChatMessageItem {...shared} message={userMessage()} canEdit onEditMessage={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("chat-message-edit-msg-ab12cd34"));
    fireEvent.change(editorTextarea("msg-ab12cd34"), { target: { value: "bonjour corrigé" } });
    // The failure reload changes the row id, so React unmounts this element type entirely.
    unmount();

    render(
      <StandardChatMessageItem
        {...shared}
        message={userMessage({ id: "msg-reloaded1" })}
        canEdit
        onEditMessage={vi.fn()}
        initialEditDraft="bonjour corrigé"
        onEditDraftConsumed={onEditDraftConsumed}
      />,
    );

    expect(editorTextarea("msg-reloaded1").value).toBe("bonjour corrigé");
    expect(onEditDraftConsumed).toHaveBeenCalledWith("msg-reloaded1");
  });

  it("(c) renders no edit affordance for a Room-style row that opts into neither canEdit nor onEditMessage", () => {
    render(<StandardChatMessageItem {...shared} message={userMessage({ id: "temp-1789537275231" })} />);

    expect(document.querySelectorAll(".chat-message-edit-action")).toHaveLength(0);
    expect(screen.queryByTestId("chat-message-edit-temp-1789537275231")).toBeNull();
    expect(screen.queryByTestId("chat-message-edit-editor-temp-1789537275231")).toBeNull();
    expect(document.querySelector('[aria-label="Edit message"]')).toBeNull();
  });
});
