import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";

const { mockEnsureTaskPlannerChatSession, mockFetchTaskPlannerChatSession, mockFetchChatMessages, mockFetchTaskDetail, mockStreamChatResponse, mockTranslations, mockT } = vi.hoisted(() => {
  const translations = new Map<string, string>();
  return {
    mockEnsureTaskPlannerChatSession: vi.fn(),
    mockFetchTaskPlannerChatSession: vi.fn(),
    mockFetchChatMessages: vi.fn(),
    mockFetchTaskDetail: vi.fn(),
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
    fetchTaskPlannerChatSession: mockFetchTaskPlannerChatSession,
    fetchChatMessages: mockFetchChatMessages,
    fetchTaskDetail: mockFetchTaskDetail,
    streamChatResponse: mockStreamChatResponse,
  };
});

vi.mock("lucide-react", () => ({
  Loader2: (props: any) => React.createElement("svg", { "data-testid": "loader2-icon", ...props }),
  Maximize2: (props: any) => React.createElement("svg", { "data-testid": "maximize2-icon", ...props }),
  Minimize2: (props: any) => React.createElement("svg", { "data-testid": "minimize2-icon", ...props }),
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

function firstTapSendFromFocusedPlannerTextarea(input: HTMLElement, sendButton: HTMLElement) {
  input.focus();
  expect(input).toHaveFocus();
  fireEvent.pointerDown(sendButton, { pointerType: "touch" });
  fireEvent.blur(input);
  fireEvent.click(sendButton);
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

function plannerQuestionMessage(id: string, args: Record<string, unknown>, createdAt = "2026-06-30T00:02:00.000Z") {
  return {
    id,
    sessionId: "chat-planner",
    role: "assistant",
    content: "Planner needs clarification.",
    thinkingOutput: null,
    metadata: { toolCalls: [{ toolName: "fn_ask_question", args, isError: false }] },
    createdAt,
  };
}

describe("TaskPlannerChatTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTranslations.clear();
    const plannerSession = {
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
    };
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session: plannerSession });
    mockEnsureTaskPlannerChatSession.mockResolvedValue({ session: plannerSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchTaskDetail.mockResolvedValue(makeTask("FN-7310"));
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  it("looks up an existing task-scoped planner session and renders the starter-prompt empty state", async () => {
    renderPlannerChat();

    const emptyState = await screen.findByTestId("task-planner-chat-empty");
    expect(emptyState).toHaveTextContent("Start a task-aware chat");
    expect(document.querySelector(".task-planner-chat-header")).toBeNull();
    expect(screen.queryByText("Planner Chat")).toBeNull();
    expect(emptyState).toHaveTextContent("Ask planning questions about this task's current status, recent activity, blockers, next steps, or definition.");
    expect(emptyState).toHaveTextContent("Starter prompts send as normal chat messages.");
    expect(mockFetchTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-7310",
      { modelProvider: "anthropic", modelId: "claude-plan" },
      undefined,
    );
    expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
    expect(mockFetchChatMessages).toHaveBeenCalledWith("chat-planner", { order: "asc" }, undefined);
    const modelBadge = screen.getByTestId("task-planner-chat-model");
    expect(modelBadge).toHaveAccessibleName("anthropic/claude-plan");
    expect(modelBadge).toHaveAttribute("title", "anthropic/claude-plan");
    expect(modelBadge).toHaveTextContent("");
    expect(emptyState).toContainElement(modelBadge);
    expect(modelBadge).toHaveClass("task-planner-chat-empty-model");
    expect(modelBadge.querySelector(".provider-icon[data-provider='anthropic']")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Summarize recent activity/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Explain status and blockers/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Identify the next best action/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review the plan or definition/ })).toBeInTheDocument();
    expect(screen.getAllByTestId(/task-planner-chat-starter-/)).toHaveLength(4);
  });

  it("does not create a planner session when no existing history is found on tab activation", async () => {
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });

    renderPlannerChat();

    const emptyState = await screen.findByTestId("task-planner-chat-empty");
    expect(emptyState).toHaveTextContent("Start a task-aware chat");
    expect(mockFetchTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-7310",
      { modelProvider: "anthropic", modelId: "claude-plan" },
      undefined,
    );
    expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
    expect(mockFetchChatMessages).not.toHaveBeenCalled();
  });

  it("creates a planner session only when a starter prompt is clicked without existing history", async () => {
    const user = userEvent.setup();
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });

    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Identify the next best action/ }));

    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-7310",
      { modelProvider: "anthropic", modelId: "claude-plan" },
      undefined,
    );
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "What is the next best action for this task, and why?",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-7310" },
    );
  });

  it("renders accessible expand controls without moving the composer out of the panel", async () => {
    const onExpandedChange = vi.fn();
    renderPlannerChat({ expanded: true, onExpandedChange });

    expect(await screen.findByTestId("task-planner-chat-empty")).toBeInTheDocument();
    const toggle = screen.getByTestId("task-planner-chat-expand-toggle");
    const modelBadge = screen.getByTestId("task-planner-chat-model");
    expect(toggle).toHaveAccessibleName("Collapse planner chat");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveClass("task-planner-chat-expand-toggle--overlay");
    expect(screen.getByTestId("task-planner-chat-panel")).toContainElement(toggle);
    expect(screen.getByTestId("task-planner-chat-empty")).toContainElement(modelBadge);
    expect(screen.getByTestId("task-planner-chat-panel")).toContainElement(screen.getByLabelText("Message planner chat"));
    expect(screen.getByTestId("task-planner-chat-panel")).toContainElement(screen.getByRole("button", { name: "Send" }));

    await userEvent.click(toggle);

    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("omits model override when the effective planning model is undefined", async () => {
    renderPlannerChat({ planningModel: {} });

    await screen.findByTestId("task-planner-chat-empty");
    expect(mockFetchTaskPlannerChatSession).toHaveBeenCalledWith("FN-7310", {}, undefined);
    expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
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

    expect(mockFetchTaskPlannerChatSession).toHaveBeenCalledTimes(1);
    expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
    expect(mockFetchChatMessages).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("task-planner-chat-empty")).toBeInTheDocument();
  });

  it("ignores stale planner-chat load responses after the task scope changes", async () => {
    const firstLoad = createDeferred<any>();
    mockFetchTaskPlannerChatSession.mockImplementation((taskId: string) => {
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
      { taskId: "FN-7312" },
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
      { taskId: "FN-7310" },
    );
    expect(screen.getByText("Help plan this")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Hello")).toBeInTheDocument());
  });

  it("sends planner Chat exactly once on the first mobile tap while the textarea is focused", async () => {
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });
    renderPlannerChat({ projectId: "project-1" });
    await screen.findByTestId("task-planner-chat-empty");

    const input = screen.getByLabelText("Message planner chat");
    fireEvent.change(input, { target: { value: "First mobile tap planner message" } });
    firstTapSendFromFocusedPlannerTextarea(input, screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith(
        "FN-7310",
        { modelProvider: "anthropic", modelId: "claude-plan" },
        "project-1",
      );
    });
    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledTimes(1);
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "First mobile tap planner message",
      expect.any(Object),
      undefined,
      "project-1",
      { taskId: "FN-7310" },
    );
    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
  });

  it("keeps planner mobile first-tap guards for blank drafts and in-flight sends", async () => {
    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    const input = screen.getByLabelText("Message planner chat");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();
    fireEvent.change(input, { target: { value: "   \n  " } });
    expect(sendButton).toBeDisabled();
    firstTapSendFromFocusedPlannerTextarea(input, sendButton);
    expect(mockStreamChatResponse).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Do not duplicate planner tap" } });
    expect(sendButton).not.toBeDisabled();
    firstTapSendFromFocusedPlannerTextarea(input, sendButton);
    fireEvent.pointerDown(sendButton, { pointerType: "touch" });
    fireEvent.click(sendButton);

    await waitFor(() => expect(mockStreamChatResponse).toHaveBeenCalledTimes(1));
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "Do not duplicate planner tap",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-7310" },
    );
  });

  it("renders live and stored thinking output through the standard chat surface", async () => {
    const user = userEvent.setup();
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{
        id: "assistant-thinking",
        sessionId: "chat-planner",
        role: "assistant",
        content: "Stored answer",
        thinkingOutput: "stored plan notes",
        metadata: null,
        createdAt: "2026-06-30T00:02:00.000Z",
      }],
    });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onThinking?.("live plan");
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat();

    expect(await screen.findByText("Stored answer")).toBeInTheDocument();
    expect(screen.getByText("stored plan notes")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message planner chat"), "Think about this");
    fireEvent.pointerDown(screen.getByTestId("chat-send-btn"), { pointerType: "touch" });

    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText("live plan")).toBeInTheDocument();
  });

  it("dedupes mobile first-tap sends through the standard composer action", async () => {
    const user = userEvent.setup();
    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Mobile first tap");
    const sendButton = screen.getByTestId("chat-send-btn");
    fireEvent.pointerDown(sendButton, { pointerType: "touch" });
    fireEvent.click(sendButton);

    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "Mobile first tap",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-7310" },
    );
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

  it("sends manual status/progress questions with the current task identity", async () => {
    const user = userEvent.setup();
    renderPlannerChat({ task: makeTask("FN-STATUS") });
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "What is the current status and progress?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "What is the current status and progress?",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-STATUS" },
    );
  });

  it("answers recent-activity starter prompts without creating steering feedback", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onDone({
          messageId: "assistant-summary",
          message: {
            id: "assistant-summary",
            sessionId: "chat-planner",
            role: "assistant",
            content: "Recent activity: executor started work and posted an update.",
            thinkingOutput: null,
            metadata: null,
            createdAt: "2026-06-30T00:03:00.000Z",
          },
        });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat({
      task: {
        ...makeTask("FN-ACTIVITY"),
        column: "in-progress",
        dependencies: ["FN-BLOCKER"],
        prompt: "# Plan\nKeep Activity and Chat separate.",
        log: [{ timestamp: "2026-06-30T00:01:00.000Z", action: "Started work" }],
      } as any,
      onTaskUpdated,
    });
    await screen.findByTestId("task-planner-chat-empty");

    await user.click(screen.getByRole("button", { name: /Summarize recent activity/ }));

    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "Summarize the recent activity for this task and call out anything important I should know.",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-ACTIVITY" },
    );
    expect(await screen.findByText("Recent activity: executor started work and posted an update.")).toBeInTheDocument();
    expect(screen.queryByTestId("task-planner-chat-steering-confirmation")).not.toBeInTheDocument();
    expect(onTaskUpdated).not.toHaveBeenCalled();
  });

  it("keeps missing task context sendable while preserving explicit planning model overrides", async () => {
    const user = userEvent.setup();
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });
    renderPlannerChat({
      task: { ...makeTask("FN-MISSING-CONTEXT"), dependencies: [], prompt: undefined, log: undefined } as any,
      planningModel: { provider: "openai", modelId: "gpt-planner" },
    });
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Explain the current task state with whatever context exists.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-MISSING-CONTEXT",
      { modelProvider: "openai", modelId: "gpt-planner" },
      undefined,
    );
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "Explain the current task state with whatever context exists.",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-MISSING-CONTEXT" },
    );
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
      { taskId: "FN-7310" },
    );
    expect(screen.queryByTestId("task-planner-chat-empty")).not.toBeInTheDocument();
  });

  it("renders planner question tool calls with the shared answer UI", async () => {
    const user = userEvent.setup();
    mockFetchChatMessages.mockResolvedValue({
      messages: [plannerQuestionMessage("assistant-question", { question: "Pick a path", options: ["Conservative", "Aggressive"] })],
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
      { taskId: "FN-7310" },
    );
  });

  it("renders steering-tool confirmation and refreshes task detail after persistence", async () => {
    const user = userEvent.setup();
    const updatedTask = { ...makeTask("FN-7310"), steeringComments: [{ id: "steer-1", text: "Keep Activity and Chat separate", author: "user" }] } as any;
    const onTaskUpdated = vi.fn();
    mockFetchTaskDetail.mockResolvedValue(updatedTask);
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onToolStart({ toolName: "fn_task_planner_add_steering", args: { text: "Keep Activity and Chat separate" } });
        handlers.onToolEnd({
          toolName: "fn_task_planner_add_steering",
          isError: false,
          result: { details: { taskId: "FN-7310", text: "Keep Activity and Chat separate", steeringComment: { id: "steer-1", text: "Keep Activity and Chat separate", author: "user" } } },
        });
        handlers.onDone({
          messageId: "assistant-steering",
          message: {
            id: "assistant-steering",
            sessionId: "chat-planner",
            role: "assistant",
            content: "I added that as steering.",
            thinkingOutput: null,
            metadata: {
              toolCalls: [{
                toolName: "fn_task_planner_add_steering",
                args: { text: "Keep Activity and Chat separate" },
                isError: false,
                result: { details: { taskId: "FN-7310", text: "Keep Activity and Chat separate", steeringComment: { id: "steer-1", text: "Keep Activity and Chat separate", author: "user" } } },
              }],
            },
            createdAt: "2026-06-30T00:03:00.000Z",
          },
        });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat({ projectId: "project-1", onTaskUpdated });
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Tell the executor to keep Activity and Chat separate");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByTestId("task-planner-chat-steering-confirmation")).toHaveTextContent("Added as steering comment");
    expect(screen.getByTestId("task-planner-chat-steering-confirmation")).toHaveTextContent("Keep Activity and Chat separate");
    await waitFor(() => expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-7310", "project-1"));
    expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
  });

  it("renders clarification questions without refreshing task steering", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [{
        id: "assistant-question",
        sessionId: "chat-planner",
        role: "assistant",
        content: "Do you want this recorded as steering?",
        thinkingOutput: null,
        metadata: { toolCalls: [{ toolName: "fn_ask_question", args: { question: "Record this as steering?", options: ["Yes", "No"] }, isError: false }] },
        createdAt: "2026-06-30T00:02:00.000Z",
      }],
    });

    renderPlannerChat({ projectId: "project-1", onTaskUpdated: vi.fn() });

    expect(await screen.findByTestId("chat-question-response")).toBeInTheDocument();
    expect(screen.queryByTestId("task-planner-chat-steering-confirmation")).not.toBeInTheDocument();
    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
  });

  it("streams risky change requests as clarification questions without steering mutation", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onToolStart({ toolName: "fn_ask_question", args: { question: "Which files and safety constraints should this destructive change use?", options: ["Clarify scope", "Cancel"] } });
        handlers.onDone({
          messageId: "assistant-risky-question",
          message: {
            id: "assistant-risky-question",
            sessionId: "chat-planner",
            role: "assistant",
            content: "I need clarification before adding steering.",
            thinkingOutput: null,
            metadata: { toolCalls: [{ toolName: "fn_ask_question", args: { question: "Which files and safety constraints should this destructive change use?", options: ["Clarify scope", "Cancel"] }, isError: false }] },
            createdAt: "2026-06-30T00:03:00.000Z",
          },
        });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat({ projectId: "project-1", onTaskUpdated });
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Delete the risky parts and rewrite the security flow broadly");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByTestId("chat-question-response")).toHaveTextContent("Which files and safety constraints should this destructive change use?");
    expect(screen.getAllByTestId("chat-question-response")).toHaveLength(1);
    expect(screen.getAllByTestId("chat-question-response-submit")).toHaveLength(1);
    expect(screen.queryByTestId("task-planner-chat-steering-confirmation")).not.toBeInTheDocument();
    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    expect(onTaskUpdated).not.toHaveBeenCalled();
  });

  it("shows failed steering tool results without optimistic steering confirmation or duplicate refresh", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onToolEnd({
          toolName: "fn_task_planner_add_steering",
          isError: true,
          result: { error: "Invalid steering text" },
        });
        handlers.onDone({
          messageId: "assistant-steering-error",
          message: {
            id: "assistant-steering-error",
            sessionId: "chat-planner",
            role: "assistant",
            content: "I could not add that as steering.",
            thinkingOutput: null,
            metadata: { toolCalls: [{ toolName: "fn_task_planner_add_steering", args: { text: "   " }, isError: true, result: { error: "Invalid steering text" } }] },
            createdAt: "2026-06-30T00:03:00.000Z",
          },
        });
      }, 0);
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat({ projectId: "project-1", onTaskUpdated });
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Add empty steering");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("I could not add that as steering.")).toBeInTheDocument();
    expect(screen.queryByTestId("task-planner-chat-steering-confirmation")).not.toBeInTheDocument();
    expect(mockFetchTaskDetail).not.toHaveBeenCalled();
    expect(onTaskUpdated).not.toHaveBeenCalled();
  });

  it("renders text, single-select, multi-select, confirm, and missing-option planner questions", async () => {
    const user = userEvent.setup();
    mockFetchChatMessages.mockResolvedValue({
      messages: [plannerQuestionMessage("assistant-question", {
        questions: [
          { id: "text", question: "Describe the risk", type: "text" },
          { id: "single", question: "Pick one", type: "single_select", options: [{ id: "safe", label: "Safe" }] },
          { id: "multi", question: "Pick many", type: "multi_select", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          { id: "confirm", question: "Proceed?", type: "confirm" },
          { id: "missing", question: "Missing choices", type: "single_select" },
        ],
      })],
    });
    renderPlannerChat();

    expect(await screen.findByTestId("chat-question-response")).toBeInTheDocument();
    expect(screen.getByTestId("chat-question-response-submit")).toBeDisabled();
    await user.type(screen.getByTestId("chat-question-response-text-text"), "Low risk");
    await user.click(screen.getByTestId("chat-question-response-option-single-safe"));
    await user.click(screen.getByTestId("chat-question-response-option-multi-a"));
    await user.click(screen.getByTestId("chat-question-response-option-confirm-no"));
    await user.type(screen.getByTestId("chat-question-response-text-missing"), "Use the default");
    await user.click(screen.getByTestId("chat-question-response-submit"));

    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "> Q: Describe the risk\nLow risk\n\n> Q: Pick one\nSafe\n\n> Q: Pick many\nA\n\n> Q: Proceed?\nNo\n\n> Q: Missing choices\nUse the default",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-7310" },
    );
  });

  it("renders answered planner questions read-only with the submitted answer", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        plannerQuestionMessage("assistant-question", { question: "Pick a path", options: ["Conservative", "Aggressive"] }),
        { id: "user-answer", sessionId: "chat-planner", role: "user", content: "> Q: Pick a path\nAggressive", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:03:00.000Z" },
      ],
    });
    renderPlannerChat();

    expect(await screen.findByTestId("chat-question-response-submitted-answer")).toHaveTextContent("Aggressive");
    expect(screen.getByText("Answered")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-question-response-option-q-0-opt-1")).not.toBeInTheDocument();
  });

  it("hides older duplicate pending planner questions after a refetch", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        plannerQuestionMessage("assistant-question-old", { question: "Pick a path", options: ["Conservative", "Aggressive"] }, "2026-06-30T00:02:00.000Z"),
        plannerQuestionMessage("assistant-question-new", { question: "Pick a path", options: ["Conservative", "Aggressive"] }, "2026-06-30T00:03:00.000Z"),
      ],
    });
    renderPlannerChat();

    expect(await screen.findByTestId("chat-question-response")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-question-response")).toHaveLength(1);
    expect(screen.getAllByTestId("chat-question-response-submit")).toHaveLength(1);
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
