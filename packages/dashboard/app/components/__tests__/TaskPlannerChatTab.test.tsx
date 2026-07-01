import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";

const { mockEnsureTaskPlannerChatSession, mockFetchChatMessages, mockStreamChatResponse, mockTranslations, mockT } = vi.hoisted(() => {
  const translations = new Map<string, string>();
  return {
    mockEnsureTaskPlannerChatSession: vi.fn(),
    mockFetchChatMessages: vi.fn(),
    mockStreamChatResponse: vi.fn(),
    mockTranslations: translations,
    mockT: (key: string, fallback: string) => translations.get(key) ?? fallback,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: mockT,
  }),
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

function makeTask(id: string) {
  return { id, description: "Test task", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: "2026-06-30T00:00:00.000Z", updatedAt: "2026-06-30T00:00:00.000Z", planningModelProvider: "anthropic", planningModelId: "claude-plan" } as any;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderPlannerChat(overrides: Partial<React.ComponentProps<typeof TaskPlannerChatTab>> = {}) {
  return render(
    <TaskPlannerChatTab
      task={makeTask("FN-7310")}
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
    mockTranslations.clear();
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

  it("loads a task-scoped planner session and renders the starter-prompt empty state", async () => {
    renderPlannerChat();

    const emptyState = await screen.findByTestId("task-planner-chat-empty");
    expect(emptyState).toHaveTextContent("Start a task-aware chat");
    expect(emptyState).toHaveTextContent("Starter prompts send as normal chat messages.");
    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-7310",
      { modelProvider: "anthropic", modelId: "claude-plan" },
      undefined,
    );
    expect(mockFetchChatMessages).toHaveBeenCalledWith("chat-planner", { order: "asc" }, undefined);
    expect(screen.getByTestId("task-planner-chat-model")).toHaveTextContent("anthropic/claude-plan");
    expect(screen.getByRole("button", { name: /Summarize recent activity/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Explain status and blockers/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Identify the next best action/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review the plan or definition/ })).toBeInTheDocument();
    expect(screen.getAllByTestId(/task-planner-chat-starter-/)).toHaveLength(4);
  });

  it("omits model override when the effective planning model is undefined", async () => {
    renderPlannerChat({ planningModel: {} });

    await screen.findByTestId("task-planner-chat-empty");
    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith("FN-7310", {}, undefined);
    expect(screen.queryByTestId("task-planner-chat-model")).not.toBeInTheDocument();
  });

  it("does not reload when parent rerenders with an equivalent planning model", async () => {
    const { rerender } = renderPlannerChat();

    await screen.findByTestId("task-planner-chat-empty");
    rerender(
      <TaskPlannerChatTab
        task={makeTask("FN-7310")}
        active
        planningModel={{ provider: "anthropic", modelId: "claude-plan" }}
        addToast={vi.fn()}
      />,
    );
    await Promise.resolve();

    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledTimes(1);
    expect(mockFetchChatMessages).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("task-planner-chat-empty")).toBeInTheDocument();
  });

  it("ignores stale planner-chat load responses after the task scope changes", async () => {
    const firstLoad = createDeferred<any>();
    mockEnsureTaskPlannerChatSession.mockImplementation((taskId: string) => {
      if (taskId === "FN-7310") return firstLoad.promise;
      return Promise.resolve({
        session: {
          id: "chat-new-task",
          agentId: `task-planner:${taskId}`,
          title: `${taskId} planner chat`,
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
    });
    mockFetchChatMessages.mockImplementation((sessionId: string) => Promise.resolve({
      messages: sessionId === "chat-new-task"
        ? []
        : [{ id: "old-message", sessionId, role: "assistant", content: "Stale old task answer", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:02:00.000Z" }],
    }));

    const { rerender } = renderPlannerChat();
    rerender(
      <TaskPlannerChatTab
        task={makeTask("FN-7312")}
        active
        planningModel={{ provider: "anthropic", modelId: "claude-plan" }}
        addToast={vi.fn()}
      />,
    );

    await screen.findByTestId("task-planner-chat-empty");
    firstLoad.resolve({
      session: {
        id: "chat-old-task",
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

    await Promise.resolve();
    await Promise.resolve();
    expect(mockFetchChatMessages).not.toHaveBeenCalledWith("chat-old-task", { order: "asc" }, undefined);
    expect(screen.queryByText("Stale old task answer")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Summarize recent activity/ }));
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-new-task",
      "Summarize the recent activity for this task and call out anything important I should know.",
      expect.any(Object),
      undefined,
      undefined,
    );
  });

  it("ignores stale stream callbacks after the task scope changes", async () => {
    const oldStreamClose = vi.fn();
    let oldHandlers: any;
    mockEnsureTaskPlannerChatSession.mockImplementation((taskId: string) => Promise.resolve({
      session: {
        id: taskId === "FN-7310" ? "chat-old-task" : "chat-new-task",
        agentId: `task-planner:${taskId}`,
        title: `${taskId} planner chat`,
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
    }));
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      oldHandlers = handlers;
      return { close: oldStreamClose, isConnected: () => true };
    });

    const { rerender } = renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");
    await userEvent.click(screen.getByRole("button", { name: /Summarize recent activity/ }));
    expect(screen.getByText("Summarize the recent activity for this task and call out anything important I should know.")).toBeInTheDocument();

    rerender(
      <TaskPlannerChatTab
        task={makeTask("FN-7312")}
        active
        planningModel={{ provider: "anthropic", modelId: "claude-plan" }}
        addToast={vi.fn()}
      />,
    );
    await screen.findByTestId("task-planner-chat-empty");
    act(() => {
      oldHandlers.onText("Stale old task answer");
      oldHandlers.onDone({
        messageId: "assistant-old-task",
        message: { id: "assistant-old-task", sessionId: "chat-old-task", role: "assistant", content: "Committed stale answer", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:04:00.000Z" },
      });
      oldHandlers.onError("Stale stream error");
    });

    expect(oldStreamClose).toHaveBeenCalled();
    expect(screen.queryByText("Stale old task answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Committed stale answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale stream error")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-planner-chat-empty")).toBeInTheDocument();
  });

  it("does not show starter prompts while planner-chat history is loading", async () => {
    mockFetchChatMessages.mockReturnValue(new Promise(() => undefined));

    renderPlannerChat();

    expect(await screen.findByRole("status")).toHaveTextContent("Loading planner chat…");
    expect(screen.queryByTestId("task-planner-chat-empty")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Summarize recent activity/ })).not.toBeInTheDocument();
  });

  it("does not render duplicate starter prompt buttons when labels collide", async () => {
    mockTranslations.set("taskDetail.plannerChat.starters.statusBlockers.label", "Summarize recent activity");

    renderPlannerChat();

    await screen.findByTestId("task-planner-chat-empty");
    expect(screen.getAllByRole("button", { name: /Summarize recent activity/ })).toHaveLength(1);
    expect(screen.getAllByTestId(/task-planner-chat-starter-/)).toHaveLength(3);
  });

  it("keeps load errors recoverable without showing premature starter prompts", async () => {
    mockFetchChatMessages.mockRejectedValue(new Error("History unavailable"));

    renderPlannerChat();

    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.queryByTestId("task-planner-chat-empty")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message planner chat")).toBeEnabled();
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
    expect(screen.queryByTestId("task-planner-chat-empty")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Summarize recent activity/ })).not.toBeInTheDocument();
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

  it("shows a recoverable error when the post-stream refresh fails", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockRejectedValueOnce(new Error("Refresh unavailable"));
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onDone({ messageId: "assistant-refresh" });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat({ addToast });
    await screen.findByTestId("task-planner-chat-empty");

    await user.click(screen.getByRole("button", { name: /Summarize recent activity/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh unavailable");
    expect(addToast).toHaveBeenCalledWith("Refresh unavailable", "error");
    expect(screen.getByLabelText("Message planner chat")).toBeEnabled();
  });

  it("sends starter prompts through the planner chat stream", async () => {
    const user = userEvent.setup();
    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    await user.click(screen.getByRole("button", { name: /Identify the next best action/ }));

    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "What is the next best action for this task, and why?",
      expect.any(Object),
      undefined,
      undefined,
    );
    expect(screen.queryByTestId("task-planner-chat-empty")).not.toBeInTheDocument();
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
