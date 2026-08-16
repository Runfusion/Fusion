// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";
import { ModelSelectionModal } from "../ModelSelectionModal";
import * as api from "../../api";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import type { UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../SessionTerminal", () => ({ SessionTerminal: () => <div /> }));
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", () => ({
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../hooks/useModelsCache", () => ({
  useModelsCache: () => ({
    models: [
      { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
      { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet" },
    ],
    favoriteProviders: [], favoriteModels: [], defaultProvider: "openai", defaultModelId: "gpt-4o",
    loading: false, refresh: vi.fn(async () => undefined),
  }),
}));
vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({ loading: false, agents: [], agentsMap: new Map(), refresh: vi.fn(async () => undefined) }),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]), fetchTasks: vi.fn().mockResolvedValue([]),
  fetchSettings: vi.fn().mockResolvedValue({}), searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchModels: vi.fn().mockResolvedValue({ models: [
    { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
    { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet" },
  ] }),
  fetchAgents: vi.fn().mockResolvedValue([]), fetchPluginRuntimes: vi.fn().mockResolvedValue({ runtimes: [] }),
  createAgent: vi.fn().mockResolvedValue({ id: "agent-1" }),
}));

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);
const mockFetchSettings = vi.mocked(api.fetchSettings);

function chatState(): UseChatReturn {
  return {
    sessions: [], activeSession: null, sessionsLoading: false, messages: [], messagesLoading: false,
    isStreaming: false, streamingText: "", streamingThinking: "", streamingToolCalls: [],
    selectSession: vi.fn(), createSession: vi.fn(), archiveSession: vi.fn(), renameSession: vi.fn(),
    setSessionThinkingLevel: vi.fn(), deleteSession: vi.fn(), sendMessage: vi.fn(), editMessageAndResend: vi.fn(),
    stopStreaming: vi.fn(), pendingMessages: [], clearPendingMessage: vi.fn(), loadMoreMessages: vi.fn(),
    hasMoreMessages: false, searchQuery: "", setSearchQuery: vi.fn(), filteredSessions: [], refreshSessions: vi.fn(), agentsMap: new Map(),
  };
}

function roomsState(): UseChatRoomsResult {
  return { rooms: [], roomsLoading: false, roomsError: null, activeRoom: null, activeRoomMembers: [], messages: [], messagesLoading: false, selectRoom: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage: vi.fn(), refreshRooms: vi.fn() };
}

function setViewport(mobile: boolean) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mobile ? 375 : 1280 });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({ matches: mobile && query.includes("max-width: 768px"), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
}

/**
 * FNXC:ModelDropdown 2026-08-15-12:27:
 * A portaled model menu is a logical child of its host dialog. These cases reproduce a keyboard-driven menu re-anchor where release/click lands on the backdrop after a filter press.
 */
describe("model-menu filter host dismissal", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks(); localStorage.clear();
    mockUseChat.mockReturnValue(chatState());
    mockUseChatRooms.mockReturnValue(roomsState());
    mockFetchSettings.mockResolvedValue({ chatNewSessionMode: "prompt", chatDefaultKind: "model", chatDefaultModelProvider: "openai", chatDefaultModelId: "gpt-4o" } as Awaited<ReturnType<typeof api.fetchSettings>>);
  });

  it.each([{ mobile: false }, { mobile: true }])("keeps New Chat open after a $mobile portal-origin filter gesture", async ({ mobile }) => {
    setViewport(mobile);
    await act(async () => { render(<ChatView projectId="project-a" addToast={vi.fn()} />); });
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());
    fireEvent.click(screen.getAllByTestId("chat-new-btn")[0]);
    fireEvent.click(screen.getByLabelText("Model"));
    const filter = await screen.findByPlaceholderText("Filter models…");
    const backdrop = screen.getByRole("dialog");

    if (mobile) fireEvent.touchStart(filter);
    fireEvent.pointerDown(filter);
    fireEvent.mouseDown(filter);
    fireEvent.change(filter, { target: { value: "no-match" } });
    if (mobile) fireEvent.touchEnd(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("model-combobox-portal")).toBeInTheDocument();
    expect(filter).toHaveValue("no-match");
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it.each([{ mobile: false }, { mobile: true }])("keeps ModelSelectionModal open after a $mobile portal-origin filter gesture and still closes for a genuine backdrop touch", async ({ mobile }) => {
    setViewport(mobile);
    const onClose = vi.fn();
    render(<ModelSelectionModal
      isOpen onClose={onClose}
      models={[
        { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
        { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet" },
      ]}
      executorValue="" validatorValue="" onExecutorChange={vi.fn()} onValidatorChange={vi.fn()}
      modelsLoading={false} modelsError={null} onRetry={vi.fn()}
    />);
    fireEvent.click(screen.getByLabelText("Executor Model"));
    const filter = await screen.findByPlaceholderText("Filter models…");
    const overlay = screen.getByTestId("model-selection-modal");
    if (mobile) fireEvent.touchStart(filter);
    fireEvent.pointerDown(filter); fireEvent.mouseDown(filter);
    fireEvent.change(filter, { target: { value: "nothing" } });
    if (mobile) fireEvent.touchEnd(overlay);
    fireEvent.mouseUp(overlay); fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("model-selection-modal")).toBeInTheDocument();
    expect(filter).toHaveValue("nothing");
    expect(screen.getByText(/No models match/)).toBeInTheDocument();

    // The clear affordance and search chrome are also portal-origin surfaces.
    for (const origin of [screen.getByLabelText("Clear filter"), filter.parentElement!]) {
      if (mobile) fireEvent.touchStart(origin);
      fireEvent.pointerDown(origin); fireEvent.mouseDown(origin);
      if (mobile) fireEvent.touchEnd(overlay);
      fireEvent.mouseUp(overlay); fireEvent.click(overlay);
      expect(onClose).not.toHaveBeenCalled();
    }

    if (mobile) {
      fireEvent.touchStart(overlay); fireEvent.touchEnd(overlay);
    } else {
      fireEvent.mouseDown(overlay); fireEvent.mouseUp(overlay);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([{ mobile: false }, { mobile: true }])("keeps the thinking popup open after a $mobile portal-origin filter gesture but closes for an outside press", async ({ mobile }) => {
    setViewport(mobile);
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={vi.fn()} models={[
      { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
    ]} />);
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByLabelText("Model"));
    const filter = await screen.findByPlaceholderText("Filter models…");
    if (mobile) fireEvent.touchStart(filter);
    fireEvent.pointerDown(filter); fireEvent.mouseDown(filter);
    expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument());
  });
});
