import type { WorkflowStepResult } from "@kb/core";

interface WorkflowResultsTabProps {
  taskId: string;
  results: WorkflowStepResult[];
  loading?: boolean;
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

export function WorkflowResultsTab({ taskId, results, loading }: WorkflowResultsTabProps) {
  if (loading) {
    return (
      <div className="workflow-results-loading" data-testid="workflow-results-loading">
        <div className="workflow-results-spinner" />
        <span>Loading workflow results…</span>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="workflow-results-empty" data-testid="workflow-results-empty">
        <p>No workflow steps have run yet.</p>
        <p className="workflow-results-empty-hint">
          Workflow steps will execute after the main task implementation completes.
        </p>
      </div>
    );
  }

  return (
    <div className="workflow-results-list" data-testid="workflow-results-list">
      {results.map((result, index) => (
        <div
          key={`${result.workflowStepId}-${index}`}
          className={`workflow-result-item workflow-result-item--${result.status}`}
          data-testid={`workflow-result-item-${result.workflowStepId}`}
        >
          <div className="workflow-result-header">
            <div className="workflow-result-name">{result.workflowStepName}</div>
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
              <div className="workflow-result-output-label">Output:</div>
              <pre
                className="workflow-result-output"
                data-testid={`workflow-result-output-${result.workflowStepId}`}
              >
                {result.output}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
