import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Column, ModelPricingOverrides, TaskTokenUsage } from "@fusion/core";
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

function doneTask(overrides = {}) {
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

    expect(container.querySelector(".detail-tabs")?.firstElementChild?.textContent).toBe("Activity");
    const summaryButton = screen.getByRole("button", { name: "Summary" });
    expectButtonActive(summaryButton);
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
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
    expect(container.querySelector(".detail-section--chat [data-testid='task-chat-tab']")).toBeTruthy();
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

  it("omits the token-cost section when token usage is absent", () => {
    render(<TaskSummaryTab task={doneTask({ tokenUsage: undefined })} />);

    expect(screen.queryByText("Token usage & cost")).toBeNull();
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
    const mobileTokenBlock = css.slice(css.indexOf("@media (max-width: 768px)"), css.indexOf("/* Spec tab layout"));

    expect(css).toContain(".task-summary-token-table");
    expect(tokenTableRule).toMatch(/min-width:\s*calc\(var\(--space-2xl\)\s*\*\s*16\)/);
    expect(modelNameRule).toContain("overflow-wrap: normal");
    expect(modelNameRule).toContain("word-break: normal");
    expect(modelNameRule).not.toContain("overflow-wrap: anywhere");
    expect(css).toContain("@media (max-width: 768px)");
    expect(mobileTokenBlock).toContain(".task-summary-token-table-wrap");
    expect(mobileTokenBlock).toContain("overflow-x: visible");
    expect(mobileTokenBlock).toContain(".task-summary-token-table td::before");
    expect(mobileTokenBlock).toContain("min-width: 0");
    expect(css).toContain("var(--color-warning)");
    expect(css).not.toMatch(/task-summary-token[^{}]*#[0-9a-fA-F]{3,8}/);
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

    const tabs = container.querySelector(".detail-tabs");
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
    expect(container.querySelector(".detail-tabs")?.firstElementChild?.textContent).toBe("Activity");
    expect(screen.getByText("Completion summary")).toBeTruthy();
  });
});
