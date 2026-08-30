import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StandardChatMessageItem, StandardStreamingMessage } from "../StandardChatSurface";
import type { ChatMessageInfo } from "../../hooks/chatTypes";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));

const shared = {
  forcePlain: false,
  agentName: "Assistant",
  hideAssistantIdentity: false,
  showAssistantModelTag: false,
  activeModelTag: null,
  activeModelProvider: null,
  activeSessionId: "session-1",
};

function message(overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo {
  return { id: "message-1", sessionId: "session-1", role: "assistant", content: "Reply", createdAt: "2026-08-23T00:00:00.000Z", ...overrides };
}

describe("StandardChatMessageItem quote action", () => {
  it("renders for populated assistant and user messages and invokes the owner", () => {
    const onQuoteMessage = vi.fn();
    const { rerender } = render(<StandardChatMessageItem {...shared} message={message()} onQuoteMessage={onQuoteMessage} />);
    fireEvent.click(screen.getByTestId("chat-message-quote-message-1"));
    expect(onQuoteMessage).toHaveBeenCalledWith(message());

    const userMessage = message({ id: "user-1", role: "user", content: "Question" });
    rerender(<StandardChatMessageItem {...shared} message={userMessage} onQuoteMessage={onQuoteMessage} />);
    fireEvent.click(screen.getByTestId("chat-message-quote-user-1"));
    expect(onQuoteMessage).toHaveBeenLastCalledWith(userMessage);
  });

  it("does not add a quote affordance to planner, empty, failed, or streaming messages", () => {
    const { rerender } = render(<StandardChatMessageItem {...shared} message={message()} />);
    expect(screen.queryByTestId("chat-message-quote-message-1")).toBeNull();

    rerender(<StandardChatMessageItem {...shared} message={message({ content: "   " })} onQuoteMessage={vi.fn()} />);
    expect(screen.queryByTestId("chat-message-quote-message-1")).toBeNull();

    rerender(<StandardChatMessageItem {...shared} message={message({ failureInfo: { summary: "Failed" } })} onQuoteMessage={vi.fn()} />);
    expect(screen.queryByTestId("chat-message-quote-message-1")).toBeNull();

    rerender(<StandardStreamingMessage {...shared} streamingText="Working" />);
    expect(screen.queryByTestId(/chat-message-quote/)).toBeNull();
  });
});
