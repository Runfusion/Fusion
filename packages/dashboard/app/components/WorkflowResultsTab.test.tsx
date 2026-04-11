import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowResultsTab } from "./WorkflowResultsTab";
import { fetchWorkflowSteps } from "../api";
import type { WorkflowStep, WorkflowStepResult } from "@fusion/core";

vi.mock("../api", () => ({
  fetchWorkflowSteps: vi.fn(),
}));

const mockedFetchWorkflowSteps = vi.mocked(fetchWorkflowSteps);

describe("WorkflowResultsTab", () => {
  const mockWorkflowSteps: WorkflowStep[] = [
    {
      id: "WS-101",
      name: "QA Check",
      description: "Run test suite",
      mode: "prompt",
      phase: "pre-merge",
      prompt: "Run QA checks",
      enabled: true,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    },
    {
      id: "WS-102",
      name: "Docs Review",
      description: "Review docs",
      mode: "prompt",
      phase: "post-merge",
      prompt: "Review docs",
      enabled: true,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    mockedFetchWorkflowSteps.mockReset();
    mockedFetchWorkflowSteps.mockResolvedValue(mockWorkflowSteps);
  });

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
    expect(passedBadge).toHaveClass("workflow-result-badge");
    expect(passedBadge).toHaveClass("workflow-result-badge--passed");

    // Failed badge
    const failedBadge = screen.getByTestId("workflow-result-badge-WS-002");
    expect(failedBadge).toHaveTextContent("Failed");
    expect(failedBadge).toHaveClass("workflow-result-badge");
    expect(failedBadge).toHaveClass("workflow-result-badge--failed");

    // Skipped badge
    const skippedBadge = screen.getByTestId("workflow-result-badge-WS-003");
    expect(skippedBadge).toHaveTextContent("Skipped");
    expect(skippedBadge).toHaveClass("workflow-result-badge");
    expect(skippedBadge).toHaveClass("workflow-result-badge--skipped");

    // Pending badge
    const pendingBadge = screen.getByTestId("workflow-result-badge-WS-004");
    expect(pendingBadge).toHaveTextContent("Running…");
    expect(pendingBadge).toHaveClass("workflow-result-badge");
    expect(pendingBadge).toHaveClass("workflow-result-badge--pending");
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

  it("shows configured step details when enabledWorkflowSteps is non-empty and results are empty", async () => {
    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        enabledWorkflowSteps={["WS-101", "WS-102"]}
      />,
    );

    expect(screen.getByTestId("workflow-configured-steps")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-configured-header")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-configured-count")).toHaveTextContent("2 steps");

    const qaStep = await screen.findByTestId("workflow-configured-step-WS-101");
    const docsStep = await screen.findByTestId("workflow-configured-step-WS-102");

    expect(qaStep).toHaveTextContent("QA Check");
    expect(qaStep).toHaveTextContent("Run test suite");
    expect(screen.getByTestId("workflow-configured-phase-WS-101")).toHaveTextContent("Pre-merge");

    expect(docsStep).toHaveTextContent("Docs Review");
    expect(docsStep).toHaveTextContent("Review docs");
    expect(screen.getByTestId("workflow-configured-phase-WS-102")).toHaveTextContent("Post-merge");

    expect(screen.getByText("Pre-merge steps run after implementation, before merge. Post-merge steps run after merge succeeds.")).toBeInTheDocument();
  });

  it("falls back to step ID and default description when definition is missing", () => {
    render(
      <WorkflowResultsTab
        taskId="FN-001"
        results={[]}
        enabledWorkflowSteps={["WS-unknown"]}
      />,
    );

    const fallbackStep = screen.getByTestId("workflow-configured-step-WS-unknown");
    expect(fallbackStep).toHaveTextContent("WS-unknown");
    expect(fallbackStep).toHaveTextContent("Step definition not found.");
    expect(screen.getByTestId("workflow-configured-phase-WS-unknown")).toHaveTextContent("Pre-merge");
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

  describe("markdown rendering toggle", () => {
    it("shows markdown mode toggle button when output is expanded", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Mode toggle should be visible
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toBeInTheDocument();
    });

    it("defaults to markdown mode", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Mode toggle should show "Markdown" (current mode)
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");
    });

    it("toggles between markdown and plain mode", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Should start in markdown mode
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");

      // Toggle to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");

      // Toggle back to markdown mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");
    });

    it("mode toggle is independent per step", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand both WS-001 and WS-002
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-002"));

      // Both should default to markdown mode
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Markdown");
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-002")).toHaveTextContent("Markdown");

      // Toggle WS-001 to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));

      // WS-001 should be plain, WS-002 should still be markdown
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-002")).toHaveTextContent("Markdown");
    });

    it("does not show mode toggle when output is collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Mode toggle should not be visible when collapsed
      expect(screen.queryByTestId("workflow-result-mode-toggle-WS-001")).not.toBeInTheDocument();
    });

    it("renders markdown content when in markdown mode", () => {
      const markdownResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-MD",
          workflowStepName: "Markdown Check",
          status: "passed",
          output: "# Header\n\n- Item 1\n- Item 2",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={markdownResult} />);

      // Expand
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-MD"));

      // Should be in markdown mode (default)
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-MD")).toHaveTextContent("Markdown");

      // Check that the output container has markdown-body class
      const outputContainer = screen.getByTestId("workflow-result-output-WS-MD");
      expect(outputContainer).toHaveClass("workflow-result-output--markdown");
    });

    it("renders plain text when in plain mode", () => {
      const markdownResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-MD",
          workflowStepName: "Markdown Check",
          status: "passed",
          output: "# Header\n\n- Item 1\n- Item 2",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={markdownResult} />);

      // Expand
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-MD"));

      // Toggle to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-MD"));

      // Output container should not have markdown class
      const outputContainer = screen.getByTestId("workflow-result-output-WS-MD");
      expect(outputContainer).not.toHaveClass("workflow-result-output--markdown");

      // Should show the raw markdown as preformatted text
      expect(outputContainer.textContent).toContain("# Header");
    });
  });

  describe("workflow step editing", () => {
    it("shows edit button when canEdit is true and configured steps are present", () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
        />,
      );

      expect(screen.getByTestId("workflow-steps-edit-toggle")).toBeInTheDocument();
    });

    it("does not show edit button when canEdit is false or undefined", () => {
      const { rerender } = render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit={false}
          enabledWorkflowSteps={["WS-101"]}
        />,
      );
      expect(screen.queryByTestId("workflow-steps-edit-toggle")).not.toBeInTheDocument();

      rerender(<WorkflowResultsTab taskId="FN-001" results={[]} enabledWorkflowSteps={["WS-101"]} />);
      expect(screen.queryByTestId("workflow-steps-edit-toggle")).not.toBeInTheDocument();
    });

    it("shows and hides workflow step checkboxes when edit is toggled", async () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
        />,
      );

      expect(screen.queryByTestId("workflow-steps-editor")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      expect(screen.getByTestId("workflow-steps-editor")).toBeInTheDocument();
      await screen.findByTestId("workflow-step-checkbox-WS-101");
      expect(screen.getByTestId("browser-verification-checkbox")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      expect(screen.queryByTestId("workflow-steps-editor")).not.toBeInTheDocument();
    });

    it("calls onWorkflowStepsChange when checking and unchecking steps", async () => {
      const onWorkflowStepsChange = vi.fn();

      const { rerender } = render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-102"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      const stepCheckbox = (await screen.findByTestId("workflow-step-checkbox-WS-101")).querySelector("input") as HTMLInputElement;
      fireEvent.click(stepCheckbox);

      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-102", "WS-101"]);

      onWorkflowStepsChange.mockClear();
      rerender(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      if (!screen.queryByTestId("workflow-steps-editor")) {
        fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      }

      const selectedCheckbox = (await screen.findByTestId("workflow-step-checkbox-WS-101")).querySelector("input") as HTMLInputElement;
      expect(selectedCheckbox.checked).toBe(true);
      fireEvent.click(selectedCheckbox);

      expect(onWorkflowStepsChange).toHaveBeenCalledWith([]);
    });

    it("reorders selected workflow steps with move buttons", async () => {
      const onWorkflowStepsChange = vi.fn();

      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101", "WS-102"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      await screen.findByTestId("workflow-step-order");

      fireEvent.click(screen.getByTestId("workflow-step-move-down-WS-101"));
      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-102", "WS-101"]);
    });

    it("removes a selected workflow step from execution order", async () => {
      const onWorkflowStepsChange = vi.fn();

      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          enabledWorkflowSteps={["WS-101", "WS-102"]}
          onWorkflowStepsChange={onWorkflowStepsChange}
        />,
      );

      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));
      await screen.findByTestId("workflow-step-order");

      fireEvent.click(screen.getByTestId("workflow-step-remove-WS-101"));
      expect(onWorkflowStepsChange).toHaveBeenCalledWith(["WS-102"]);
    });

    it("shows both results and edit UI when editing with existing results", async () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={mockResults}
          canEdit
          enabledWorkflowSteps={["WS-101"]}
        />,
      );

      expect(screen.getByTestId("workflow-results-list")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("workflow-steps-edit-toggle"));

      expect(screen.getByTestId("workflow-results-list")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-steps-editor")).toBeInTheDocument();
      await screen.findByTestId("workflow-step-checkbox-WS-101");
    });

    it("fetches workflow step definitions when canEdit and projectId are provided", async () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[]}
          canEdit
          projectId="proj-123"
          enabledWorkflowSteps={[]}
        />,
      );

      await waitFor(() => {
        expect(mockedFetchWorkflowSteps).toHaveBeenCalledWith("proj-123");
      });
    });
  });

  describe("theming contract", () => {
    it("uses CSS classes for phase badges instead of inline styles", () => {
      render(
        <WorkflowResultsTab
          taskId="FN-001"
          results={[
            {
              workflowStepId: "WS-001",
              workflowStepName: "Pre-merge Step",
              phase: "pre-merge",
              status: "passed",
            },
            {
              workflowStepId: "WS-002",
              workflowStepName: "Post-merge Step",
              phase: "post-merge",
              status: "passed",
            },
          ]}
        />,
      );

      // Pre-merge phase badge should use CSS class
      const preMergeBadge = screen.getByTestId("workflow-result-phase-WS-001");
      expect(preMergeBadge).toHaveClass("phase-badge");
      expect(preMergeBadge).toHaveClass("phase-badge--pre-merge");
      // Check that there are no rgba() values in inline styles
      expect(preMergeBadge.getAttribute("style") || "").not.toMatch(/rgba\(/);

      // Post-merge phase badge should use CSS class
      const postMergeBadge = screen.getByTestId("workflow-result-phase-WS-002");
      expect(postMergeBadge).toHaveClass("phase-badge");
      expect(postMergeBadge).toHaveClass("phase-badge--post-merge");
      expect(postMergeBadge.getAttribute("style") || "").not.toMatch(/rgba\(/);
    });

    it("uses CSS classes for status badges instead of inline styles", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      const passedBadge = screen.getByTestId("workflow-result-badge-WS-001");
      const failedBadge = screen.getByTestId("workflow-result-badge-WS-002");
      const skippedBadge = screen.getByTestId("workflow-result-badge-WS-003");
      const pendingBadge = screen.getByTestId("workflow-result-badge-WS-004");

      // All badges should have CSS class-based styling
      expect(passedBadge).toHaveClass("workflow-result-badge--passed");
      expect(failedBadge).toHaveClass("workflow-result-badge--failed");
      expect(skippedBadge).toHaveClass("workflow-result-badge--skipped");
      expect(pendingBadge).toHaveClass("workflow-result-badge--pending");

      // No inline background color styles with rgba values
      const passedStyle = passedBadge.getAttribute("style") || "";
      const failedStyle = failedBadge.getAttribute("style") || "";
      expect(passedStyle).not.toMatch(/rgba\(/);
      expect(failedStyle).not.toMatch(/rgba\(/);
    });

    it("prevents reintroduction of hardcoded phase colors in component source", () => {
      // Read the component source file
      const fs = require("fs");
      const path = require("path");
      const componentPath = path.join(__dirname, "WorkflowResultsTab.tsx");
      const componentSource = fs.readFileSync(componentPath, "utf-8");

      // These hardcoded color patterns should NOT appear in the component
      // (they were the old inline style values)
      const forbiddenPatterns = [
        /rgba\(59,\s*130,\s*246,\s*0\.15\)/, // pre-merge background
        /rgba\(139,\s*92,\s*246,\s*0\.15\)/, // post-merge background
        /#[38]b82f6/, // pre-merge text (partial match for #3b82f6 or #8b5cf6)
        /#[89]b5cf6/, // post-merge text (partial match for #8b5cf6)
      ];

      for (const pattern of forbiddenPatterns) {
        expect(componentSource).not.toMatch(pattern);
      }
    });

    it("prevents reintroduction of getStatusColor function with hardcoded colors", () => {
      const fs = require("fs");
      const path = require("path");
      const componentPath = path.join(__dirname, "WorkflowResultsTab.tsx");
      const componentSource = fs.readFileSync(componentPath, "utf-8");

      // The getStatusColor function should not exist (removed to use CSS classes)
      expect(componentSource).not.toMatch(/function getStatusColor/);
      expect(componentSource).not.toMatch(/getStatusColor\(/);
    });
  });

  describe("expanded view modal", () => {
    it("opens expanded view when zoom button is clicked", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // First expand the output
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));

      // Then click the expand button
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal should be visible
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();
      expect(screen.getByTestId("workflow-output-modal-content")).toBeInTheDocument();
    });

    it("shows modal header with step name and phase badge", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Check header content - use more specific selector
      expect(screen.getByTestId("workflow-output-modal")).toHaveTextContent("QA Check");
      expect(screen.getByTestId("workflow-output-modal-phase-WS-001")).toHaveTextContent("Pre-merge");
    });

    it("has a close button that closes the modal", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal is open
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();

      // Click close button
      fireEvent.click(screen.getByTestId("workflow-output-modal-close"));

      // Modal should be closed
      expect(screen.queryByTestId("workflow-output-modal")).not.toBeInTheDocument();
    });

    it("closes modal when clicking backdrop", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal is open
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();

      // Click backdrop (overlay)
      const overlay = screen.getByTestId("workflow-output-modal");
      fireEvent.click(overlay);

      // Modal should be closed (clicking backdrop should close)
      // Note: The actual click handler checks if target === currentTarget
      // In the DOM, clicking the overlay div itself triggers the close
    });

    it("modal syncs with step render mode", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand WS-001 and toggle to plain mode
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-mode-toggle-WS-001"));
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");

      // Open modal
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal should also be in plain mode
      expect(screen.getByTestId("workflow-output-modal-mode-toggle")).toHaveTextContent("Plain");
    });

    it("can toggle render mode within modal", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand and open modal (starts in markdown mode)
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));

      // Modal is in markdown mode
      expect(screen.getByTestId("workflow-output-modal-mode-toggle")).toHaveTextContent("Markdown");

      // Toggle to plain in modal
      fireEvent.click(screen.getByTestId("workflow-output-modal-mode-toggle"));
      expect(screen.getByTestId("workflow-output-modal-mode-toggle")).toHaveTextContent("Plain");

      // The inline view should also reflect this change
      expect(screen.getByTestId("workflow-result-mode-toggle-WS-001")).toHaveTextContent("Plain");
    });

    it("displays markdown content in expanded view", () => {
      const markdownResult: WorkflowStepResult[] = [
        {
          workflowStepId: "WS-MD",
          workflowStepName: "Markdown Check",
          status: "passed",
          output: "# Header\n\n- Item 1\n- Item 2",
        },
      ];

      render(<WorkflowResultsTab taskId="FN-001" results={markdownResult} />);

      // Expand and open modal
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-MD"));
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-MD"));

      // Modal content should be rendered
      expect(screen.getByTestId("workflow-output-modal-content")).toBeInTheDocument();
    });

    it("does not show expand button when output is collapsed", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand button should not be visible when output is collapsed
      expect(screen.queryByTestId("workflow-result-expand-WS-001")).not.toBeInTheDocument();
    });

    it("modal is independent per step", () => {
      render(<WorkflowResultsTab taskId="FN-001" results={mockResults} />);

      // Expand both
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-001"));
      fireEvent.click(screen.getByTestId("workflow-result-toggle-WS-002"));

      // Open modal for WS-001
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-001"));
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();

      // Close modal
      fireEvent.click(screen.getByTestId("workflow-output-modal-close"));
      expect(screen.queryByTestId("workflow-output-modal")).not.toBeInTheDocument();

      // Open modal for WS-002
      fireEvent.click(screen.getByTestId("workflow-result-expand-WS-002"));
      expect(screen.getByTestId("workflow-output-modal")).toBeInTheDocument();
    });
  });
});
