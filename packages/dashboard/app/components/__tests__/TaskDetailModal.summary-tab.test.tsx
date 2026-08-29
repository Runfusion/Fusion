import { Profiler, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Column, ModelPricingOverrides, Task, TaskDetail, TaskTokenUsage } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  readDashboardStylesSource,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";
import { TaskSummaryTab } from "../TaskSummaryTab";

setupTaskDetailModalHooks();

function expectButtonActive(button: HTMLElement): void {
  expect(button.classList.contains("detail-tab-active")).toBe(true);
}

function tokenUsage(overrides: Partial<TaskTokenUsage> = {}): TaskTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    firstUsedAt: "2026-01-01T00:00:00Z",
    lastUsedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function doneTask(overrides: Partial<TaskDetail> = {}) {
  return makeTask({
    column: "done",
    summary: "Completed **summary** with `packages/dashboard/app/components/TaskDetailModal.tsx`.",
    modifiedFiles: ["packages/dashboard/app/components/TaskDetailModal.tsx"],
    mergeDetails: {
      commitSha: "abcdef1234567890",
      filesChanged: 2,
      insertions: 12,
      deletions: 3,
      landedFiles: [
        "packages/dashboard/app/components/TaskDetailModal.tsx",
        "packages/dashboard/app/components/TaskSummaryTab.tsx",
      ],
    },
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Skipped optional", status: "skipped" },
      { name: "Still pending", status: "pending" },
    ],
    workflowStepResults: [
      { workflowStepId: "WS-1", workflowStepName: "Code Review", status: "passed" },
      { workflowStepId: "WS-2", workflowStepName: "Advisory Check", status: "advisory_failure" },
    ],
    retrySummary: {
      stuckKill: 0,
      recovery: 0,
      taskDone: 0,
      worktreeSession: 0,
      workflowStep: 1,
      verification: 0,
      postReviewFix: 0,
      mergeConflict: 0,
      branchConflict: 0,
      reviewerContext: 0,
      reviewerFallback: 0,
      total: 1,
    },
    ...overrides,
  });
}

function slimDoneTask(overrides: Partial<TaskDetail> = {}): Task {
  const { prompt: _prompt, ...task } = doneTask(overrides);
  return task;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeCommitRecorder() {
  const commits: { hasRecommendationsButton: boolean; planActive: boolean }[] = [];
  const wrap = (children: ReactNode) => (
    <Profiler id="task-detail" onRender={() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>(".detail-tabs .detail-tab"));
      commits.push({
        hasRecommendationsButton: buttons.some((button) => button.textContent?.trim() === "Recommendations"),
        planActive: buttons.some((button) => button.textContent?.trim() === "Plan" && button.classList.contains("detail-tab-active")),
      });
    }}>
      {children}
    </Profiler>
  );
  return { commits, wrap };
}

function detailModal(task: Task | TaskDetail, initialTab?: "recommendations") {
  return (
    <TaskDetailModal
      task={task}
      initialTab={initialTab}
      onClose={noop}
      onMoveTask={noopMove}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />
  );
}

describe("TaskDetailModal Summary tab", () => {
  it("lands done tasks on Summary by default while keeping Activity first and accessible", () => {
    const { container } = render(
      <TaskDetailModal
        task={doneTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(document.querySelector(".detail-tabs")?.firstElementChild?.textContent).toBe("Activity");
    const summaryButton = screen.getByRole("button", { name: "Summary" });
    expectButtonActive(summaryButton);
    /*
    FNXC:TaskDetailTabs 2026-07-07-09:25:
    The planner-chat ("Chat") tab now renders unconditionally in the task-detail tab strip (both taskDetailChatFirst branches), so done tasks expose Activity, Chat, Summary, ... (see TaskDetailModal.definition-actions.test.tsx). Done tasks still land on Summary by default; Chat is present but not active.
    */
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByText("Completion summary")).toBeTruthy();
    expect(screen.getByText("summary")).toBeTruthy();
    expect(screen.getByText("What changed")).toBeTruthy();
    expect(screen.getByText("packages/dashboard/app/components/TaskSummaryTab.tsx")).toBeTruthy();
    expect(screen.getByText("Work done by agents")).toBeTruthy();
    expect(screen.getByText("Preflight")).toBeTruthy();
    expect(screen.getByText("Code Review")).toBeTruthy();
    expect(screen.getByText("Agents retried this task 1 time.")).toBeTruthy();

    const activityButton = screen.getByRole("button", { name: "Activity" });
    fireEvent.click(activityButton);
    expectButtonActive(activityButton);
    expect(screen.queryByText("Completion summary")).toBeNull();
    expect(document.querySelector(".detail-section--chat [data-testid='task-chat-tab']")).toBeTruthy();
  });

  it("honors explicit initialTab=\"chat\" for done tasks", () => {
    render(
      <TaskDetailModal
        task={doneTask()}
        initialTab="chat"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expectButtonActive(screen.getByRole("button", { name: "Activity" }));
    expect(screen.queryByText("Completion summary")).toBeNull();
  });

  it("honors explicit non-chat tabs for done tasks", () => {
    const changesRender = render(
      <TaskDetailModal
        task={doneTask()}
        initialTab="changes"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expectButtonActive(screen.getByRole("button", { name: "Changes" }));
    expect(screen.queryByText("Completion summary")).toBeNull();
    changesRender.unmount();

    render(
      <TaskDetailModal
        task={doneTask({ enabledWorkflowSteps: ["WS-1"] })}
        initialTab="workflow"
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expectButtonActive(screen.getByRole("button", { name: "Workflow" }));
    expect(screen.queryByText("Completion summary")).toBeNull();
  });

  it("does not render Summary for non-done columns and still defaults to Activity", () => {
    for (const column of ["in-progress", "in-review", "todo"] as Column[]) {
      const rendered = render(
        <TaskDetailModal
          task={makeTask({ column })}
          onClose={noop}
          onMoveTask={noopMove}
          onDeleteTask={noopDelete}
          onMergeTask={noopMerge}
          onOpenDetail={noopOpenDetail}
          addToast={noop}
        />,
      );
      expect(screen.queryByRole("button", { name: "Summary" })).toBeNull();
      expectButtonActive(screen.getByRole("button", { name: "Activity" }));
      rendered.unmount();
    }
  });

  it("hides Recommendations unless a completed task carries recommendations", async () => {
    const empty = render(detailModal(doneTask({ recommendations: undefined }), "recommendations"));
    const emptyTabs = document.querySelector(".detail-tabs");
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
    expect(screen.queryByText("No recommendations were produced for this task.")).toBeNull();
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Plan" })));
    expect(Array.from(emptyTabs?.querySelectorAll<HTMLElement>(".detail-tab") ?? []).every((tab) => tab.textContent?.trim())).toBe(true);
    expect(emptyTabs?.querySelector('[aria-label*="Recommendations"], [title*="Recommendations"]')).toBeNull();
    const emptyButtonCount = emptyTabs?.querySelectorAll("button").length;
    empty.unmount();

    const noRecords = render(detailModal(doneTask({ recommendations: [] }), "recommendations"));
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Plan" })));
    noRecords.unmount();

    const recommendation = { id: "REC-1", title: "Review cache policy", description: "Check retention.", category: "improvement" as const };
    const populated = render(detailModal(doneTask({ recommendations: [recommendation] }), "recommendations"));
    const recommendations = screen.getByRole("button", { name: "Recommendations" });
    expectButtonActive(recommendations);
    expect(recommendations.classList.contains("detail-tab")).toBe(true);
    expect(document.querySelector(".detail-tabs")?.contains(recommendations)).toBe(true);
    expect(document.querySelector(".detail-tabs")?.querySelectorAll("button").length).toBe((emptyButtonCount ?? 0) + 1);
    expect(screen.getByText("Review cache policy")).toBeInTheDocument();
    populated.unmount();

    render(detailModal(doneTask({ recommendations: [{ ...recommendation, id: "REC-2", createdTaskId: "FN-123" }] }), "recommendations"));
    expect(screen.getByRole("button", { name: "Recommendations" })).toBeInTheDocument();
  });

  it("requires completion before showing Recommendations", () => {
    render(detailModal(makeTask({ column: "todo", recommendations: [{ id: "REC-3", title: "Follow up", description: "", category: "feature" }] }), "recommendations"));
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
  });

  it("keeps a Recommendations deep link selected until this slim task resolves", async () => {
    const pending = deferred<TaskDetail>();
    const fetchTaskDetail = vi.mocked((await import("../../api")).fetchTaskDetail);
    fetchTaskDetail.mockReset();
    fetchTaskDetail.mockReturnValue(pending.promise);
    const task = slimDoneTask({ id: "FN-pending" });
    render(detailModal(task, "recommendations"));

    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
    expect(screen.getByRole("button", { name: "Plan" })).not.toHaveClass("detail-tab-active");
    await act(async () => {
      pending.resolve(doneTask({ id: task.id, recommendations: [{ id: "REC-pending", title: "Resolved recommendation", description: "", category: "feature" }] }));
    });
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Recommendations" })));
    expect(screen.getByText("Resolved recommendation")).toBeInTheDocument();
  });

  it("reconciles a Recommendations deep link to Plan when pending detail resolves empty", async () => {
    const pending = deferred<TaskDetail>();
    const fetchTaskDetail = vi.mocked((await import("../../api")).fetchTaskDetail);
    fetchTaskDetail.mockReset();
    fetchTaskDetail.mockReturnValue(pending.promise);
    const task = slimDoneTask({ id: "FN-pending-empty" });
    render(detailModal(task, "recommendations"));

    expect(screen.getByRole("button", { name: "Plan" })).not.toHaveClass("detail-tab-active");
    await act(async () => {
      pending.resolve(doneTask({ id: task.id, recommendations: [] }));
    });
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Plan" })));
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
  });

  it("does not redirect a Recommendations deep link after detail fetch rejection", async () => {
    const fetchTaskDetail = vi.mocked((await import("../../api")).fetchTaskDetail);
    fetchTaskDetail.mockReset();
    fetchTaskDetail.mockRejectedValue(new Error("unavailable"));
    render(detailModal(slimDoneTask({ id: "FN-rejected" }), "recommendations"));

    await waitFor(() => expect(fetchTaskDetail).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Plan" })).not.toHaveClass("detail-tab-active"));
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
  });

  it("never reads a prior task snapshot during a slim task switch", async () => {
    const pending = deferred<TaskDetail>();
    const fetchTaskDetail = vi.mocked((await import("../../api")).fetchTaskDetail);
    fetchTaskDetail.mockReset();
    fetchTaskDetail.mockReturnValue(pending.promise);
    const recorder = makeCommitRecorder();
    const taskA = doneTask({ id: "FN-A", recommendations: [{ id: "REC-A", title: "Recommendation A", description: "", category: "bug" }] });
    const view = render(recorder.wrap(detailModal(taskA, "recommendations")));
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Recommendations" })));

    const priorCommitCount = recorder.commits.length;
    const taskB = slimDoneTask({ id: "FN-B", recommendations: undefined });
    view.rerender(recorder.wrap(detailModal(taskB, "recommendations")));
    expect(recorder.commits.length).toBeGreaterThan(priorCommitCount);
    const switchCommits = recorder.commits.slice(priorCommitCount);
    expect(switchCommits.every((commit) => !commit.hasRecommendationsButton)).toBe(true);
    expect(switchCommits.every((commit) => !commit.planActive)).toBe(true);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull());
    expect(screen.getByRole("button", { name: "Plan" })).not.toHaveClass("detail-tab-active");

    await act(async () => {
      pending.resolve(doneTask({ id: taskB.id, recommendations: [{ id: "REC-B", title: "Recommendation B", description: "", category: "improvement" }] }));
    });
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Recommendations" })));
    expect(screen.getByText("Recommendation B")).toBeInTheDocument();
    expect(screen.queryByText("Recommendation A")).toBeNull();
  });

  it("reconciles a task-switched Recommendations deep link when the new detail resolves empty", async () => {
    const pending = deferred<TaskDetail>();
    const fetchTaskDetail = vi.mocked((await import("../../api")).fetchTaskDetail);
    fetchTaskDetail.mockReset();
    fetchTaskDetail.mockReturnValue(pending.promise);
    const taskA = doneTask({ id: "FN-switch-A", recommendations: [{ id: "REC-switch-A", title: "Prior recommendation", description: "", category: "bug" }] });
    const view = render(detailModal(taskA, "recommendations"));
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Recommendations" })));

    const taskB = slimDoneTask({ id: "FN-switch-B", recommendations: undefined });
    view.rerender(detailModal(taskB, "recommendations"));
    await act(async () => {
      pending.resolve(doneTask({ id: taskB.id, recommendations: [] }));
    });
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Plan" })));
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
  });

  it("does not fetch or redirect Recommendations while an embedded host is hidden", async () => {
    const pending = deferred<TaskDetail>();
    const fetchTaskDetail = vi.mocked((await import("../../api")).fetchTaskDetail);
    fetchTaskDetail.mockReset();
    fetchTaskDetail.mockReturnValue(pending.promise);
    const task = slimDoneTask({ id: "FN-hidden" });
    const props = {
      task,
      embedded: true,
      initialTab: "recommendations" as const,
      onMoveTask: noopMove,
      onDeleteTask: noopDelete,
      onMergeTask: noopMerge,
      onOpenDetail: noopOpenDetail,
      addToast: noop,
    };
    const view = render(<TaskDetailContent {...props} active={false} />);
    expect(fetchTaskDetail).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Plan" })).not.toHaveClass("detail-tab-active");

    view.rerender(<TaskDetailContent {...props} active />);
    await waitFor(() => expect(fetchTaskDetail).toHaveBeenCalledTimes(1));
    await act(async () => {
      pending.resolve(doneTask({ id: task.id, recommendations: [] }));
    });
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Plan" })));
  });

  it("restores Recommendations when a hidden embedded host resolves populated detail", async () => {
    const pending = deferred<TaskDetail>();
    const fetchTaskDetail = vi.mocked((await import("../../api")).fetchTaskDetail);
    fetchTaskDetail.mockReset();
    fetchTaskDetail.mockReturnValue(pending.promise);
    const task = slimDoneTask({ id: "FN-hidden-populated" });
    const props = {
      task,
      embedded: true,
      initialTab: "recommendations" as const,
      onMoveTask: noopMove,
      onDeleteTask: noopDelete,
      onMergeTask: noopMerge,
      onOpenDetail: noopOpenDetail,
      addToast: noop,
    };
    const view = render(<TaskDetailContent {...props} active={false} />);
    expect(fetchTaskDetail).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Plan" })).not.toHaveClass("detail-tab-active");

    view.rerender(<TaskDetailContent {...props} active />);
    await act(async () => {
      pending.resolve(doneTask({ id: task.id, recommendations: [{ id: "REC-hidden", title: "Restored recommendation", description: "", category: "feature" }] }));
    });
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Recommendations" })));
    expect(screen.getByText("Restored recommendation")).toBeInTheDocument();
  });

  it("gates the shared Recommendations tab strip entry at mobile width", () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const empty = render(detailModal(doneTask({ recommendations: [] })));
    expect(document.querySelector(".detail-tabs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
    empty.unmount();

    render(detailModal(doneTask({ recommendations: [{ id: "REC-mobile", title: "Mobile recommendation", description: "", category: "feature" }] }), "recommendations"));
    const recommendationButton = screen.getByRole("button", { name: "Recommendations" });
    expectButtonActive(recommendationButton);
    expect(document.querySelector(".detail-tabs")?.contains(recommendationButton)).toBe(true);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  });

  it("omits the token-cost section when token usage is absent", () => {
    render(<TaskSummaryTab task={doneTask({ tokenUsage: undefined })} />);

    expect(screen.queryByText("Token usage & cost")).toBeNull();
    expect(screen.queryByTestId("task-summary-token-cost-section")).toBeNull();
  });

  it("keeps populated token costs in a locally scrollable real table across data states", () => {
    const twoModelUsage = tokenUsage({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      perModel: [
        {
          modelProvider: "anthropic",
          modelId: "claude-sonnet-4-6",
          inputTokens: 200,
          outputTokens: 100,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 300,
          firstUsedAt: "2026-01-01T00:00:00Z",
          lastUsedAt: "2026-01-01T00:00:00Z",
        },
        {
          modelProvider: "openai",
          modelId: "gpt-4o-mini",
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 150,
          firstUsedAt: "2026-01-01T00:00:00Z",
          lastUsedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const view = render(<TaskSummaryTab task={doneTask({ tokenUsage: twoModelUsage })} />);
    const section = screen.getByTestId("task-summary-token-cost-section");
    const wrapper = section.querySelector<HTMLElement>(".task-summary-token-table-wrap");
    const table = wrapper?.querySelector<HTMLTableElement>("table.task-summary-token-table");

    expect(wrapper).toBeTruthy();
    expect(table).toBeTruthy();
    expect(table?.tagName).toBe("TABLE");
    expect(wrapper?.contains(table ?? null)).toBe(true);
    for (const heading of ["Model", "Input", "Output", "Cached", "Total", "Cost"]) {
      expect(within(table!).getByRole("columnheader", { name: heading })).toBeTruthy();
    }
    expect(table?.querySelector("tfoot")).toBeTruthy();
    expect(screen.getAllByTestId("task-summary-token-row")).toHaveLength(2);

    const css = readDashboardStylesSource();
    expect(css).toMatch(/\.task-summary-tab\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(css).toMatch(/\.task-summary-section\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(css).toMatch(/\.task-summary-token-table-wrap\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);

    view.rerender(<TaskSummaryTab task={doneTask({ tokenUsage: { ...twoModelUsage, perModel: [twoModelUsage.perModel![0]] } })} />);
    expect(screen.getAllByTestId("task-summary-token-row")).toHaveLength(1);
    expect(screen.getByTestId("task-summary-token-cost-section").querySelector("table.task-summary-token-table")).toBeTruthy();

    view.rerender(<TaskSummaryTab task={doneTask({ tokenUsage: undefined })} />);
    expect(screen.queryByTestId("task-summary-token-cost-section")).toBeNull();
  });

  it("renders multi-model token counts with priced, unpriced, and unavailable total cost states", () => {
    render(
      <TaskSummaryTab
        task={doneTask({
          tokenUsage: tokenUsage({
            inputTokens: 1_000_100,
            outputTokens: 1_000_000,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2_000_100,
            perModel: [
              {
                modelProvider: "anthropic",
                modelId: "claude-sonnet-4-6",
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 2_000_000,
                firstUsedAt: "2026-01-01T00:00:00Z",
                lastUsedAt: "2026-01-01T00:00:00Z",
              },
              {
                modelProvider: "unknown-provider",
                modelId: "unpriced-model",
                inputTokens: 100,
                outputTokens: 0,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 100,
                firstUsedAt: "2026-01-01T00:00:00Z",
                lastUsedAt: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        })}
      />,
    );

    const rows = screen.getAllByTestId("task-summary-token-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("claude-sonnet-4-6")).toBeTruthy();
    expect(within(rows[0]).getAllByText("1,000,000")).toHaveLength(2);
    expect(within(rows[0]).getByText("2,000,000")).toBeTruthy();
    expect(within(rows[0]).getByText("$18.00")).toBeTruthy();
    expect(within(rows[0]).getByTestId("anthropic-icon")).toBeTruthy();
    expect(within(rows[1]).getByText("unpriced-model")).toBeTruthy();
    expect(within(rows[1]).getByText("—")).toBeTruthy();
    expect(screen.getByText("Total cost")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("renders a numeric task total when all contributing models are priced", () => {
    render(
      <TaskSummaryTab
        task={doneTask({
          tokenUsage: tokenUsage({
            inputTokens: 2_000_000,
            outputTokens: 2_000_000,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 4_000_000,
            perModel: [
              {
                modelProvider: "anthropic",
                modelId: "claude-sonnet-4-6",
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 2_000_000,
                firstUsedAt: "2026-01-01T00:00:00Z",
                lastUsedAt: "2026-01-01T00:00:00Z",
              },
              {
                modelProvider: "openai",
                modelId: "gpt-4o-mini",
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 2_000_000,
                firstUsedAt: "2026-01-01T00:00:00Z",
                lastUsedAt: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        })}
      />,
    );

    expect(screen.getByText("$18.00")).toBeTruthy();
    expect(screen.getByText("$0.75")).toBeTruthy();
    expect(screen.getByText("$18.75")).toBeTruthy();
  });

  it("synthesizes a single aggregate row when per-model buckets are absent", () => {
    render(
      <TaskSummaryTab
        task={doneTask({
          tokenUsage: tokenUsage({
            inputTokens: 1234,
            outputTokens: 5678,
            cachedTokens: 90,
            cacheWriteTokens: 12,
            totalTokens: 7014,
            perModel: [],
          }),
        })}
      />,
    );

    const rows = screen.getAllByTestId("task-summary-token-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("(unknown)")).toBeTruthy();
    expect(within(rows[0]).getByText("1,234")).toBeTruthy();
    expect(within(rows[0]).getByText("5,678")).toBeTruthy();
    expect(within(rows[0]).getByText("90")).toBeTruthy();
    expect(within(rows[0]).getByText("7,014")).toBeTruthy();
  });

  it("renders a dollar amount for the current runtime token-usage model snapshot", () => {
    render(
      <TaskSummaryTab
        task={doneTask({
          tokenUsage: tokenUsage({
            inputTokens: 1_000_000,
            outputTokens: 200_000,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 1_200_000,
            modelProvider: "anthropic",
            modelId: "claude-sonnet-5",
            perModel: [
              {
                modelProvider: "anthropic",
                modelId: "claude-sonnet-5",
                inputTokens: 1_000_000,
                outputTokens: 200_000,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 1_200_000,
                firstUsedAt: "2026-07-10T15:22:50.837Z",
                lastUsedAt: "2026-07-10T15:22:50.837Z",
              },
            ],
          }),
        })}
      />,
    );

    expect(screen.getAllByText("$4.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("claude-sonnet-5")).toBeTruthy();
  });

  it("applies pricing overrides passed into the summary component", () => {
    const pricingOverrides: ModelPricingOverrides = {
      "custom:override-model": {
        inputPer1M: 2,
        outputPer1M: 3,
        cacheReadPer1M: 4,
        cacheWritePer1M: 5,
        source: "test override",
      },
    };

    render(
      <TaskSummaryTab
        pricingOverrides={pricingOverrides}
        task={doneTask({
          tokenUsage: tokenUsage({
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cachedTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
            totalTokens: 4_000_000,
            perModel: [
              {
                modelProvider: "custom",
                modelId: "override-model",
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cachedTokens: 1_000_000,
                cacheWriteTokens: 1_000_000,
                totalTokens: 4_000_000,
                firstUsedAt: "2026-01-01T00:00:00Z",
                lastUsedAt: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        })}
      />,
    );

    expect(screen.getAllByText("$14.00").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the shared token-cost section through embedded and full detail content entrypoints", () => {
    const task = doneTask({
      tokenUsage: tokenUsage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2_000_000,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-6",
      }),
    });

    const full = render(
      <TaskDetailContent
        task={task}
        initialTab="summary"
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.getByText("Token usage & cost")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    full.unmount();

    render(
      <TaskDetailContent
        task={task}
        embedded
        initialTab="summary"
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.getByText("Token usage & cost")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
  });

  it("keeps token-cost summary styling responsive without hardcoded colors", () => {
    const css = readDashboardStylesSource();
    const tokenTableRule = css.match(/\.task-summary-token-table\s*\{[^}]*\}/)?.[0] ?? "";
    const modelNameRule = css.match(/\.task-summary-model-label span:last-child\s*\{[^}]*\}/)?.[0] ?? "";
    const tokenTableSectionStart = css.indexOf(".task-summary-token-table-wrap {");
    const tokenTableSectionEnd = css.indexOf(".detail-section--spec {", tokenTableSectionStart);
    expect(tokenTableSectionStart).toBeGreaterThanOrEqual(0);
    expect(tokenTableSectionEnd).toBeGreaterThan(tokenTableSectionStart);
    const tokenTableSection = css.slice(tokenTableSectionStart, tokenTableSectionEnd);
    const mobileTokenBlock = tokenTableSection.slice(tokenTableSection.indexOf("@media (max-width: 768px)"));

    expect(css).toContain(".task-summary-token-table");
    expect(tokenTableRule).toMatch(/min-width:\s*calc\(var\(--space-2xl\)\s*\*\s*16\)/);
    expect(modelNameRule).toContain("overflow-wrap: normal");
    expect(modelNameRule).toContain("word-break: normal");
    expect(modelNameRule).not.toContain("overflow-wrap: anywhere");
    expect(css).toContain("@media (max-width: 768px)");
    expect(mobileTokenBlock).not.toContain(".task-summary-token-table-wrap");
    expect(mobileTokenBlock).not.toContain("overflow-x: visible");
    expect(mobileTokenBlock).not.toContain(".task-summary-token-table td::before");
    expect(tokenTableRule).not.toContain("min-width: 0");
    expect(css).toContain("var(--color-warning)");
    expect(css).not.toMatch(/task-summary-token[^{}]*#[0-9a-fA-F]{3,8}/);
  });

  it("renders every Merge Details data state inside the done-only Summary tab", () => {
    const linkedTask = doneTask({
      mergeDetails: {
        commitSha: "abcdef1234567890",
        mergeConfirmed: true,
        prNumber: 42,
        mergedAt: "2026-07-29T12:00:00Z",
        mergeCommitMessage: "feat: land summary merge details",
      },
      prInfo: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        status: "merged",
        title: "Task",
        headBranch: "fusion/fn-8197",
        baseBranch: "main",
        commentCount: 0,
      },
    });
    const view = render(<TaskSummaryTab task={linkedTask} />);

    const summary = screen.getByTestId("task-summary-tab");
    const mergeCard = summary.querySelector(".merge-details-card");
    expect(screen.getByText("Merge Details")).toBeTruthy();
    expect(screen.getByText("Merged successfully")).toBeTruthy();
    expect(screen.getByText("Merged at")).toBeTruthy();
    expect(screen.getByText("feat: land summary merge details")).toBeTruthy();
    expect(screen.getByRole("link", { name: "#42" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/42");
    expect(mergeCard?.classList.contains("pr-card")).toBe(true);
    expect(summary.contains(mergeCard)).toBe(true);

    view.rerender(
      <TaskSummaryTab
        task={doneTask({
          mergeDetails: { commitSha: "abcdef1234567890", mergeConfirmed: false, prNumber: 7 },
          prInfo: undefined,
        })}
      />,
    );
    expect(screen.getByText("Recorded without local merge confirmation")).toBeTruthy();
    expect(screen.getByText("#7")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "#7" })).toBeNull();
    expect(screen.queryByText("Merged at")).toBeNull();
    expect(screen.queryByText("Message")).toBeNull();

    view.rerender(<TaskSummaryTab task={doneTask({ mergeDetails: { commitSha: "abcdef1234567890" } })} />);
    expect(screen.queryByText("PR")).toBeNull();
    expect(screen.queryByText("Merged at")).toBeNull();
    expect(screen.queryByText("Message")).toBeNull();

    view.rerender(<TaskSummaryTab task={doneTask({ mergeDetails: undefined })} />);
    expect(screen.getByTestId("task-summary-tab")).toBeTruthy();
    expect(screen.queryByText("Merge Details")).toBeNull();
  });

  it("keeps relocated Merge Details inside the existing mobile pr-card containment", () => {
    const { container } = render(<TaskSummaryTab task={doneTask({ mergeDetails: { commitSha: "abcdef1234567890", prNumber: 42 } })} />);
    const summary = screen.getByTestId("task-summary-tab");
    const mergeCard = document.querySelector(".task-summary-tab .merge-details-card.pr-card");

    expect(mergeCard).toBeTruthy();
    expect(summary.contains(mergeCard)).toBe(true);
    expect(readDashboardStylesSource()).toMatch(/@media \(max-width: 768px\)[\s\S]*\.pr-card/);
  });

  it("renders graceful empty states without orphaned changed-file headings", () => {
    render(
      <TaskDetailModal
        task={doneTask({
          summary: "",
          modifiedFiles: [],
          mergeDetails: undefined,
          steps: [],
          workflowStepResults: [],
          retrySummary: { total: 0 },
        })}
        onClose={noop}
        initialTab="summary"
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(screen.getByText("Completion summary")).toBeTruthy();
    expect(screen.getByText("No completion summary was recorded for this task.")).toBeTruthy();
    expect(screen.queryByText("What changed")).toBeNull();
    expect(screen.getByText("Work done by agents")).toBeTruthy();
    expect(screen.getByText("No completed steps or workflow results are available for this task.")).toBeTruthy();
  });

  it("keeps the Summary tab as a detail-tab inside the horizontally scrollable tab strip", () => {
    const { container } = render(
      <TaskDetailModal
        task={doneTask()}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    const tabs = document.querySelector(".detail-tabs");
    const summaryButton = screen.getByRole("button", { name: "Summary" });
    expect(tabs?.contains(summaryButton)).toBe(true);
    expect(summaryButton.classList.contains("detail-tab")).toBe(true);
  });

  it("resolves the done-task Summary default in embedded TaskDetailContent", () => {
    const { container } = render(
      <TaskDetailContent
        task={doneTask()}
        embedded
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expectButtonActive(screen.getByRole("button", { name: "Summary" }));
    expect(document.querySelector(".detail-tabs")?.firstElementChild?.textContent).toBe("Activity");
    expect(screen.getByText("Completion summary")).toBeTruthy();
  });

  it("gates Recommendations through the shared embedded detail entrypoint", async () => {
    const empty = render(
      <TaskDetailContent
        task={doneTask({ recommendations: [] })}
        embedded
        initialTab="recommendations"
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
    await waitFor(() => expectButtonActive(screen.getByRole("button", { name: "Plan" })));
    empty.unmount();

    render(
      <TaskDetailContent
        task={doneTask({ recommendations: [{ id: "REC-embedded", title: "Embedded recommendation", description: "", category: "bug" }] })}
        embedded
        initialTab="recommendations"
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expectButtonActive(screen.getByRole("button", { name: "Recommendations" }));
    expect(screen.getByText("Embedded recommendation")).toBeInTheDocument();
  });
});
