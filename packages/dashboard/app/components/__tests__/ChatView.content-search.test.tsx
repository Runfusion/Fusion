/*
FNXC:ChatSearch 2026-07-07-00:00:
Covers the "Search in title only" toggle affordance: renders on desktop AND mobile chat
sidebars (shared DOM, CSS-breakpoint driven), toggling calls setSearchInTitleOnly, the toggle
does not leak into the Rooms scope, and matchedMessagePreview renders when content-mode drove
a session's inclusion.
*/
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import {
  renderWithAct,
  setupMockChat,
  setupMockRooms,
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

describe("ChatView content search toggle", () => {
  it("renders the title-only toggle on the desktop sidebar and calls setSearchInTitleOnly on click", async () => {
    mockViewportMode("desktop");
    const setSearchInTitleOnly = vi.fn();
    setupMockChat({ sessions: [], filteredSessions: [], searchInTitleOnly: false, setSearchInTitleOnly });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const toggle = screen.getByTestId("chat-search-title-only-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    expect(setSearchInTitleOnly).toHaveBeenCalledWith(true);
  });

  it("renders the title-only toggle on the mobile sidebar and calls setSearchInTitleOnly on click", async () => {
    mockViewportMode("mobile");
    const setSearchInTitleOnly = vi.fn();
    setupMockChat({ sessions: [], filteredSessions: [], searchInTitleOnly: true, setSearchInTitleOnly });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const toggle = screen.getByTestId("chat-search-title-only-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    expect(setSearchInTitleOnly).toHaveBeenCalledWith(false);
  });

  it("does not render the toggle in Rooms scope", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));

    expect(screen.queryByTestId("chat-search-title-only-toggle")).toBeNull();
  });

  it("shows matchedMessagePreview for a session included via content match", async () => {
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
      searchInTitleOnly: false,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-session-matched-preview-session-content-match")).toHaveTextContent(
      "quarterly roadmap discussion",
    );
  });
});
