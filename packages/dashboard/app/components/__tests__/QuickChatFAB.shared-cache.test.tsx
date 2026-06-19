import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuickChatFAB } from "../QuickChatFAB";
import { useModelsCache } from "../../hooks/useModelsCache";
import { writeCache, SWR_CACHE_KEYS } from "../../utils/swrCache";

const mockFetchModels = vi.fn();
const mockFetchDiscoveredSkills = vi.fn();
const mockUseAgents = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
    fetchDiscoveredSkills: (...args: unknown[]) => mockFetchDiscoveredSkills(...args),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

vi.mock("../../hooks/useAgents", () => ({ useAgents: (...args: unknown[]) => mockUseAgents(...args) }));
vi.mock("../../hooks/useQuickChat", () => ({
  FN_AGENT_ID: "__fn_agent__",
  useQuickChat: vi.fn(() => ({
    activeSession: null,
    messages: [],
    isStreaming: false,
    streamingText: "",
    streamingThinking: null,
    streamingToolCalls: [],
    sessions: [],
    sessionsLoading: false,
    messagesLoading: false,
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessage: "",
    clearPendingMessage: vi.fn(),
    switchSession: vi.fn(),
    selectSession: vi.fn(),
    startModelChat: vi.fn(),
    startFreshSession: vi.fn(),
    refreshSessions: vi.fn(),
    skipNextSessionInitRef: { current: false },
  })),
}));
vi.mock("../../hooks/useFileMention", () => ({ useFileMention: vi.fn(() => ({ mentionActive: false, detectMention: vi.fn(), dismissMention: vi.fn(), handleKeyDown: vi.fn(), selectTask: vi.fn(), selectFile: vi.fn(), tasks: [], files: [], combinedItems: [], loading: false, mentionQuery: "", selectedIndex: 0, setSelectedIndex: vi.fn() })) }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOpen: false, keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0 })) }));
vi.mock("../../hooks/useViewportMode", () => {
  const useViewportMode = vi.fn(() => "desktop");
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    getViewportMode: () => useViewportMode(),
    isMobileViewport: () => useViewportMode() === "mobile",
    useViewportMode,
  };
});
vi.mock("react-markdown", () => ({ default: ({ children }: { children: string }) => children }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("QuickChatFAB shared cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseAgents.mockReturnValue({ agents: [{ id: "agent-1", name: "Agent One", role: "executor", state: "active" }], activeAgents: [], stats: null, isLoading: false, loadAgents: vi.fn(), loadStats: vi.fn() });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: null, defaultModelId: null });
    mockFetchDiscoveredSkills.mockResolvedValue([]);
  });

  it("uses cached models and selects configured default model", () => {
    writeCache(SWR_CACHE_KEYS.MODELS, {
      models: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude" },
      ],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    }, { maxBytes: 500_000 });

    render(<QuickChatFAB addToast={vi.fn()} projectId="p1" open />);

    expect(screen.getByTestId("quick-chat-model-tag")).toHaveTextContent("GPT-4o");
  });

  it("shows cached discovered skills immediately after slash trigger", () => {
    writeCache(`${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}p1`, [
      { id: "s1", name: "fusion-basics", relativePath: "skills/fusion-basics", source: "acme/skills" },
      { id: "s2", name: "deploy-helper", relativePath: "skills/deploy-helper", source: "acme/skills" },
    ], { maxBytes: 500_000 });

    render(<QuickChatFAB addToast={vi.fn()} projectId="p1" open />);
    fireEvent.change(screen.getByTestId("quick-chat-input"), { target: { value: "/" } });

    expect(screen.getByTestId("quick-chat-skill-menu")).toHaveTextContent("fusion-basics");
    expect(screen.getByTestId("quick-chat-skill-menu")).toHaveTextContent("deploy-helper");
  });

  it("dedups model fetch with another useModelsCache consumer", () => {
    const request = deferred<{ models: unknown[]; favoriteProviders: string[]; favoriteModels: string[]; defaultProvider: string | null; defaultModelId: string | null }>();
    mockFetchModels.mockReturnValue(request.promise);

    function ModelsConsumer() {
      useModelsCache();
      return null;
    }

    render(
      <>
        <QuickChatFAB addToast={vi.fn()} projectId="p1" open />
        <ModelsConsumer />
      </>,
    );

    expect(mockFetchModels).toHaveBeenCalledTimes(1);
    request.resolve({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: null, defaultModelId: null });
  });

  it("keeps agent mode when no configured default model exists", () => {
    writeCache(SWR_CACHE_KEYS.MODELS, {
      models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: null,
      defaultModelId: null,
    }, { maxBytes: 500_000 });

    render(<QuickChatFAB addToast={vi.fn()} projectId="p1" open />);

    expect(screen.queryByTestId("quick-chat-model-tag")).toBeNull();
    expect(screen.getByTestId("quick-chat-session-dropdown-trigger")).toHaveTextContent("Select a session");
  });
});
