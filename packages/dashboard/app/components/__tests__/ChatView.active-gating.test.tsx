import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

const { markRead } = vi.hoisted(() => ({ markRead: vi.fn() }));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
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

function renderChat(active: boolean, withMessages = true) {
  setupMockRooms();
  setupMockChat({
    ...defaultChatState,
    activeSession: activeSessionFixture,
    messages: withMessages ? [{ id: "message-1", role: "user", content: "Unread", createdAt: "2026-08-30T19:05:00.000Z" }] as never : [],
  });
  return renderWithAct(<ChatView addToast={vi.fn()} active={active} />);
}

describe("ChatView active keep-alive gate", () => {
  beforeEach(() => {
    markRead.mockClear();
  });

  it("marks an active conversation read", async () => {
    await renderChat(true);

    expect(markRead).toHaveBeenCalledWith("direct", activeSessionFixture.id, expect.any(String));
  });

  it("does not acknowledge messages while inactive, including an empty or streaming selection", async () => {
    await renderChat(false);
    expect(markRead).not.toHaveBeenCalled();

    setupMockChat({ ...defaultChatState, activeSession: null, messages: [] });
    await renderWithAct(<ChatView addToast={vi.fn()} active={false} />);
    expect(markRead).not.toHaveBeenCalled();

    setupMockChat({
      ...defaultChatState,
      activeSession: activeSessionFixture,
      isStreaming: true,
      messages: [{ id: "message-streaming", role: "assistant", content: "Still streaming", createdAt: "2026-08-31T14:54:00.000Z" }] as never,
    });
    await renderWithAct(<ChatView addToast={vi.fn()} active={false} />);
    expect(markRead).not.toHaveBeenCalled();
  });

  it("resumes acknowledgement after the retained view becomes active", async () => {
    const result = await renderChat(false);
    expect(markRead).not.toHaveBeenCalled();

    result.rerender(<ChatView addToast={vi.fn()} active />);
    expect(markRead).toHaveBeenCalledWith("direct", activeSessionFixture.id, expect.any(String));
  });
});
