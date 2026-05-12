import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Agent } from "../../api";
import type { ChatSession } from "@fusion/core";
import * as apiModule from "../../api";
import { useAgents } from "../../hooks/useAgents";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useMobileKeyboard } from "../../hooks/useMobileKeyboard";
import { QuickChatFAB } from "../QuickChatFAB";

vi.mock("../../api", () => ({
  fetchResumeChatSession: vi.fn(),
  fetchChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchModels: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

vi.mock("../../hooks/useAgents", () => ({ useAgents: vi.fn() }));
vi.mock("../../hooks/useViewportMode", () => ({ useViewportMode: vi.fn() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn() }));

const mockFetchResumeChatSession = vi.mocked(apiModule.fetchResumeChatSession);
const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);
const mockUseAgents = vi.mocked(useAgents);
const mockUseViewportMode = vi.mocked(useViewportMode);
const mockUseMobileKeyboard = vi.mocked(useMobileKeyboard);

const agents: Agent[] = [
  { id: "agent-001", name: "Agent One", role: "executor", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} },
  { id: "agent-002", name: "Agent Two", role: "reviewer", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} },
];

const modelSession: ChatSession = {
  id: "session-model",
  agentId: "__fn_agent__",
  modelProvider: "openai",
  modelId: "gpt-4o",
  title: "Model thread",
  status: "active",
  projectId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const modelSessionAnthropic: ChatSession = {
  ...modelSession,
  id: "session-model-anthropic",
  modelProvider: "anthropic",
  modelId: "claude-3-7-sonnet",
  title: "Claude thread",
};

const agentSession: ChatSession = {
  id: "session-agent",
  agentId: "agent-001",
  modelProvider: null,
  modelId: null,
  title: null,
  status: "active",
  projectId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const agentTwoSession: ChatSession = {
  ...agentSession,
  id: "session-agent-two",
  agentId: "agent-002",
  title: "Agent Two thread",
};

function resolveResumeSession(agentId: string, modelProvider?: string, modelId?: string): ChatSession {
  if (agentId === "agent-002") {
    return agentTwoSession;
  }

  if (agentId === "__fn_agent__" && modelProvider === "anthropic" && modelId === "claude-3-7-sonnet") {
    return modelSessionAnthropic;
  }

  return modelSession;
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("QuickChatFAB session-first UX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.dispatchEvent(new Event("resize"));
    localStorage.clear();
    mockUseAgents.mockReturnValue({ agents, activeAgents: agents, stats: null, isLoading: false, loadAgents: vi.fn(), loadStats: vi.fn() });
    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
    mockFetchResumeChatSession.mockImplementation(async ({ agentId, modelProvider, modelId }) => ({
      session: resolveResumeSession(agentId, modelProvider, modelId),
    }));
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSessions.mockResolvedValue({ sessions: [modelSession, agentSession] });
    mockCreateChatSession.mockResolvedValue({ session: { ...modelSession, id: "session-new" } });
    mockCancelChatResponse.mockResolvedValue({ success: true });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onDone?.({ messageId: "msg-stream" });
      return { close: vi.fn(), isConnected: () => true };
    });
    mockFetchModels.mockResolvedValue({
      models: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 },
        { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", reasoning: true, contextWindow: 200000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });
    mockFetchDiscoveredSkills.mockResolvedValue([
      { id: "sk-1", name: "fusion-basics", relativePath: "skills/fusion-basics", source: "acme/skills" },
      { id: "sk-2", name: "deploy-helper", relativePath: "skills/deploy-helper", source: "acme/skills" },
    ]);
  });

  it("removes header mode toggle and renders session dropdown", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByTestId("quick-chat-session-dropdown")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-chat-mode-toggle")).toBeNull();
    expect(screen.getByRole("option", { name: "Model thread — GPT-4o [openai/gpt-4o]" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Session 2 — Agent One" })).toBeInTheDocument();
  });

  it("opens inline chooser from new button defaulting to model", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    fireEvent.click(await screen.findByTestId("quick-chat-new-thread"));
    expect(await screen.findByTestId("quick-chat-new-session-chooser")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-inline-mode-model")).toHaveClass("quick-chat-mode-btn--active");
    expect(screen.getByTestId("quick-chat-new-model-select")).toBeInTheDocument();
  });

  it("restores the newest agent session target on first open after reload", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [agentTwoSession, modelSession, agentSession],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message Agent Two");
    });
    expect(mockFetchResumeChatSession).toHaveBeenCalledWith({ agentId: "agent-002" }, "proj-1");
  });

  it("restores the newest model session target instead of the configured default", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [modelSessionAnthropic, modelSession, agentSession],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-tag")).toHaveTextContent("Claude 3.7 Sonnet");
    });
    expect(mockFetchResumeChatSession).toHaveBeenCalledWith(
      { agentId: "__fn_agent__", modelProvider: "anthropic", modelId: "claude-3-7-sonnet" },
      "proj-1",
    );
  });

  it("falls back to the existing default target when there are no prior sessions", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [] });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-tag")).toHaveTextContent("GPT-4o");
    });
    expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message GPT-4o");
    expect(mockFetchResumeChatSession).toHaveBeenCalledWith(
      { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
      "proj-1",
    );
  });

  it("creates fresh model session from inline chooser and closes chooser", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await screen.findByTestId("quick-chat-model-tag");
    fireEvent.click(await screen.findByTestId("quick-chat-new-thread"));

    await waitFor(() => expect(screen.getByTestId("quick-chat-new-session-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("quick-chat-new-session-submit"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
        "proj-1",
      );
    });
    expect(screen.queryByTestId("quick-chat-new-session-chooser")).toBeNull();
  });

  it("creates fresh agent session from inline chooser agent path", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await screen.findByTestId("quick-chat-model-tag");
    fireEvent.click(await screen.findByTestId("quick-chat-new-thread"));
    await waitFor(() => expect(screen.getByTestId("quick-chat-new-session-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("quick-chat-inline-mode-agent"));
    fireEvent.change(screen.getByTestId("quick-chat-new-agent-select"), { target: { value: "agent-002" } });
    fireEvent.click(screen.getByTestId("quick-chat-new-session-submit"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith({ agentId: "agent-002" }, "proj-1");
    });
  });

  it("shows distinguishable labels for sessions from multiple models", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        { ...modelSession, id: "session-openai", title: null },
        { ...modelSession, id: "session-anthropic", modelProvider: "anthropic", modelId: "claude-3-7-sonnet", title: null },
      ],
    });
    mockFetchModels.mockResolvedValueOnce({
      models: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 },
        { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", reasoning: true, contextWindow: 200000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByRole("option", { name: "Session 1 — GPT-4o [openai/gpt-4o]" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Session 2 — Claude 3.7 Sonnet [anthropic/claude-3-7-sonnet]" })).toBeInTheDocument();
  });

  it("includes both title and model descriptor in session label", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByRole("option", { name: "Model thread — GPT-4o [openai/gpt-4o]" })).toBeInTheDocument();
  });

  it("uses icon-only model tag without pill styling when mobile header fallback is active", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");

    mockFetchModels.mockResolvedValueOnce({
      models: [{ provider: "openai", id: "gpt-4o", name: "Extremely Long Model Name", reasoning: true, contextWindow: 128000 }],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const modelTag = await screen.findByTestId("quick-chat-model-tag");
    expect(modelTag).toHaveClass("quick-chat-model-tag--icon");

    const styles = window.getComputedStyle(modelTag);
    expect(styles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(styles.borderTopStyle).toBe("none");
    expect(styles.paddingLeft).toBe("0px");
    expect(styles.paddingRight).toBe("0px");
  });

  it("intercepts exact /clear and starts a fresh session for the active target", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: " /clear " } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
        "proj-1",
      );
    });
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
  });

  it("intercepts exact /new and starts a fresh session for the active target", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: " /new " } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
        "proj-1",
      );
    });
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
  });

  it("does not intercept non-exact /new prompts", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/new now" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-model",
        "/new now",
        expect.any(Object),
        [],
        "proj-1",
      );
    });
  });

  it("does not intercept non-exact /clear prompts", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/clear now" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-model",
        "/clear now",
        expect.any(Object),
        [],
        "proj-1",
      );
    });
  });

  it("shows skill menu when typing slash", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/" } });

    expect(await screen.findByTestId("quick-chat-skill-menu")).toBeInTheDocument();
    expect(screen.getByText("fusion-basics")).toBeInTheDocument();
  });

  it("filters skills from slash input", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/fusion" } });

    expect(await screen.findByText("fusion-basics")).toBeInTheDocument();
    expect(screen.queryByText("deploy-helper")).toBeNull();
  });

  it("supports keyboard navigation and enter selection for skills", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/" } });

    await screen.findByTestId("quick-chat-skill-menu");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveValue("/skill:deploy-helper ");
  });

  it("selects skill from menu click and replaces slash trigger", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/" } });

    const skillName = await screen.findByText("fusion-basics");
    fireEvent.click(skillName.closest("button") as HTMLButtonElement);
    expect(input).toHaveValue("/skill:fusion-basics ");
  });

  it("shows help message for exact /help command", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/help" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    const helpMessage = await screen.findByTestId("quick-chat-help-message");
    expect(helpMessage).toBeInTheDocument();
    expect(helpMessage).toHaveTextContent("/new");
    expect(helpMessage).toHaveTextContent("/clear");
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
  });

  it("clears help message on next user message", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: "/help" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));
    expect(await screen.findByTestId("quick-chat-help-message")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-help-message")).toBeNull();
      expect(mockStreamChatResponse).toHaveBeenCalledWith("session-model", "hello", expect.any(Object), [], "proj-1");
    });
  });

  it("switches existing sessions from dropdown without creating new session", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const select = await screen.findByTestId("quick-chat-session-dropdown");
    await screen.findByRole("option", { name: "Session 2 — Agent One" });
    fireEvent.change(select, { target: { value: "session-agent" } });

    await waitFor(() => {
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-agent", { limit: 50 }, "proj-1");
    });
    expect(mockCreateChatSession).not.toHaveBeenCalled();
  });

  it("shows streaming feedback on second turn after first turn completes", async () => {
    const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];
    mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
      handlers.push(nextHandlers);
      return { close: vi.fn(), isConnected: () => true };
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: "Turn one" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    expect(await screen.findByTestId("quick-chat-streaming-message")).toBeInTheDocument();

    handlers[0]?.onDone?.({ messageId: "msg-1" });

    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-streaming-message")).toBeNull();
    });

    fireEvent.change(input, { target: { value: "Turn two" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    expect(await screen.findByTestId("quick-chat-streaming-message")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-waiting")).toHaveTextContent("Connecting…");
    expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
  });

  it("shows the streaming indicator instead of the loading placeholder while waiting for a long reply", async () => {
    const deferredMessages = createDeferredPromise<{ messages: never[] }>();
    mockFetchChatMessages.mockImplementation(() => deferredMessages.promise);
    mockStreamChatResponse.mockImplementation(() => ({ close: vi.fn(), isConnected: () => false }));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: "Explain the current architecture" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    expect(await screen.findByTestId("quick-chat-streaming-message")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-waiting")).toHaveTextContent("Connecting…");
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  });

  it("keeps tap behavior for below-threshold touch movement", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);

    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.pointerDown(fab, { pointerId: 21, pointerType: "touch", button: 0, clientX: 120, clientY: 420 });
    fireEvent.pointerMove(document, { pointerId: 21, pointerType: "touch", clientX: 123, clientY: 423 });
    fireEvent.pointerUp(document, { pointerId: 21, pointerType: "touch", clientX: 123, clientY: 423 });
    fireEvent.click(fab);

    expect(await screen.findByTestId("quick-chat-panel")).toBeInTheDocument();
  });

  it("repositions on touch drag without opening panel and persists position", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);

    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.pointerDown(fab, { pointerId: 33, pointerType: "touch", button: 0, clientX: 150, clientY: 500 });
    fireEvent.pointerMove(document, { pointerId: 33, pointerType: "touch", clientX: 180, clientY: 470 });
    fireEvent.pointerUp(document, { pointerId: 33, pointerType: "touch", clientX: 180, clientY: 470 });
    fireEvent.click(fab);

    expect(screen.queryByTestId("quick-chat-panel")).toBeNull();

    const saved = localStorage.getItem("fusion-quick-chat-position-proj-1");
    expect(saved).not.toBeNull();
    expect(saved).toContain("\"x\"");
    expect(saved).toContain("\"y\"");
  });

  it("shows jump-to-latest only after leaving live tail and scrolls back on click", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        {
          id: "msg-1",
          sessionId: "session-model",
          role: "assistant",
          content: "First",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => 1200 });
    Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 240 });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    scrollTopValue = 700;
    fireEvent.scroll(messages);
    expect(screen.getByTestId("quick-chat-jump-to-latest")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quick-chat-jump-to-latest"));
    expect(scrollTopValue).toBe(1200);
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-jump-to-latest")).toBeNull();
    });
  });

  it("FN-3910: anchors to live tail on initial controlled open", async () => {
    const deferredMessages = createDeferredPromise<{
      messages: Array<{ id: string; sessionId: string; role: "assistant"; content: string; createdAt: string }>;
    }>();
    mockFetchChatMessages.mockImplementationOnce(() => deferredMessages.promise);

    const { rerender } = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open={false} onOpenChange={vi.fn()} />);

    rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open onOpenChange={vi.fn()} />);

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const scrollHeightValue = 1100;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    // FN-3910: install descriptors before initial messages resolve so the initial-open
    // useLayoutEffect branch (openingNow from isOpen false->true) writes to this scrollTop.
    expect(scrollTopValue).toBe(0);

    deferredMessages.resolve({
      messages: [
        {
          id: "msg-initial",
          sessionId: "session-model",
          role: "assistant",
          content: "hello",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  it("FN-3884: reopens same session and scrolls to latest again", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.click(fab);

    let messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const installScrollDescriptors = (target: HTMLElement) => {
      Object.defineProperty(target, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(target, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });
    };
    installScrollDescriptors(messages);

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    scrollTopValue = 0;
    fireEvent.click(fab);

    messages = await screen.findByTestId("quick-chat-messages");
    installScrollDescriptors(messages);

    await waitFor(() => {
      expect(scrollTopValue).toBe(1000);
    });
  });

  it("FN-3884: retries anchor when quick chat thread height grows after open", async () => {
    const originalRaf = window.requestAnimationFrame;
    const rafQueue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const messages = await screen.findByTestId("quick-chat-messages");
      let scrollTopValue = 0;
      let scrollHeightValue = 500;
      Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messages, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      scrollHeightValue = 900;
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift();
        cb?.(performance.now());
      }

      expect(scrollTopValue).toBe(900);
    } finally {
      window.requestAnimationFrame = originalRaf;
    }
  });

  it("FN-4040: mobile reopen re-anchors quick chat to the latest message", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.click(fab);

    let scrollTopValue = 0;
    const installScrollDescriptors = (target: HTMLElement) => {
      Object.defineProperty(target, "scrollHeight", { configurable: true, get: () => 1080 });
      Object.defineProperty(target, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });
    };

    let messages = await screen.findByTestId("quick-chat-messages");
    installScrollDescriptors(messages);

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    scrollTopValue = 0;
    fireEvent.click(fab);

    messages = await screen.findByTestId("quick-chat-messages");
    installScrollDescriptors(messages);

    await waitFor(() => {
      expect(scrollTopValue).toBe(1080);
    });
  });

  it("applies keyboard-open panel class on mobile to remove composer safe-area gap", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 160,
      viewportHeight: 500,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel).toHaveClass("quick-chat-panel--keyboard-open");
  });

  it("FN-4040: mobile visibility restore re-anchors quick chat to latest", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 120;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => 1320 });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    scrollTopValue = 280;

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => {
      expect(scrollTopValue).toBe(1320);
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("renders non-member mention chips when roomContext is provided", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        {
          id: "msg-room-mention",
          sessionId: "session-model",
          role: "user",
          content: "Check with @Agent_Two",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(
      <QuickChatFAB
        addToast={vi.fn()}
        projectId="proj-1"
        roomContext={{ roomName: "engineering", memberIds: new Set(["agent-001"]) }}
      />,
    );
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const nonMemberChip = await screen.findByText("@Agent_Two", { selector: ".chat-mention-chip--non-member" });
    expect(nonMemberChip).toHaveAttribute("title", "Not a member of engineering");
  });

  it("FN-3884: snaps to bottom when switching sessions while open", async () => {
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "A", createdAt: new Date().toISOString() }] })
      .mockResolvedValueOnce({ messages: [{ id: "msg-2", sessionId: "session-agent", role: "assistant", content: "B", createdAt: new Date().toISOString() }] });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    let scrollHeightValue = 1100;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    fireEvent.change(await screen.findByTestId("quick-chat-session-dropdown"), { target: { value: "session-agent" } });
    scrollHeightValue = 1700;

    await waitFor(() => {
      expect(scrollTopValue).toBe(1700);
    });
  });

  it("FN-3945: snaps to bottom on controlled initial open (open=false -> open=true) with an active session already loaded", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{ id: "msg-open", sessionId: "session-model", role: "assistant", content: "Loaded", createdAt: new Date().toISOString() }],
    });

    const { rerender } = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open={false} onOpenChange={vi.fn()} />);

    rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open onOpenChange={vi.fn()} />);

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const scrollHeightValue = 1400;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  it("FN-4095: snaps to bottom on uncontrolled initial open (FAB click) with preloaded messages", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{ id: "msg-open", sessionId: "session-model", role: "assistant", content: "Loaded", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const scrollHeightValue = 1400;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });
});
