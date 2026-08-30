import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Column, Task, TaskDetail } from "@fusion/core";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent, TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

function doneTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return makeTask({
    column: "done",
    summary: "Completed report for the Summary tab.",
    steps: [{ name: "Implement", status: "done" }],
    ...overrides,
  });
}

function modal(task: Task | TaskDetail, initialTab?: any) {
  return (
    <TaskDetailModal
      task={task}
      initialTab={initialTab}
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />
  );
}

describe("TaskDetailModal Summary tab", () => {
  it("lands completed work on its report-first Summary while Activity remains first in the strip", () => {
    render(modal(doneTask()));

    expect(document.querySelector(".detail-tabs")?.firstElementChild?.textContent).toContain("Activity");
    expect(screen.getByRole("button", { name: "Summary" })).toHaveClass("detail-tab-active");
    expect(screen.getByRole("heading", { name: "Work done by agents", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("Completed report for the Summary tab.")).toBeInTheDocument();
    expect(screen.queryByText("Implement")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Completed steps" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "What changed" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Token usage & cost" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
    expect(screen.queryByText("Completed report for the Summary tab.")).toBeNull();
  });

  it("renders Summary for every live column without changing its activity-first default", () => {
    for (const column of ["todo", "in-progress", "in-review"] as Column[]) {
      const view = render(modal(makeTask({ column })));
      expect(screen.getByRole("button", { name: "Summary" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("detail-tab-active");
      fireEvent.click(screen.getByRole("button", { name: "Summary" }));
      expect(screen.getByTestId("task-summary-tab")).toBeInTheDocument();
      view.unmount();
    }
  });

  it("places captured recommendations under Summary without restoring a Recommendations tab", () => {
    render(modal(doneTask({ recommendations: [{ id: "REC-244", title: "Audit a related path", description: "Optional future work.", category: "improvement" }] })));

    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Recommendations", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("Audit a related path")).toBeInTheDocument();
  });

  it("hides the recommendation section when no captured recommendation belongs to the task", () => {
    render(modal(doneTask({ recommendations: [] })));

    expect(screen.queryByRole("heading", { name: "Recommendations", level: 3 })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recommendations" })).toBeNull();
  });

  it("renders Merge Details as the final Summary block after recommendations", () => {
    render(modal(doneTask({
      mergeDetails: { commitSha: "abcdef1234567890", mergedAt: "2026-08-29T03:00:00.000Z" },
      recommendations: [{ id: "REC-256", title: "Optional follow-up", description: "Keep this non-blocking work visible.", category: "improvement" }],
      stepReports: [{ id: "step-report-0", stepIndex: 0, stepName: "Implement", summary: "Implemented the requested behavior.", recordedAt: "2026-08-29T03:00:15.000Z", source: "agent", attempt: 1 }],
      log: [
        { timestamp: "2026-08-29T03:00:00.000Z", action: "Step 0 (Implement) → in-progress" },
        { timestamp: "2026-08-29T03:00:15.000Z", action: "Step 0 (Implement) → done" },
      ],
    })));

    const summarySection = screen.getByTestId("task-summary-tab").closest(".detail-section--summary");
    const mergeCard = summarySection?.querySelector(".merge-details-card");
    const mergePanel = mergeCard?.closest(".detail-section");
    const reviewEntries = screen.getByTestId("task-history-stage-review").querySelectorAll(".task-history-entry");

    expect(mergeCard).toBeInTheDocument();
    expect(summarySection?.lastElementChild).toBe(mergePanel);
    expect(screen.getByText("Optional follow-up")).toBeInTheDocument();
    expect(reviewEntries[reviewEntries.length - 1]).toHaveTextContent("Completed report for the Summary tab.");
    expect(screen.getAllByTestId("task-history-entry-duration")).toHaveLength(1);
  });

  it("does not leave a Summary merge wrapper for incomplete or unmerged tasks", () => {
    const unmerged = render(modal(doneTask()));
    const unmergedSummary = screen.getByTestId("task-summary-tab").closest(".detail-section--summary");
    expect(unmergedSummary?.querySelector(".merge-details-card")).toBeNull();
    expect(unmergedSummary?.querySelector(":scope > .detail-section")).toBeNull();
    unmerged.unmount();

    render(modal(makeTask({
      column: "in-review",
      mergeDetails: { commitSha: "abcdef1234567890" },
    }), "summary"));
    const reviewSummary = screen.getByTestId("task-summary-tab").closest(".detail-section--summary");
    expect(reviewSummary?.querySelector(".merge-details-card")).toBeNull();
    expect(reviewSummary?.querySelector(":scope > .detail-section")).toBeNull();
  });

  it("keeps Summary in the shared horizontally scrollable strip for embedded detail", () => {
    render(
      <TaskDetailContent
        task={doneTask()}
        embedded
        initialTab="summary"
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    expect(document.querySelector(".detail-tabs")?.contains(screen.getByRole("button", { name: "Summary" }))).toBe(true);
    expect(screen.getByTestId("task-summary-tab")).toBeInTheDocument();
  });
});
