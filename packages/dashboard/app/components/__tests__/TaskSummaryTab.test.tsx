import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { WorkflowStepResult } from "@fusion/core";
import { makeTask, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";
import { TaskSummaryTab } from "../TaskSummaryTab";

setupTaskDetailModalHooks();

describe("TaskSummaryTab", () => {
  it("renders report-first empty stage history without duplicate completion, change, or cost sections", () => {
    render(<TaskSummaryTab task={makeTask({ column: "todo", steps: [], workflowStepResults: [] })} results={[]} />);

    expect(screen.getByRole("heading", { name: "Work done by agents", level: 3 })).toBeInTheDocument();
    expect(screen.getByTestId("task-history-tab")).toBeInTheDocument();
    for (const stage of ["plan", "code", "review"]) {
      const stageNode = screen.getByTestId(`task-history-stage-${stage}`);
      expect(stageNode).toBeInTheDocument();
      expect(stageNode.querySelector(".task-history-empty")?.textContent?.trim()).toBeTruthy();
    }
    expect(screen.queryByTestId("task-history-stage-merge")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Completion summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What changed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Token usage & cost" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-summary-ai-disclosure")).not.toBeInTheDocument();
  });

  it("accepts undefined optional task detail fields without an orphaned completed-steps heading", () => {
    const task = makeTask({
      steps: undefined,
      workflowStepResults: undefined,
      mergeDetails: undefined,
      tokenUsage: undefined,
    });

    render(<TaskSummaryTab task={task} results={[]} />);

    expect(screen.getByTestId("task-summary-tab")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Completed steps" })).not.toBeInTheDocument();
  });

  it("renders a task completion summary exactly once in the Review stage when no workflow summary exists", () => {
    const completionSummary = "The task completed with the canonical report.";
    render(<TaskSummaryTab task={makeTask({ summary: completionSummary, workflowStepResults: [] })} results={[]} />);

    const reviewStage = screen.getByTestId("task-history-stage-review");
    expect(within(reviewStage).getByText(completionSummary)).toBeInTheDocument();
    expect(screen.getAllByText(completionSummary)).toHaveLength(1);
    expect(screen.getByTestId("task-summary-ai-disclosure")).toHaveAttribute("data-ai-disclosure", "generated-output");
  });

  it("does not repeat a completed step when no report was recorded", () => {
    render(<TaskSummaryTab task={makeTask({
      steps: [{ name: "Implement", status: "done" }],
      stepReports: [],
    })} results={[]} />);

    expect(screen.queryByRole("heading", { name: "Completed steps" })).not.toBeInTheDocument();
    expect(screen.queryByText("Implement")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-history-stage-code").querySelector(".task-history-empty")).toBeInTheDocument();
  });

  it("preserves the task summary when completion workflow output is empty", () => {
    const completionSummary = "The persisted completion report must remain visible.";
    const results: WorkflowStepResult[] = [{
      workflowStepId: "completion-summary",
      workflowStepName: "Completion summary",
      status: "passed",
      output: " ",
      notes: " ",
      findings: [],
    }];

    render(<TaskSummaryTab task={makeTask({ summary: completionSummary, workflowStepResults: results })} results={results} />);

    const reviewStage = screen.getByTestId("task-history-stage-review");
    expect(within(reviewStage).getByText(completionSummary)).toBeInTheDocument();
    expect(within(reviewStage).queryByTestId("task-history-entry-no-body")).not.toBeInTheDocument();
    expect(screen.getAllByText(completionSummary)).toHaveLength(1);
  });

  it("renders a documentation-delivery summary once and without a status badge", () => {
    const completionSummary = "The documentation delivery report must appear once.";
    const results: WorkflowStepResult[] = [{
      workflowStepId: "documentation-delivery",
      workflowStepName: "Documentation",
      phase: "pre-merge",
      status: "passed",
      verdict: "APPROVE",
      output: completionSummary,
      startedAt: "2026-08-28T13:53:53.000Z",
      completedAt: "2026-08-28T13:54:19.500Z",
    }];

    render(<TaskSummaryTab task={makeTask({ summary: completionSummary, workflowStepResults: results })} results={results} />);

    const reviewStage = screen.getByTestId("task-history-stage-review");
    const completionHeading = within(reviewStage).getByRole("heading", { name: "Completion summary", level: 5 });
    expect(screen.getAllByText(completionSummary)).toHaveLength(1);
    expect(screen.queryByText("Documentation")).not.toBeInTheDocument();
    expect(completionHeading.closest("article")?.querySelector(".workflow-result-badge")).toBeNull();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });
});
