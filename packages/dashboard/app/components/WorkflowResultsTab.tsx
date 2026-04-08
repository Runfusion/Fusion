import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, Pencil, X } from "lucide-react";
import type { WorkflowStep, WorkflowStepResult } from "@fusion/core";
import { fetchWorkflowSteps } from "../api";

interface WorkflowResultsTabProps {
  taskId: string;
  results: WorkflowStepResult[];
  loading?: boolean;
  enabledWorkflowSteps?: string[];
  canEdit?: boolean;
  projectId?: string;
  onWorkflowStepsChange?: (steps: string[]) => void;
}

interface WorkflowStepOption {
  id: string;
  name: string;
  description: string;
  phase: "pre-merge" | "post-merge";
  icon?: ReactNode;
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

function phaseBadge(phase: "pre-merge" | "post-merge", id: string, prefix: string): ReactNode {
  return (
    <span
      style={{
        marginLeft: "6px",
        fontSize: "11px",
        padding: "1px 6px",
        borderRadius: "4px",
        background: phase === "post-merge" ? "rgba(139, 92, 246, 0.15)" : "rgba(59, 130, 246, 0.15)",
        color: phase === "post-merge" ? "#8b5cf6" : "#3b82f6",
      }}
      data-testid={`${prefix}-${id}`}
    >
      {phase === "post-merge" ? "Post-merge" : "Pre-merge"}
    </span>
  );
}

export function WorkflowResultsTab({
  taskId,
  results,
  loading,
  enabledWorkflowSteps,
  canEdit,
  projectId,
  onWorkflowStepsChange,
}: WorkflowResultsTabProps) {
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});
  const [allWorkflowSteps, setAllWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWorkflowSteps(projectId)
      .then((steps) => {
        if (!cancelled) {
          setAllWorkflowSteps(steps.filter((step) => step.enabled));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAllWorkflowSteps([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const selectedWorkflowSteps = enabledWorkflowSteps ?? [];

  const workflowStepOptions = useMemo<WorkflowStepOption[]>(() => {
    const fetched = allWorkflowSteps.map((step) => ({
      id: step.id,
      name: step.name,
      description: step.description,
      phase: (step.phase || "pre-merge") as "pre-merge" | "post-merge",
    }));

    return [
      ...fetched,
      {
        id: "browser-verification",
        name: "Browser Verification",
        description: "Verify web application functionality using browser automation (agent-browser)",
        phase: "pre-merge",
      },
    ];
  }, [allWorkflowSteps]);

  const workflowStepLookup = useMemo(() => {
    return new Map(workflowStepOptions.map((step) => [step.id, step]));
  }, [workflowStepOptions]);

  const toggleOutput = (stepId: string) => {
    setExpandedOutputs((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  const toggleStep = useCallback((stepId: string, checked: boolean) => {
    if (!onWorkflowStepsChange) return;

    if (checked) {
      if (selectedWorkflowSteps.includes(stepId)) {
        onWorkflowStepsChange(selectedWorkflowSteps);
        return;
      }
      onWorkflowStepsChange([...selectedWorkflowSteps, stepId]);
      return;
    }

    onWorkflowStepsChange(selectedWorkflowSteps.filter((id) => id !== stepId));
  }, [onWorkflowStepsChange, selectedWorkflowSteps]);

  const moveWorkflowStepUp = useCallback((index: number) => {
    if (!onWorkflowStepsChange || index <= 0) return;
    const updated = [...selectedWorkflowSteps];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    onWorkflowStepsChange(updated);
  }, [onWorkflowStepsChange, selectedWorkflowSteps]);

  const moveWorkflowStepDown = useCallback((index: number) => {
    if (!onWorkflowStepsChange || index >= selectedWorkflowSteps.length - 1) return;
    const updated = [...selectedWorkflowSteps];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    onWorkflowStepsChange(updated);
  }, [onWorkflowStepsChange, selectedWorkflowSteps]);

  const removeWorkflowStep = useCallback((stepId: string) => {
    if (!onWorkflowStepsChange) return;
    onWorkflowStepsChange(selectedWorkflowSteps.filter((id) => id !== stepId));
  }, [onWorkflowStepsChange, selectedWorkflowSteps]);

  const hasResults = results.length > 0;
  const hasConfiguredSteps = selectedWorkflowSteps.length > 0;

  useEffect(() => {
    if (!canEdit) {
      setIsEditing(false);
    }
  }, [canEdit]);

  const configuredSteps = useMemo(() => {
    return selectedWorkflowSteps.map((stepId) => {
      const stepInfo = workflowStepLookup.get(stepId);
      return {
        id: stepId,
        name: stepInfo?.name || stepId,
        description: stepInfo?.description || "Step definition not found.",
        phase: stepInfo?.phase || "pre-merge",
      } as WorkflowStepOption;
    });
  }, [selectedWorkflowSteps, workflowStepLookup]);

  const renderEditor = () => {
    if (!canEdit || !isEditing || loading) {
      return null;
    }

    return (
      <div className="workflow-results-editor" data-testid="workflow-steps-editor">
        <small style={{ marginBottom: "8px", display: "block" }}>
          Select steps to run after task implementation completes
        </small>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {workflowStepOptions.map((step) => (
            <label
              key={step.id}
              className="checkbox-label"
              style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}
              data-testid={step.id === "browser-verification"
                ? "browser-verification-checkbox"
                : `workflow-step-checkbox-${step.id}`}
            >
              <input
                type="checkbox"
                checked={selectedWorkflowSteps.includes(step.id)}
                onChange={(event) => toggleStep(step.id, event.target.checked)}
                style={{ marginTop: "2px" }}
              />
              <div>
                <span style={{ fontWeight: 500, fontSize: "13px" }}>
                  {step.name}
                  {phaseBadge(step.phase, step.id, "workflow-step-phase")}
                </span>
                <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
                  {step.description}
                </div>
              </div>
            </label>
          ))}
        </div>

        {selectedWorkflowSteps.length > 1 && (
          <div className="workflow-step-order" data-testid="workflow-step-order">
            <small className="workflow-step-order-label">Execution order:</small>
            {selectedWorkflowSteps.map((stepId, index) => {
              const stepInfo = workflowStepLookup.get(stepId);
              return (
                <div key={stepId} className="workflow-step-order-item" data-testid={`workflow-step-order-item-${stepId}`}>
                  <span className="workflow-step-order-number">{index + 1}</span>
                  <span className="workflow-step-order-name">{stepInfo?.name || stepId}</span>
                  <div className="workflow-step-order-actions">
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveWorkflowStepUp(index)}
                      disabled={index === 0}
                      data-testid={`workflow-step-move-up-${stepId}`}
                      title="Move up"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveWorkflowStepDown(index)}
                      disabled={index === selectedWorkflowSteps.length - 1}
                      data-testid={`workflow-step-move-down-${stepId}`}
                      title="Move down"
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => removeWorkflowStep(stepId)}
                      data-testid={`workflow-step-remove-${stepId}`}
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderResults = () => {
    if (loading) {
      return (
        <div className="workflow-results-loading" data-testid="workflow-results-loading">
          <div className="workflow-results-spinner" />
          <span>Loading workflow results…</span>
        </div>
      );
    }

    if (!hasResults) {
      return (
        <div className="workflow-results-empty" data-testid="workflow-results-empty">
          <p>No workflow steps configured for this task.</p>
          <p className="workflow-results-empty-hint">
            Pre-merge steps run after implementation, before merge. Post-merge steps run after merge succeeds.
          </p>
        </div>
      );
    }

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
          const phase = (result.phase || "pre-merge") as "pre-merge" | "post-merge";
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
                  {phaseBadge(phase, result.workflowStepId, "workflow-result-phase")}
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
                  <span className="workflow-result-timestamp">Started: {formatTimestamp(result.startedAt)}</span>
                )}
                {result.completedAt && (
                  <span className="workflow-result-duration">{formatDuration(result.startedAt, result.completedAt)}</span>
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
                      <span
                        className="workflow-result-output-preview"
                        data-testid={`workflow-result-preview-${result.workflowStepId}`}
                      >
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
  };

  const editButton = canEdit ? (
    <button
      type="button"
      className="modal-edit-btn workflow-results-edit-toggle"
      onClick={() => setIsEditing((prev) => !prev)}
      data-testid="workflow-steps-edit-toggle"
      aria-label={isEditing ? "Done editing workflow steps" : "Edit workflow steps"}
      title={isEditing ? "Done" : "Edit"}
    >
      {isEditing ? (
        <>
          <Check size={14} />
          Done
        </>
      ) : (
        <>
          <Pencil size={14} />
          Edit
        </>
      )}
    </button>
  ) : null;

  const showConfiguredStepsState = !loading && !hasResults && hasConfiguredSteps;
  const showEditHeaderForResults = canEdit && hasResults;

  return (
    <div className="workflow-results-tab" data-task-id={taskId}>
      {showConfiguredStepsState ? (
        <div className="workflow-configured-steps" data-testid="workflow-configured-steps">
          <div className="workflow-configured-header" data-testid="workflow-configured-header">
            <div className="workflow-configured-title-row">
              <h4>Configured Workflow Steps</h4>
              <span className="workflow-configured-count" data-testid="workflow-configured-count">
                {configuredSteps.length} step{configuredSteps.length === 1 ? "" : "s"}
              </span>
            </div>
            {editButton}
          </div>

          <div className="workflow-configured-list" data-testid="workflow-configured-list">
            {configuredSteps.map((step) => (
              <div
                key={step.id}
                className="workflow-configured-item"
                data-testid={`workflow-configured-step-${step.id}`}
              >
                <div className="workflow-configured-name">
                  {step.name}
                  {phaseBadge(step.phase, step.id, "workflow-configured-phase")}
                </div>
                <p className="workflow-configured-description">{step.description}</p>
              </div>
            ))}
          </div>

          <p className="workflow-results-empty-hint">
            Pre-merge steps run after implementation, before merge. Post-merge steps run after merge succeeds.
          </p>

          {renderEditor()}
        </div>
      ) : (
        <>
          {showEditHeaderForResults && (
            <div className="workflow-results-edit-header" data-testid="workflow-results-edit-header">
              <h4>Workflow Steps</h4>
              {editButton}
            </div>
          )}
          {renderResults()}
          {renderEditor()}
        </>
      )}
    </div>
  );
}
