import "@xyflow/react/dist/style.css";
import "./WorkflowResultsTab.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/*
FNXC:i18n-Localize 2026-06-20-00:00:
FN-6770 requires the workflow/task/setup/PR dashboard cluster to render user-facing copy through locale catalogs so i18n:lint can scan these files again without narrow deferrals.
*/
import { Check, ChevronDown, ChevronRight, ChevronUp, Maximize2, Pencil, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import type { Agent, AgentLogEntry, Settings, Task, TaskDetail, WorkflowDefinition, WorkflowStep, WorkflowStepResult, ResolvedWorkflowOptionalStep } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import { approveTaskWorkflowCli, fetchBoardWorkflows, fetchWorkflow, fetchWorkflows, fetchWorkflowSteps, fetchTaskWorkflow, fetchWorkflowOptionalSteps, selectTaskWorkflow, submitTaskWorkflowInput } from "../api";
import { WorkflowSelector } from "./WorkflowSelector";
import { phaseBadge } from "./workflow-phase-badge";
import { useAgentLogs } from "../hooks/useAgentLogs";
import { ProviderIcon } from "./ProviderIcon";
import { irToFlow } from "./workflow-flow-mapping";
import { workflowNodeTypes } from "./nodes/WorkflowNodeTypes";
import type { Components } from "react-markdown";
import { linkifyFilePaths, linkifyReactChildren } from "../utils/filePathLinkify";
import { resolveEffectiveExecutor, resolveEffectivePlanning, resolveEffectiveValidator } from "./effective-model-resolution";

// Markdown rendering components for workflow output
const markdownComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  code: ({ children, ...props }) => <code {...props}>{linkifyReactChildren(children)}</code>,
  pre: ({ children, className, ...props }) => (
    <pre
      {...props}
      className={["workflow-markdown-pre", className].filter(Boolean).join(" ")}
    >
      {linkifyReactChildren(children)}
    </pre>
  ),
  table: ({ children, className, ...props }) => (
    <table
      {...props}
      className={["workflow-markdown-table", className].filter(Boolean).join(" ")}
    >
      {children}
    </table>
  ),
};

interface WorkflowResultsTabProps {
  taskId: string;
  task?: Task | TaskDetail;
  results: WorkflowStepResult[];
  loading?: boolean;
  enabledWorkflowSteps?: string[];
  canEdit?: boolean;
  projectId?: string;
  isTaskInProgress?: boolean;
  onWorkflowStepsChange?: (steps: string[]) => void;
  taskStatus?: string;
  taskPausedReason?: string;
  settings?: Settings;
  agentLogEntries?: AgentLogEntry[];
  assignedAgent?: Agent | null;
  onEditWorkflow?: () => void;
  /** U5 (R20): called after a workflow switch affects board placement
   *  (any reconciliation result) so the board can refresh before the SSE
   *  catch-up arrives; lane membership is keyed by workflow id, not column. */
  onWorkflowReconciled?: () => void;
}

/** Extract the user-facing question from a workflow-input paused reason.
 *  Strips the leading "workflow-input:<nodeId>: " prefix if present. */
function parseWorkflowInputQuestion(pausedReason: string | undefined, t: ReturnType<typeof useTranslation>["t"]): string {
  const fallback = t("app:workflow.replyInComments", "Reply in the comments and unpause the task to continue.");
  if (!pausedReason) return fallback;
  const match = /^workflow-input:[^:]+:\s*(.*)$/s.exec(pausedReason);
  if (match) return match[1].trim() || fallback;
  return pausedReason;
}

/** Extract the CLI command from a workflow-cli-approval paused reason.
 *  Strips the leading "workflow-cli-approval:<nodeId>: " prefix if present. */
function parseCliApprovalCommand(pausedReason?: string): string {
  if (!pausedReason) return "";
  const match = /^workflow-cli-approval:[^:]+:\s*(.*)$/s.exec(pausedReason);
  if (match) return match[1].trim();
  return pausedReason;
}

interface WorkflowStepOption {
  id: string;
  name: string;
  description: string;
  phase: "pre-merge" | "post-merge";
  icon?: ReactNode;
}

function getStatusLabel(status: WorkflowStepResult["status"], t: ReturnType<typeof useTranslation>["t"]): string {
  switch (status) {
    case "passed":
      return t("app:workflow.statusPassed", "Passed");
    case "failed":
      return t("app:workflow.statusFailed", "Failed");
    case "advisory_failure":
      return t("app:workflow.statusAdvisory", "Advisory failure");
    case "skipped":
      return t("app:workflow.statusSkipped", "Skipped");
    case "pending":
      return t("app:workflow.statusRunning", "Running…");
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

// phaseBadge moved to ./workflow-phase-badge (shared with the optional-steps panel
// and the optional-steps dropdown). Imported above.

function getWorkflowName(
  workflowId: string | null,
  workflows: WorkflowDefinition[],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!workflowId) return t("app:workflow.noWorkflowAssigned", "No workflow assigned");
  const match = workflows.find((workflow) => workflow.id === workflowId);
  return match?.name || t("app:workflow.customWorkflowFallback", "Custom workflow");
}

function getAggregateWorkflowResult(
  results: WorkflowStepResult[],
  t: ReturnType<typeof useTranslation>["t"],
): { label: string; badgeClass: string; testId: string } {
  if (results.some((result) => result.status === "failed")) {
    return { label: t("app:workflow.statusFailed", "Failed"), badgeClass: "workflow-result-badge--failed", testId: "failed" };
  }
  if (results.some((result) => result.status === "advisory_failure")) {
    return { label: t("app:workflow.aggregateAdvisory", "Advisory"), badgeClass: "workflow-result-badge--advisory_failure", testId: "advisory" };
  }
  if (results.some((result) => result.status === "pending")) {
    return { label: t("app:workflow.aggregateInProgress", "In progress"), badgeClass: "workflow-result-badge--pending", testId: "pending" };
  }
  if (results.length === 0) {
    return { label: t("app:workflow.aggregateNoResults", "No results"), badgeClass: "workflow-result-badge--skipped", testId: "no-results" };
  }
  return { label: t("app:workflow.aggregateAllPassed", "All passed"), badgeClass: "workflow-result-badge--passed", testId: "passed" };
}

function getExecutionPhase(
  task: Task | TaskDetail | undefined,
  taskStatus: string | undefined,
  taskPausedReason: string | undefined,
  results: WorkflowStepResult[],
  t: ReturnType<typeof useTranslation>["t"],
): { label: string; badgeClass: string; testId: string } {
  if (taskStatus === "awaiting-user-input") {
    return { label: t("app:workflow.executionAwaitingInput", "Awaiting input"), badgeClass: "workflow-result-badge--pending", testId: "awaiting-input" };
  }
  if (taskStatus === "awaiting-cli-approval") {
    return { label: t("app:workflow.executionAwaitingCliApproval", "Awaiting CLI approval"), badgeClass: "workflow-result-badge--pending", testId: "awaiting-cli-approval" };
  }
  if (taskStatus === "paused" || taskPausedReason) {
    return { label: t("app:workflow.executionPaused", "Paused"), badgeClass: "workflow-result-badge--pending", testId: "paused" };
  }

  const pendingResult = results.find((result) => result.status === "pending");
  if (pendingResult) {
    const isPostMerge = (pendingResult.phase || "pre-merge") === "post-merge";
    return {
      label: isPostMerge
        ? t("app:workflow.executionPostMerge", "Post-merge steps running")
        : t("app:workflow.executionPreMerge", "Pre-merge steps running"),
      badgeClass: "workflow-result-badge--pending",
      testId: isPostMerge ? "post-merge" : "pre-merge",
    };
  }

  const hasTerminalResults = results.length > 0 && results.every((result) => ["passed", "failed", "advisory_failure", "skipped"].includes(result.status));
  if (hasTerminalResults || taskStatus === "done" || task?.column === "done" || task?.column === "in-review") {
    return { label: t("app:workflow.executionCompleted", "Completed"), badgeClass: "workflow-result-badge--passed", testId: "completed" };
  }

  return { label: t("app:workflow.executionNotStarted", "Not started"), badgeClass: "workflow-result-badge--pending", testId: "not-started" };
}

function formatModelValue(selection: { provider?: string; modelId?: string } | undefined, t: ReturnType<typeof useTranslation>["t"]): string {
  if (!selection?.provider || !selection.modelId) return t("app:workflow.modelDefault", "Default");
  return `${selection.provider}/${selection.modelId}`;
}

/**
 * Renders live agent log output for a running (pending) workflow step.
 * Filters entries to show only those timestamped on or after the step's startedAt.
 */
function LiveAgentLogOutput({
  entries,
  startedAt,
  stepId,
  t,
}: {
  entries: AgentLogEntry[];
  startedAt: string;
  stepId: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startedAtMs = new Date(startedAt).getTime();

  // Filter entries to only show those from this step's time window
  const stepEntries = entries.filter((entry) => {
    const entryMs = new Date(entry.timestamp).getTime();
    return entryMs >= startedAtMs;
  });

  // Auto-scroll to bottom as new entries arrive
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [stepEntries.length]);

  if (stepEntries.length === 0) {
    return (
      <div className="workflow-live-log" data-testid={`workflow-live-log-${stepId}`}>
        <div className="workflow-live-log-empty">{t("app:workflow.waitingForOutput", "Waiting for agent output…")}</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="workflow-live-log"
      data-testid={`workflow-live-log-${stepId}`}
    >
      {stepEntries.map((entry, i) => {
        if (entry.type === "tool") {
          return (
            <div key={i} className="workflow-live-log-tool">
              ⚡ {linkifyFilePaths(entry.text)}
              {entry.detail && <span className="workflow-live-log-detail"> — {linkifyFilePaths(entry.detail)}</span>}
            </div>
          );
        }
        if (entry.type === "tool_result") {
          return (
            <div key={i} className="workflow-live-log-tool-result">
              ✓ {linkifyFilePaths(entry.text)}
              {entry.detail && <span className="workflow-live-log-detail"> — {linkifyFilePaths(entry.detail)}</span>}
            </div>
          );
        }
        if (entry.type === "tool_error") {
          return (
            <div key={i} className="workflow-live-log-tool-error">
              ✗ {linkifyFilePaths(entry.text)}
              {entry.detail && <span className="workflow-live-log-detail"> — {linkifyFilePaths(entry.detail)}</span>}
            </div>
          );
        }
        if (entry.type === "thinking") {
          return (
            <div key={i} className="workflow-live-log-thinking">
              {linkifyFilePaths(entry.text)}
            </div>
          );
        }
        // Default: text entries
        return (
          <span key={i} className="workflow-live-log-text">
            {linkifyFilePaths(entry.text)}
          </span>
        );
      })}
    </div>
  );
}

export function WorkflowResultsTab({
  taskId,
  task,
  results,
  loading,
  enabledWorkflowSteps,
  canEdit,
  projectId,
  isTaskInProgress,
  onWorkflowStepsChange,
  taskStatus,
  taskPausedReason,
  settings,
  agentLogEntries = [],
  assignedAgent = null,
  onEditWorkflow,
  onWorkflowReconciled,
}: WorkflowResultsTabProps) {
  const { t } = useTranslation("app");
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});
  const [renderModes, setRenderModes] = useState<Record<string, "markdown" | "plain">>({});
  const [inputText, setInputText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [expandedViewStepId, setExpandedViewStepId] = useState<string | null>(null);
  const [allWorkflowSteps, setAllWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [optionalWorkflowSteps, setOptionalWorkflowSteps] = useState<ResolvedWorkflowOptionalStep[]>([]);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<WorkflowDefinition[]>([]);
  const [boardWorkflowFallbackId, setBoardWorkflowFallbackId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [workflowGraphCache, setWorkflowGraphCache] = useState<Record<string, WorkflowDefinition>>({});
  const [workflowGraphLoading, setWorkflowGraphLoading] = useState(false);
  const [modelSettingsExpanded, setModelSettingsExpanded] = useState(false);

  // Reset the paused-action UI whenever the blocked node/task changes, so a new
  // awaiting-user-input / awaiting-cli-approval pause starts with fresh controls
  // instead of a stale "Resuming…" banner.
  useEffect(() => {
    setInputText("");
    setSubmitting(false);
    setSubmitted(false);
    setResumeError(null);
  }, [taskId, taskStatus, taskPausedReason]);

  // Load the task's current workflow selection (if any).
  useEffect(() => {
    let cancelled = false;
    fetchTaskWorkflow(taskId, projectId)
      .then((res) => {
        if (!cancelled) setSelectedWorkflowId(res.workflowId);
      })
      .catch(() => {
        /* selection is optional; ignore load failures */
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, projectId]);

  const handleWorkflowSelect = useCallback(
    async (workflowId: string | null) => {
      const res = await selectTaskWorkflow(taskId, workflowId, projectId);
      setSelectedWorkflowId(res.workflowId);
      onWorkflowStepsChange?.(res.enabledWorkflowSteps);
      /*
      FNXC:CustomWorkflows 2026-06-17-07:21:
      A workflow switch can move the card to a different board lane even when reconciliation preserves the column, because lane membership is keyed by workflow id rather than column id. Refresh the task detail for any reconciliation result so the detail modal pushes the board update before SSE catch-up.
      */
      if (res.reconciliation) {
        onWorkflowReconciled?.();
      }
    },
    [taskId, projectId, onWorkflowStepsChange, onWorkflowReconciled],
  );

  useEffect(() => {
    let cancelled = false;
    fetchWorkflows(projectId)
      .then((definitions) => {
        if (!cancelled) setWorkflowDefinitions(definitions);
      })
      .catch(() => {
        if (!cancelled) setWorkflowDefinitions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setBoardWorkflowFallbackId(null);
    fetchBoardWorkflows(projectId)
      .then((payload) => {
        if (cancelled) return;
        const mappedWorkflowId = payload.taskWorkflowIds?.[taskId] || null;
        const defaultWorkflowId = payload.defaultWorkflowId || null;
        setBoardWorkflowFallbackId(payload.flagEnabled ? (mappedWorkflowId ?? defaultWorkflowId) : null);
      })
      .catch(() => {
        if (!cancelled) setBoardWorkflowFallbackId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, projectId]);

  /*
  FNXC:TaskWorkflowDetails 2026-06-24-09:50:
  A null per-task workflow selection means "inherit the board workflow" when board-workflows supplies a task mapping or project default. Use this effective id for read-only task-detail surfaces while keeping the explicit selection value for WorkflowSelector.
  */
  const effectiveWorkflowId = selectedWorkflowId ?? boardWorkflowFallbackId;
  const graphCacheKey = effectiveWorkflowId ? `${projectId ?? ""}::${effectiveWorkflowId}` : null;

  useEffect(() => {
    if (!graphExpanded || !effectiveWorkflowId || !graphCacheKey || workflowGraphCache[graphCacheKey]) return;
    let cancelled = false;
    setWorkflowGraphLoading(true);
    fetchWorkflow(effectiveWorkflowId, projectId)
      .then((definition) => {
        if (!cancelled) {
          setWorkflowGraphCache((prev) => ({ ...prev, [graphCacheKey]: definition }));
        }
      })
      .catch(() => {
        /* graph preview is optional; leave empty state */
      })
      .finally(() => {
        if (!cancelled) setWorkflowGraphLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graphExpanded, effectiveWorkflowId, graphCacheKey, projectId, workflowGraphCache]);

  // Check if any result has pending status
  const hasPendingStep = results.some((r) => r.status === "pending");

  // Subscribe to live agent logs when task is in progress and has a pending step
  const { entries: liveLogEntries } = useAgentLogs(
    taskId,
    !!isTaskInProgress && hasPendingStep,
    projectId,
  );

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

  useEffect(() => {
    if (!effectiveWorkflowId) {
      setOptionalWorkflowSteps([]);
      return;
    }
    let cancelled = false;
    fetchWorkflowOptionalSteps(effectiveWorkflowId, projectId)
      .then((steps) => {
        if (!cancelled) setOptionalWorkflowSteps(steps);
      })
      .catch(() => {
        if (!cancelled) setOptionalWorkflowSteps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveWorkflowId, projectId]);

  const selectedWorkflowSteps = enabledWorkflowSteps ?? [];

  const workflowStepOptions = useMemo<WorkflowStepOption[]>(() => {
    const options: WorkflowStepOption[] = allWorkflowSteps.map((step) => ({
      id: step.id,
      name: step.name,
      description: step.description,
      phase: (step.phase || "pre-merge") as "pre-merge" | "post-merge",
    }));
    const seen = new Set<string>();
    for (const step of allWorkflowSteps) {
      seen.add(step.id);
      if (step.templateId) seen.add(step.templateId);
    }
    for (const step of optionalWorkflowSteps) {
      if (seen.has(step.templateId)) continue;
      seen.add(step.templateId);
      options.push({
        id: step.templateId,
        name: step.name,
        description: step.description,
        phase: step.phase,
      });
    }
    return options;
  }, [allWorkflowSteps, optionalWorkflowSteps]);

  const workflowStepLookup = useMemo(() => {
    return new Map(workflowStepOptions.map((step) => [step.id, step]));
  }, [workflowStepOptions]);

  const toggleOutput = (stepId: string) => {
    setExpandedOutputs((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  const toggleRenderMode = (stepId: string) => {
    setRenderModes((prev) => {
      const currentMode = prev[stepId] ?? "markdown";
      return { ...prev, [stepId]: currentMode === "markdown" ? "plain" : "markdown" };
    });
  };

  // Expanded view modal handlers
  const openExpandedView = (stepId: string) => {
    setExpandedViewStepId(stepId);
  };

  const closeExpandedView = () => {
    setExpandedViewStepId(null);
  };

  // Escape key handler for closing expanded view
  useEffect(() => {
    if (!expandedViewStepId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeExpandedView();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [expandedViewStepId]);

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
        description: stepInfo?.description || t("app:workflow.stepDefinitionNotFound", "Step definition not found."),
        phase: stepInfo?.phase || "pre-merge",
      } as WorkflowStepOption;
    });
  }, [selectedWorkflowSteps, workflowStepLookup, t]);

  const workflowName = useMemo(() => getWorkflowName(effectiveWorkflowId, workflowDefinitions, t), [effectiveWorkflowId, workflowDefinitions, t]);
  const executionPhase = useMemo(() => getExecutionPhase(task, taskStatus, taskPausedReason, results, t), [task, taskStatus, taskPausedReason, results, t]);
  const aggregateResult = useMemo(() => getAggregateWorkflowResult(results, t), [results, t]);
  const completedStepCount = useMemo(() => results.filter((result) => ["passed", "skipped", "failed", "advisory_failure"].includes(result.status)).length, [results]);
  const graphWorkflow = graphCacheKey ? workflowGraphCache[graphCacheKey] : undefined;
  const graphFlow = useMemo(() => (graphWorkflow ? irToFlow(graphWorkflow) : null), [graphWorkflow]);
  const effectiveExecutor = useMemo(() => (task ? resolveEffectiveExecutor(task, agentLogEntries, assignedAgent, settings) : undefined), [agentLogEntries, assignedAgent, task, settings]);
  const effectiveValidator = useMemo(() => (task ? resolveEffectiveValidator(task, agentLogEntries, assignedAgent, settings) : undefined), [agentLogEntries, assignedAgent, task, settings]);
  const effectivePlanning = useMemo(() => (task ? resolveEffectivePlanning(task, agentLogEntries, settings) : undefined), [agentLogEntries, task, settings]);

  const renderEditor = () => {
    if (!canEdit || !isEditing || loading) {
      return null;
    }

    return (
      <div className="workflow-results-editor" data-testid="workflow-steps-editor">
        <div className="workflow-steps-section">
          <small className="workflow-steps-description">
            {t("app:workflow.selectStepsDescription", "Select steps to run after task implementation completes")}
          </small>
          <div className="workflow-steps-list">
            {workflowStepOptions.map((step) => (
              <label
                key={step.id}
                className="checkbox-label workflow-step-item"
                data-testid={`workflow-step-checkbox-${step.id}`}
              >
                <input
                  type="checkbox"
                  checked={selectedWorkflowSteps.includes(step.id)}
                  onChange={(event) => toggleStep(step.id, event.target.checked)}
                />
                <div>
                  <span className="workflow-step-name">
                    {step.name}
                    {phaseBadge(step.phase, step.id, "workflow-step-phase", t)}
                  </span>
                  <div className="workflow-step-description">
                    {step.description}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {selectedWorkflowSteps.length > 1 && (
          <div className="workflow-step-order" data-testid="workflow-step-order">
            <small className="workflow-step-order-label">{t("app:workflow.executionOrder", "Execution order:")}</small>
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
                      title={t("app:workflow.moveUp", "Move up")}
                    >
                      <ChevronUp />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => moveWorkflowStepDown(index)}
                      disabled={index === selectedWorkflowSteps.length - 1}
                      data-testid={`workflow-step-move-down-${stepId}`}
                      title={t("app:workflow.moveDown", "Move down")}
                    >
                      <ChevronDown />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => removeWorkflowStep(stepId)}
                      data-testid={`workflow-step-remove-${stepId}`}
                      title={t("app:workflow.remove", "Remove")}
                    >
                      <X />
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
          <span>{t("app:workflow.loadingResults", "Loading workflow results…")}</span>
        </div>
      );
    }

    if (!hasResults) {
      return (
        <div className="workflow-results-empty" data-testid="workflow-results-empty">
          <p>{t("app:workflow.noStepsConfigured", "No workflow steps configured for this task.")}</p>
          <p className="workflow-results-empty-hint">
            {t("app:workflow.stepsExplanation", "Pre-merge steps run after implementation, before merge. Post-merge steps run after merge succeeds.")}
          </p>
        </div>
      );
    }

    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const advisoryFailures = results.filter((r) => r.status === "advisory_failure");
    const skipped = results.filter((r) => r.status === "skipped").length;
    const pending = results.filter((r) => r.status === "pending").length;

    const summaryParts: string[] = [t("app:workflow.summaryStepCount", { count: results.length, defaultValue_one: "{{count}} step", defaultValue_other: "{{count}} steps" })];
    if (passed > 0) summaryParts.push(t("app:workflow.summaryPassed", "{{count}} passed", { count: passed }));
    if (failed > 0) summaryParts.push(t("app:workflow.summaryFailed", "{{count}} failed", { count: failed }));
    if (advisoryFailures.length > 0) summaryParts.push(t("app:workflow.summaryAdvisory", "{{count}} advisory", { count: advisoryFailures.length }));
    if (skipped > 0) summaryParts.push(t("app:workflow.summarySkipped", "{{count}} skipped", { count: skipped }));
    if (pending > 0) summaryParts.push(t("app:workflow.summaryRunning", "{{count}} running", { count: pending }));

    return (
      <div className="workflow-results-list" data-testid="workflow-results-list">
        <div className="workflow-results-summary-bar" data-testid="workflow-results-summary">
          {summaryParts.join(t("app:workflow.summarySeparator", " · "))}
        </div>
        {advisoryFailures.length > 0 && (
          <div className="workflow-polish-notes" data-testid="workflow-polish-notes">
            <h4>{t("app:workflow.polishNotes", "Polish notes")}</h4>
            <p>{t("app:workflow.advisoryExplanation", "Advisory workflow steps flagged non-blocking improvements:")}</p>
            <ul>
              {advisoryFailures.map((result, index) => (
                <li key={`advisory-${result.workflowStepId}-${index}`}>
                  <strong>{result.workflowStepName}:</strong> {result.output || t("app:workflow.needsReview", "Needs follow-up review.")}
                </li>
              ))}
            </ul>
          </div>
        )}
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
                  {phaseBadge(phase, result.workflowStepId, "workflow-result-phase", t)}
                </div>
                <div className="workflow-result-badges">
                  {result.verdict && (
                    <span
                      className={`workflow-verdict-badge workflow-verdict-badge--${result.verdict}`}
                      data-testid={`workflow-verdict-badge-${result.workflowStepId}`}
                    >
                      {result.verdict}
                    </span>
                  )}
                  <span
                    className={`workflow-result-badge workflow-result-badge--${result.status}`}
                    data-testid={`workflow-result-badge-${result.workflowStepId}`}
                  >
                    {getStatusLabel(result.status, t)}
                  </span>
                </div>
              </div>

              {result.notes && result.status !== "pending" && (
                <div className="workflow-result-notes" data-testid={`workflow-result-notes-${result.workflowStepId}`}>
                  <span className="workflow-result-notes-label">{t("app:workflow.notes", "Notes:")} </span>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {result.notes}
                  </ReactMarkdown>
                </div>
              )}

              <div className="workflow-result-meta">
                {result.startedAt && (
                  <span className="workflow-result-timestamp">{t("app:workflow.started", "Started:")} {formatTimestamp(result.startedAt)}</span>
                )}
                {result.completedAt && (
                  <span className="workflow-result-duration">{formatDuration(result.startedAt, result.completedAt)}</span>
                )}
              </div>

              {/* Show live agent logs for pending steps, static output for completed steps */}
              {result.status === "pending" && result.startedAt ? (
                <LiveAgentLogOutput
                  entries={liveLogEntries}
                  startedAt={result.startedAt}
                  stepId={result.workflowStepId}
                  t={t}
                />
              ) : result.output ? (
                <div className="workflow-result-output-section">
                  <div className="workflow-result-output-header">
                    <span className="workflow-result-output-label">{t("app:workflow.output", "Output:")} </span>
                    <button
                      type="button"
                      className="btn btn-sm workflow-result-toggle"
                      onClick={() => toggleOutput(result.workflowStepId)}
                      data-testid={`workflow-result-toggle-${result.workflowStepId}`}
                    >
                      {isExpanded ? t("app:workflow.hideOutput", "Hide output") : t("app:workflow.showOutput", "Show output")}
                    </button>
                    {!isExpanded && (
                      <span
                        className="workflow-result-output-preview"
                        data-testid={`workflow-result-preview-${result.workflowStepId}`}
                      >
                        {getOutputPreview(result.output)}
                      </span>
                    )}
                    {isExpanded && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm workflow-result-mode-toggle"
                          onClick={() => toggleRenderMode(result.workflowStepId)}
                          data-testid={`workflow-result-mode-toggle-${result.workflowStepId}`}
                          title={(renderModes[result.workflowStepId] ?? "markdown") === "markdown" ? t("app:workflow.switchToPlain", "Switch to plain text") : t("app:workflow.switchToMarkdown", "Switch to markdown")}
                        >
                          {(renderModes[result.workflowStepId] ?? "markdown") === "markdown" ? t("app:workflow.markdown", "Markdown") : t("app:workflow.plain", "Plain")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon btn-sm workflow-result-expand-toggle"
                          onClick={() => openExpandedView(result.workflowStepId)}
                          data-testid={`workflow-result-expand-${result.workflowStepId}`}
                          title={t("app:workflow.expandOutput", "Expand output")}
                        >
                          <Maximize2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  {isExpanded && (
                    <div
                      className={`workflow-result-output${(renderModes[result.workflowStepId] ?? "markdown") === "markdown" ? " workflow-result-output--markdown" : ""}`}
                      data-testid={`workflow-result-output-${result.workflowStepId}`}
                    >
                      {(renderModes[result.workflowStepId] ?? "markdown") === "markdown" ? (
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {result.output}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <pre className="workflow-result-output-text">
                          {linkifyFilePaths(result.output ?? "")}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const editButton = canEdit ? (
    <button
      type="button"
      className="btn btn-sm workflow-results-edit-toggle"
      onClick={() => setIsEditing((prev) => !prev)}
      data-testid="workflow-steps-edit-toggle"
      aria-label={isEditing ? t("app:workflow.doneEditingAriaLabel", "Done editing workflow steps") : t("app:workflow.editAriaLabel", "Edit workflow steps")}
      title={isEditing ? t("app:workflow.done", "Done") : t("app:workflow.edit", "Edit")}
    >
      {isEditing ? (
        <>
          <Check size={14} />
          {t("app:workflow.done", "Done")}
        </>
      ) : (
        <>
          <Pencil size={14} />
          {t("app:workflow.edit", "Edit")}
        </>
      )}
    </button>
  ) : null;

  const hasEditableStepOptions = workflowStepOptions.length > 0;
  const showConfiguredStepsState = !loading && !hasResults && (hasConfiguredSteps || (canEdit && hasEditableStepOptions));
  const showEditHeaderForResults = canEdit && hasResults;

  const isAwaitingInput = taskStatus === "awaiting-user-input";
  const isAwaitingCliApproval = taskStatus === "awaiting-cli-approval";

  const handleSubmitInput = async () => {
    if (!inputText.trim() || submitting) return;
    setSubmitting(true);
    setResumeError(null);
    try {
      await submitTaskWorkflowInput(taskId, inputText, projectId);
      setInputText("");
      setSubmitted(true);
    } catch (err) {
      setResumeError(getErrorMessage(err) || t("app:workflow.resumeTaskError", "Failed to resume task"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveCli = async () => {
    if (submitting) return;
    setSubmitting(true);
    setResumeError(null);
    try {
      await approveTaskWorkflowCli(taskId, projectId);
      setSubmitted(true);
    } catch (err) {
      setResumeError(getErrorMessage(err) || t("app:workflow.approveCommandError", "Failed to approve command"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="workflow-results-tab" data-task-id={taskId}>
      {isAwaitingInput && (
        <div className="workflow-input-banner" role="alert">
          <strong>{t("app:workflow.awaitingInputTitle", "Waiting for your input")}</strong>
          <span>{parseWorkflowInputQuestion(taskPausedReason, t)}</span>
          {submitted ? (
            <span className="workflow-input-resuming">{t("app:workflow.resuming", "Resuming…")}</span>
          ) : (
            <div className="workflow-input-actions">
              <textarea
                className="workflow-input-textarea"
                rows={3}
                placeholder={t("app:workflow.inputPlaceholder", "Type your reply…")}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={submitting}
              />
              <button
                type="button"
                className="workflow-input-submit"
                onClick={handleSubmitInput}
                disabled={submitting || !inputText.trim()}
              >
                {submitting ? t("app:workflow.submitting", "Submitting…") : t("app:workflow.submitAndResume", "Submit & resume")}
              </button>
              {resumeError && (
                <span className="workflow-input-error" role="alert">{resumeError}</span>
              )}
            </div>
          )}
        </div>
      )}
      {isAwaitingCliApproval && (
        <div className="workflow-input-banner workflow-input-banner--approval" role="alert">
          <strong>{t("app:workflow.cliApprovalTitle", "Approve CLI command?")}</strong>
          <span className="workflow-input-approval-warning">
            {t("app:workflow.cliApprovalWarning", "This command will run in the task worktree. Approving trusts this exact command for future runs.")}
          </span>
          <pre className="workflow-input-approval-command"><code>{parseCliApprovalCommand(taskPausedReason)}</code></pre>
          {submitted ? (
            <span className="workflow-input-resuming">{t("app:workflow.resuming", "Resuming…")}</span>
          ) : (
            <div className="workflow-input-actions">
              <button
                type="button"
                className="workflow-input-submit"
                onClick={handleApproveCli}
                disabled={submitting}
              >
                {submitting ? t("app:workflow.approving", "Approving…") : t("app:workflow.approveAndRun", "Approve & run")}
              </button>
              <span className="workflow-input-keep-paused">{t("app:workflow.cliApprovalRejectHint", "To reject, keep the task paused and do not approve.")}</span>
              {resumeError && (
                <span className="workflow-input-error" role="alert">{resumeError}</span>
              )}
            </div>
          )}
        </div>
      )}
      <section className="card workflow-state-summary" data-testid="workflow-state-summary">
        <div className="workflow-state-summary__header">
          <h4>{t("app:workflow.overview", "Workflow overview")}</h4>
        </div>
        <div className="workflow-state-summary__grid">
          <div className="workflow-state-summary__item" data-testid="workflow-state-summary-name">
            <span className="workflow-state-summary__label">{t("app:workflow.workflowName", "Workflow")}</span>
            <span className="workflow-state-summary__value">{workflowName}</span>
          </div>
          <div className="workflow-state-summary__item" data-testid="workflow-state-summary-phase">
            <span className="workflow-state-summary__label">{t("app:workflow.executionPhase", "Execution phase")}</span>
            <span className={`workflow-result-badge ${executionPhase.badgeClass}`} data-testid={`workflow-phase-badge-${executionPhase.testId}`}>
              {executionPhase.label}
            </span>
          </div>
          <div className="workflow-state-summary__item" data-testid="workflow-state-summary-aggregate">
            <span className="workflow-state-summary__label">{t("app:workflow.aggregateResult", "Aggregate result")}</span>
            <span className={`workflow-result-badge ${aggregateResult.badgeClass}`} data-testid={`workflow-aggregate-badge-${aggregateResult.testId}`}>
              {aggregateResult.label}
            </span>
          </div>
          <div className="workflow-state-summary__item" data-testid="workflow-state-summary-count">
            <span className="workflow-state-summary__label">{t("app:workflow.stepProgress", "Step count")}</span>
            <span className="workflow-state-summary__value">{t("app:workflow.stepProgressValue", "{{completed}} of {{total}} steps completed", { completed: completedStepCount, total: results.length })}</span>
          </div>
        </div>
      </section>

      <section className="card workflow-disclosure" data-testid="workflow-graph-section">
        <button
          type="button"
          className="workflow-disclosure__toggle"
          onClick={() => setGraphExpanded((prev) => !prev)}
          data-testid="workflow-graph-toggle"
        >
          <span className="workflow-disclosure__title">
            {graphExpanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            {t("app:workflow.graph", "Workflow graph")}
          </span>
        </button>
        {graphExpanded && (
          <div className="workflow-disclosure__content">
            {!effectiveWorkflowId ? (
              <p className="workflow-disclosure__empty" data-testid="workflow-graph-empty">
                {t("app:workflow.noWorkflowAssigned", "No workflow assigned")}
              </p>
            ) : workflowGraphLoading && !graphWorkflow ? (
              <div className="workflow-results-loading" data-testid="workflow-graph-loading">
                <div className="workflow-results-spinner" />
                <span>{t("app:workflow.loadingGraph", "Loading workflow graph…")}</span>
              </div>
            ) : graphFlow ? (
              <div className="workflow-graph-preview" data-testid="workflow-graph-preview">
                <ReactFlowProvider>
                  <ReactFlow
                    nodes={graphFlow.nodes}
                    edges={graphFlow.edges}
                    nodeTypes={workflowNodeTypes}
                    fitView
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    zoomOnScroll={false}
                    panOnDrag={false}
                    preventScrolling={false}
                    attributionPosition="bottom-left"
                  />
                </ReactFlowProvider>
              </div>
            ) : (
              <p className="workflow-disclosure__empty" data-testid="workflow-graph-unavailable">
                {t("app:workflow.graphUnavailable", "Workflow graph unavailable")}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="card workflow-management" data-testid="workflow-management-section">
        <div className="workflow-management__header">
          <h4>{t("app:workflow.workflowName", "Workflow")}</h4>
          {canEdit && effectiveWorkflowId && onEditWorkflow && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onEditWorkflow}
              data-testid="workflow-edit-button"
            >
              <Pencil aria-hidden />
              {t("app:workflow.editWorkflow", "Edit workflow")}
            </button>
          )}
        </div>
        <WorkflowSelector
          value={selectedWorkflowId}
          onChange={handleWorkflowSelect}
          projectId={projectId}
          label={t("app:workflow.customWorkflowLabel", "Custom workflow")}
          disabled={!canEdit}
        />
      </section>

      <section className="card workflow-disclosure" data-testid="workflow-model-settings-section">
        <button
          type="button"
          className="workflow-disclosure__toggle"
          onClick={() => setModelSettingsExpanded((prev) => !prev)}
          data-testid="workflow-model-settings-toggle"
        >
          <span className="workflow-disclosure__title">
            {modelSettingsExpanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            {t("app:workflow.modelSettings", "Model settings")}
          </span>
        </button>
        {modelSettingsExpanded && (
          <div className="workflow-disclosure__content workflow-state-summary__grid" data-testid="workflow-model-settings-content">
            {[
              { key: "executor", label: t("models.targetLabels.executor", "Executor"), value: formatModelValue(effectiveExecutor, t), provider: effectiveExecutor?.provider },
              { key: "reviewer", label: t("models.targetLabels.validator", "Reviewer"), value: formatModelValue(effectiveValidator, t), provider: effectiveValidator?.provider },
              { key: "planning", label: t("models.targetLabels.planning", "Planning"), value: formatModelValue(effectivePlanning, t), provider: effectivePlanning?.provider },
              { key: "thinking", label: t("app:workflow.thinkingLevel", "Thinking level"), value: task?.thinkingLevel || "Default" },
            ].map((item) => (
              <div className="workflow-state-summary__item" key={item.key} data-testid={`workflow-model-setting-${item.key}`}>
                <span className="workflow-state-summary__label">{item.label}</span>
                <span className="workflow-state-summary__value workflow-model-value">
                  {item.provider ? <ProviderIcon provider={item.provider} size="sm" /> : null}
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {showConfiguredStepsState ? (
        <div className="workflow-configured-steps" data-testid="workflow-configured-steps">
          <div className="workflow-configured-header" data-testid="workflow-configured-header">
            <div className="workflow-configured-title-row">
              <h4>{t("app:workflow.configuredSteps", "Configured Workflow Steps")}</h4>
              <span className="workflow-configured-count" data-testid="workflow-configured-count">
                {t("app:workflow.stepCount", { count: configuredSteps.length, defaultValue_one: "{{count}} step", defaultValue_other: "{{count}} steps" })}
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
                  <span className="workflow-configured-name-text">{step.name}</span>
                  {phaseBadge(step.phase, step.id, "workflow-configured-phase", t)}
                </div>
                <p className="workflow-configured-description">{step.description}</p>
              </div>
            ))}
          </div>

          <p className="workflow-results-empty-hint">
            {t("app:workflow.stepsExplanation", "Pre-merge steps run after implementation, before merge. Post-merge steps run after merge succeeds.")}
          </p>

          {renderEditor()}
        </div>
      ) : (
        <>
          {showEditHeaderForResults && (
            <div className="workflow-results-edit-header" data-testid="workflow-results-edit-header">
              <h4>{t("app:workflow.steps", "Workflow Steps")}</h4>
              {editButton}
            </div>
          )}
          {renderResults()}
          {renderEditor()}
        </>
      )}

      {/* Expanded Output Modal */}
      {expandedViewStepId && (() => {
        const result = results.find((r) => r.workflowStepId === expandedViewStepId);
        if (!result) return null;

        const renderMode = renderModes[result.workflowStepId] ?? "markdown";
        const phase = (result.phase || "pre-merge") as "pre-merge" | "post-merge";

        return (
          <div
            className="workflow-output-modal-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeExpandedView();
            }}
            data-testid="workflow-output-modal"
          >
            <div className="workflow-output-modal" role="dialog" aria-modal="true">
              <div className="workflow-output-modal-header">
                <div className="workflow-output-modal-title">
                  <span className="workflow-output-modal-name">{result.workflowStepName}</span>
                  {phaseBadge(phase, result.workflowStepId, "workflow-output-modal-phase", t)}
                </div>
                <div className="workflow-output-modal-controls">
                  <button
                    type="button"
                    className="btn btn-sm workflow-result-mode-toggle"
                    onClick={() => toggleRenderMode(result.workflowStepId)}
                    data-testid="workflow-output-modal-mode-toggle"
                    title={renderMode === "markdown" ? t("app:workflow.switchToPlain", "Switch to plain text") : t("app:workflow.switchToMarkdown", "Switch to markdown")}
                  >
                    {renderMode === "markdown" ? t("app:workflow.markdown", "Markdown") : t("app:workflow.plain", "Plain")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon btn-sm workflow-output-modal-close"
                    onClick={closeExpandedView}
                    data-testid="workflow-output-modal-close"
                    aria-label={t("actions.close", "Close")}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              <div className="workflow-output-modal-body">
                <div
                  className={`workflow-result-output workflow-result-output--expanded${renderMode === "markdown" ? " workflow-result-output--markdown" : ""}`}
                  data-testid="workflow-output-modal-content"
                >
                  {renderMode === "markdown" ? (
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {result.output}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <pre className="workflow-result-output-text">{linkifyFilePaths(result.output ?? "")}</pre>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
