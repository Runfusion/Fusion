import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WorkflowStepResult } from "@fusion/core";
import { makeTask, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";
import { TaskSummaryTab } from "../TaskSummaryTab";

setupTaskDetailModalHooks();

describe("TaskSummaryTab prior-attempt history", () => {
  it("renders each prior attempt once through the agent report history without the retired disclosure", () => {
    const results: WorkflowStepResult[] = [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      status: "failed",
      output: "attempt-2 feedback",
      startedAt: "2026-07-09T00:02:00Z",
      priorAttempts: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "failed",
        output: "attempt-1 feedback",
        startedAt: "2026-07-09T00:01:00Z",
      }],
    }];

    render(<TaskSummaryTab task={makeTask({ column: "done", workflowStepResults: results })} results={results} />);

    expect(screen.getAllByText("Code Review")).toHaveLength(2);
    expect(screen.getAllByText("failed")).toHaveLength(2);
    expect(screen.getAllByText("attempt-1 feedback")).toHaveLength(1);
    expect(screen.getAllByText("attempt-2 feedback")).toHaveLength(1);
    expect(screen.queryAllByTestId("task-summary-prior-attempts")).toHaveLength(0);
    expect(screen.getByTestId("task-summary-ai-disclosure")).toHaveAttribute("data-ai-disclosure", "generated-output");
  });

  it("does not disclose generated output when prior attempts have only empty or undefined output", () => {
    const results: WorkflowStepResult[] = [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      status: "failed",
      output: "   ",
      startedAt: "2026-07-09T00:02:00Z",
      priorAttempts: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "failed",
        output: undefined,
        startedAt: "2026-07-09T00:01:00Z",
      }, {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "failed",
        output: "",
        startedAt: "2026-07-09T00:01:30Z",
      }],
    }];

    render(<TaskSummaryTab task={makeTask({ column: "done", workflowStepResults: results, summary: undefined })} results={results} />);

    expect(screen.getAllByText("Code Review").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("task-summary-ai-disclosure")).not.toBeInTheDocument();
  });
});
