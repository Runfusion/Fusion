/*
FNXC:TaskDetailTabs 2026-06-17-08:20:
FN-6532 made Chat the default TaskDetailModal tab. Tests that assert Definition-only sections must opt into `initialTab="definition"` so they verify the intended surface instead of the Chat landing state.
*/
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
  mockConfirmWithChoice,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

vi.mock("../BranchGroupCard", () => ({
  BranchGroupCard: ({ groupId }: { groupId: string }) => <div>Mock Branch Group {groupId}</div>,
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

describe("TaskDetailModal summarize title action", () => {
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

describe("TaskDetailModal Logs activity loading", () => {
  function renderLogsModal(task: ReturnType<typeof makeTask> | Record<string, unknown>) {
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

    renderLogsModal(makeSlimTask());

    expect(await screen.findByRole("status")).toHaveTextContent("Loading activity…");
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
  });

  it("shows activity loading when switching to Logs before slim task detail resolves", async () => {
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

    await user.click(screen.getByRole("button", { name: "Logs" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Loading activity…");
    expect(screen.queryByText("(no activity)")).not.toBeInTheDocument();
  });

  it("shows empty activity only after loaded detail has no entries", async () => {
    const { fetchTaskDetail } = await import("../../api");
    vi.mocked(fetchTaskDetail).mockReset();
    vi.mocked(fetchTaskDetail).mockResolvedValueOnce(makeTask({ id: "FN-6040", prompt: "# Loaded", log: [] }));

    renderLogsModal(makeSlimTask());

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

    const { container } = renderLogsModal(makeSlimTask());

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

    renderLogsModal(makeSlimTask());

    expect(await screen.findByText("Showing the most recent 1 activity entries.")).toBeInTheDocument();
    expect(screen.getByText("kept entry")).toBeInTheDocument();
  });
});

describe("TaskDetailModal Chat task merge", () => {
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

describe("TaskDetailModal Logs agent loading", () => {
  it("shows the Agent Log loading indicator when entering the subview", async () => {
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

    await user.click(screen.getByRole("button", { name: "Logs" }));
    await user.click(screen.getByRole("button", { name: "Agent Log" }));

    expect(screen.getByText("Loading agent logs…")).toBeInTheDocument();
    expect(screen.queryByText("No agent output yet.")).not.toBeInTheDocument();

    mockUseAgentLogs.mockImplementation(() => ({ entries: [], loading: false, clear: vi.fn(), loadMore: vi.fn(async () => {}), hasMore: false, total: null, loadingMore: false }));
  });
});

describe("TaskDetailModal branch group surfacing", () => {
  it("renders branch group card when task has group context", () => {
    render(
      <TaskDetailModal
        initialTab="definition"
        task={makeTask({ branchContext: { groupId: "BG-1", source: "planning", assignmentMode: "shared" } })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Mock Branch Group BG-1")).toBeInTheDocument();
  });
});

describe("TaskDetailModal delete affordance", () => {
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
    expect(screen.getByRole("button", { name: "Logs" })).toHaveClass("detail-tab-active");
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("log-subview-btn-active");
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
