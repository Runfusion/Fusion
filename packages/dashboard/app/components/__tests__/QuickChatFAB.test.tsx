import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Agent } from "../../api";
import type { ChatSession } from "@fusion/core";
import * as apiModule from "../../api";
import { useAgents } from "../../hooks/useAgents";
import { QuickChatFAB } from "../QuickChatFAB";

vi.mock("../../api", () => ({
  fetchResumeChatSession: vi.fn(),
  fetchChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchModels: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

vi.mock("../../hooks/useAgents", () => ({ useAgents: vi.fn() }));

const mockFetchResumeChatSession = vi.mocked(apiModule.fetchResumeChatSession);
const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);
const mockUseAgents = vi.mocked(useAgents);

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
    mockUseAgents.mockReturnValue({ agents, activeAgents: agents, stats: null, isLoading: false, loadAgents: vi.fn(), loadStats: vi.fn() });
    mockFetchResumeChatSession.mockResolvedValue({ session: modelSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSessions.mockResolvedValue({ sessions: [modelSession, agentSession] });
    mockCreateChatSession.mockResolvedValue({ session: { ...modelSession, id: "session-new" } });
    mockCancelChatResponse.mockResolvedValue({ success: true });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onDone?.({ messageId: "msg-stream" });
      return { close: vi.fn(), isConnected: () => true };
    });
    mockFetchModels.mockResolvedValue({
      models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 }],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });
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
});
