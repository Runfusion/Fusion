import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";

const { mockEnsureTaskPlannerChatSession, mockFetchChatMessages, mockStreamChatResponse } = vi.hoisted(() => ({
  mockEnsureTaskPlannerChatSession: vi.fn(),
  mockFetchChatMessages: vi.fn(),
  mockStreamChatResponse: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    ensureTaskPlannerChatSession: mockEnsureTaskPlannerChatSession,
    fetchChatMessages: mockFetchChatMessages,
    streamChatResponse: mockStreamChatResponse,
  };
});

vi.mock("lucide-react", () => ({
  Loader2: (props: any) => React.createElement("svg", { "data-testid": "loader2-icon", ...props }),
  Send: (props: any) => React.createElement("svg", { "data-testid": "send-icon", ...props }),
}));

function renderPlannerChat(overrides: Partial<React.ComponentProps<typeof TaskPlannerChatTab>> = {}) {
  return render(
    <TaskPlannerChatTab
      task={{ id: "FN-7310", description: "Test task", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: "2026-06-30T00:00:00.000Z", updatedAt: "2026-06-30T00:00:00.000Z", planningModelProvider: "anthropic", planningModelId: "claude-plan" } as any}
      active
      planningModel={{ provider: "anthropic", modelId: "claude-plan" }}
      addToast={vi.fn()}
      {...overrides}
    />,
  );
}

describe("TaskPlannerChatTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTaskPlannerChatSession.mockResolvedValue({
      session: {
        id: "chat-planner",
        agentId: "task-planner:FN-7310",
        title: "FN-7310 planner chat",
        status: "active",
        projectId: null,
        modelProvider: "anthropic",
        modelId: "claude-plan",
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
        cliSessionFile: null,
        cliExecutorAdapterId: null,
        inFlightGeneration: null,
      },
    });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  it("loads a task-scoped planner session and renders the empty state", async () => {
    renderPlannerChat();

    expect(await screen.findByTestId("task-planner-chat-empty")).toHaveTextContent("No planner-chat messages yet.");
    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-7310",
      { modelProvider: "anthropic", modelId: "claude-plan" },
      undefined,
    );
    expect(mockFetchChatMessages).toHaveBeenCalledWith("chat-planner", { order: "asc" }, undefined);
    expect(screen.getByTestId("task-planner-chat-model")).toHaveTextContent("anthropic/claude-plan");
    expect(screen.getByRole("button", { name: "What is the current state of this task?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Help me turn this into clear steering for the executor." })).toBeInTheDocument();
  });

  it("omits model override when the effective planning model is undefined", async () => {
    renderPlannerChat({ planningModel: {} });

    await screen.findByTestId("task-planner-chat-empty");
    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith("FN-7310", {}, undefined);
    expect(screen.queryByTestId("task-planner-chat-model")).not.toBeInTheDocument();
  });

  it("renders persisted planner-chat messages", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        { id: "m2", sessionId: "chat-planner", role: "assistant", content: "Planner answer", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:02:00.000Z" },
        { id: "m1", sessionId: "chat-planner", role: "user", content: "Question", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:01:00.000Z" },
      ],
    });

    renderPlannerChat();

    expect(await screen.findByText("Question")).toBeInTheDocument();
    expect(screen.getByText("Planner answer")).toBeInTheDocument();
  });

  it("sends messages through the chat stream and appends success responses", async () => {
    const user = userEvent.setup();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onText("Hello");
        handlers.onDone({
          messageId: "assistant-1",
          message: { id: "assistant-1", sessionId: "chat-planner", role: "assistant", content: "Hello", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:03:00.000Z" },
        });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Help plan this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "Help plan this",
      expect.any(Object),
      undefined,
      undefined,
    );
    expect(screen.getByText("Help plan this")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Hello")).toBeInTheDocument());
  });

  it("sends starter prompts through the planner chat stream", async () => {
    const user = userEvent.setup();
    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    await user.click(screen.getByRole("button", { name: "What should happen next?" }));

    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "What should happen next?",
      expect.any(Object),
      undefined,
      undefined,
    );
  });

  it("renders planner question tool calls with the shared answer UI", async () => {
    const user = userEvent.setup();
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        {
          id: "assistant-question",
          sessionId: "chat-planner",
          role: "assistant",
          content: "Which path should we use?",
          thinkingOutput: null,
          metadata: {
            toolCalls: [{ toolName: "fn_ask_question", args: { question: "Pick a path", options: ["Conservative", "Aggressive"] }, isError: false }],
          },
          createdAt: "2026-06-30T00:02:00.000Z",
        },
      ],
    });
    renderPlannerChat();

    expect(await screen.findByTestId("chat-question-response")).toBeInTheDocument();
    await user.click(screen.getByTestId("chat-question-response-option-q-0-opt-0"));
    await user.click(screen.getByTestId("chat-question-response-submit"));

    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "> Q: Pick a path\nConservative",
      expect.any(Object),
      undefined,
      undefined,
    );
  });

  it("shows API errors and re-enables the composer", async () => {
    const user = userEvent.setup();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => handlers.onError("Planner unavailable"), 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Question");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Planner unavailable");
    await waitFor(() => expect(screen.getByLabelText("Message planner chat")).toBeEnabled());
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
