/*
FNXC:ChatMessageEdit 2026-09-16-05:58:
FN-459. The direct Chat used to offer the edit pencil on EVERY user row, including the optimistic
`temp-<ts>` bubble, so the first edit after a send posted a local id and the server answered
`Message temp-… not found in session …` (404) while the typed correction was destroyed by the
reload. These tests pin the narrowed affordance and the non-destructive recovery.

Surface Enumeration: this file covers the ChatView host's data states (empty transcript, optimistic
`temp-` row, persisted `msg-<uuid8>` row, assistant row, CLI-backed session) plus the host inventory
of the affordance. The breakpoint dimension is deliberately exempt: the pencil and the inline editor
are the same DOM nodes at every width (StandardChatSurface has no responsive branch for
`chat-message-edit-action`), and the invariant under test is message identity, not layout.
*/
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import * as useChatModule from "../../hooks/useChat";
import { readAppFile, listComponentFiles } from "../../test/cssFixture";
import type { ChatMessageInfo, ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms", () => ({
  useChatRooms: () => ({
    rooms: [],
    roomsLoading: false,
    roomsError: null,
    activeRoom: null,
    activeRoomMembers: [],
    messages: [],
    messagesLoading: false,
    selectRoom: vi.fn(),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(),
    sendRoomMessage: vi.fn(),
    refreshRooms: vi.fn(),
  }),
}));
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", () => ({
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

const mockUseChat = vi.mocked(useChatModule.useChat);

const activeSession: ChatSessionInfo = {
  id: "chat-87bb623c",
  agentId: "agent-1",
  status: "active",
  title: "Chat",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

function makeMessage(overrides: Partial<ChatMessageInfo> & Pick<ChatMessageInfo, "id" | "role" | "content">): ChatMessageInfo {
  return {
    sessionId: activeSession.id,
    createdAt: "2026-09-16T00:00:01.000Z",
    ...overrides,
  } as ChatMessageInfo;
}

function setupChat(overrides: Partial<UseChatReturn> = {}): void {
  mockUseChat.mockReturnValue({
    sessions: [activeSession],
    activeSession,
    sessionsLoading: false,
    messages: [],
    messagesLoading: false,
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    streamingToolCalls: [],
    selectSession: vi.fn(),
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    editMessageAndResend: vi.fn(),
    editDraftRestore: null,
    clearEditDraftRestore: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessages: [],
    clearPendingMessage: vi.fn(),
    loadMoreMessages: vi.fn(),
    hasMoreMessages: false,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    filteredSessions: [activeSession],
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
    ...overrides,
  } as UseChatReturn);
}

function openConversation(): void {
  fireEvent.click(screen.getByTestId(`chat-session-${activeSession.id}`));
}

async function renderChat(): Promise<void> {
  render(
    <FileBrowserProvider>
      <ChatView />
    </FileBrowserProvider>,
  );
  openConversation();
  await waitFor(() => expect(document.querySelector(".chat-thread")).toBeTruthy());
}

describe("ChatView edit affordance is scoped to persisted rows (FN-459)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) offers no edit command and leaves no empty action shell for an optimistic temp- row", async () => {
    setupChat({ messages: [makeMessage({ id: "temp-1789537275231", role: "user", content: "bonjour" })] });
    await renderChat();

    expect(screen.queryByTestId("chat-message-edit-temp-1789537275231")).toBeNull();
    expect(document.querySelectorAll(".chat-message-edit-action")).toHaveLength(0);
    // The time row keeps its timestamp and its unrelated affordances, but carries no edit shell:
    // the pencil is fully unrendered, not an empty/dead button with a dangling aria-label.
    const timeRow = document.querySelector(".chat-message-time-row");
    expect(timeRow).toBeTruthy();
    expect(timeRow?.querySelector(".chat-message-edit-action")).toBeNull();
    expect(timeRow?.querySelector('[aria-label="Edit message"]')).toBeNull();
    expect(timeRow?.textContent?.trim().length).toBeGreaterThan(0);
  });

  /*
  Anti-regression guard for the `msg-` identity constraint: `msg-<uuid8>` is the PERSISTED id format
  produced by ChatStore.addMessage. If the shared guard ever classified it as local, this positive
  case fails immediately and the whole transcript would have silently become uneditable.
  */
  it("(b) offers the edit command on a persisted msg-<uuid8> user row", async () => {
    setupChat({ messages: [makeMessage({ id: "msg-ab12cd34", role: "user", content: "bonjour" })] });
    await renderChat();

    expect(screen.getByTestId("chat-message-edit-msg-ab12cd34")).toBeInTheDocument();
  });

  it("(c) offers no edit command while a CLI-backed session owns the transcript", async () => {
    setupChat({
      activeSession: { ...activeSession, cliExecutorAdapterId: "cli-adapter-1" } as ChatSessionInfo,
      sessions: [{ ...activeSession, cliExecutorAdapterId: "cli-adapter-1" } as ChatSessionInfo],
      filteredSessions: [{ ...activeSession, cliExecutorAdapterId: "cli-adapter-1" } as ChatSessionInfo],
      messages: [makeMessage({ id: "msg-ab12cd34", role: "user", content: "bonjour" })],
    });
    await renderChat();

    expect(screen.queryByTestId("chat-message-edit-msg-ab12cd34")).toBeNull();
  });

  it("(d) renders no edit affordance at all for an empty transcript", async () => {
    setupChat({ messages: [] });
    await renderChat();

    expect(document.querySelectorAll(".chat-message-edit-action")).toHaveLength(0);
  });

  it("(e) offers no edit command on an assistant row, even with a persisted msg- id", async () => {
    setupChat({ messages: [makeMessage({ id: "msg-assist01", role: "assistant", content: "réponse" })] });
    await renderChat();

    expect(screen.queryByTestId("chat-message-edit-msg-assist01")).toBeNull();
    expect(document.querySelectorAll(".chat-message-edit-action")).toHaveLength(0);
  });

  it("reopens the editor pre-filled when a rejected edit republishes the correction", async () => {
    const clearEditDraftRestore = vi.fn();
    setupChat({
      messages: [makeMessage({ id: "msg-reloaded1", role: "user", content: "bonjour" })],
      editDraftRestore: { messageId: "msg-reloaded1", content: "bonjour corrigé" },
      clearEditDraftRestore,
    });
    await renderChat();

    const editor = await screen.findByTestId("chat-message-edit-editor-msg-reloaded1");
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("bonjour corrigé");
    expect(clearEditDraftRestore).toHaveBeenCalledWith("msg-reloaded1");
  });
});

/*
(f) Host inventory. The edit affordance must keep exactly one renderer (StandardChatSurface) and two
hosts (ChatView, TaskPlannerChatTab). A third host would be a surface this fix never reached.
*/
describe("chat edit affordance host inventory (FN-459)", () => {
  it("keeps one renderer and two hosts", () => {
    const renderers: string[] = [];
    const hosts: string[] = [];
    for (const file of listComponentFiles()) {
      if (file.includes("__tests__")) continue;
      const source = readAppFile(`components/${file}`);
      if (source.includes("chat-message-edit-")) renderers.push(file);
      if (source.includes("onEditMessage=")) hosts.push(file);
    }

    expect(renderers.sort()).toEqual(["StandardChatSurface.tsx"]);
    expect(hosts.sort()).toEqual(["ChatView.tsx", "TaskPlannerChatTab.tsx"]);
  });
});
