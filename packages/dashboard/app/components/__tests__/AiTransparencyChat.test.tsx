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

function message(role: ChatMessageInfo["role"], content: string): ChatMessageInfo {
  return {
    id: `${role}-message`,
    sessionId: "session-1",
    role,
    content,
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("shared chat AI transparency", () => {
  afterEach(cleanup);

  it("labels a persisted assistant message with exact session attribution", () => {
    render(<StandardChatMessageItem {...common} message={message("assistant", "Generated answer")} activeSessionId="session-1" />);

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
        activeModelProvider={null}
        activeModelId={null}
        message={message("assistant", "Older answer")}
        activeSessionId="session-legacy"
      />,
    );
    expect(screen.getByRole("note")).toHaveAttribute("data-ai-attribution", "provider-agnostic");
  });
});
