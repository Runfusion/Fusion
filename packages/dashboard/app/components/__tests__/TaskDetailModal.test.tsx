/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-7306 labels the stable internal `chat` tab as Activity and keeps it as the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Activity landing state.
*/
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
  mockConfirm,
  mockConfirmWithCheckbox,
  mockConfirmWithChoice,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";

vi.mock("../BranchGroupCard", () => ({
  BranchGroupCard: ({ groupId }: { groupId: string }) => {
    const [expanded, setExpanded] = React.useState(false);
    return (
      <div>
        Mock Branch Group {groupId}
        <button type="button" onClick={() => setExpanded(true)}>Mock expand branch group</button>
        {expanded && <span>Mock branch group expanded</span>}
      </div>
    );
  },
}));

setupTaskDetailModalHooks();

function renderSummarizeTitleModal(overrides: Parameters<typeof makeTask>[0] = {}, props: Partial<ComponentProps<typeof TaskDetailModal>> = {}) {
  const addToast = props.addToast ?? vi.fn();
  const onTaskUpdated = props.onTaskUpdated ?? vi.fn();
  const task = makeTask({
    id: "FN-6059",
    column: "triage" as any,
    title: "Existing title",
    description: "This task description should be summarized into a concise task title.",
    prompt: "# Prompt",
    ...overrides,
  });

  const result = render(
    <TaskDetailModal
      initialTab="definition"
      task={task}
      onClose={noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={addToast}
      onTaskUpdated={onTaskUpdated}
      {...props}
    />,
  );

  return { ...result, addToast, onTaskUpdated, task };
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

describe("TaskDetailModal planner Chat tab", () => {
  function renderTask(column: any = "in-progress", initialTab?: ComponentProps<typeof TaskDetailModal>["initialTab"]) {
    return render(
      <TaskDetailModal
        initialTab={initialTab}
        task={makeTask({ column })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
  }

  function tabLabels(): string[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(".detail-tabs .detail-tab"))
      .map((button) => button.textContent?.trim() ?? "");
  }

  it("renders Activity then Chat as the first task-detail conversation tabs for active tasks", async () => {
    const user = userEvent.setup();
    renderTask("in-progress");

    expect(tabLabels().slice(0, 2)).toEqual(["Activity", "Chat"]);
    expect(screen.getAllByRole("button", { name: "Chat" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");

    await user.click(screen.getByRole("button", { name: "Chat" }));

    expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
    expect(screen.getByRole("button", { name: "Activity" })).not.toHaveClass("detail-tab-active");
  });

  it("preserves Summary as the default for done tasks while keeping Activity then Chat order", () => {
    renderTask("done");

    expect(tabLabels().slice(0, 3)).toEqual(["Activity", "Chat", "Summary"]);
    expect(screen.getByRole("button", { name: "Summary" })).toHaveClass("detail-tab-active");
  });

  it("keeps explicit legacy chat deep links routed to Activity", () => {
    renderTask("in-progress", "chat");

    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expect(screen.getByRole("tab", { name: "Current" })).toHaveAttribute("aria-selected", "true");
  });

  it("routes explicit planner-chat requests to the new Chat tab", () => {
    renderTask("todo", "planner-chat");

    expect(screen.getByRole("button", { name: "Chat" })).toHaveClass("detail-tab-active");
    expect(screen.getByTestId("task-planner-chat-panel")).toBeInTheDocument();
  });
});

describe("TaskDetailModal summarize title action", () => {
  it("orders board detail header actions as edit, expand, then Back to board", () => {
    const onBackToBoard = vi.fn();
    const onPopOut = vi.fn();
    renderSummarizeTitleModal(
      { column: "todo" as any },
      { embedded: true, onBackToBoard, onPopOut },
    );

    const actions = document.querySelector(".modal-header-actions");
    expect(actions).not.toBeNull();
    const editButton = screen.getByRole("button", { name: "Edit task" });
    const popOutButton = screen.getByTestId("task-detail-pop-out");
    const backButton = screen.getByRole("button", { name: /back to board/i });

    // FNXC:TaskDetail 2026-06-22-18:32: Board task-detail action order is edit, expand/pop-out, then Back to board pinned far right.
    expect(Array.from(actions!.children)).toEqual([editButton, popOutButton, backButton]);
  });

  it("renders when the task is editable and has a description", () => {
    renderSummarizeTitleModal({ column: "todo" as any });

    expect(screen.getByTestId("summarize-title-btn")).toBeVisible();
    expect(screen.getByRole("button", { name: "Summarize as title" })).toBeEnabled();
  });

  it("hides while the task is in edit mode", async () => {
    const user = userEvent.setup();
    renderSummarizeTitleModal();

    expect(screen.getByTestId("summarize-title-btn")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit task" }));

    expect(screen.queryByTestId("summarize-title-btn")).not.toBeInTheDocument();
  });

  it("hides for non-editable columns", () => {
    renderSummarizeTitleModal({ column: "in-progress" as any });

    expect(screen.queryByTestId("summarize-title-btn")).not.toBeInTheDocument();
  });

  it("hides when the task has no description", () => {
    renderSummarizeTitleModal({ description: "" });

    expect(screen.queryByTestId("summarize-title-btn")).not.toBeInTheDocument();
  });

  it("summarizes the description, saves the generated title, and reports success", async () => {
    const user = userEvent.setup();
    const { summarizeTitle, updateTask } = await import("../../api");
    const addToast = vi.fn();
    const onTaskUpdated = vi.fn();
    const updatedTask = makeTask({ id: "FN-6059", column: "triage" as any, title: "Generated Title" });
    vi.mocked(summarizeTitle).mockReset();
    vi.mocked(updateTask).mockReset();
    vi.mocked(summarizeTitle).mockResolvedValueOnce("Generated Title");
    vi.mocked(updateTask).mockResolvedValueOnce(updatedTask);

    const { task } = renderSummarizeTitleModal({}, { addToast, onTaskUpdated, projectId: "project-1" });

    await user.click(screen.getByTestId("summarize-title-btn"));

    await waitFor(() => {
      expect(summarizeTitle).toHaveBeenCalledWith(task.description, undefined, undefined, "project-1");
      expect(updateTask).toHaveBeenCalledWith("FN-6059", { title: "Generated Title" }, "project-1");
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
      expect(addToast).toHaveBeenCalledWith("Title updated from description", "success");
    });
    expect(screen.getByTestId("sparkles-icon")).toBeInTheDocument();
    expect(screen.getByTestId("summarize-title-btn")).toBeEnabled();
  });

  it("shows a disabled loading state while summarization is pending", async () => {
    const user = userEvent.setup();
    const { summarizeTitle, updateTask } = await import("../../api");
    const deferred = createDeferred<string>();
    vi.mocked(summarizeTitle).mockReset();
    vi.mocked(updateTask).mockReset();
    vi.mocked(summarizeTitle).mockReturnValueOnce(deferred.promise);
    vi.mocked(updateTask).mockResolvedValueOnce(makeTask({ id: "FN-6059", title: "Generated Title" }));

    renderSummarizeTitleModal();
    await user.click(screen.getByTestId("summarize-title-btn"));

    expect(screen.getByTestId("summarize-title-btn")).toBeDisabled();
    expect(screen.getByTestId("loader2-icon")).toBeInTheDocument();

    deferred.resolve("Generated Title");
    await waitFor(() => expect(screen.getByTestId("summarize-title-btn")).toBeEnabled());
    expect(screen.getByTestId("sparkles-icon")).toBeInTheDocument();
  });

  it("shows an error toast and re-enables the button when summarization fails", async () => {
    const user = userEvent.setup();
    const { summarizeTitle, updateTask } = await import("../../api");
    const addToast = vi.fn();
    vi.mocked(summarizeTitle).mockReset();
    vi.mocked(updateTask).mockReset();
    vi.mocked(summarizeTitle).mockRejectedValueOnce(new Error("description is too short"));

    renderSummarizeTitleModal({}, { addToast });
    await user.click(screen.getByTestId("summarize-title-btn"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Failed to summarize title: description is too short", "error");
    });
    expect(updateTask).not.toHaveBeenCalled();
    expect(screen.getByTestId("summarize-title-btn")).toBeEnabled();
  });

  it("remains visible and accessible on mobile viewports", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    renderSummarizeTitleModal({ column: "todo" as any });

    const button = screen.getByTestId("summarize-title-btn");
    expect(button).toBeVisible();
    expect(button).toHaveAccessibleName("Summarize as title");
  });
});

describe("TaskDetailModal GitHub tracking CTA", () => {
  it("disables create tracking issue when task has no usable title", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          githubTracking: { enabled: true },
          title: "",
          description: "",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    const button = screen.getByRole("button", { name: "Create tracking issue" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Add a title or description so a tracking issue can be created.");
    expect(screen.getByText("Tracking issue will be created once this task has a title or description to summarize.")).toBeInTheDocument();
  });

  it("enables create tracking issue when task title is present", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          githubTracking: { enabled: true },
          title: "Real title",
          description: "",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    expect(screen.getByRole("button", { name: "Create tracking issue" })).toBeEnabled();
    expect(screen.queryByText("Tracking issue will be created once this task has a title or description to summarize.")).not.toBeInTheDocument();
  });

  it("enables create tracking issue when task description has a non-empty first line", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          githubTracking: { enabled: true },
          title: "",
          description: "A meaningful first line.\nMore text.",
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Expand GitHub tracking details" }));
    expect(screen.getByRole("button", { name: "Create tracking issue" })).toBeEnabled();
    expect(screen.queryByText("Tracking issue will be created once this task has a title or description to summarize.")).not.toBeInTheDocument();
  });
});

describe("TaskDetailModal Activity feed loading", () => {
  function renderActivityFeedModal(task: ReturnType<typeof makeTask> | Record<string, unknown>) {
    return render(
      <TaskDetailModal
        task={task as any}
        initialTab="logs"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
  }

  function makeSlimTask(overrides: Record<string, unknown> = {}) {
    const { prompt: _prompt, log: _log, steps: _steps, ...task } = makeTask({
      id: "FN-6040",
      description: "Slim task",
      ...overrides,
    });
    return task;
  }

  it("shows activity loading instead of empty state while slim task detail is pending", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockImplementationOnce(() => new Promise(() => {}));

    renderActivityFeedModal(makeSlimTask());

    expect(await screen.findByRole("status")).toHaveTextContent("Loading activity…");
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
  });

  it("shows activity loading when switching to Activity Feed before slim task detail resolves", async () => {
    const user = userEvent.setup();
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockImplementationOnce(() => new Promise(() => {}));

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeSlimTask() as any}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Activity" }));
    await user.click(screen.getByRole("tab", { name: "Feed" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Loading activity…");
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
  });

  it("shows empty activity only after loaded detail has no entries", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValueOnce(makeTask({ id: "FN-6040", prompt: "# Loaded", log: [] }));

    renderActivityFeedModal(makeSlimTask());

    expect(await screen.findByText("(no activity)")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders loaded activity entries newest first", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValueOnce(makeTask({
      id: "FN-6040",
      prompt: "# Loaded",
      log: [
        { timestamp: "2026-06-08T00:00:00.000Z", action: "older entry" },
        { timestamp: "2026-06-08T00:01:00.000Z", action: "newer entry" },
      ],
    }));

    const { container } = renderActivityFeedModal(makeSlimTask());

    await screen.findByText("newer entry");
    const actions = Array.from(container.querySelectorAll(".detail-log-action")).map((node) => node.textContent);
    expect(actions).toEqual(["newer entry", "older entry"]);
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
  });

  it("preserves truncated activity message after detail load", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValueOnce(makeTask({
      id: "FN-6040",
      prompt: "# Loaded",
      log: [{ timestamp: "2026-06-08T00:00:00.000Z", action: "kept entry" }],
      activityLogTruncatedCount: 25,
    } as any));

    renderActivityFeedModal(makeSlimTask());

    expect(await screen.findByText("Showing the most recent 1 activity entries.")).toBeInTheDocument();
    expect(screen.getByText("kept entry")).toBeInTheDocument();
  });
});

describe("TaskDetailModal Chat task merge", () => {
  it("exposes the steering composer only in Activity Current and posts through task updates", async () => {
    const user = userEvent.setup();
    const { addSteeringComment } = await import("../../api");
    const onTaskUpdated = vi.fn();
    const updatedTask = makeTask({
      id: "FN-7309",
      column: "in-progress" as any,
      steeringComments: [{ id: "steer-7309", text: "Please keep the current approach", author: "user", createdAt: "2026-06-30T21:00:00.000Z" }],
    });
    vi.mocked(addSteeringComment).mockReset();
    vi.mocked(addSteeringComment).mockResolvedValueOnce(updatedTask);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-7309", column: "in-progress" as any, log: [{ timestamp: "2026-06-30T20:00:00.000Z", action: "Started work" }] })}
        initialTab="chat"
        projectId="project-7309"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        onTaskUpdated={onTaskUpdated}
      />,
    );

    expect(screen.getByRole("tab", { name: "Current" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("form", { name: "Steering comment" })).toHaveLength(1);
    expect(screen.getByText("Send operational guidance to the active task through steering comments.")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Feed" }));
    expect(screen.queryByRole("form", { name: "Steering comment" })).not.toBeInTheDocument();
    expect(screen.getByText("Started work")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Raw Logs" }));
    expect(screen.queryByRole("form", { name: "Steering comment" })).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-log-viewer")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current" }));
    const input = screen.getByLabelText("Message active agent session");
    await user.type(input, "Please keep the current approach");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(addSteeringComment).toHaveBeenCalledWith("FN-7309", "Please keep the current approach", "project-7309");
      expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
    });
  });

  it("exposes the steering composer in embedded task detail without duplicating Feed or Raw Logs composers", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailContent
        task={makeTask({ id: "FN-7310", column: "todo" as any, steeringComments: undefined, log: [] })}
        projectId="project-7309"
        embedded
        onRequestClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getAllByRole("form", { name: "Steering comment" })).toHaveLength(1);
    expect(screen.getByText("No agent output yet. Live messages from Planner, Executor, Reviewer, and Merger agents will appear here.")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Feed" }));
    expect(screen.queryByRole("form", { name: "Steering comment" })).not.toBeInTheDocument();
    expect(screen.getByText("(no activity)")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Raw Logs" }));
    expect(screen.queryByRole("form", { name: "Steering comment" })).not.toBeInTheDocument();
  });

  it("forwards full-detail agent fields to Chat when a sparse parent task has undefined live fields", async () => {
    const user = userEvent.setup();
    const { fetchTaskDetail, addSteeringComment } = await import("../../api");
    const fullDetail = makeTask({
      id: "FN-6346",
      column: "in-progress" as any,
      status: "queued",
      assignedAgentId: "agent-full",
      checkedOutBy: "agent-full",
      prompt: "# Loaded detail",
    });
    const sparseParent = makeTask({
      id: "FN-6346",
      column: undefined as any,
      status: undefined,
      assignedAgentId: undefined,
      checkedOutBy: undefined,
    });
    delete (sparseParent as any).prompt;
    delete (sparseParent as any).log;
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValueOnce(fullDetail);
    vi.mocked(addSteeringComment).mockReset();
    vi.mocked(addSteeringComment).mockResolvedValueOnce(fullDetail);

    render(
      <TaskDetailModal
        task={sparseParent as any}
        initialTab="chat"
        projectId="project-1"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => expect(fetchTaskDetail).toHaveBeenCalledWith("FN-6346", "project-1"));
    const input = await screen.findByLabelText("Message active agent session");
    await waitFor(() => {
      expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
      expect(input).not.toBeDisabled();
    });
    await user.type(input, "Continue from the attached worktree agent");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(addSteeringComment).toHaveBeenCalledWith("FN-6346", "Continue from the attached worktree agent", "project-1");
    });
  });
});

describe("TaskDetailModal Raw Logs agent loading", () => {
  it("shows the Raw Logs loading indicator when entering the segment", async () => {
    const user = userEvent.setup();
    const { useAgentLogs } = await import("../../hooks/useAgentLogs");
    const mockUseAgentLogs = vi.mocked(useAgentLogs);
    mockUseAgentLogs.mockImplementation((_taskId, enabled) => ({
      entries: [],
      loading: enabled,
      clear: vi.fn(),
      loadMore: vi.fn(async () => {}),
      hasMore: false,
      total: null,
      loadingMore: false,
    }));

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ prompt: "# Loaded" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Activity" }));
    await user.click(screen.getByRole("tab", { name: "Feed" }));
    await user.click(screen.getByRole("tab", { name: "Raw Logs" }));

    expect(screen.getByText("Loading agent logs…")).toBeInTheDocument();
    expect(screen.queryByText("No agent output yet.")).not.toBeInTheDocument();

    mockUseAgentLogs.mockImplementation(() => ({ entries: [], loading: false, clear: vi.fn(), loadMore: vi.fn(async () => {}), hasMore: false, total: null, loadingMore: false }));
  });

  it("renders Raw Logs populated pagination state from the Activity segment", async () => {
    const user = userEvent.setup();
    const { useAgentLogs } = await import("../../hooks/useAgentLogs");
    const loadMore = vi.fn(async () => {});
    const mockUseAgentLogs = vi.mocked(useAgentLogs);
    mockUseAgentLogs.mockImplementation(() => ({
      entries: [
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-6040", text: "raw executor output", type: "text" as const, agent: "executor" },
        { timestamp: "2026-01-01T00:01:00Z", taskId: "FN-6040", text: "raw reviewer output", type: "text" as const, agent: "reviewer" },
      ],
      loading: false,
      clear: vi.fn(),
      loadMore,
      hasMore: true,
      total: 5,
      loadingMore: false,
    }));

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ id: "FN-6040", prompt: "# Loaded" })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Activity" }));
    await user.click(screen.getByRole("tab", { name: "Raw Logs" }));

    expect(screen.getByTestId("agent-log-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("agent-log-summary")).toHaveTextContent("Showing 2 of 5 entries");
    expect(screen.getByText("raw executor output")).toBeInTheDocument();
    expect(screen.getByText("raw reviewer output")).toBeInTheDocument();

    await user.click(screen.getByTestId("agent-log-load-more-button"));
    expect(loadMore).toHaveBeenCalledTimes(1);

    mockUseAgentLogs.mockImplementation(() => ({ entries: [], loading: false, clear: vi.fn(), loadMore: vi.fn(async () => {}), hasMore: false, total: null, loadingMore: false }));
  });
});

describe("TaskDetailModal branch group surfacing", () => {
  const branchContext = { groupId: "BG-1", source: "planning", assignmentMode: "shared" } as const;

  function renderTaskWithBranchContext(id: string) {
    return (
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ id, branchContext })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />
    );
  }

  it("renders branch group card when task has group context", () => {
    render(renderTaskWithBranchContext("FN-6041"));

    expect(screen.getByText("Mock Branch Group BG-1")).toBeInTheDocument();
  });

  it("remounts the branch group card when switching tasks inside the same group", async () => {
    const user = userEvent.setup();
    const { rerender } = render(renderTaskWithBranchContext("FN-6041"));

    await user.click(screen.getByRole("button", { name: "Mock expand branch group" }));
    expect(screen.getByText("Mock branch group expanded")).toBeInTheDocument();

    rerender(renderTaskWithBranchContext("FN-6042"));

    expect(screen.queryByText("Mock branch group expanded")).not.toBeInTheDocument();
    expect(screen.getByText("Mock Branch Group BG-1")).toBeInTheDocument();
  });
});

describe("TaskDetailModal delete affordance", () => {
  function dependencyConflictError(dependentIds: string[]) {
    const error = new Error("Task has dependents");
    (error as Error & { details: { code: string; dependentIds: string[] } }).details = {
      code: "TASK_HAS_DEPENDENTS",
      dependentIds,
    };
    return error;
  }

  function renderClosingTaskDetailModal(props: Partial<ComponentProps<typeof TaskDetailModal>> = {}) {
    const onClose = vi.fn();
    const Harness = () => {
      const [open, setOpen] = React.useState(true);
      if (!open) return null;
      return (
        <TaskDetailModal
          initialTab="definition"
          task={makeTask({ column: "triage", ...props.task })}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
          {...props}
        />
      );
    };

    const result = render(<Harness />);
    return { ...result, onClose };
  }

  it.each(["close", "back"] as const)("closes the %s-header task dialog before a confirmed delete settles", async (mobileHeaderMode) => {
    const user = userEvent.setup();
    const pendingDelete = createDeferred<ReturnType<typeof makeTask>>();
    const onDeleteTask = vi.fn(() => pendingDelete.promise);
    const { onClose } = renderClosingTaskDetailModal({
      mobileHeaderMode,
      onDeleteTask,
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { allowResurrection: false }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    pendingDelete.resolve(makeTask());
  });

  it("closes an embedded task-detail host before a confirmed delete settles", async () => {
    const user = userEvent.setup();
    const pendingDelete = createDeferred<ReturnType<typeof makeTask>>();
    const onDeleteTask = vi.fn(() => pendingDelete.promise);
    const onRequestClose = vi.fn();

    render(
      <TaskDetailContent
        initialTab="definition"
        embedded
        task={makeTask({ column: "triage" })}
        onRequestClose={onRequestClose}
        onMoveTask={noopMove}
        onDeleteTask={onDeleteTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith("FN-099", { allowResurrection: false }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    pendingDelete.resolve(makeTask());
  });

  it("closes embedded retry deletes before the force-delete retry settles", async () => {
    const user = userEvent.setup();
    const pendingRetry = createDeferred<ReturnType<typeof makeTask>>();
    const onDeleteTask = vi
      .fn()
      .mockRejectedValueOnce(dependencyConflictError(["FN-200"]))
      .mockReturnValueOnce(pendingRetry.promise);
    const onRequestClose = vi.fn();
    mockConfirm.mockResolvedValueOnce(true);

    render(
      <TaskDetailContent
        initialTab="definition"
        embedded
        task={makeTask({ column: "triage" })}
        onRequestClose={onRequestClose}
        onMoveTask={noopMove}
        onDeleteTask={onDeleteTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledTimes(2));
    expect(onDeleteTask).toHaveBeenNthCalledWith(2, "FN-099", {
      removeDependencyReferences: true,
      removeLineageReferences: true,
      githubIssueAction: undefined,
      allowResurrection: false,
    });
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    pendingRetry.resolve(makeTask());
  });

  it("keeps the dialog open when the delete confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn(async () => makeTask());
    mockConfirmWithCheckbox.mockResolvedValueOnce({ choice: "cancel", checkboxValue: false });
    const { onClose } = renderClosingTaskDetailModal({ onDeleteTask });

    await user.click(screen.getByRole("button", { name: "Delete task" }));

    expect(onDeleteTask).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("archives done task when Archive Instead is chosen", async () => {
    const user = userEvent.setup();
    const onArchiveTask = vi.fn(async () => makeTask({ column: "archived" }));
    const onDeleteTask = vi.fn(async () => makeTask());
    const onClose = vi.fn();
    mockConfirmWithChoice.mockResolvedValueOnce("tertiary");

    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ column: "done" })}
        onClose={onClose}
        onMoveTask={noopMove}
        onDeleteTask={onDeleteTask}
        onArchiveTask={onArchiveTask}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(mockConfirmWithChoice).toHaveBeenCalledWith(expect.objectContaining({ tertiaryLabel: "Archive Instead" }));
      expect(onArchiveTask).toHaveBeenCalledWith("FN-099");
      expect(onDeleteTask).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe("TaskDetailModal in-review stall diagnostics", () => {
  it("renders diagnostic row and jumps to highlighted activity entry", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          column: "in-review",
          inReviewStall: {
            code: "merge-blocker",
            reason: "Workflow pre-merge check failed",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
          log: [
            { timestamp: "2026-05-13T00:01:00.000Z", action: "In-review stall surfaced [merge-blocker]: Workflow pre-merge check failed" },
          ],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pull Request" }));

    expect(screen.getByText("Merge blocked by a pre-merge check")).toBeInTheDocument();
    expect(screen.getByText("Workflow pre-merge check failed")).toBeInTheDocument();
    expect(screen.getByText("Open the Review tab to see which step is blocking, then fix the failure or override the step.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View activity log" }));
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expect(screen.getByRole("tab", { name: "Feed" })).toHaveAttribute("aria-selected", "true");
    const highlighted = document.querySelector(".detail-log-entry--stall-highlight .detail-log-action");
    expect(highlighted?.textContent).toContain("In-review stall surfaced [merge-blocker]");
  });

  it("renders retry-exhausted badge label with counter", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          column: "in-review",
          mergeRetries: 3,
          inReviewStall: {
            code: "merge-retries-exhausted",
            reason: "Auto-merge retries exhausted",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pull Request" }));
    expect(screen.getByText("Retries exhausted 3/3")).toBeInTheDocument();
  });

  it("shows no-log copy when no matching stall entry exists", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          column: "in-review",
          inReviewStall: {
            code: "merge-blocker",
            reason: "Workflow pre-merge check failed",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
          log: [{ timestamp: "2026-05-13T00:01:00.000Z", action: "Something else" }],
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pull Request" }));
    expect(screen.getByText("No log entry yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View activity log" })).not.toBeInTheDocument();
  });

  it("FN-4570: hides merge-blocker diagnostic while task is actively merging", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({
          column: "in-review",
          status: "merging-fix",
          inReviewStall: {
            code: "merge-blocker",
            reason: "Workflow pre-merge check failed",
            observedAt: "2026-05-13T00:00:00.000Z",
          },
        })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Merge blocked by a pre-merge check")).not.toBeInTheDocument();
  });

  it.each([
    {
      label: "paused in-review task",
      task: makeTask({
        column: "in-review",
        paused: true,
        inReviewStall: {
          code: "merge-blocker",
          reason: "Workflow pre-merge check failed",
          observedAt: "2026-05-13T00:00:00.000Z",
        },
      }),
    },
    {
      label: "non in-review task",
      task: makeTask({
        column: "in-progress",
        inReviewStall: {
          code: "merge-blocker",
          reason: "Workflow pre-merge check failed",
          observedAt: "2026-05-13T00:00:00.000Z",
        },
      }),
    },
  ])("does not render diagnostic row for $label", ({ task }) => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={task}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.queryByText("Merge blocked by a pre-merge check")).not.toBeInTheDocument();
  });
});
