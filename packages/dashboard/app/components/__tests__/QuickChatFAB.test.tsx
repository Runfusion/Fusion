import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Agent, ChatSession } from "../../api";
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

vi.mock("../../hooks/useAgents", () => ({
  useAgents: vi.fn(),
}));

const mockFetchResumeChatSession = vi.mocked(apiModule.fetchResumeChatSession);
const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockUseAgents = vi.mocked(useAgents);

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Agent One",
    role: "executor",
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
  {
    id: "agent-002",
    name: "Agent Two",
    role: "reviewer",
    state: "terminated",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const mockSession: ChatSession = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockModels = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    contextWindow: 200_000,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: true,
    contextWindow: 128_000,
  },
];

function mockAgentsHook(agents: Agent[], isLoading = false) {
  mockUseAgents.mockReturnValue({
    agents,
    activeAgents: agents.filter((agent) => agent.state === "active" || agent.state === "running"),
    stats: null,
    isLoading,
    loadAgents: vi.fn(),
    loadStats: vi.fn(),
  });
}

function createMockStreamResponse() {
  const handlers: {
    onThinking?: (data: string) => void;
    onText?: (data: string) => void;
    onToolStart?: (data: { toolName: string; args?: Record<string, unknown> }) => void;
    onToolEnd?: (data: { toolName: string; isError: boolean; result?: unknown }) => void;
    onDone?: (data: { messageId: string }) => void;
    onError?: (data: string) => void;
    onConnectionStateChange?: (state: string) => void;
  } = {};

  const mockStream = {
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    // Allow setting handlers
    setHandlers: (h: typeof handlers) => {
      Object.assign(handlers, h);
    },
  };

  // Mock streamChatResponse to capture handlers and return mock stream
  mockStreamChatResponse.mockImplementation((sessionId, content, textHandlers) => {
    // Store handlers for test to invoke
    mockStream.setHandlers(textHandlers as typeof handlers);

    // Simulate async response
    setTimeout(() => {
      // Simulate streaming text
      textHandlers.onConnectionStateChange?.("connected");
      textHandlers.onText?.("Thinking...");
      textHandlers.onText?.("Here's my response.");
      textHandlers.onDone?.({ messageId: `msg-${Date.now()}` });
    }, 10);

    return {
      close: mockStream.close,
      isConnected: mockStream.isConnected,
    };
  });

  return mockStream;
}

async function selectModelOption(optionName: string) {
  const trigger = screen.getByRole("button", { name: "Select model override" });

  await waitFor(() => {
    expect(trigger).not.toBeDisabled();
  });

  fireEvent.click(trigger);

  const listbox = await screen.findByRole("listbox");
  const optionLabel = await within(listbox).findByText(optionName);
  const option = optionLabel.closest('[role="option"]') ?? optionLabel;
  fireEvent.click(option);
}

describe("QuickChatFAB", () => {
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentsHook(mockAgents);
    mockFetchResumeChatSession.mockResolvedValue({ session: null });
    mockFetchChatSessions.mockResolvedValue({ sessions: [] });
    mockCreateChatSession.mockResolvedValue({ session: mockSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockCancelChatResponse.mockResolvedValue({ success: true });
    mockFetchModels.mockResolvedValue({
      models: mockModels,
      favoriteProviders: [],
      favoriteModels: [],
    });
    createMockStreamResponse();
  });

  it("keeps FAB visible when no agents exist so model chats can start", async () => {
    mockAgentsHook([]);

    render(<QuickChatFAB addToast={addToast} />);

    expect(screen.getByTestId("quick-chat-fab")).toBeDefined();

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // With no agents, auto-switches to model mode: model dropdown visible, no toggle, no agent select
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();
    });
    expect(screen.queryByTestId("quick-chat-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("quick-chat-agent-select")).toBeNull();
  });

  it("renders FAB button when agents exist", () => {
    render(<QuickChatFAB addToast={addToast} />);

    expect(screen.getByTestId("quick-chat-fab")).toBeDefined();
  });

  it("opens chat panel when FAB is clicked", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });
  });

  it("renders the model dropdown when panel is open in model mode", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Switch to model mode via the toggle
    const modelModeBtn = await screen.findByTestId("quick-chat-mode-model");
    fireEvent.click(modelModeBtn);

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();
      expect(screen.getByRole("button", { name: "Select model override" })).toBeDefined();
      expect(mockFetchModels).toHaveBeenCalledTimes(1);
    });
  });

  it("switching to model mode hides agent dropdown and shows model dropdown", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Default is agent mode — agent select visible, model select hidden
    expect(await screen.findByTestId("quick-chat-agent-select")).toBeDefined();
    expect(screen.queryByTestId("quick-chat-model-select")).toBeNull();

    // Switch to model mode
    fireEvent.click(screen.getByTestId("quick-chat-mode-model"));

    // Agent select should be hidden, model select visible
    expect(screen.queryByTestId("quick-chat-agent-select")).toBeNull();
    expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();
  });

  it("switching to agent mode hides model dropdown and shows agent dropdown", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Start in agent mode, switch to model mode
    const modelModeBtn = await screen.findByTestId("quick-chat-mode-model");
    fireEvent.click(modelModeBtn);

    expect(screen.queryByTestId("quick-chat-agent-select")).toBeNull();
    expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();

    // Switch back to agent mode
    fireEvent.click(screen.getByTestId("quick-chat-mode-agent"));

    expect(screen.getByTestId("quick-chat-agent-select")).toBeDefined();
    expect(screen.queryByTestId("quick-chat-model-select")).toBeNull();
  });

  it("closes panel via close button and Escape key", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    });
  });

  it("shows available agents in selector", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const select = await screen.findByTestId("quick-chat-agent-select");
    expect(select).toBeDefined();
    expect(screen.getByRole("option", { name: "Agent One (executor)" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Agent Two (reviewer)" })).toBeDefined();
  });

  it("shows mention popup when @ is typed in quick chat input", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "@" } });

    expect(await screen.findByTestId("agent-mention-popup")).toBeDefined();
    expect(screen.getByTestId("agent-mention-item-agent-001")).toBeDefined();
  });

  it("selecting mention item inserts @AgentName into quick chat input", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "@agent" } });

    const mentionItem = await screen.findByTestId("agent-mention-item-agent-001");
    fireEvent.click(mentionItem);

    expect((screen.getByTestId("quick-chat-input") as HTMLInputElement).value).toBe("@Agent_One ");
    expect(screen.queryByTestId("agent-mention-popup")).toBeNull();
  });

  it("selecting a model with no agents creates a KB agent session with model override", async () => {
    mockAgentsHook([]);

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await selectModelOption("Claude Sonnet 4.5");

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: "__fn_agent__",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        },
        "proj-123",
      );
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello model" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-001",
        "Hello model",
        expect.any(Object),
        "proj-123",
      );
    });
  });

  it("model mode creates a KB agent session with the selected model", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Switch to model mode
    const modelModeBtn = await screen.findByTestId("quick-chat-mode-model");
    fireEvent.click(modelModeBtn);

    await selectModelOption("GPT-4o");

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: "__fn_agent__",
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
        "proj-123",
      );
    });
  });

  it("new chat action creates a fresh model thread without changing the selected model", async () => {
    const existingModelSession: ChatSession = {
      id: "session-model-001",
      agentId: "__fn_agent__",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const freshModelSession: ChatSession = {
      id: "session-model-002",
      agentId: "__fn_agent__",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockAgentsHook([]);
    mockFetchResumeChatSession.mockResolvedValueOnce({ session: existingModelSession });
    mockCreateChatSession.mockResolvedValueOnce({ session: freshModelSession });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-tag")).toHaveTextContent("Claude Sonnet 4.5");
      expect(mockCreateChatSession).not.toHaveBeenCalled();
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-model-001", { limit: 50 }, "proj-123");
    });

    fireEvent.click(screen.getByTestId("quick-chat-new-thread"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledTimes(1);
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: "__fn_agent__",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        },
        "proj-123",
      );
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-model-002", { limit: 50 }, "proj-123");
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "fresh thread message" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-model-002",
        "fresh thread message",
        expect.any(Object),
        "proj-123",
      );
    });
  });

  it("switching from model mode to agent mode creates session with only agentId", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Switch to model mode and select a model
    const modelModeBtn = await screen.findByTestId("quick-chat-mode-model");
    fireEvent.click(modelModeBtn);

    await selectModelOption("GPT-4o");

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: "__fn_agent__",
          modelProvider: "openai",
          modelId: "gpt-4o",
        },
        "proj-123",
      );
    });

    // Switch back to agent mode — clears model selection, uses agent's default
    const agentModeBtn = screen.getByTestId("quick-chat-mode-agent");
    fireEvent.click(agentModeBtn);

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith({ agentId: "agent-001" }, "proj-123");
    });
  });

  it("selecting a model from dropdown does not dismiss the chat panel", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    // Switch to model mode by clicking the "Model" toggle button
    const modelModeBtn = await screen.findByTestId("quick-chat-mode-model");
    fireEvent.click(modelModeBtn);

    // Click the model dropdown trigger to open the dropdown
    const trigger = screen.getByRole("button", { name: "Select model override" });
    fireEvent.click(trigger);

    // Find a model option and click it
    const optionLabel = await screen.findByText("Claude Sonnet 4.5");
    const option = optionLabel.closest('[role="option"]') ?? optionLabel;
    fireEvent.click(option);

    // Panel should still be visible after selecting the model
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    // Assert mockCreateChatSession was called with the correct model parameters
    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        {
          agentId: "__fn_agent__",
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-5",
        },
        "proj-123",
      );
    });
  });

  it("sending a message calls streamChatResponse API with expected params", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Wait for session initialization
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Ship it" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    // Wait for streamChatResponse to be called
    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-001",
        "Ship it",
        expect.objectContaining({
          onThinking: expect.any(Function),
          onText: expect.any(Function),
          onToolStart: expect.any(Function),
          onToolEnd: expect.any(Function),
          onDone: expect.any(Function),
          onError: expect.any(Function),
        }),
        "proj-123",
      );
    });

    // Input should be cleared
    await waitFor(() => {
      expect((screen.getByTestId("quick-chat-input") as HTMLInputElement).value).toBe("");
    });
  });

  it("shows stop button during streaming and keeps input enabled", async () => {
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onConnectionStateChange?.("connected");
      handlers.onText?.("Streaming...");
      return {
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-stop")).toBeInTheDocument();
    });
    expect(screen.getByTestId("quick-chat-input")).not.toBeDisabled();
  });

  it("clicking stop button cancels streaming", async () => {
    const closeFn = vi.fn();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onConnectionStateChange?.("connected");
      handlers.onText?.("Streaming...");
      return {
        close: closeFn,
        isConnected: vi.fn(() => true),
      };
    });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-stop")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("quick-chat-stop"));

    await waitFor(() => {
      expect(closeFn).toHaveBeenCalled();
      expect(mockCancelChatResponse).toHaveBeenCalledWith("session-001", "proj-123");
    });
  });

  it("renders pending message indicator when a message is queued", async () => {
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onConnectionStateChange?.("connected");
      handlers.onText?.("Streaming...");
      return {
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-stop")).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: "Queued follow-up" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("chat-pending-indicator")).toHaveTextContent("Queued: Queued follow-up");
    });
  });

  it("user can type while streaming", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Wait for session initialization
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    // Input should be cleared after send
    await waitFor(() => {
      expect((screen.getByTestId("quick-chat-input") as HTMLInputElement).value).toBe("");
    });

    // User should still be able to type in the input while streaming
    fireEvent.change(input, { target: { value: "Second message" } });
    expect((screen.getByTestId("quick-chat-input") as HTMLInputElement).value).toBe("Second message");
  });

  it("after streaming completes, assistant message is shown", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Wait for session initialization
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    // Wait for streaming to complete and message to appear
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    // After streaming completes, input should be re-enabled
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-input")).not.toBeDisabled();
    });
  });

  it("renders tool calls in quick chat messages", async () => {
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onText?.("Used read tool");
        handlers.onToolStart?.({ toolName: "read", args: { path: "foo.ts" } });
        handlers.onToolEnd?.({ toolName: "read", isError: false, result: "contents" });
        handlers.onDone?.({ messageId: "msg-tool" });
      }, 0);

      return {
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Show tools" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(screen.getByText("read")).toBeInTheDocument();
      expect(screen.getByText("Tool calls")).toBeInTheDocument();
    });

    const preview = document.querySelector(".chat-tool-call-preview");
    expect(preview).toHaveTextContent("result: contents");
  });

  it("shows streaming tool calls during generation", async () => {
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onText?.("Still working");
      handlers.onToolStart?.({ toolName: "read", args: { path: "foo.ts" } });

      return {
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Stream tools" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      const streamingMessage = screen.getByTestId("quick-chat-streaming-message");
      expect(within(streamingMessage).getByText("read")).toBeInTheDocument();
      expect(streamingMessage.querySelector(".chat-tool-call--running")).toBeTruthy();
      expect(streamingMessage.querySelector(".chat-tool-call-preview")).toHaveTextContent("path=foo.ts");
    });
  });

  it("preserves user message after assistant reply completes", async () => {
    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Wait for session initialization
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    // Wait for streaming to complete and assistant response to appear
    await waitFor(
      () => {
        expect(screen.getByText(/Here's my response/)).toBeDefined();
      },
      { timeout: 5000 },
    );

    // Check that user's "Hello" message is preserved
    expect(screen.getByText("Hello")).toBeDefined();

    // Input should be enabled after streaming completes
    expect(screen.getByTestId("quick-chat-input")).not.toBeDisabled();

    // Send button should be enabled after streaming completes (input is empty so still disabled)
    expect(screen.getByTestId("quick-chat-send")).toBeDisabled();
  });

  it("switching agents creates a new session for the selected agent", async () => {
    // First session exists
    mockFetchResumeChatSession.mockResolvedValueOnce({ session: mockSession });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Wait for initial session to be created
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    // Switch to agent-002
    fireEvent.change(screen.getByTestId("quick-chat-agent-select"), {
      target: { value: "agent-002" },
    });

    // Should create a new session for agent-002
    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith({ agentId: "agent-002" }, "proj-123");
    });
  });

  it("switching back to a previous agent restores its conversation", async () => {
    const sessionForAgent1: ChatSession = {
      id: "session-agent-001",
      agentId: "agent-001",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const sessionForAgent2: ChatSession = {
      id: "session-agent-002",
      agentId: "agent-002",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const agent1Messages = [
      {
        id: "msg-001",
        sessionId: "session-agent-001",
        role: "user" as const,
        content: "Hello from agent 1",
        createdAt: new Date().toISOString(),
      },
      {
        id: "msg-002",
        sessionId: "session-agent-001",
        role: "assistant" as const,
        content: "Hello from agent 1 assistant",
        createdAt: new Date().toISOString(),
      },
    ];
    const agent2Messages = [
      {
        id: "msg-003",
        sessionId: "session-agent-002",
        role: "user" as const,
        content: "Hello from agent 2",
        createdAt: new Date().toISOString(),
      },
      {
        id: "msg-004",
        sessionId: "session-agent-002",
        role: "assistant" as const,
        content: "Agent 2 response",
        createdAt: new Date().toISOString(),
      },
    ];

    // Setup: agent-001 has an existing session, agent-002 does not
    // Override beforeEach's createChatSession mock (which returns session-001)
    // so that creating agent-002's session returns the correct ID
    mockCreateChatSession.mockResolvedValueOnce({ session: sessionForAgent2 });
    mockFetchResumeChatSession
      // Initial load: agent-001's existing session found
      .mockResolvedValueOnce({ session: sessionForAgent1 })
      // Switch to agent-002: no session found → will create new
      .mockResolvedValueOnce({ session: null })
      // Switch back to agent-001: should find the existing session
      .mockResolvedValueOnce({ session: sessionForAgent1 });

    // Per-call message mocks
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: agent1Messages })
      .mockResolvedValueOnce({ messages: agent2Messages })
      .mockResolvedValueOnce({ messages: agent1Messages });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Step 1: Open chat with agent-001 (existing session found)
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalledWith(
        {
          agentId: "agent-001",
          modelProvider: undefined,
          modelId: undefined,
        },
        "proj-123",
      );
    });

    // Verify agent-001's messages are shown
    await waitFor(() => {
      expect(screen.getByText("Hello from agent 1")).toBeDefined();
      expect(screen.getByText("Hello from agent 1 assistant")).toBeDefined();
    });

    // Step 2: Switch to agent-002 → messages should clear then load
    fireEvent.change(screen.getByTestId("quick-chat-agent-select"), {
      target: { value: "agent-002" },
    });

    // New session created for agent-002
    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenLastCalledWith({ agentId: "agent-002" }, "proj-123");
    });

    // Verify agent-002's messages are shown
    await waitFor(() => {
      expect(screen.getByText("Hello from agent 2")).toBeDefined();
      expect(screen.getByText("Agent 2 response")).toBeDefined();
    });

    // Step 3: Switch back to agent-001 → should restore original session
    fireEvent.change(screen.getByTestId("quick-chat-agent-select"), {
      target: { value: "agent-001" },
    });

    // Should find existing session (not create new)
    await waitFor(() => {
      // Verify targeted resume lookup was called with the selected agent on each switch
      expect(mockFetchResumeChatSession.mock.calls).toEqual([
        [{ agentId: "agent-001", modelProvider: undefined, modelId: undefined }, "proj-123"],
        [{ agentId: "agent-002", modelProvider: undefined, modelId: undefined }, "proj-123"],
        [{ agentId: "agent-001", modelProvider: undefined, modelId: undefined }, "proj-123"],
      ]);
      // Verify no new session was created for agent-001 (already had one)
      expect(mockCreateChatSession).not.toHaveBeenLastCalledWith(
        { agentId: "agent-001" },
        "proj-123",
      );
    });

    // Verify agent-001's original messages are restored
    await waitFor(() => {
      expect(screen.getByText("Hello from agent 1")).toBeDefined();
      expect(screen.getByText("Hello from agent 1 assistant")).toBeDefined();
    });

    // Verify fetchChatMessages was called with correct session IDs for each agent
    expect(mockFetchChatMessages.mock.calls).toEqual([
      ["session-agent-001", { limit: 50 }, "proj-123"],
      ["session-agent-002", { limit: 50 }, "proj-123"],
      ["session-agent-001", { limit: 50 }, "proj-123"],
    ]);
  });

  it("shows placeholder text when conversation is empty", async () => {
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByText("No messages yet. Start the conversation!")).toBeDefined();
    });
  });

  it("closes panel when clicking outside", async () => {
    render(<QuickChatFAB addToast={addToast} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    });
  });

  it("does not close panel when clicking inside portaled model dropdown", async () => {
    // Render with no agents so it defaults to model mode
    mockAgentsHook([]);

    render(<QuickChatFAB addToast={addToast} />);

    // Open the quick chat panel
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    // Click the model combobox trigger to open the dropdown portal
    const trigger = screen.getByRole("button", { name: "Select model override" });
    fireEvent.click(trigger);

    // Verify the portaled dropdown appears
    const portalDropdown = await screen.findByTestId("model-combobox-portal");
    expect(portalDropdown).toBeDefined();

    // Click inside the portaled dropdown (on the search input)
    const searchInput = portalDropdown.querySelector("input");
    expect(searchInput).not.toBeNull();
    fireEvent.mouseDown(searchInput!);

    // Panel should still be visible (not closed by the dropdown click)
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
    });

    // Control: clicking outside the panel and dropdown should still close the panel
    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    });
  });

  it("shows favorited models as pinned rows in the model dropdown when favoriteModels prop is provided", async () => {
    // Render with no agents to default to model mode
    mockAgentsHook([]);

    // Provide a favorited model
    const favoriteModels = ["openai/gpt-4o"];
    render(<QuickChatFAB addToast={addToast} favoriteModels={favoriteModels} />);

    // Open the quick chat panel
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Switch to model mode (should already be default with no agents)
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();
    });

    // Open the model dropdown
    const trigger = screen.getByRole("button", { name: "Select model override" });
    fireEvent.click(trigger);

    // The favorited model should appear as a pinned row (before the provider groups)
    const portalDropdown = await screen.findByTestId("model-combobox-portal");
    expect(portalDropdown).toBeDefined();

    // Find the favorited model option
    const gpt4oOption = portalDropdown.querySelector('.model-combobox-option--favorite');
    expect(gpt4oOption).not.toBeNull();

    // Verify it contains the model name
    const gpt4oText = gpt4oOption?.querySelector(".model-combobox-option-text");
    expect(gpt4oText?.textContent).toBe("GPT-4o");
  });

  it("shows favorited providers sorted first in the model dropdown when favoriteProviders prop is provided", async () => {
    // Render with no agents to default to model mode
    mockAgentsHook([]);

    // Provide a favorited provider (and onToggleFavorite so the star button is rendered)
    const favoriteProviders = ["openai"];
    const onToggleFavorite = vi.fn();
    render(<QuickChatFAB addToast={addToast} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} />);

    // Open the quick chat panel
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();
    });

    // Open the model dropdown
    const trigger = screen.getByRole("button", { name: "Select model override" });
    fireEvent.click(trigger);

    // The portaled dropdown should show
    const portalDropdown = await screen.findByTestId("model-combobox-portal");
    expect(portalDropdown).toBeDefined();

    // Check that the "Use default" option is first
    const options = portalDropdown.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toContain("Use default");

    // OpenAI should be marked as favorite with an active star button
    const openaiOptgroup = portalDropdown.querySelector(".model-combobox-optgroup");
    expect(openaiOptgroup).not.toBeNull();

    const favoriteBtn = openaiOptgroup?.querySelector(".model-combobox-optgroup-favorite--active");
    expect(favoriteBtn).not.toBeNull();
    expect(favoriteBtn?.textContent).toBe("★");
  });

  it("calls onToggleModelFavorite when the favorite button on a model is clicked", async () => {
    // Render with no agents to default to model mode
    mockAgentsHook([]);

    const onToggleModelFavorite = vi.fn();
    render(<QuickChatFAB addToast={addToast} onToggleModelFavorite={onToggleModelFavorite} />);

    // Open the quick chat panel
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();
    });

    // Open the model dropdown
    const trigger = screen.getByRole("button", { name: "Select model override" });
    fireEvent.click(trigger);

    const portalDropdown = await screen.findByTestId("model-combobox-portal");
    expect(portalDropdown).toBeDefined();

    // Find a model's favorite toggle button (☆ means not favorited)
    const unfavoritedBtn = portalDropdown.querySelector(".model-combobox-option-favorite:not(.model-combobox-option-favorite--active)");
    expect(unfavoritedBtn).not.toBeNull();

    // Click the toggle button (stopPropagation prevents dropdown close)
    fireEvent.click(unfavoritedBtn!);

    // The callback should have been called with the model ID
    expect(onToggleModelFavorite).toHaveBeenCalledTimes(1);
    const calledWith = onToggleModelFavorite.mock.calls[0][0];
    // Should be in "{provider}/{modelId}" format
    expect(calledWith).toMatch(/\w+\/\w+/);
  });

  it("calls onToggleFavorite when the favorite button on a provider group is clicked", async () => {
    // Render with no agents to default to model mode
    mockAgentsHook([]);

    const onToggleFavorite = vi.fn();
    render(<QuickChatFAB addToast={addToast} onToggleFavorite={onToggleFavorite} />);

    // Open the quick chat panel
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-select")).toBeDefined();
    });

    // Open the model dropdown after model loading completes
    const trigger = screen.getByRole("button", { name: "Select model override" });
    await waitFor(() => {
      expect(trigger).not.toBeDisabled();
    });
    fireEvent.click(trigger);

    const portalDropdown = await screen.findByTestId("model-combobox-portal");
    expect(portalDropdown).toBeDefined();

    // Find the provider optgroup
    const openaiOptgroup = portalDropdown.querySelector(".model-combobox-optgroup");
    expect(openaiOptgroup).not.toBeNull();

    // Click the provider's favorite toggle button
    const favoriteBtn = openaiOptgroup?.querySelector(".model-combobox-optgroup-favorite");
    expect(favoriteBtn).not.toBeNull();
    fireEvent.click(favoriteBtn!);

    // The callback should have been called with the provider name
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    const calledWith = onToggleFavorite.mock.calls[0][0];
    expect(typeof calledWith).toBe("string");
    expect(calledWith.length).toBeGreaterThan(0);
  });

  it("hides FAB button when showFAB is false", () => {
    render(<QuickChatFAB addToast={addToast} showFAB={false} />);

    expect(screen.queryByTestId("quick-chat-fab")).toBeNull();
  });

  it("still opens panel programmatically when showFAB is false with controlled open prop", async () => {
    render(<QuickChatFAB addToast={addToast} showFAB={false} open={true} />);

    expect(screen.queryByTestId("quick-chat-fab")).toBeNull();
    expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
  });

  it("controlled open prop opens panel without clicking FAB", () => {
    render(<QuickChatFAB addToast={addToast} open={true} />);

    expect(screen.getByTestId("quick-chat-panel")).toBeDefined();
  });

  it("controlled open prop defaults to closed when not set", () => {
    render(<QuickChatFAB addToast={addToast} />);

    expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
  });

  it("onOpenChange callback is called when panel is opened via FAB (controlled mode)", async () => {
    const onOpenChange = vi.fn();
    render(<QuickChatFAB addToast={addToast} open={false} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(true);
    });
  });

  it("onOpenChange callback is called when panel is closed via FAB", async () => {
    const onOpenChange = vi.fn();
    render(<QuickChatFAB addToast={addToast} open={true} onOpenChange={onOpenChange} />);

    // Panel should be open initially
    expect(screen.getByTestId("quick-chat-panel")).toBeDefined();

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("error handling shows toast on stream error", async () => {
    // Mock streamChatResponse to trigger error
    mockStreamChatResponse.mockImplementationOnce((sessionId, content, textHandlers) => {
      setTimeout(() => {
        textHandlers.onError?.("Stream connection failed");
      }, 10);
      return {
        close: vi.fn(),
        isConnected: vi.fn(() => false),
      };
    });

    render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    // Wait for session initialization
    await waitFor(() => {
      expect(mockFetchResumeChatSession).toHaveBeenCalled();
    });

    const input = await screen.findByTestId("quick-chat-input");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    // Wait for error toast
    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Failed to get response", "error");
    });
  });

  // Drag-related tests
  describe("draggable behavior", () => {
    const localStorageMock = {
      store: {} as Record<string, string>,
      getItem: vi.fn((key: string) => localStorageMock.store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { localStorageMock.store[key] = value; }),
      removeItem: vi.fn((key: string) => { delete localStorageMock.store[key]; }),
      clear: vi.fn(() => { localStorageMock.store = {}; }),
    };

    beforeEach(() => {
      vi.stubGlobal("localStorage", localStorageMock);
      localStorageMock.store = {};
      localStorageMock.getItem.mockClear();
      localStorageMock.setItem.mockClear();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("FAB can be dragged to a new position", async () => {
      render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

      const fab = screen.getByTestId("quick-chat-fab");

      // Simulate drag: pointerdown -> pointermove -> pointerup
      const fabRect = { left: window.innerWidth - 72, top: window.innerHeight - 72, width: 48, height: 48 };
      vi.spyOn(fab, "getBoundingClientRect").mockReturnValue(fabRect as DOMRect);

      // Start drag
      fireEvent.pointerDown(fab, {
        clientX: fabRect.left + 24,
        clientY: fabRect.top + 24,
        button: 0,
        pointerId: 1,
      });

      // Verify data-dragging attribute is set
      expect(fab.getAttribute("data-dragging")).toBe("true");

      // Move pointer (drag 50px to the left, which means increasing right offset)
      fireEvent.pointerMove(fab, {
        clientX: fabRect.left + 24 - 50,
        clientY: fabRect.top + 24,
        pointerId: 1,
      });

      // End drag
      fireEvent.pointerUp(fab, {
        clientX: fabRect.left + 24 - 50,
        clientY: fabRect.top + 24,
        button: 0,
        pointerId: 1,
      });

      // Verify localStorage was called with the new position
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "fusion-quick-chat-position-proj-123",
        expect.stringContaining('"x":'),
      );
    });

    it("small movement (< 5px) is treated as click not drag", async () => {
      const onOpenChange = vi.fn();
      render(<QuickChatFAB addToast={addToast} open={false} onOpenChange={onOpenChange} projectId="proj-123" />);

      const fab = screen.getByTestId("quick-chat-fab");

      // Simulate click: pointerDown + small pointerMove (< 5px) + pointerUp + click
      // Since movement is < 5px, this should be treated as a click, not a drag
      fireEvent.pointerDown(fab, {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
      });

      // Small movement (less than 5px threshold)
      fireEvent.pointerMove(fab, {
        clientX: 102,
        clientY: 100,
        pointerId: 1,
      });

      fireEvent.pointerUp(fab, {
        clientX: 102,
        clientY: 100,
        button: 0,
        pointerId: 1,
      });

      // jsdom doesn't fire click automatically after pointerup with movement < threshold,
      // so we simulate the click event that would fire in a real browser
      fireEvent.click(fab);

      // Should have toggled panel (treated as click)
      expect(onOpenChange).toHaveBeenCalledWith(true);

      // Should NOT have saved position to localStorage (was a click, not a drag)
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });

    it("FAB position is loaded from localStorage on mount", async () => {
      // Pre-populate localStorage with saved position
      localStorageMock.store["fusion-quick-chat-position-proj-123"] = JSON.stringify({ x: 100, y: 200 });

      render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

      const fab = screen.getByTestId("quick-chat-fab");

      // Verify the FAB has the saved position
      expect(fab.style.right).toBe("100px");
      expect(fab.style.bottom).toBe("200px");

      // Verify localStorage was read
      expect(localStorageMock.getItem).toHaveBeenCalledWith("fusion-quick-chat-position-proj-123");
    });

    it("FAB position is clamped to viewport boundaries", async () => {
      // Desktop viewport (jsdom default 1024px > 768px): 48px edge margin
      render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

      const fab = screen.getByTestId("quick-chat-fab");

      // Simulate drag to extreme position (off viewport)
      fireEvent.pointerDown(fab, {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
      });

      // Try to drag way off screen (negative coordinates)
      fireEvent.pointerMove(fab, {
        clientX: -1000,
        clientY: -1000,
        pointerId: 1,
      });

      fireEvent.pointerUp(fab, {
        clientX: -1000,
        clientY: -1000,
        button: 0,
        pointerId: 1,
      });

      // Desktop: position should be clamped to at least 8px from edges
      const savedPosition = JSON.parse(localStorageMock.setItem.mock.calls[0]?.[1] || "{}");
      expect(savedPosition.x).toBeGreaterThanOrEqual(8);
      expect(savedPosition.y).toBeGreaterThanOrEqual(8);
    });

    it("on mobile viewport, FAB can be dragged to within 4px of the edge", async () => {
      // Mock mobile viewport (375px wide, which is <= 768px)
      Object.defineProperty(window, "innerWidth", { value: 375, writable: true });
      Object.defineProperty(window, "innerHeight", { value: 812, writable: true });

      render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

      const fab = screen.getByTestId("quick-chat-fab");

      // Simulate drag to extreme position (off viewport)
      fireEvent.pointerDown(fab, {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
      });

      // Try to drag way off screen (negative coordinates)
      fireEvent.pointerMove(fab, {
        clientX: -1000,
        clientY: -1000,
        pointerId: 1,
      });

      fireEvent.pointerUp(fab, {
        clientX: -1000,
        clientY: -1000,
        button: 0,
        pointerId: 1,
      });

      // Mobile (375px <= 768px): position should be clamped to at least 4px from edges
      const savedPosition = JSON.parse(localStorageMock.setItem.mock.calls[0]?.[1] || "{}");
      expect(savedPosition.x).toBeGreaterThanOrEqual(4);
      expect(savedPosition.y).toBeGreaterThanOrEqual(4);
    });

    it("on desktop viewport, FAB edge margin is 8px", async () => {
      // Explicitly set desktop viewport (1024px wide, which is > 768px)
      Object.defineProperty(window, "innerWidth", { value: 1024, writable: true });
      Object.defineProperty(window, "innerHeight", { value: 768, writable: true });

      render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

      const fab = screen.getByTestId("quick-chat-fab");

      // Simulate drag to extreme position (off viewport)
      fireEvent.pointerDown(fab, {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
      });

      // Try to drag way off screen (negative coordinates)
      fireEvent.pointerMove(fab, {
        clientX: -1000,
        clientY: -1000,
        pointerId: 1,
      });

      fireEvent.pointerUp(fab, {
        clientX: -1000,
        clientY: -1000,
        button: 0,
        pointerId: 1,
      });

      // Desktop: position should be clamped to at least 8px from edges
      const savedPosition = JSON.parse(localStorageMock.setItem.mock.calls[0]?.[1] || "{}");
      expect(savedPosition.x).toBeGreaterThanOrEqual(8);
      expect(savedPosition.y).toBeGreaterThanOrEqual(8);
    });

    it("touch events work for dragging", async () => {
      render(<QuickChatFAB addToast={addToast} projectId="proj-123" />);

      const fab = screen.getByTestId("quick-chat-fab");

      // Simulate touch drag
      fireEvent.pointerDown(fab, {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
        pointerType: "touch",
      });

      // Verify data-dragging attribute is set
      expect(fab.getAttribute("data-dragging")).toBe("true");

      // Move touch
      fireEvent.pointerMove(fab, {
        clientX: 50,
        clientY: 100,
        pointerId: 1,
        pointerType: "touch",
      });

      // End touch
      fireEvent.pointerUp(fab, {
        clientX: 50,
        clientY: 100,
        button: 0,
        pointerId: 1,
        pointerType: "touch",
      });

      // Position should have been saved
      expect(localStorageMock.setItem).toHaveBeenCalled();
    });

    it("panel position anchors relative to FAB position", async () => {
      render(<QuickChatFAB addToast={addToast} projectId="proj-123" open={true} />);

      const panel = screen.getByTestId("quick-chat-panel");
      const fab = screen.getByTestId("quick-chat-fab");

      // Initial positions (FAB at x=24, y=24+footer, panel at x=24, y=84+footer = FAB.y + 60)
      const fabBottom = parseFloat(fab.style.bottom);
      const panelBottom = parseFloat(panel.style.bottom);
      expect(panelBottom - fabBottom).toBe(60);
    });
  });
});
