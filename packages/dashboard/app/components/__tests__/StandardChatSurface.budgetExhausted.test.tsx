import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageInfo } from "../../hooks/chatTypes";
import { StandardChatMessageItem } from "../StandardChatSurface";
import { installChatViewEnv } from "./ChatView.test-harness";

/*
FNXC:ChatOutputBudget 2026-08-20-20:17 (RUFU-144):
Component coverage for the output-budget-exhausted inline notice. An assistant turn
persisted with empty content plus `metadata.budgetExhausted` must render the explicit
explanation (role="note", data-testid="chat-message-budget-exhausted") instead of a
silent empty bubble; failure UI takes precedence; non-empty content, user messages,
and ordinary empty (no-marker) turns must NOT show the notice. The mock i18n `t`
returns the fallback string, so assertions match the English fallback copy.
*/

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) };
});

// The shared harness resolves its `vi.mocked` handles against this file's own hoisted
// mock of ../../api (see ChatView.test-harness.tsx), so the factory must exist here.
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchSettings: vi.fn().mockResolvedValue({}),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: null, defaultModelId: null }),
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

installChatViewEnv();

const BUDGET_NOTICE_FALLBACK = "The model used its entire output budget on thinking — raise maxTokens for this model.";

function message(overrides: Partial<ChatMessageInfo>): ChatMessageInfo {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    content: "",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function renderMessage(overrides: Partial<ChatMessageInfo>) {
  return render(
    <StandardChatMessageItem
      message={message(overrides)}
      forcePlain={false}
      agentName="Assistant"
      hideAssistantIdentity={false}
      showAssistantModelTag={false}
      activeModelTag={null}
      activeModelProvider={null}
      activeSessionId="session-1"
    />,
  );
}

describe("StandardChatSurface output-budget-exhausted notice", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the inline notice for an empty assistant turn marked budgetExhausted", () => {
    renderMessage({ content: "", metadata: { budgetExhausted: true } });

    const notice = screen.getByTestId("chat-message-budget-exhausted");
    expect(notice).toHaveAttribute("role", "note");
    expect(notice).toHaveTextContent(BUDGET_NOTICE_FALLBACK);
    // The generic "No message" placeholder must be replaced by the notice.
    expect(screen.queryByTestId("chat-message-empty")).not.toBeInTheDocument();
  });

  it("keeps the thinking disclosure visible next to the notice when thinkingOutput exists", () => {
    const { container } = renderMessage({
      content: "",
      metadata: { budgetExhausted: true },
      thinkingOutput: "I will reason about this for a very long time.",
    });

    expect(screen.getByTestId("chat-message-budget-exhausted")).toBeInTheDocument();
    expect(container.querySelector(".chat-message-thinking")).not.toBeNull();
    expect(container.querySelector(".chat-message-thinking")).toHaveTextContent(
      "I will reason about this for a very long time.",
    );
  });

  it("prefers failure UI over the budget notice when both markers are present", () => {
    renderMessage({
      content: "",
      metadata: { budgetExhausted: true },
      failureInfo: {
        summary: "The model stream ended with an error.",
        errorClass: "ProviderError",
        code: "E400",
        detail: "provider said no",
      },
    });

    expect(screen.queryByTestId("chat-message-budget-exhausted")).not.toBeInTheDocument();
    expect(screen.getByText("Response failed")).toBeInTheDocument();
  });

  it("does not render the notice for non-empty content, even with the marker", () => {
    renderMessage({ content: "A partial answer that was truncated.", metadata: { budgetExhausted: true } });

    expect(screen.queryByTestId("chat-message-budget-exhausted")).not.toBeInTheDocument();
    expect(screen.getByText("A partial answer that was truncated.")).toBeInTheDocument();
  });

  it("does not render the notice for an ordinary empty assistant turn (no marker)", () => {
    renderMessage({ content: "", metadata: undefined });

    expect(screen.queryByTestId("chat-message-budget-exhausted")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-message-empty")).toBeInTheDocument();
  });

  it("never renders the notice for user messages, even with the marker", () => {
    renderMessage({ role: "user", content: "", metadata: { budgetExhausted: true } });

    expect(screen.queryByTestId("chat-message-budget-exhausted")).not.toBeInTheDocument();
  });
});
