import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Column } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

function expectButtonActive(button: HTMLElement): void {
  expect(button.classList.contains("detail-tab-active")).toBe(true);
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
  it("lands done tasks on Summary and renders completion, changed-files, and agent-work sections", () => {
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

    const summaryButton = screen.getByRole("button", { name: "Summary" });
    expectButtonActive(summaryButton);
    expect(screen.getByText("Completion summary")).toBeTruthy();
    expect(screen.getByText("summary")).toBeTruthy();
    expect(screen.getByText("What changed")).toBeTruthy();
    expect(screen.getByText("packages/dashboard/app/components/TaskSummaryTab.tsx")).toBeTruthy();
    expect(screen.getByText("Work done by agents")).toBeTruthy();
    expect(screen.getByText("Preflight")).toBeTruthy();
    expect(screen.getByText("Code Review")).toBeTruthy();
    expect(screen.getByText("Agents retried this task 1 time.")).toBeTruthy();
    expect(container.querySelector(".detail-tabs")?.firstElementChild?.textContent).toBe("Summary");
  });

  it("honors explicit Chat for done tasks", () => {
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

    expectButtonActive(screen.getByRole("button", { name: "Chat" }));
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

  it("does not render Summary for non-done columns and still defaults to Chat", () => {
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
      expectButtonActive(screen.getByRole("button", { name: "Chat" }));
      rendered.unmount();
    }
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
    render(
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
    expect(screen.getByText("Completion summary")).toBeTruthy();
  });
});
