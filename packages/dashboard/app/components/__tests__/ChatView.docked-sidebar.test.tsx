import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import {
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

const session = {
  id: "session-001", agentId: "agent-001", status: "active" as const, title: "Architecture discussion",
  lastMessagePreview: "The latest conversation message", modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
  createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
};

async function renderSelected(props: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  setupMockChat({ activeSession: session, sessions: [session], filteredSessions: [session] });
  const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);
  await act(async () => { fireEvent.click(screen.getByTestId(`chat-session-${session.id}`)); });
  return view;
}

describe("ChatView shared sidebar layout", () => {
  it.each(["desktop", "tablet"] as const)("keeps the shared conversation sidebar visible on %s", async (mode) => {
    const restore = mockViewportMode(mode);
    try {
      const view = await renderSelected();
      expect(screen.getByTestId("chat-sidebar-panel")).toBeInTheDocument();
      expect(screen.getByTestId("chat-sidebar-resize-handle")).toHaveAttribute("aria-valuenow", "300");
      expect(screen.queryByTestId("chat-docked-sidebar-toggle")).toBeNull();
      expect(screen.queryByTestId("chat-back-btn")).toBeNull();
      view.unmount();
    } finally { restore(); }
  });

  it("uses the header backAction and no thread back row on mobile", async () => {
    const restore = mockViewportMode("mobile");
    try {
      const view = await renderSelected();
      expect(screen.getByTestId("chat-back-btn")).toHaveClass("view-back-button");
      expect(document.querySelector(".chat-thread-header-back")).toBeNull();
      expect(screen.queryByTestId("chat-sidebar-resize-handle")).toBeNull();
      view.unmount();
    } finally { restore(); }
  });

  it("keeps a wide Quick Chat on the shared sidebar without persisting ephemeral preferences", async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    try {
      const view = await renderSelected({ floating: true, persistChatPreferences: false });
      const handle = screen.getByTestId("chat-sidebar-resize-handle");
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(handle).toHaveAttribute("aria-valuenow", "316");
      expect(localStorage.getItem("kb:proj-123:kb-dashboard-view-sidebar-width")).toBeNull();
      view.unmount();
    } finally { bounds.mockRestore(); }
  });

  it("keeps dedicated windows bound to their thread with no list or create action", async () => {
    setupMockChat({ activeSession: session, sessions: [session], filteredSessions: [session] });
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating dedicatedConversation initialDirectSession={session} persistChatPreferences={false} />);
    expect(screen.queryByTestId("chat-sidebar-panel")).toBeNull();
    expect(screen.queryByTestId("chat-new-btn")).toBeNull();
    expect(screen.queryByTestId("chat-back-btn")).toBeNull();
    view.unmount();
  });
});
