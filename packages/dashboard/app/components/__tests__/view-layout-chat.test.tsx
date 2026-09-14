import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  installChatViewEnv,
  isChatDetailOpen,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 proves the Chat family on its real hosts: the conversation rail and the single New Chat entry live in the
canonical header, the only visible detail exit is the shared chevron before the title, and a dedicated window keeps
its own conversation identity instead of retargeting its controller.
*/

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), removeNav: vi.fn() }) };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "", defaultModelId: "" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();
afterEach(() => cleanup());

const baseProps = { projectId: "proj-chat", addToast: vi.fn() };

/** Opens the conversation the way a user does: through its list row in the shared rail. */
async function enterDetail() {
  fireEvent.pointerDown(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));
  fireEvent.click(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));
  await waitFor(() => expect(isChatDetailOpen()).toBe(true));
}

describe("FN-379 standardized Chat layout", () => {
  it("keeps the conversation rail and one canonical New Chat in the shared header", async () => {
    mockViewportMode("desktop");
    setupMockChat({ sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView {...baseProps} />);

    expect(screen.getByTestId("chat-sidebar-panel")).toBeInTheDocument();
    const creates = screen.getAllByTestId("chat-new-btn");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toHaveClass("view-action-button--create");
    expect(within(screen.getByRole("banner")).getByTestId("chat-new-btn")).toBe(creates[0]);
  });

  it("keeps an empty conversation collection on the rail with one creation entry", async () => {
    mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });
    await renderWithAct(<ChatView {...baseProps} />);

    expect(screen.getByTestId("chat-sidebar-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-new-btn")).toHaveLength(1);
    expect(isChatDetailOpen()).toBe(false);
  });

  it("starts phone Chat on the list and exposes only the shared header chevron in the thread", async () => {
    mockViewportMode("mobile");
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView {...baseProps} />);
    expect(isChatDetailOpen()).toBe(false);
    expect(screen.queryByTestId("chat-back-btn")).toBeNull();

    await enterDetail();

    const back = screen.getByTestId("chat-back-btn");
    expect(back).toHaveClass("view-back-button");
    expect(within(screen.getByRole("banner")).getByTestId("chat-back-btn")).toBe(back);
    expect(document.querySelectorAll(".chat-thread-header-back")).toHaveLength(0);

    fireEvent.click(back);
    await waitFor(() => expect(isChatDetailOpen()).toBe(false));
  });

  it("keeps the docked desktop rail beside the thread instead of swapping it away", async () => {
    mockViewportMode("desktop");
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(<ChatView {...baseProps} />);
    await enterDetail();

    expect(screen.getByTestId("chat-sidebar-panel")).toBeInTheDocument();
    expect(document.querySelector(".chat-sidebar")).toBeInTheDocument();
  });

  it("locks a dedicated conversation window on its own identity without list, back, or creation", async () => {
    mockViewportMode("desktop");
    setupMockChat({ activeSession: activeSessionFixture, sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    await renderWithAct(
      <ChatView
        {...baseProps}
        floating
        dedicatedConversation
        initialDirectSession={activeSessionFixture}
        persistChatPreferences={false}
      />,
    );

    expect(document.querySelector(".chat-thread")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-sidebar-panel")).toBeNull();
    expect(screen.queryByTestId("chat-back-btn")).toBeNull();
    expect(screen.queryByTestId("chat-new-btn")).toBeNull();
    expect(within(screen.getByRole("banner")).getByText(activeSessionFixture.title!)).toBeInTheDocument();
  });

  it("never selects a session merely because the destination mounted", async () => {
    mockViewportMode("desktop");
    const selectSession = vi.fn();
    setupMockChat({ sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], selectSession });
    await renderWithAct(<ChatView {...baseProps} />);

    expect(selectSession).not.toHaveBeenCalled();
  });
});
