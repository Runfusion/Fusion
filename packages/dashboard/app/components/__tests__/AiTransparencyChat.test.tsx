import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageInfo } from "../../hooks/chatTypes";
import { StandardChatMessageItem, StandardStreamingMessage } from "../StandardChatSurface";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const common = {
  forcePlain: false,
  agentName: "Fusion",
  hideAssistantIdentity: false,
  showAssistantModelTag: true,
  activeModelTag: "Claude Opus 4.1",
  activeModelProvider: "anthropic",
  activeModelId: "claude-opus-4-1",
};

function message(
  role: ChatMessageInfo["role"],
  content: string,
  metadata?: ChatMessageInfo["metadata"],
  id = `${role}-message`,
): ChatMessageInfo {
  return {
    id,
    sessionId: "session-1",
    role,
    content,
    ...(metadata ? { metadata } : {}),
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("shared chat AI transparency", () => {
  afterEach(cleanup);

  it("labels a persisted assistant message with stored per-message attribution", () => {
    render(
      <StandardChatMessageItem
        {...common}
        message={message("assistant", "Generated answer", { modelProvider: "anthropic", modelId: "claude-opus-4-1" })}
        activeSessionId="session-1"
      />,
    );

    const note = screen.getByRole("note", { name: "AI-generated · anthropic/claude-opus-4-1" });
    expect(note).toHaveAttribute("data-compliance", "eu-ai-act-art-50");
    expect(note).toHaveAttribute("data-ai-disclosure", "generated-output");
    expect(note).toHaveAttribute("data-ai-provider", "anthropic");
    expect(note).toHaveAttribute("data-ai-model", "claude-opus-4-1");
  });

  it("does not label a human message", () => {
    render(<StandardChatMessageItem {...common} message={message("user", "Human steering")} activeSessionId="session-1" />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("renders one stable note for streaming text and nested tool output", () => {
    render(
      <StandardStreamingMessage
        {...common}
        streamingText="Streaming answer"
        streamingToolCalls={[{ toolName: "read_file", status: "completed", isError: false, result: "nested result" }]}
      />,
    );

    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveAttribute("data-ai-disclosure", "ai-interaction");
    expect(notes[0]).not.toHaveAttribute("aria-live");
  });

  it("falls back to provider-agnostic metadata when persisted provenance is absent", () => {
    render(
      <StandardChatMessageItem
        {...common}
        message={message("assistant", "Older answer")}
        activeSessionId="session-legacy"
      />,
    );
    expect(screen.getByRole("note")).toHaveAttribute("data-ai-attribution", "provider-agnostic");
    expect(screen.getByRole("note")).not.toHaveAttribute("data-ai-provider");
  });

  it("keeps historic Direct Chat attribution after the active session model changes", () => {
    const { rerender } = render(
      <StandardChatMessageItem
        {...common}
        message={message("assistant", "Answer from model A", { modelProvider: "anthropic", modelId: "claude-opus-4-1" }, "historic-a")}
        activeSessionId="session-1"
      />,
    );
    expect(screen.getByTestId("chat-ai-disclosure-historic-a")).toHaveAttribute("data-ai-provider", "anthropic");
    expect(screen.getByTestId("chat-ai-disclosure-historic-a")).toHaveAttribute("data-ai-model", "claude-opus-4-1");

    rerender(
      <StandardChatMessageItem
        {...common}
        activeModelProvider="openai"
        activeModelId="gpt-4o"
        activeModelTag="GPT-4o"
        message={message("assistant", "Answer from model A", { modelProvider: "anthropic", modelId: "claude-opus-4-1" }, "historic-a")}
        activeSessionId="session-1"
      />,
    );
    expect(screen.getByTestId("chat-ai-disclosure-historic-a")).toHaveAttribute("data-ai-provider", "anthropic");
    expect(screen.getByTestId("chat-ai-disclosure-historic-a")).toHaveAttribute("data-ai-model", "claude-opus-4-1");
    expect(screen.getByTestId("chat-ai-disclosure-historic-a")).not.toHaveAttribute("data-ai-provider", "openai");
  });

  it("discloses each persisted assistant row with its own provenance across a model-A-to-model-B transition", () => {
    render(
      <>
        <StandardChatMessageItem
          {...common}
          message={message("assistant", "From model A", { modelProvider: "anthropic", modelId: "claude-opus-4-1" }, "msg-a")}
          activeSessionId="session-1"
        />
        <StandardChatMessageItem
          {...common}
          activeModelProvider="openai"
          activeModelId="gpt-4o"
          activeModelTag="GPT-4o"
          message={message("assistant", "From model B", { modelProvider: "openai", modelId: "gpt-4o" }, "msg-b")}
          activeSessionId="session-1"
        />
        <StandardChatMessageItem
          {...common}
          activeModelProvider="openai"
          activeModelId="gpt-4o"
          message={message("assistant", "Legacy row without provenance", undefined, "msg-legacy")}
          activeSessionId="session-1"
        />
      </>,
    );

    expect(screen.getByTestId("chat-ai-disclosure-msg-a")).toHaveAttribute("data-ai-provider", "anthropic");
    expect(screen.getByTestId("chat-ai-disclosure-msg-b")).toHaveAttribute("data-ai-provider", "openai");
    expect(screen.getByTestId("chat-ai-disclosure-msg-legacy")).toHaveAttribute("data-ai-attribution", "provider-agnostic");
  });
});
