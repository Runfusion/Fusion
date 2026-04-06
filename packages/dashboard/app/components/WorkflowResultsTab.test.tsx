import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowResultsTab } from "./WorkflowResultsTab";
import type { WorkflowStepResult } from "@fusion/core";

describe("WorkflowResultsTab", () => {
  const mockResults: WorkflowStepResult[] = [
    {
      workflowStepId: "WS-001",
      workflowStepName: "QA Check",
      phase: "pre-merge",
      status: "passed",
      output: "All tests passed successfully.",
      startedAt: "2026-03-31T10:00:00Z",
      completedAt: "2026-03-31T10:02:30Z",
    },
    {
      workflowStepId: "WS-002",
      workflowStepName: "Security Audit",
      phase: "pre-merge",
      status: "failed",
      output: "Found 2 security issues in auth.ts",
      startedAt: "2026-03-31T10:02:35Z",
      completedAt: "2026-03-31T10:03:15Z",
    },
    {
      workflowStepId: "WS-003",
      workflowStepName: "Documentation Review",
      phase: "post-merge",
      status: "skipped",
      output: undefined,
      startedAt: undefined,
      completedAt: undefined,
    },
    {
      workflowStepId: "WS-004",
      workflowStepName: "Performance Check",
      phase: "post-merge",
      status: "pending",
      output: undefined,
      startedAt: "2026-03-31T10:03:20Z",
      completedAt: undefined,
    },
  ];

  it("renders list of workflow step results", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    expect(screen.getByTestId("workflow-results-list")).toBeInTheDocument();
    expect(screen.getByText("QA Check")).toBeInTheDocument();
    expect(screen.getByText("Security Audit")).toBeInTheDocument();
    expect(screen.getByText("Documentation Review")).toBeInTheDocument();
    expect(screen.getByText("Performance Check")).toBeInTheDocument();
  });

  it("renders correct status badges for each result", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Passed badge
    const passedBadge = screen.getByTestId("workflow-result-badge-WS-001");
    expect(passedBadge).toHaveTextContent("Passed");
    expect(passedBadge).toHaveStyle({ backgroundColor: "var(--color-success, #3fb950)" });

    // Failed badge
    const failedBadge = screen.getByTestId("workflow-result-badge-WS-002");
    expect(failedBadge).toHaveTextContent("Failed");
    expect(failedBadge).toHaveStyle({ backgroundColor: "var(--color-error, #f85149)" });

    // Skipped badge
    const skippedBadge = screen.getByTestId("workflow-result-badge-WS-003");
    expect(skippedBadge).toHaveTextContent("Skipped");

    // Pending badge
    const pendingBadge = screen.getByTestId("workflow-result-badge-WS-004");
    expect(pendingBadge).toHaveTextContent("Running…");
    expect(pendingBadge).toHaveStyle({ backgroundColor: "var(--todo, #58a6ff)" });
  });

  it("shows output content when toggle is clicked to expand", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Output should be hidden by default (collapsed)
    expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();

    // Click "Show output" for WS-001
    fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

    // Now output should be visible
    expect(screen.getByTestId("workflow-result-output-WS-001")).toHaveTextContent(
      "All tests passed successfully."
    );

    // WS-002 should still be collapsed
    expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();
  });

  it("hides output when toggle is clicked again", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Expand WS-001
    fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
    expect(screen.getByTestId("workflow-result-output-WS-001")).toBeInTheDocument();

    // Toggle text should say "Hide output"
    expect(screen.getByTestId("workflow-result-toggle-WS-001")).toHaveTextContent("Hide output");

    // Collapse WS-001
    fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

    // Output should be hidden again
    expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();

    // Toggle text should say "Show output"
    expect(screen.getByTestId("workflow-result-toggle-WS-001")).toHaveTextContent("Show output");
  });

  it("handles results without output gracefully", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // WS-003 and WS-004 have no output, so output section elements should not be rendered
    expect(screen.queryByTestId("workflow-result-toggle-WS-003")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-toggle-WS-004")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-output-WS-003")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workflow-result-output-WS-004")).not.toBeInTheDocument();
  });

  it("shows empty state when no workflow steps are configured", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={[]} />);

    expect(screen.getByTestId("workflow-results-empty")).toBeInTheDocument();
    expect(screen.getByText("No workflow steps configured for this task.")).toBeInTheDocument();
  });

  it("shows 'configured but not run' empty state when enabledWorkflowSteps is non-empty", () => {
    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        enabledWorkflowSteps={["WS-001", "WS-002"]}
      />,
    );

    expect(screen.getByTestId("workflow-results-empty")).toBeInTheDocument();
    expect(screen.getByText("Workflow steps configured but haven't run yet.")).toBeInTheDocument();
  });

  it("shows loading state when loading prop is true", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={[]} loading={true} />);

    expect(screen.getByTestId("workflow-results-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading workflow results…")).toBeInTheDocument();
  });

  it("displays execution timestamps when available", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Check that timestamps are displayed for results that have them
    const timestamps = screen.getAllByText(/Started:/);
    expect(timestamps.length).toBeGreaterThanOrEqual(3); // 3 results have startedAt
  });

  it("displays duration when start and end times are available", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // The first result has a 2m 30s duration
    expect(screen.getByText("2m 30s")).toBeInTheDocument();
  });

  it("handles results with missing timestamps gracefully", () => {
    const resultsWithoutTimestamps: WorkflowStepResult[] = [
      {
        workflowStepId: "WS-005",
        workflowStepName: "Simple Check",
        phase: "pre-merge",
        status: "passed",
        output: "Done",
      },
    ];

    render(<WorkflowResultsTab taskId="FN-001" results={resultsWithoutTimestamps} />);

    expect(screen.getByText("Simple Check")).toBeInTheDocument();
    // Should not crash without timestamps
  });

  it("displays phase badges for each result", () => {
    render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

    // Pre-merge results (WS-001, WS-002)
    expect(screen.getByTestId("workflow-result-phase-WS-001")).toHaveTextContent("Pre-merge");
    expect(screen.getByTestId("workflow-result-phase-WS-002")).toHaveTextContent("Pre-merge");

    // Post-merge results (WS-003, WS-004)
    expect(screen.getByTestId("workflow-result-phase-WS-003")).toHaveTextContent("Post-merge");
    expect(screen.getByTestId("workflow-result-phase-WS-004")).toHaveTextContent("Post-merge");
  });

  it("defaults to Pre-merge phase badge when phase is undefined", () => {
    const resultsWithoutPhase: WorkflowStepResult[] = [
      {
        workflowStepId: "WS-005",
        workflowStepName: "Legacy Check",
        status: "passed",
        output: "Done",
      },
    ];

    render(<WorkflowResultsTab taskId="FN-001" results={resultsWithoutPhase} />);

    expect(screen.getByTestId("workflow-result-phase-WS-005")).toHaveTextContent("Pre-merge");
  });

  describe("summary bar", () => {
    it("renders summary bar with correct counts", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      const summary = screen.getByTestId("workflow-results-summary");
      expect(summary).toBeInTheDocument();
      expect(summary).toHaveTextContent("4 steps");
      expect(summary).toHaveTextContent("1 passed");
      expect(summary).toHaveTextContent("1 failed");
      expect(summary).toHaveTextContent("1 skipped");
      expect(summary).toHaveTextContent("1 running");
    });

    it("shows plural 'step' for single result", () => {
      const singleResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-001",
          workflowStepName: "QA Check",
          status: "passed",
          output: "Done",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={singleResult} />);

      const summary = screen.getByTestId("workflow-results-summary");
      expect(summary).toHaveTextContent("1 step");
      expect(summary).toHaveTextContent("1 passed");
      // Should not include "0 failed" etc. for zero-count categories
      expect(summary).not.toHaveTextContent("0 failed");
    });

    it("omits zero-count categories from summary", () => {
      const allPassed: WorkflowStepResult[] = [
        { workflowStepId: "WS-001", workflowStepName: "Check 1", status: "passed" },
        { workflowStepId: "WS-002", workflowStepName: "Check 2", status: "passed" },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={allPassed} />);

      const summary = screen.getByTestId("workflow-results-summary");
      expect(summary).toHaveTextContent("2 steps");
      expect(summary).toHaveTextContent("2 passed");
      expect(summary).not.toHaveTextContent("failed");
      expect(summary).not.toHaveTextContent("skipped");
      expect(summary).not.toHaveTextContent("running");
    });
  });

  describe("collapsible output", () => {
    it("output sections default to collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Outputs should not be rendered in DOM by default
      expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();
      expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();

      // Toggles should say "Show output"
      expect(screen.getByTestId("workflow-result-toggle-WS-001")).toHaveTextContent("Show output");
      expect(screen.getByTestId("workflow-result-toggle-WS-002")).toHaveTextContent("Show output");
    });

    it("shows preview hint when output is collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Preview should show for results with output
      expect(screen.getByTestId("workflow-result-preview-WS-001")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-result-preview-WS-002")).toBeInTheDocument();
    });

    it("shows line count in preview for multi-line output", () => {
      const multiLineResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-010",
          workflowStepName: "Multi Line Check",
          status: "passed",
          output: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={multiLineResult} />);

      expect(screen.getByTestId("workflow-result-preview-WS-010")).toHaveTextContent("5 lines");
    });

    it("shows output text as preview for single-line output", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // WS-001 output is "All tests passed successfully." — single line
      expect(screen.getByTestId("workflow-result-preview-WS-001")).toHaveTextContent(
        "All tests passed successfully."
      );
    });

    it("expands and collapses independently per step", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-output-WS-001")).toBeInTheDocument();
      expect(screen.queryByTestId("workflow-result-output-WS-002")).not.toBeInTheDocument();

      // Expand WS-002 as well
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-002"));
      expect(screen.getByTestId("workflow-result-output-WS-001")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-result-output-WS-002")).toBeInTheDocument();

      // Collapse WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      expect(screen.queryByTestId("workflow-result-output-WS-001")).not.toBeInTheDocument();
      expect(screen.getByTestId("workflow-result-output-WS-002")).toBeInTheDocument();
    });
  });
});
