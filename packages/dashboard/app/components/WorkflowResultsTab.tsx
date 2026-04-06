import { useState } from "react";
import type { WorkflowStepResult } from "@fusion/core";

interface WorkflowResultsTabProps {
  taskId: string;
  results: WorkflowStepResult[];
  loading?: boolean;
  enabledWorkflowSteps?: string[];
}

function getStatusColor(status: WorkflowStepResult["status"]): string {
  switch (status) {
    case "passed":
      return "var(--color-success, #3fb950)";
    case "failed":
      return "var(--color-error, #f85149)";
    case "skipped":
      return "var(--text-dim, #484f58)";
    case "pending":
      return "var(--todo, #58a6ff)";
    default:
      return "var(--text-dim, #484f58)";
  }
}

function getStatusLabel(status: WorkflowStepResult["status"]): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "pending":
      return "Running…";
    default:
      return status;
  }
}

function formatDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt || !completedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  const durationMs = end - start;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTimestamp(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleString();
}

function getOutputPreview(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 1) return output;
  return `${lines.length} lines`;
}

export function WorkflowResultsTab({ taskId, results, loading, enabledWorkflowSteps }: WorkflowResultsTabProps) {
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});

  const toggleOutput = (stepId: string) => {
    setExpandedOutputs((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  if (loading) {
    return (
      <div className="workflow-results-loading" data-testid="workflow-results-loading">
        <div className="workflow-results-spinner" />
        <span>Loading workflow results…</span>
      </div>
    );
  }

  if (results.length === 0) {
    const hasConfiguredSteps = (enabledWorkflowSteps?.length ?? 0) > 0;
    return (
      <div className="workflow-results-empty" data-testid="workflow-results-empty">
        <p>
          {hasConfiguredSteps
            ? "Workflow steps configured but haven't run yet."
            : "No workflow steps configured for this task."}
        </p>
        <p className="workflow-results-empty-hint">
          Pre-merge steps run after implementation, before merge. Post-merge steps run after merge succeeds.
        </p>
      </div>
    );
  }

  // Compute summary counts
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const pending = results.filter((r) => r.status === "pending").length;

  const summaryParts: string[] = [`${results.length} step${results.length !== 1 ? "s" : ""}`];
  if (passed > 0) summaryParts.push(`${passed} passed`);
  if (failed > 0) summaryParts.push(`${failed} failed`);
  if (skipped > 0) summaryParts.push(`${skipped} skipped`);
  if (pending > 0) summaryParts.push(`${pending} running`);

  return (
    <div className="workflow-results-list" data-testid="workflow-results-list">
      <div className="workflow-results-summary-bar" data-testid="workflow-results-summary">
        {summaryParts.join(" · ")}
      </div>
      {results.map((result, index) => {
        const phase = result.phase || "pre-merge";
        const isExpanded = expandedOutputs[result.workflowStepId] ?? false;
        return (
          <div
            key={`${result.workflowStepId}-${index}`}
            className={`workflow-result-item workflow-result-item--${result.status}`}
            data-testid={`workflow-result-item-${result.workflowStepId}`}
          >
            <div className="workflow-result-header">
              <div className="workflow-result-name">
                {result.workflowStepName}
                <span
                  className={`workflow-result-phase-badge workflow-result-phase-badge--${phase}`}
                  data-testid={`workflow-result-phase-${result.workflowStepId}`}
                  style={{
                    marginLeft: "8px",
                    fontSize: "11px",
                    padding: "1px 6px",
                    borderRadius: "4px",
                    background: phase === "post-merge"
                      ? "rgba(139, 92, 246, 0.15)"
                      : "rgba(59, 130, 246, 0.15)",
                    color: phase === "post-merge"
                      ? "#8b5cf6"
                      : "#3b82f6",
                  }}
                >
                  {phase === "post-merge" ? "Post-merge" : "Pre-merge"}
                </span>
              </div>
              <span
                className={`workflow-result-badge workflow-result-badge--${result.status}`}
                style={{
                  backgroundColor: getStatusColor(result.status),
                  color: result.status === "skipped" ? "var(--text-muted)" : "#fff",
                }}
                data-testid={`workflow-result-badge-${result.workflowStepId}`}
              >
                {getStatusLabel(result.status)}
              </span>
            </div>

            <div className="workflow-result-meta">
              {result.startedAt && (
                <span className="workflow-result-timestamp">
                  Started: {formatTimestamp(result.startedAt)}
                </span>
              )}
              {result.completedAt && (
                <span className="workflow-result-duration">
                  {formatDuration(result.startedAt, result.completedAt)}
                </span>
              )}
            </div>

            {result.output && (
              <div className="workflow-result-output-section">
                <div className="workflow-result-output-header">
                  <span className="workflow-result-output-label">Output:</span>
                  <button
                    className="workflow-result-toggle"
                    onClick={() => toggleOutput(result.workflowStepId)}
                    data-testid={`workflow-result-toggle-${result.workflowStepId}`}
                  >
                    {isExpanded ? "Hide output" : "Show output"}
                  </button>
                  {!isExpanded && (
                    <span className="workflow-result-output-preview" data-testid={`workflow-result-preview-${result.workflowStepId}`}>
                      {getOutputPreview(result.output)}
                    </span>
                  )}
                </div>
                {isExpanded && (
                  <pre
                    className="workflow-result-output"
                    data-testid={`workflow-result-output-${result.workflowStepId}`}
                  >
                    {result.output}
                  </pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
