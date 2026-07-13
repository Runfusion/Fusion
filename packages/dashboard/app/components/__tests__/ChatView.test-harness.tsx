import { vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { ChatView } from "../ChatView";
import type { DiscoveredSkill } from "@fusion/dashboard";
import * as useChatModule from "../../hooks/useChat";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";
import * as apiModule from "../../api";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

/*
FNXC:DashboardTests 2026-06-25-16:30:
Shared harness for the ChatView suite. The 231-test ChatView.test.tsx was split into 3
sibling files (core / sessions-rooms / mobile) so the dashboard chat project parallelizes
them across workers instead of running one ~24s sequential file (FN-5048 feedback-loop
velocity).

CRITICAL: the vi.mock(...) factories stay INLINE in each split test file, NOT here. This
harness imports ChatView/../../api, so a vi.mock factory that referenced a harness export
would evaluate during harness init while that export is still in the TDZ — producing
`ReferenceError: Cannot access '__vi_import_N__' before initialization`. The factories must
stay self-contained (lucide-react, CustomModelDropdown, useNavigationHistory, ../../api,
useChat, useChatRooms). This harness only exports fixtures, helpers, the `vi.mocked`
handles (resolved against the per-file hoisted mocks), and installChatViewEnv() — the
former file-level beforeEach/afterEach.
*/

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

export const mockUseChat = vi.mocked(useChatModule.useChat);
export const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
export const mockFetchModels = vi.mocked(apiModule.fetchModels);
export const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);
export const mockCreateObjectURL = vi.fn();
export const mockRevokeObjectURL = vi.fn();
export const mockClipboardWriteText = vi.fn();

export const defaultModelsResponse = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  ],
  favoriteProviders: [],
  favoriteModels: [],
  defaultProvider: "anthropic",
  defaultModelId: "claude-sonnet-4-5",
};

export const defaultChatState: UseChatReturn = {
  sessions: [],
  activeSession: null,
  sessionsLoading: false,
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamingText: "",
  streamingThinking: "",
  streamingToolCalls: [],
  selectSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__", status: "active", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" } satisfies ChatSessionInfo),
  archiveSession: vi.fn(),
  renameSession: vi.fn(),
  setSessionThinkingLevel: vi.fn(),
  deleteSession: vi.fn(),
  sendMessage: vi.fn(),
  editMessageAndResend: vi.fn(),
  stopStreaming: vi.fn(),
  pendingMessages: [],
  clearPendingMessage: vi.fn(),
  loadMoreMessages: vi.fn(),
  hasMoreMessages: false,
  searchQuery: "",
  setSearchQuery: vi.fn(),
  filteredSessions: [],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),
};

export const defaultRoomsState: UseChatRoomsResult = {
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
};

export async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

export const activeSessionFixture: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Test Chat",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

export function createMockSkill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: "skill-id",
    name: "skill/name",
    path: "/tmp/skills/skill.md",
    relativePath: "skills/skill.md",
    enabled: true,
    metadata: {
      source: "*",
      scope: "project",
      origin: "top-level",
    },
    ...overrides,
  };
}

export function setupMockChat(overrides: Partial<UseChatReturn> = {}) {
  const state: UseChatReturn = { ...defaultChatState, ...overrides };
  mockUseChat.mockReturnValue(state);
}

export function setupMockRooms(overrides: Partial<UseChatRoomsResult> = {}) {
  const state: UseChatRoomsResult = { ...defaultRoomsState, ...overrides };
  mockUseChatRooms.mockReturnValue(state);
}

export function createRoomFixture(name: string) {
  return {
    id: `room-${name}`,
    projectId: "proj-123",
    slug: name,
    name,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}

export function setupStatefulCreateRoomMock(options?: { createRejects?: boolean }) {
  const createRoom = vi.fn();

  mockUseChatRooms.mockImplementation(() => {
    const [roomsState, setRoomsState] = useState<UseChatRoomsResult["rooms"]>([]);
    const [activeRoom, setActiveRoom] = useState<UseChatRoomsResult["activeRoom"]>(null);

    return {
      ...defaultRoomsState,
      rooms: roomsState,
      activeRoom,
      activeRoomMembers: activeRoom
        ? [{ roomId: activeRoom.id, agentId: "agent-001", role: "member", addedAt: "2026-05-12T00:00:00.000Z" }]
        : [],
      createRoom: async ({ name, memberAgentIds }) => {
        createRoom({ name, memberAgentIds });
        if (options?.createRejects) {
          throw new Error("Failed to create room.");
        }
        const nextRoom = createRoomFixture(name);
        setRoomsState((previous) => [...previous, nextRoom]);
        setActiveRoom(nextRoom);
        return nextRoom;
      },
      selectRoom: (roomId) => {
        setActiveRoom(roomsState.find((room) => room.id === roomId) ?? null);
      },
    } satisfies UseChatRoomsResult;
  });

  return { createRoom };
}

export async function renderRoomCreation(options?: { viewport?: "mobile" | "desktop"; createRejects?: boolean }) {
  const viewportSpy = mockViewportMode(options?.viewport ?? "mobile");
  const { createRoom } = setupStatefulCreateRoomMock({ createRejects: options?.createRejects });
  setupMockChat({ sessions: [], filteredSessions: [] });
  localStorage.setItem("fusion:chat-scope", "rooms");

  const user = userEvent.setup({ delay: null });
  await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

  await user.click(screen.getByTestId("chat-create-room-btn"));
  const dialog = await screen.findByRole("dialog", { name: "Create room" });
  fireEvent.change(within(dialog).getByLabelText("Room name"), { target: { value: "newroom" } });
  await user.click(within(screen.getByTestId("create-room-member-list")).getByText("Alpha"));
  await user.click(within(dialog).getByRole("button", { name: "Create room" }));

  return { createRoom, viewportSpy };
}

export function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(),
    });
  }
}

export function mockViewportMode(mode: "mobile" | "desktop") {
  ensureMatchMedia();
  const isMobile = mode === "mobile";
  Object.defineProperty(window, "innerWidth", { value: isMobile ? 375 : 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches:
      isMobile &&
      (query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/**
 * FNXC:DashboardTests 2026-06-25-16:30:
 * The former file-level beforeEach/afterEach from ChatView.test.tsx. Each split file calls
 * this once at top level so the shared jsdom/global setup (object-URL, clipboard, matchMedia
 * desktop default, viewport-height reset) is identical across the parallel chat files.
 */
export function installChatViewEnv() {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    _resetInitialViewportHeight();
    setupMockRooms();
    mockViewportMode("desktop");
    mockFetchModels.mockResolvedValue({ ...defaultModelsResponse });
    mockFetchDiscoveredSkills.mockResolvedValue([]);
    mockCreateObjectURL.mockImplementation((file: File) => `blob:${file.name}`);
    Object.defineProperty(URL, "createObjectURL", { value: mockCreateObjectURL, writable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: mockRevokeObjectURL, writable: true });
    mockClipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockClipboardWriteText },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    _resetInitialViewportHeight();
  });
}
