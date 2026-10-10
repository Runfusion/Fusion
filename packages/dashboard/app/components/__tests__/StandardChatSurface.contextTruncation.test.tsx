import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageInfo } from "../../hooks/chatTypes";
import { StandardChatMessageItem } from "../StandardChatSurface";
import { installChatViewEnv } from "./ChatView.test-harness";

/*
FNXC:ChatContextGuardTier3 2026-09-04-22:51 (RUFU-183):
Component coverage for the tier-3 deterministic-truncation notice. An assistant turn
persisted with `metadata.contextTruncation` (rescue evidence from the chat overflow
guard) must render the shared inline notice (role="note",
data-testid="chat-context-truncation-notice") with the dropped counts interpolated, the
explicit unproven sentence when `contextTokensAfter` is null, and NOTHING for absent or
malformed payloads — the notice renders below the body in every assistant branch, so the
failure row proves it is not swallowed by the failure UI. Because every chat surface
(main ChatView, room transcripts, task-planner tab) renders messages through this one
component, this file is the whole-surface coverage.

FNXC:ChatContextGuardTier3 2026-09-04-23:45:
The notice copy is count-driven plural (repo `defaultValue_one`/`defaultValue_other`
convention) — a single dropped message must read "1 older message … was dropped",
never "1 older messages … were dropped". The mock i18n `t` mirrors that selection and
interpolates {{count}}/{{tokens}}.
*/

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallbackOrOptions?: string | Record<string, unknown>, maybeOptions?: Record<string, unknown>) => {
        if (typeof fallbackOrOptions === "string") {
          if (!maybeOptions) return fallbackOrOptions;
          return fallbackOrOptions.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(maybeOptions[name] ?? ""));
        }
        const options = fallbackOrOptions ?? {};
        const count = typeof options.count === "number" ? options.count : undefined;
        const template = (count === 1 ? options.defaultValue_one : options.defaultValue_other) ?? options.defaultValue ?? key;
        return String(template).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ""));
      },
    }),
  };
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

function message(overrides: Partial<ChatMessageInfo>): ChatMessageInfo {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    content: "A full rescued reply.",
    createdAt: "2026-09-04T00:00:00.000Z",
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

describe("StandardChatSurface context-truncation notice (RUFU-183)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the notice with dropped counts for a rescued assistant reply", () => {
    renderMessage({
      metadata: { contextTruncation: { droppedMessageCount: 4, droppedTokens: 45000, floorTokens: 100, contextTokensAfter: 90000 } },
    });

    const notice = screen.getByTestId("chat-context-truncation-notice");
    expect(notice).toHaveAttribute("role", "note");
    expect(notice).toHaveTextContent("4 older messages");
    expect(notice).toHaveTextContent("45000 tokens");
    expect(notice).toHaveTextContent("were dropped");
    // A proven rescue (non-null re-measurement) must not show the unproven sentence.
    expect(notice.textContent).not.toContain("could not be verified");
    // The reply body itself stays rendered — the notice discloses, it does not replace.
    expect(screen.getByText("A full rescued reply.")).toBeInTheDocument();
  });

  it("uses the singular form when exactly one message was dropped", () => {
    renderMessage({
      metadata: { contextTruncation: { droppedMessageCount: 1, droppedTokens: 1200, floorTokens: 100, contextTokensAfter: 90000 } },
    });

    const notice = screen.getByTestId("chat-context-truncation-notice");
    expect(notice).toHaveTextContent("1 older message (1200 tokens) was dropped");
    expect(notice.textContent).not.toContain("messages");
    expect(notice.textContent).not.toContain("were dropped");
  });

  it("adds the unproven sentence when contextTokensAfter is null", () => {
    renderMessage({
      metadata: { contextTruncation: { droppedMessageCount: 12, droppedTokens: 60000, floorTokens: 100, contextTokensAfter: null } },
    });

    const notice = screen.getByTestId("chat-context-truncation-notice");
    expect(notice).toHaveTextContent("12 older messages");
    expect(notice).toHaveTextContent("The reduced context size could not be verified.");
  });

  it("renders alongside the failure UI when a rescued send later failed", () => {
    renderMessage({
      content: "",
      failureInfo: { summary: "Context still over the hard limit.", code: "CHAT_CONTEXT_OVERFLOW" },
      metadata: { contextTruncation: { droppedMessageCount: 3, droppedTokens: 30000, floorTokens: 100, contextTokensAfter: null } },
    });

    expect(screen.getByText("Response failed")).toBeInTheDocument();
    expect(screen.getByTestId("chat-context-truncation-notice")).toHaveTextContent("3 older messages");
  });

  it("renders nothing for absent, malformed, or non-assistant rows (controls)", () => {
    renderMessage({});
    expect(screen.queryByTestId("chat-context-truncation-notice")).not.toBeInTheDocument();
    cleanup();

    renderMessage({ metadata: { contextTruncation: { droppedTokens: 45000 } } });
    expect(screen.queryByTestId("chat-context-truncation-notice")).not.toBeInTheDocument();
    cleanup();

    renderMessage({ metadata: { contextTruncation: { droppedMessageCount: "4", droppedTokens: 45000 } } });
    expect(screen.queryByTestId("chat-context-truncation-notice")).not.toBeInTheDocument();
    cleanup();

    renderMessage({ metadata: { contextTruncation: { droppedMessageCount: 0, droppedTokens: 0 } } });
    expect(screen.queryByTestId("chat-context-truncation-notice")).not.toBeInTheDocument();
    cleanup();

    renderMessage({ role: "user", content: "hello", metadata: { contextTruncation: { droppedMessageCount: 4, droppedTokens: 45000, contextTokensAfter: 90000 } } });
    expect(screen.queryByTestId("chat-context-truncation-notice")).not.toBeInTheDocument();
  });
});
