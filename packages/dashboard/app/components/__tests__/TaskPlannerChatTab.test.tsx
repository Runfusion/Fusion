import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";

const taskPlannerChatCss = readFileSync(resolve(__dirname, "../TaskPlannerChatTab.css"), "utf8");

const { mockEnsureTaskPlannerChatSession, mockFetchTaskPlannerChatSession, mockFetchChatSession, mockFetchChatMessages, mockFetchTaskDetail, mockStreamChatResponse, mockAttachChatStream, mockEditChatMessage, mockAddSteeringComment, mockTranslations, mockT } = vi.hoisted(() => {
  const translations = new Map<string, string>();
  return {
    mockEnsureTaskPlannerChatSession: vi.fn(),
    mockFetchTaskPlannerChatSession: vi.fn(),
    mockFetchChatSession: vi.fn(),
    mockFetchChatMessages: vi.fn(),
    mockFetchTaskDetail: vi.fn(),
    mockStreamChatResponse: vi.fn(),
    mockAttachChatStream: vi.fn(),
    mockEditChatMessage: vi.fn(),
    mockAddSteeringComment: vi.fn(),
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
    fetchChatSession: mockFetchChatSession,
    fetchChatMessages: mockFetchChatMessages,
    fetchTaskDetail: mockFetchTaskDetail,
    streamChatResponse: mockStreamChatResponse,
    attachChatStream: mockAttachChatStream,
    editChatMessage: mockEditChatMessage,
    addSteeringComment: mockAddSteeringComment,
  };
});

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Loader2: (props: any) => React.createElement("svg", { "data-testid": "loader2-icon", ...props }),
    Maximize2: (props: any) => React.createElement("svg", { "data-testid": "maximize2-icon", ...props }),
    Minimize2: (props: any) => React.createElement("svg", { "data-testid": "minimize2-icon", ...props }),
    Send: (props: any) => React.createElement("svg", { "data-testid": "send-icon", ...props }),
  };
});

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
  return { id, description: "Test task", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: "2026-06-30T00:00:00.000Z", updatedAt: "2026-06-30T00:00:00.000Z", planningModelProvider: "anthropic", planningModelId: "claude-plan", ...overrides } as any;
}

function makePlannerSession(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
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
    const plannerSession = makePlannerSession();
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session: plannerSession });
    mockFetchChatSession.mockResolvedValue({ session: plannerSession });
    mockEnsureTaskPlannerChatSession.mockResolvedValue({ session: plannerSession });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchTaskDetail.mockResolvedValue(makeTask("FN-7310"));
    mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockEditChatMessage.mockResolvedValue({ retained: [] });
    mockAddSteeringComment.mockResolvedValue(makeTask("FN-7310"));
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

  it("lets a done task with no planner history create a task-scoped session on first composer send", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });

    renderPlannerChat({ task: makeTask("FN-DONE", { column: "done" }), addToast });
    await screen.findByTestId("task-planner-chat-empty");

    expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Message planner chat"), "What changed in this completed task?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-DONE",
      { modelProvider: "anthropic", modelId: "claude-plan" },
      undefined,
    );
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "What changed in this completed task?",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-DONE" },
    );
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("planner chat can only be started while a task is live"), "error");
  });

  it("lets a done task with no planner history create a task-scoped session from a starter prompt", async () => {
    const user = userEvent.setup();
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });

    renderPlannerChat({ task: makeTask("FN-DONE", { column: "done" }) });
    await screen.findByTestId("task-planner-chat-empty");
    await user.click(screen.getByRole("button", { name: /Summarize recent activity/ }));

    expect(mockEnsureTaskPlannerChatSession).toHaveBeenCalledWith(
      "FN-DONE",
      { modelProvider: "anthropic", modelId: "claude-plan" },
      undefined,
    );
    expect(mockStreamChatResponse).toHaveBeenCalledWith(
      "chat-planner",
      "Summarize the recent activity for this task and call out anything important I should know.",
      expect.any(Object),
      undefined,
      undefined,
      { taskId: "FN-DONE" },
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

  it("reattaches an in-flight planner generation after modal remount and keeps stop visible", async () => {
    const firstClose = vi.fn();
    const inFlightGeneration = {
      status: "generating",
      streamingText: "Partial planner answer",
      streamingThinking: "Reviewing task context",
      toolCalls: [{ toolName: "fn_task_planner_add_steering", args: { text: "Add this steering" }, isError: false, status: "running" }],
      replayFromEventId: 7,
      updatedAt: "2026-07-01T14:00:00.000Z",
    };
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "user-1", sessionId: "chat-planner", role: "user", content: "Help plan this", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T13:59:00.000Z" }],
    });
    mockAttachChatStream.mockReturnValueOnce({ close: firstClose, isConnected: () => true }).mockReturnValue({ close: vi.fn(), isConnected: () => true });

    const { unmount } = renderPlannerChat();

    expect(await screen.findByText("Partial planner answer")).toBeInTheDocument();
    expect(screen.getByText("Reviewing task context")).toBeInTheDocument();
    expect(screen.getByTestId("task-planner-chat-steering-pending")).toHaveTextContent("Adding steering comment…");
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeInTheDocument();
    expect(mockAttachChatStream).toHaveBeenCalledWith("chat-planner", expect.any(Object), undefined, { lastEventId: 7 });

    unmount();
    expect(firstClose).toHaveBeenCalled();

    renderPlannerChat();
    expect(await screen.findByText("Partial planner answer")).toBeInTheDocument();
    expect(mockAttachChatStream).toHaveBeenCalledTimes(2);
  });

  it("refreshes to completed planner history after returning to a remounted modal", async () => {
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: false, inFlightGeneration: null }) });
    mockFetchChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: false, inFlightGeneration: null }) });
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        { id: "user-1", sessionId: "chat-planner", role: "user", content: "Summarize blockers", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T13:59:00.000Z" },
        { id: "assistant-1", sessionId: "chat-planner", role: "assistant", content: "The planner finished while you were away.", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T14:00:00.000Z" },
      ],
    });

    const { unmount } = renderPlannerChat();
    expect(await screen.findByText("The planner finished while you were away.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
    unmount();

    renderPlannerChat();
    expect(await screen.findByText("The planner finished while you were away.")).toBeInTheDocument();
    expect(mockAttachChatStream).not.toHaveBeenCalled();
  });

  it("refreshes attached planner completion without leaving a stale streaming bubble", async () => {
    let attachedHandlers: any;
    const inFlightGeneration = {
      status: "generating",
      streamingText: "Partial draft",
      streamingThinking: "Synthesizing",
      toolCalls: [],
      replayFromEventId: 11,
      updatedAt: "2026-07-01T14:00:00.000Z",
    };
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [{ id: "assistant-complete", sessionId: "chat-planner", role: "assistant", content: "Final planner response", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T14:01:00.000Z" }],
      });
    mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
      attachedHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });

    renderPlannerChat();
    expect(await screen.findByText("Partial draft")).toBeInTheDocument();
    act(() => {
      attachedHandlers.onDone({ messageId: "assistant-complete" });
    });

    expect(await screen.findByText("Final planner response")).toBeInTheDocument();
    expect(screen.queryByText("Partial draft")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("surfaces a failed reattached planner stream as recoverable error and refreshed history", async () => {
    let attachedHandlers: any;
    const inFlightGeneration = {
      status: "generating",
      streamingText: "",
      streamingThinking: "Still thinking",
      toolCalls: [],
      replayFromEventId: 9,
      updatedAt: "2026-07-01T14:00:00.000Z",
    };
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [{ id: "assistant-failed", sessionId: "chat-planner", role: "assistant", content: "Planner failed while you were away.", thinkingOutput: null, metadata: { failureInfo: { summary: "Planner failed while you were away." } }, createdAt: "2026-07-01T14:01:00.000Z" }],
      });
    mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
      attachedHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });

    renderPlannerChat();
    expect(await screen.findByText("Still thinking")).toBeInTheDocument();
    act(() => {
      attachedHandlers.onError({ summary: "Planner failed while you were away." });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Planner failed while you were away.");
    expect(await screen.findAllByText("Planner failed while you were away.")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
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

  it("keeps send and thinking stop icons visible in planner chat", async () => {
    const user = userEvent.setup();
    let streamHandlers: any;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });
    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");

    await user.type(screen.getByLabelText("Message planner chat"), "Think with an icon");
    const sendButton = screen.getByTestId("chat-send-btn");
    expect(sendButton).toHaveAccessibleName("Send");
    expect(sendButton.querySelector("svg")).toBeTruthy();
    // FN-7685: the idle send button is icon-only — no visible "Send" text span,
    // even though the accessible name (aria-label) above still resolves to "Send".
    expect(sendButton.querySelector("span")).toBeNull();

    fireEvent.pointerDown(sendButton, { pointerType: "touch" });
    act(() => {
      streamHandlers.onThinking?.("checking the plan");
    });

    const stopButton = await screen.findByTestId("chat-stop-btn");
    expect(stopButton).toHaveAccessibleName("Stop generation");
    const stopIcon = stopButton.querySelector(".chat-input-stop-icon");
    expect(stopIcon).toBeTruthy();
    expect(stopIcon).toHaveAttribute("aria-hidden", "true");
    // FN-7655: the streaming stop button is icon-only — no visible "Stop generation" text span,
    // even though the accessible name (aria-label) above still resolves to "Stop generation".
    expect(stopButton.querySelector("span:not(.chat-input-stop-icon)")).toBeNull();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText("checking the plan")).toBeInTheDocument();

    const mobileTextHideRule = taskPlannerChatCss.match(/@media \(max-width: 768px\)[\s\S]*?\.task-planner-chat-send[^{}]*\{[^}]*clip:[^}]*\}/)?.[0] ?? "";
    expect(mobileTextHideRule).toContain("clip:");
    expect(mobileTextHideRule).toMatch(/span:not\(\.chat-input-stop-icon\)/);
    expect(mobileTextHideRule).not.toMatch(/\.task-planner-chat-send\s+span\s*\{/);
    expect(stopIcon).toHaveClass("chat-input-stop-icon");
  });

  it("keeps the planner stop button width in parity with the send button on desktop and mobile (FN-7634)", () => {
    // Desktop: both `.chat-input-send` and `.chat-input-stop` (from ChatView.css) read
    // `width: var(--chat-input-control-size)`, which is only declared inside `.chat-input-row`.
    // The Planner composer must declare that same custom property itself so the value never
    // resolves to `auto`, and must give the shared `.task-planner-chat-send` class (present on
    // both the send and stop button variants) a `min-inline-size` floor bound to it — otherwise
    // the streaming Stop button can render narrower than the idle Send button.
    expect(taskPlannerChatCss).toMatch(/\.task-planner-chat-composer\s*\{[\s\S]*?--chat-input-control-size:\s*calc\(var\(--space-lg\)\s*\*\s*2\.5\);/);

    // The base (non-mobile) `.task-planner-chat-send` rule is the first one in source order,
    // before the `@media (max-width: 768px)` block redeclares it for mobile.
    const mediaQueryStart = taskPlannerChatCss.indexOf("@media (max-width: 768px)");
    const desktopCss = mediaQueryStart >= 0 ? taskPlannerChatCss.slice(0, mediaQueryStart) : taskPlannerChatCss;
    const desktopSendRule = desktopCss.match(/\.task-planner-chat-send\s*\{[^}]*\}/)?.[0] ?? "";
    // The desktop rule must bind the same control-size custom property as its floor so the
    // Send button (idle) and Stop button (streaming) — both of which carry this class — never
    // differ in width footprint.
    expect(desktopSendRule).toMatch(/min-inline-size:\s*var\(--chat-input-control-size\)/);

    // Mobile keeps its pre-existing explicit square sizing, which already applies identically
    // to both the send and stop variants via the shared `.task-planner-chat-send` class.
    const mobileSendRule = taskPlannerChatCss
      .slice(mediaQueryStart)
      .match(/\.task-planner-chat-send\s*\{[^}]*\}/)?.[0] ?? "";
    expect(mobileSendRule).toMatch(/inline-size:\s*calc\(var\(--space-2xl\)\s*\+\s*var\(--space-lg\)\)/);
    expect(mobileSendRule).toMatch(/min-inline-size:\s*calc\(var\(--space-2xl\)\s*\+\s*var\(--space-lg\)\)/);

    // Guard the FN-7594-era contract that the stop icon span stays visible on mobile even
    // though other text-label spans are visually hidden.
    const mobileTextHideRule = taskPlannerChatCss.match(/@media \(max-width: 768px\)[\s\S]*?\.task-planner-chat-send[^{}]*\{[^}]*clip:[^}]*\}/)?.[0] ?? "";
    expect(mobileTextHideRule).toMatch(/span:not\(\.chat-input-stop-icon\)/);
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

  it("renders mixed persisted planner question tool calls with the shared answer UI outside collapsed details", async () => {
    const user = userEvent.setup();
    mockFetchChatMessages.mockResolvedValue({
      messages: [{
        ...plannerQuestionMessage("assistant-question", { question: "Pick a path", options: ["Conservative", "Aggressive"] }),
        metadata: {
          toolCalls: [
            { toolName: "bash", args: { command: "echo hi" }, isError: false, result: "hi", status: "completed" },
            { toolName: "fn_ask_question", args: { question: "Pick a path", options: ["Conservative", "Aggressive"] }, isError: false, status: "completed" },
          ],
        },
      }],
    });
    renderPlannerChat();

    const transcript = await screen.findByTestId("task-planner-chat-transcript");
    const question = await screen.findByTestId("chat-question-response");
    expect(transcript).toContainElement(question);
    expect(question).toHaveTextContent("Pick a path");
    expect(question.closest("details.chat-tool-calls-group")).toBeNull();
    expect(screen.getByTestId("chat-tool-calls")).toHaveTextContent("bash");
    expect(screen.getByTestId("chat-tool-calls")).not.toHaveTextContent("fn_ask_question");
    await user.click(screen.getByTestId("chat-question-response-option-q-0-opt-0"));
    await user.click(screen.getByTestId("chat-question-response-submit"));

    expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
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

  it("renders reattached planner questions and pending/completed/error steering and refinement tool states", async () => {
    const inFlightGeneration = {
      status: "generating",
      streamingText: "I need clarification and may add steering or refinement.",
      streamingThinking: "Checking planner tools",
      toolCalls: [
        { toolName: "fn_ask_question", args: { question: "Pick a path", options: ["Conservative", "Aggressive"] }, isError: false, status: "completed" },
        { toolName: "fn_task_planner_add_steering", args: { text: "Persist this later" }, isError: false, status: "running" },
        { toolName: "fn_task_planner_add_steering", args: { text: "Persisted steering" }, isError: false, result: { details: { text: "Persisted steering" } }, status: "completed" },
        { toolName: "fn_task_planner_add_steering", args: { text: "Bad steering" }, isError: true, result: { error: "Invalid steering" }, status: "completed" },
        { toolName: "fn_task_planner_create_refinement", args: { feedback: "Create follow-up" }, isError: false, status: "running" },
        { toolName: "fn_task_planner_create_refinement", args: { feedback: "Add export support" }, isError: false, result: { details: { sourceTaskId: "FN-7310", refinementTaskId: "FN-REFINE", description: "Add export support" } }, status: "completed" },
        { toolName: "fn_task_planner_create_refinement", args: { feedback: "" }, isError: true, result: { details: { sourceTaskId: "FN-7310", error: "feedback required" } }, status: "completed" },
      ],
      replayFromEventId: 12,
      updatedAt: "2026-07-01T14:00:00.000Z",
    };
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatSession.mockResolvedValue({ session: makePlannerSession({ isGenerating: true, inFlightGeneration }) });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });

    renderPlannerChat();

    expect(await screen.findByTestId("chat-question-response")).toHaveTextContent("Pick a path");
    expect(screen.getByTestId("task-planner-chat-steering-pending")).toHaveTextContent("Adding steering comment…");
    expect(screen.getByTestId("task-planner-chat-steering-confirmation")).toHaveTextContent("Persisted steering");
    expect(screen.getByTestId("task-planner-chat-steering-error")).toHaveTextContent("Steering comment was not added");
    expect(screen.getByTestId("task-planner-chat-refinement-pending")).toHaveTextContent("Creating refinement task…");
    expect(screen.getByTestId("task-planner-chat-refinement-confirmation")).toHaveTextContent("Created refinement task FN-REFINE");
    expect(screen.getByTestId("task-planner-chat-refinement-confirmation")).toHaveTextContent("Add export support");
    expect(screen.getByTestId("task-planner-chat-refinement-error")).toHaveTextContent("Refinement task was not created");
    expect(screen.getAllByTestId("chat-question-response-submit")).toHaveLength(1);
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

  it("streams mixed planner question tool calls as an actionable card outside collapsed details", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      setTimeout(() => {
        handlers.onToolStart({ toolName: "bash", args: { command: "echo preparing" } });
        handlers.onToolEnd({ toolName: "bash", isError: false, result: "preparing" });
        handlers.onToolStart({ toolName: "fn_ask_question", args: { question: "Which files and safety constraints should this destructive change use?", options: ["Clarify scope", "Cancel"] } });
        handlers.onDone({
          messageId: "assistant-risky-question",
          message: {
            id: "assistant-risky-question",
            sessionId: "chat-planner",
            role: "assistant",
            content: "I need clarification before adding steering.",
            thinkingOutput: null,
            metadata: {
              toolCalls: [
                { toolName: "bash", args: { command: "echo preparing" }, isError: false, result: "preparing", status: "completed" },
                { toolName: "fn_ask_question", args: { question: "Which files and safety constraints should this destructive change use?", options: ["Clarify scope", "Cancel"] }, isError: false, status: "completed" },
              ],
            },
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

    const question = await screen.findByTestId("chat-question-response");
    expect(question).toHaveTextContent("Which files and safety constraints should this destructive change use?");
    expect(question.closest("details.chat-tool-calls-group")).toBeNull();
    expect(screen.getAllByTestId("chat-question-response")).toHaveLength(1);
    expect(screen.getAllByTestId("chat-question-response-submit")).toHaveLength(1);
    expect(screen.getByTestId("chat-tool-calls")).toHaveTextContent("bash");
    expect(screen.getByTestId("chat-tool-calls")).not.toHaveTextContent("fn_ask_question");
    await user.click(screen.getByTestId("chat-question-response-option-q-0-opt-0"));
    await user.click(screen.getByTestId("chat-question-response-submit"));
    expect(mockStreamChatResponse).toHaveBeenLastCalledWith(
      "chat-planner",
      "> Q: Which files and safety constraints should this destructive change use?\nClarify scope",
      expect.any(Object),
      undefined,
      "project-1",
      { taskId: "FN-7310" },
    );
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

  it("keeps accepted silent planner streams waiting and reconciles late history", async () => {
    const user = userEvent.setup();
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        { id: "planner-user-slow", sessionId: "chat-planner", role: "user", content: "slow planner prompt", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "planner-assistant-late", sessionId: "chat-planner", role: "assistant", content: "late planner answer", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T00:00:01.000Z" },
      ],
    });
    let doneHandler: any;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      doneHandler = handlers.onDone;
      return { close: vi.fn(), isConnected: () => true };
    });

    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");
    await user.type(screen.getByLabelText("Message planner chat"), "slow planner prompt");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("slow planner prompt")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Timed out waiting for first response event")).not.toBeInTheDocument();
    expect(screen.queryByText("Planner chat failed to respond")).not.toBeInTheDocument();
    expect(document.querySelector(".chat-message--streaming")).toBeInTheDocument();

    act(() => doneHandler?.({ messageId: "planner-assistant-late" }));

    expect(await screen.findByText("late planner answer")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector(".chat-message--streaming")).not.toBeInTheDocument();
  });

  it("reattaches accepted silent planner streams without showing timeout errors", async () => {
    const inFlightSession = makePlannerSession({
      isGenerating: true,
      inFlightGeneration: {
        status: "generating",
        streamingText: "",
        streamingThinking: "",
        toolCalls: [],
        replayFromEventId: 9,
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: inFlightSession });
    mockFetchChatSession.mockResolvedValueOnce({ session: inFlightSession });
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({
        messages: [{ id: "planner-attached-late", sessionId: "chat-planner", role: "assistant", content: "attached late answer", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T00:00:01.000Z" }],
      });
    let attachedDoneHandler: any;
    mockAttachChatStream.mockImplementation((_sessionId, handlers) => {
      attachedDoneHandler = handlers.onDone;
      return { close: vi.fn(), isConnected: () => true };
    });

    renderPlannerChat();

    await waitFor(() => expect(mockAttachChatStream).toHaveBeenCalledWith("chat-planner", expect.any(Object), undefined, { lastEventId: 9 }));
    expect(screen.queryByText("Timed out waiting for first response event")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.querySelector(".chat-message--streaming")).toBeInTheDocument();

    act(() => attachedDoneHandler?.({ messageId: "planner-attached-late" }));

    expect(await screen.findByText("attached late answer")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps first planner message visible after accepted provider error and reconciles persisted history", async () => {
    const user = userEvent.setup();
    mockFetchTaskPlannerChatSession.mockResolvedValueOnce({ session: null });
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{ id: "planner-user-1", sessionId: "chat-planner", role: "user", content: "hello after 429", thinkingOutput: null, metadata: null, createdAt: "2026-07-01T00:00:00.000Z" }],
    });
    let errorHandler: any;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");
    await user.type(screen.getByLabelText("Message planner chat"), "hello after 429");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("hello after 429")).toBeInTheDocument();
    act(() => errorHandler?.({ summary: "Planner provider rate limit" }, { requestAccepted: true, receivedStreamEvent: true }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Planner provider rate limit");
    await waitFor(() => expect(screen.getAllByText("hello after 429")).toHaveLength(1));
    expect(mockFetchChatMessages).toHaveBeenCalledWith("chat-planner", { order: "asc" }, undefined);
  });

  it("rolls back planner optimistic message for pre-acceptance failures", async () => {
    const user = userEvent.setup();
    let errorHandler: any;
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      errorHandler = handlers.onError;
      return { close: vi.fn(), isConnected: () => true };
    });

    renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");
    await user.type(screen.getByLabelText("Message planner chat"), "blocked before persist");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("blocked before persist")).toBeInTheDocument();
    act(() => errorHandler?.("Request failed: 429", { requestAccepted: false, receivedStreamEvent: false }));

    await waitFor(() => expect(screen.queryByText("blocked before persist")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Request failed: 429");
  });

  it("ignores stale planner provider errors after the task scope changes", async () => {
    const user = userEvent.setup();
    let oldHandlers: any;
    mockStreamChatResponse.mockImplementationOnce((_sessionId, _content, handlers) => {
      oldHandlers = handlers;
      return { close: vi.fn(), isConnected: () => true };
    });
    const { rerender } = renderPlannerChat();
    await screen.findByTestId("task-planner-chat-empty");
    await user.type(screen.getByLabelText("Message planner chat"), "old task message");
    await user.click(screen.getByRole("button", { name: "Send" }));

    rerender(
      <TaskPlannerChatTab
        task={makeTask("FN-7312")}
        active
        planningModel={{ provider: "anthropic", modelId: "claude-plan" }}
        addToast={vi.fn()}
      />,
    );
    await screen.findByTestId("task-planner-chat-empty");
    act(() => oldHandlers.onError("Stale provider error", { requestAccepted: true, receivedStreamEvent: true }));

    expect(screen.queryByText("Stale provider error")).not.toBeInTheDocument();
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

  /*
   * FNXC:TaskDetailPlannerChat 2026-07-07-10:15:
   * Covers the FN-7639 edit-and-resend affordance across the enumerated surfaces: renders only
   * for persisted user rows, absent on assistant/optimistic/streaming rows and while sending,
   * truncates-then-resends in order, reloads truthful history and toasts on PATCH failure without
   * resending, preserves planner-question dedup across an edited answer, and refreshes task detail
   * with a discard notice (but no reversal) when the discarded range held a steering/refinement
   * confirmation.
   */
  describe("message edit affordance", () => {
    it("renders the edit affordance only for persisted user messages, hiding it for assistant, optimistic, and streaming rows", async () => {
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          { id: "m1", sessionId: "chat-planner", role: "user", content: "Hello", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:01:00.000Z" },
          { id: "m2", sessionId: "chat-planner", role: "assistant", content: "Hi there", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:02:00.000Z" },
        ],
      });

      renderPlannerChat();

      expect(await screen.findByTestId("chat-message-edit-m1")).toBeInTheDocument();
      expect(screen.queryByTestId("chat-message-edit-m2")).toBeNull();
      const assistantMessage = screen.getByTestId("chat-message-m2");
      expect(assistantMessage.querySelector("[aria-label='Edit message']")).toBeNull();
    });

    it("hides the edit affordance for an optimistic row and the streaming placeholder while sending", async () => {
      const deferredStream = createDeferred<void>();
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        void deferredStream.promise.then(() => {
          handlers.onText("partial");
        });
        return { close: vi.fn(), isConnected: () => true };
      });
      const user = userEvent.setup();
      renderPlannerChat();
      await screen.findByTestId("task-planner-chat-empty");

      await user.type(screen.getByLabelText("Message planner chat"), "In flight");
      await user.click(screen.getByRole("button", { name: "Send" }));

      const optimisticMessage = await screen.findByText("In flight");
      const optimisticRow = optimisticMessage.closest("[data-testid^='chat-message-']") as HTMLElement;
      expect(optimisticRow?.querySelector("[aria-label='Edit message']")).toBeNull();
      expect(screen.queryByLabelText("Edit message")).toBeNull();

      deferredStream.resolve();
    });

    it("truncates locally, calls editChatMessage, then resends through the normal streaming send in order", async () => {
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          { id: "m1", sessionId: "chat-planner", role: "user", content: "Hello", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:01:00.000Z" },
          { id: "m2", sessionId: "chat-planner", role: "assistant", content: "Hi there", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:02:00.000Z" },
        ],
      });
      const deferredEdit = createDeferred<{ retained: unknown[] }>();
      mockEditChatMessage.mockReturnValue(deferredEdit.promise);
      mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

      const user = userEvent.setup();
      renderPlannerChat();

      await screen.findByText("Hello");
      await user.click(screen.getByTestId("chat-message-edit-m1"));
      const editor = screen.getByTestId("chat-message-edit-editor-m1");
      const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello, edited" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(mockEditChatMessage).toHaveBeenCalledWith("chat-planner", "m1", "Hello, edited", undefined));
      // Optimistic truncation happens before the PATCH resolves: the edited row and its tail drop immediately.
      await waitFor(() => expect(screen.queryByText("Hello")).not.toBeInTheDocument());
      expect(screen.queryByText("Hi there")).not.toBeInTheDocument();
      expect(mockStreamChatResponse).not.toHaveBeenCalled();

      deferredEdit.resolve({ retained: [] });

      await waitFor(() => expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "chat-planner",
        "Hello, edited",
        expect.any(Object),
        undefined,
        undefined,
        { taskId: "FN-7310" },
      ));
      const editCallOrder = mockEditChatMessage.mock.invocationCallOrder[0];
      const sendCallOrder = mockStreamChatResponse.mock.invocationCallOrder[mockStreamChatResponse.mock.calls.length - 1];
      expect(editCallOrder).toBeLessThan(sendCallOrder);
    });

    it("reloads truthful history and toasts on PATCH failure without resending", async () => {
      mockFetchChatMessages.mockResolvedValueOnce({
        messages: [
          { id: "m1", sessionId: "chat-planner", role: "user", content: "Hello", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:01:00.000Z" },
        ],
      });
      mockFetchChatMessages.mockResolvedValueOnce({
        messages: [
          { id: "m1", sessionId: "chat-planner", role: "user", content: "Hello", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:01:00.000Z" },
        ],
      });
      mockEditChatMessage.mockRejectedValueOnce(new Error("edit failed"));
      const addToast = vi.fn();

      renderPlannerChat({ addToast });
      await screen.findByText("Hello");
      fireEvent.click(screen.getByTestId("chat-message-edit-m1"));
      const editor = screen.getByTestId("chat-message-edit-editor-m1");
      const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello, edited" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(addToast).toHaveBeenCalledWith("edit failed", "error"));
      await waitFor(() => expect(mockFetchChatMessages).toHaveBeenCalledTimes(2));
      expect(mockStreamChatResponse).not.toHaveBeenCalled();
      expect(await screen.findByText("Hello")).toBeInTheDocument();
    });

    it("hides the edit affordance on an already-persisted message while a new generation is streaming", async () => {
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          { id: "m1", sessionId: "chat-planner", role: "user", content: "Hello", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:01:00.000Z" },
        ],
      });
      const deferredStream = createDeferred<void>();
      mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
        void deferredStream.promise.then(() => handlers.onText("partial"));
        return { close: vi.fn(), isConnected: () => true };
      });
      const user = userEvent.setup();

      renderPlannerChat();
      await screen.findByTestId("chat-message-edit-m1");

      await user.type(screen.getByLabelText("Message planner chat"), "another message");
      await user.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => expect(screen.queryByTestId("chat-message-edit-m1")).toBeNull());
      expect(mockEditChatMessage).not.toHaveBeenCalled();

      deferredStream.resolve();
    });

    it("editing a planner-question answer does not corrupt question dedup", async () => {
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          plannerQuestionMessage("assistant-question", { question: "Pick a path", options: ["Conservative", "Aggressive"] }, "2026-06-30T00:01:00.000Z"),
          { id: "answer-1", sessionId: "chat-planner", role: "user", content: "> Q: Pick a path\nConservative", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:02:00.000Z" },
        ],
      });
      mockEditChatMessage.mockResolvedValue({ retained: [] });
      mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });

      renderPlannerChat();
      await screen.findByTestId("chat-question-response");
      expect(screen.getByTestId("chat-question-response")).toHaveClass("chat-question-response--answered");

      fireEvent.click(screen.getByTestId("chat-message-edit-answer-1"));
      const editor = screen.getByTestId("chat-message-edit-editor-answer-1");
      const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "> Q: Pick a path\nAggressive" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(mockEditChatMessage).toHaveBeenCalledWith("chat-planner", "answer-1", "> Q: Pick a path\nAggressive", undefined));
      // The prior answer is discarded and the edited content is resent as the new answer: the
      // question card stays a single card (no duplicate/corrupted dedup state) and reflects the
      // resent answer as the current answered state.
      await waitFor(() => expect(screen.getAllByTestId("chat-question-response")).toHaveLength(1));
      expect(screen.getByTestId("chat-question-response")).toHaveClass("chat-question-response--answered");
      expect(screen.getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("Aggressive");
    });

    it("refreshes task detail and surfaces a discard notice (without reverting) when the discarded range held a steering confirmation", async () => {
      mockFetchChatMessages.mockResolvedValue({
        messages: [
          { id: "m1", sessionId: "chat-planner", role: "user", content: "Please steer this", thinkingOutput: null, metadata: null, createdAt: "2026-06-30T00:01:00.000Z" },
          {
            id: "m2",
            sessionId: "chat-planner",
            role: "assistant",
            content: "Added that as steering.",
            thinkingOutput: null,
            metadata: {
              toolCalls: [{
                toolName: "fn_task_planner_add_steering",
                args: { text: "Please steer this" },
                isError: false,
                result: { details: { taskId: "FN-7310", text: "Please steer this", steeringComment: { id: "steer-1", text: "Please steer this" } } },
                status: "completed",
              }],
            },
            createdAt: "2026-06-30T00:02:00.000Z",
          },
        ],
      });
      mockEditChatMessage.mockResolvedValue({ retained: [] });
      mockStreamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
      const onTaskUpdated = vi.fn();
      const addToast = vi.fn();

      renderPlannerChat({ onTaskUpdated, addToast });
      await screen.findByTestId("task-planner-chat-steering-confirmation");

      fireEvent.click(screen.getByTestId("chat-message-edit-m1"));
      const editor = screen.getByTestId("chat-message-edit-editor-m1");
      const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Please steer this differently" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(mockFetchTaskDetail).toHaveBeenCalledWith("FN-7310", undefined));
      await waitFor(() => expect(onTaskUpdated).toHaveBeenCalled());
      await waitFor(() => expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("were not undone"),
        "info",
      ));
      // No reversal call is made for the already-applied steering comment.
      expect(mockFetchTaskDetail).not.toHaveBeenCalledWith("FN-7310", expect.anything(), expect.anything());
    });
  });

  describe("slash-command /steer", () => {
    it("shows /steer in the '/' menu, disabled with a hint, when the task's agent is not running", async () => {
      renderPlannerChat({ task: makeTask("FN-7310", { column: "todo" }) });
      const textarea = await screen.findByLabelText("Message planner chat");

      fireEvent.change(textarea, { target: { value: "/" } });

      const option = await screen.findByRole("option", { name: /steer/i });
      expect(option).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText(/no running agent/i)).toBeInTheDocument();
    });

    it("enables /steer in the menu when the task's agent is running (column === in-progress)", async () => {
      renderPlannerChat({ task: makeTask("FN-7310", { column: "in-progress" }) });
      const textarea = await screen.findByLabelText("Message planner chat");

      fireEvent.change(textarea, { target: { value: "/" } });

      const option = await screen.findByRole("option", { name: /steer/i });
      expect(option).toHaveAttribute("aria-disabled", "false");
    });

    it("submitting '/steer do X' on a running task calls addSteeringComment and does not start a planner-chat send", async () => {
      renderPlannerChat({ task: makeTask("FN-7310", { column: "in-progress" }), projectId: "proj-1" });
      const textarea = await screen.findByLabelText("Message planner chat");

      fireEvent.change(textarea, { target: { value: "/steer do X" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(mockAddSteeringComment).toHaveBeenCalledWith("FN-7310", "do X", "proj-1"));
      expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
      await waitFor(() => expect(textarea).toHaveValue(""));
    });

    it("submitting a normal message still starts a planner-chat send when the task's agent is running", async () => {
      renderPlannerChat({ task: makeTask("FN-7310", { column: "in-progress" }) });
      const textarea = await screen.findByLabelText("Message planner chat");

      fireEvent.change(textarea, { target: { value: "What is the status?" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await screen.findByText("What is the status?");
      expect(mockAddSteeringComment).not.toHaveBeenCalled();
    });

    it("submitting '/steer ...' with no running agent shows a hint and does not dispatch or send a message", async () => {
      const addToast = vi.fn();
      renderPlannerChat({ task: makeTask("FN-7310", { column: "todo" }), addToast });
      const textarea = await screen.findByLabelText("Message planner chat");

      fireEvent.change(textarea, { target: { value: "/steer do X" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringContaining("No running agent"), "warning"));
      expect(mockAddSteeringComment).not.toHaveBeenCalled();
      expect(mockEnsureTaskPlannerChatSession).not.toHaveBeenCalled();
      expect(textarea).toHaveValue("/steer do X");
    });

    it("does not dispatch when the trigger appears mid-message", async () => {
      renderPlannerChat({ task: makeTask("FN-7310", { column: "in-progress" }) });
      const textarea = await screen.findByLabelText("Message planner chat");

      fireEvent.change(textarea, { target: { value: "please /steer this" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await screen.findByText("please /steer this");
      expect(mockAddSteeringComment).not.toHaveBeenCalled();
    });
  });
});
