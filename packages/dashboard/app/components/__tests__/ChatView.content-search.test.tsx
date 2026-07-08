/*
FNXC:ChatSearch 2026-07-07-12:00:
Covers content search: no "Search in title only" toggle renders on desktop or mobile chat
sidebars (FN-7651 removed the affordance), and matchedMessagePreview still renders when
content-mode drove a session's inclusion — content search remains always-on.
*/
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import {
  renderWithAct,
  setupMockChat,
  mockViewportMode,
  activeSessionFixture,
  installChatViewEnv,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return { ...actual };
});
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

describe("ChatView content search", () => {
  it("does not render the title-only toggle on the desktop sidebar", async () => {
    mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-search-title-only-toggle")).toBeNull();
  });

  it("does not render the title-only toggle on the mobile sidebar", async () => {
    mockViewportMode("mobile");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-search-title-only-toggle")).toBeNull();
  });

  it("shows matchedMessagePreview for a session included via content match, with no toggle present", async () => {
    const contentMatchedSession = {
      ...activeSessionFixture,
      id: "session-content-match",
      title: "Weekend plans",
      matchedMessagePreview: "quarterly roadmap discussion",
    };
    setupMockChat({
      sessions: [contentMatchedSession],
      filteredSessions: [contentMatchedSession],
      searchQuery: "roadmap",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-session-matched-preview-session-content-match")).toHaveTextContent(
      "quarterly roadmap discussion",
    );
    expect(screen.queryByTestId("chat-search-title-only-toggle")).toBeNull();
  });
});
