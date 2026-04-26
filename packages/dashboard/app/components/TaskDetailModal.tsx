import "./TaskDetailModal.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Bot, X, ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskDetail, TaskAttachment, Column, MergeResult, Settings, AgentLogEntry, Agent, TaskPriority, TaskSourceIssue } from "@fusion/core";
import { COLUMN_LABELS, DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, VALID_TRANSITIONS, getErrorMessage } from "@fusion/core";
import { uploadAttachment, deleteAttachment, updateTask, pauseTask, unpauseTask, fetchTaskDetail, fetchSettings, requestSpecRevision, rebuildTaskSpec, approvePlan, rejectPlan, refineTask, fetchWorkflowResults, assignTask, fetchAgents, fetchAgent } from "../api";
import type { WorkflowStepResult } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { useAgentLogs } from "../hooks/useAgentLogs";
import { AgentLogViewer } from "./AgentLogViewer";
import { ModelSelectorTab } from "./ModelSelectorTab";
import { PrSection } from "./PrSection";
import { TaskComments } from "./TaskComments";
import { MergeDetails } from "./MergeDetails";
import { TaskChangesTab } from "./TaskChangesTab";
import { TaskForm, type PendingImage } from "./TaskForm";
import { WorkflowResultsTab } from "./WorkflowResultsTab";
import { TaskDocumentsTab } from "./TaskDocumentsTab";
import { TaskTokenStatsPanel } from "./TaskTokenStatsPanel";
import { PluginSlot } from "./PluginSlot";
import { ProviderIcon } from "./ProviderIcon";
import { subscribeSse } from "../sse-bus";
import { usePluginUiSlots } from "../hooks/usePluginUiSlots";
import { appendTokenQuery } from "../auth";

interface ModelSelection {
  provider?: string;
  modelId?: string;
}



/**
 * Resolve the effective executor model following the engine's resolution order:
 * 1. Per-task modelProvider/modelId (both must be set)
 * 2. Global settings defaultProvider/defaultModelId
 */
function resolveEffectiveExecutor(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  if (task.modelProvider && task.modelId) {
    return { provider: task.modelProvider, modelId: task.modelId };
  }
  if (settings?.defaultProvider && settings.defaultModelId) {
    return { provider: settings.defaultProvider, modelId: settings.defaultModelId };
  }
  return {};
}

/**
 * Resolve the effective validator model following the engine's resolution order:
 * 1. Per-task validatorModelProvider/validatorModelId (both must be set)
 * 2. Project settings validatorProvider/validatorModelId
 * 3. Global settings defaultProvider/defaultModelId
 */
function resolveEffectiveValidator(
  task: Task | TaskDetail,
  settings?: Settings,
): ModelSelection {
  if (task.validatorModelProvider && task.validatorModelId) {
    return { provider: task.validatorModelProvider, modelId: task.validatorModelId };
  }
  if (settings?.validatorProvider && settings.validatorModelId) {
    return { provider: settings.validatorProvider, modelId: settings.validatorModelId };
  }
  if (settings?.defaultProvider && settings.defaultModelId) {
    return { provider: settings.defaultProvider, modelId: settings.defaultModelId };
  }
  return {};
}

/**
 * Extract planning/triage model from agent log entries.
 * Looks for text entries with agent role "triage" matching the pattern:
 *   "Triage using model: <provider>/<modelId>"
 * Returns the latest match, or null if none found.
 */
function extractPlanningModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  // Iterate in chronological order; last match wins
  let result: { provider: string; modelId: string } | null = null;
  for (const entry of entries) {
    if (entry.agent !== "triage" || entry.type !== "text") continue;
    const match = entry.text.match(/^Triage using model: (.+?)\/(.+)$/);
    if (match) {
      result = { provider: match[1], modelId: match[2] };
    }
  }
  return result;
}

/**
 * Resolve the effective planning/triage model following the resolution order:
 * 1. Per-task planningModelProvider/planningModelId override
 * 2. Runtime triage model from agent log marker (if present)
 * 3. Project settings planningProvider/planningModelId
 * 4. Global settings defaultProvider/defaultModelId
 */
function resolveEffectivePlanning(
  task: Task | TaskDetail,
  logEntries: AgentLogEntry[],
  settings?: Settings,
): ModelSelection {
  // 1. Per-task override takes precedence
  if (task.planningModelProvider && task.planningModelId) {
    return { provider: task.planningModelProvider, modelId: task.planningModelId };
  }
  // 2. Runtime triage model from agent log marker
  const fromLog = extractPlanningModelFromLog(logEntries);
  if (fromLog) {
    return fromLog;
  }
  // 3. Project settings planningProvider/planningModelId
  if (settings?.planningProvider && settings.planningModelId) {
    return { provider: settings.planningProvider, modelId: settings.planningModelId };
  }
  // 4. Global settings defaultProvider/defaultModelId
  if (settings?.defaultProvider && settings.defaultModelId) {
    return { provider: settings.defaultProvider, modelId: settings.defaultModelId };
  }
  return {};
}

function getStepStatusColor(status: string): string {
  switch (status) {
    case "done":
      return "var(--color-success, #3fb950)";
    case "in-progress":
      return "var(--todo, #58a6ff)";
    case "skipped":
      return "var(--text-dim, #484f58)";
    case "pending":
    default:
      return "var(--border, #30363d)";
  }
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type TabId = "definition" | "logs" | "changes" | "comments" | "model" | "workflow" | "documents" | "stats" | `plugin-${string}`;

interface TaskDetailModalProps {
  task: Task | TaskDetail;
  projectId?: string;
  tasks?: Task[];
  onClose: () => void;
  onOpenDetail: (task: Task | TaskDetail) => void; // For clicking dependencies
  onMoveTask: (id: string, column: Column) => Promise<Task>;
  onDeleteTask: (id: string, options?: { removeDependencyReferences?: boolean }) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  /** Open the modal with this tab active instead of "definition" */
  initialTab?: TabId;
}

function extractDependencyDeleteConflict(err: unknown): { dependentIds: string[] } | null {
  if (!(err instanceof Error)) {
    return null;
  }

  const details = (err as { details?: { code?: string; dependentIds?: unknown } }).details;
  if (details?.code === "TASK_HAS_DEPENDENTS" && Array.isArray(details.dependentIds)) {
    return { dependentIds: details.dependentIds.filter((id): id is string => typeof id === "string") };
  }

  const idsInMessage = err.message.match(/[A-Z]+-\d+/g) ?? [];
  if (idsInMessage.length > 1) {
    return { dependentIds: [...new Set(idsInMessage.slice(1))] };
  }

  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function sameStringArray(a: string[] = [], b: string[] = []): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function splitModelSelection(value: string): { provider: string; modelId: string } | null {
  const slashIdx = value.indexOf("/");
  if (!value || slashIdx === -1) return null;
  return {
    provider: value.slice(0, slashIdx),
    modelId: value.slice(slashIdx + 1),
  };
}

function normalizeSourceIssueText(value: string): string {
  return value.trim();
}

function normalizeSourceIssueUrl(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTaskPriorityValue(priority: Task["priority"]): TaskPriority {
  return typeof priority === "string" && (TASK_PRIORITIES as readonly string[]).includes(priority)
    ? (priority as TaskPriority)
    : DEFAULT_TASK_PRIORITY;
}

function normalizeExecutionModeValue(executionMode: Task["executionMode"]): "standard" | "fast" {
  return executionMode === "fast" ? "fast" : "standard";
}

const DESCRIPTION_TRUNCATE_LENGTH = 200;

const EDITABLE_COLUMNS: Set<Column> = new Set(["triage", "todo"]);

export function TaskDetailModal({
  task,
  projectId,
  tasks = [],
  onClose,
  onOpenDetail,
  onMoveTask,
  onDeleteTask,
  onMergeTask,
  onRetryTask,
  onDuplicateTask,
  onTaskUpdated,
  addToast,
  prAuthAvailable,
  initialTab = "definition",
}: TaskDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  // ── Async detail loading ──────────────────────────────────────────────────
  // When opened optimistically with a Task (no prompt), fetch the full
  // TaskDetail in the background. The modal renders immediately with the
  // lightweight data and shows a loading indicator in the spec section.
  const [fullDetail, setFullDetail] = useState<TaskDetail | null>(() =>
    "prompt" in task ? (task as TaskDetail) : null,
  );
  const [detailLoading, setDetailLoading] = useState(() =>
    !("prompt" in task),
  );

  useEffect(() => {
    // If the prop already has a prompt field, it's a full TaskDetail
    if ("prompt" in task) {
      setFullDetail(task as TaskDetail);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setFullDetail(null);

    fetchTaskDetail(task.id, projectId)
      .then((detail) => {
        if (!cancelled) {
          setFullDetail(detail);
          setDetailLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [task.id, projectId]);

  // Derive a working task that always has all available fields.
  // Falls back to the optimistic Task while loading, uses fullDetail once loaded.
  const workingTask: TaskDetail = fullDetail ?? { ...task, prompt: "" } as TaskDetail;
  const canRetryTask =
    task.status === "failed" ||
    task.status === "stuck-killed" ||
    task.status === "specifying" ||
    task.status === "needs-respecify" ||
    (task.stuckKillCount ?? 0) > 0 ||
    (task.recoveryRetryCount ?? 0) > 0 ||
    Boolean(task.nextRecoveryAt);

  // Sync activeTab when the caller changes initialTab (e.g. opening a different tab)
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Reset description expanded state when task changes
  useEffect(() => {
    setDescriptionExpanded(false);
  }, [task.id]);

  const [logSubview, setLogSubview] = useState<"activity" | "agent-log">("activity");
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [attachments, setAttachments] = useState<TaskAttachment[]>(task.attachments || []);
  const [uploading, setUploading] = useState(false);
  const [dependencies, setDependencies] = useState<string[]>(task.dependencies || []);
  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [assignedAgent, setAssignedAgent] = useState<Agent | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [isSavingSpec, setIsSavingSpec] = useState(false);
  const [isRequestingRevision, setIsRequestingRevision] = useState(false);
  const [isEditingSpec, setIsEditingSpec] = useState(false);
  const [specEditContent, setSpecEditContent] = useState(workingTask.prompt || "");
  const [specFeedback, setSpecFeedback] = useState("");
  const [showRefineModal, setShowRefineModal] = useState(false);
  const [refineFeedback, setRefineFeedback] = useState("");
  const [isRefining, setIsRefining] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title || "");
  const [editDescription, setEditDescription] = useState(task.description || "");
  const [editDependencies, setEditDependencies] = useState<string[]>(task.dependencies || []);
  const [editExecutorModel, setEditExecutorModel] = useState("");
  const [editValidatorModel, setEditValidatorModel] = useState("");
  const [editPlanningModel, setEditPlanningModel] = useState("");
  const [editThinkingLevel, setEditThinkingLevel] = useState("");
  const [editPresetMode, setEditPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [editReviewLevel, setEditReviewLevel] = useState<number | undefined>(undefined);
  const [editPriority, setEditPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [editExecutionMode, setEditExecutionMode] = useState<"standard" | "fast">(normalizeExecutionModeValue(task.executionMode));
  const [editSelectedPresetId, setEditSelectedPresetId] = useState("");
  const [editSelectedWorkflowSteps, setEditSelectedWorkflowSteps] = useState<string[]>(task.enabledWorkflowSteps || []);
  const [editSourceIssueProvider, setEditSourceIssueProvider] = useState(task.sourceIssue?.provider ?? "");
  const [editSourceIssueRepository, setEditSourceIssueRepository] = useState(task.sourceIssue?.repository ?? "");
  const [editSourceIssueExternalId, setEditSourceIssueExternalId] = useState(task.sourceIssue?.externalIssueId ?? "");
  const [editSourceIssueUrl, setEditSourceIssueUrl] = useState(task.sourceIssue?.url ?? "");
  const [editPendingImages, setEditPendingImages] = useState<PendingImage[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const mountedRef = useRef(false);

  // Split-menu dropdown state for footer actions
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  // Plugin UI slots for task-detail-tab
  const { getSlotsForId: getPluginSlots } = usePluginUiSlots(projectId);
  const pluginTabSlots = getPluginSlots("task-detail-tab");

  // Track mount state to avoid setting state on unmounted component
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Merged project settings for effective model resolution in Agent Log header
  const [settings, setSettings] = useState<Settings | undefined>(undefined);

  // Workflow results state
  const [workflowResults, setWorkflowResults] = useState<WorkflowStepResult[]>([]);
  const [workflowResultsLoading, setWorkflowResultsLoading] = useState(false);
  const [workflowEnabledSteps, setWorkflowEnabledSteps] = useState<string[]>(task.enabledWorkflowSteps || []);

  // Reset edit state when task changes
  useEffect(() => {
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    setIsEditing(false);
  }, [task.id, task.title, task.description, task.sourceIssue, task.executionMode]);

  useEffect(() => {
    setWorkflowEnabledSteps(task.enabledWorkflowSteps || []);
  }, [task.id, task.enabledWorkflowSteps]);

  // Load merged settings for effective model resolution
  useEffect(() => {
    let cancelled = false;
    fetchSettings(projectId)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        // Settings fetch failure is non-blocking; fallback to "Using default"
      });
    return () => { cancelled = true; };
  }, [projectId]);

  // Load workflow results when workflow tab is active
  useEffect(() => {
    if (activeTab !== "workflow") return;
    let cancelled = false;
    setWorkflowResultsLoading(true);
    fetchWorkflowResults(task.id, projectId)
      .then((results) => {
        if (!cancelled) setWorkflowResults(results);
      })
      .catch((err) => {
        if (!cancelled) {
          addToast(`Failed to load workflow results: ${getErrorMessage(err)}`, "error");
        }
      })
      .finally(() => {
        if (!cancelled) setWorkflowResultsLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab, task.id, projectId, addToast]);

  // Subscribe to SSE for real-time workflow result updates while workflow tab is active
  useEffect(() => {
    if (activeTab !== "workflow") return;

    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

    const handleTaskUpdated = (e: MessageEvent) => {
      try {
        const updatedTask = JSON.parse(e.data);
        // Only update if this is for our task and has workflow step results
        if (updatedTask.id === task.id && Array.isArray(updatedTask.workflowStepResults)) {
          setWorkflowResults(updatedTask.workflowStepResults);
        }
      } catch {
        // Skip malformed events
      }
    };

    return subscribeSse(`/api/events${query}`, {
      events: { "task:updated": handleTaskUpdated },
    });
  }, [activeTab, task.id, projectId]);

  // Reset dependency search when dropdown closes
  useEffect(() => {
    if (!showDepDropdown) {
      setDepSearch("");
    }
  }, [showDepDropdown]);

  useEffect(() => {
    if (!task.assignedAgentId) {
      setAssignedAgent(null);
      return;
    }

    const knownAgent = agents.find((agent) => agent.id === task.assignedAgentId);
    if (knownAgent) {
      setAssignedAgent(knownAgent);
      return;
    }

    let cancelled = false;
    void fetchAgent(task.assignedAgentId, projectId)
      .then((agent) => {
        if (!cancelled) setAssignedAgent(agent);
      })
      .catch(() => {
        if (!cancelled) setAssignedAgent(null);
      });

    return () => {
      cancelled = true;
    };
  }, [task.assignedAgentId, projectId, agents]);

  useEffect(() => {
    setShowAgentPicker(false);
  }, [task.id]);

  // Close footer dropdown menus on outside click
  useEffect(() => {
    const hasOpenMenu = showMoveMenu || showActionsMenu;
    if (!hasOpenMenu) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inMoveMenu = moveMenuRef.current?.contains(target);
      const inActionsMenu = actionsMenuRef.current?.contains(target);

      if (!inMoveMenu && showMoveMenu) {
        setShowMoveMenu(false);
      }
      if (!inActionsMenu && showActionsMenu) {
        setShowActionsMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMoveMenu, showActionsMenu]);

  // Close footer dropdown menus on Escape key (before modal Escape handler)
  useEffect(() => {
    const hasOpenMenu = showMoveMenu || showActionsMenu;
    if (!hasOpenMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // Prevent modal from closing
        if (showMoveMenu) setShowMoveMenu(false);
        if (showActionsMenu) setShowActionsMenu(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showMoveMenu, showActionsMenu]);

  // Reset spec edit state when task changes
  useEffect(() => {
    setIsEditingSpec(false);
    setSpecEditContent(workingTask.prompt || "");
    setSpecFeedback("");
  }, [task.id, workingTask.prompt]);

  // Note: TaskForm handles auto-focus internally via isActive prop

  // Check if task can be edited
  const canEdit = EDITABLE_COLUMNS.has(task.column) && !isSaving;

  const enterEditMode = useCallback(() => {
    if (!canEdit) return;
    setIsEditing(true);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditDependencies(task.dependencies || []);
    // Populate model overrides from task
    const execModel = task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "";
    const valModel = task.validatorModelProvider && task.validatorModelId ? `${task.validatorModelProvider}/${task.validatorModelId}` : "";
    const planModel = task.planningModelProvider && task.planningModelId ? `${task.planningModelProvider}/${task.planningModelId}` : "";
    setEditExecutorModel(execModel);
    setEditValidatorModel(valModel);
    setEditPlanningModel(planModel);
    setEditThinkingLevel(task.thinkingLevel ?? "");
    setEditPresetMode(execModel || valModel || planModel ? "custom" : "default");
    setEditSelectedPresetId("");
    setEditSelectedWorkflowSteps(task.enabledWorkflowSteps || []);
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditPendingImages([]);
    setEditReviewLevel(task.reviewLevel);
    setEditPriority(normalizeTaskPriorityValue(task.priority));
  }, [canEdit, task]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditDependencies(task.dependencies || []);
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditPriority(normalizeTaskPriorityValue(task.priority));
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    editPendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setEditPendingImages([]);
  }, [task.title, task.description, task.dependencies, task.priority, task.executionMode, editPendingImages]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const updates: Parameters<typeof updateTask>[1] = {};
      const trimmedTitle = editTitle.trim();
      const trimmedDescription = editDescription.trim();

      if (trimmedTitle && trimmedTitle !== (task.title ?? "")) {
        updates.title = trimmedTitle;
      }
      if (trimmedDescription && trimmedDescription !== (task.description ?? "")) {
        updates.description = trimmedDescription;
      }
      if (!sameStringArray(editDependencies, task.dependencies ?? [])) {
        updates.dependencies = editDependencies;
      }
      if (!sameStringArray(editSelectedWorkflowSteps, task.enabledWorkflowSteps ?? [])) {
        updates.enabledWorkflowSteps = editSelectedWorkflowSteps;
      }

      const executorSelection = splitModelSelection(editExecutorModel);
      const currentExecutorModel = task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "";
      if (editExecutorModel !== currentExecutorModel) {
        updates.modelProvider = executorSelection?.provider ?? null;
        updates.modelId = executorSelection?.modelId ?? null;
      }

      const validatorSelection = splitModelSelection(editValidatorModel);
      const currentValidatorModel = task.validatorModelProvider && task.validatorModelId ? `${task.validatorModelProvider}/${task.validatorModelId}` : "";
      if (editValidatorModel !== currentValidatorModel) {
        updates.validatorModelProvider = validatorSelection?.provider ?? null;
        updates.validatorModelId = validatorSelection?.modelId ?? null;
      }

      const planningSelection = splitModelSelection(editPlanningModel);
      const currentPlanningModel = task.planningModelProvider && task.planningModelId ? `${task.planningModelProvider}/${task.planningModelId}` : "";
      if (editPlanningModel !== currentPlanningModel) {
        updates.planningModelProvider = planningSelection?.provider ?? null;
        updates.planningModelId = planningSelection?.modelId ?? null;
      }

      const currentThinkingLevel = task.thinkingLevel ?? "";
      if (editThinkingLevel !== currentThinkingLevel) {
        updates.thinkingLevel = editThinkingLevel !== "" ? (editThinkingLevel as "minimal" | "low" | "medium" | "high") : null;
      }

      const currentReviewLevel = task.reviewLevel;
      if (editReviewLevel !== currentReviewLevel) {
        updates.reviewLevel = editReviewLevel;
      }

      const currentPriority = normalizeTaskPriorityValue(task.priority);
      if (editPriority !== currentPriority) {
        updates.priority = editPriority;
      }

      const currentExecutionMode = normalizeExecutionModeValue(task.executionMode);
      if (editExecutionMode !== currentExecutionMode) {
        updates.executionMode = editExecutionMode === "fast" ? "fast" : null;
      }

      const normalizedProvider = normalizeSourceIssueText(editSourceIssueProvider);
      const normalizedRepository = normalizeSourceIssueText(editSourceIssueRepository);
      const normalizedExternalId = normalizeSourceIssueText(editSourceIssueExternalId);
      const normalizedUrl = normalizeSourceIssueUrl(editSourceIssueUrl);
      const allSourceFieldsEmpty =
        normalizedProvider.length === 0
        && normalizedRepository.length === 0
        && normalizedExternalId.length === 0
        && !normalizedUrl;

      if (allSourceFieldsEmpty) {
        if (task.sourceIssue) {
          updates.sourceIssue = null;
        }
      } else {
        if (!normalizedProvider || !normalizedRepository || !normalizedExternalId) {
          addToast("Source issue provider, repository, and issue identifier are required", "error");
          setIsSaving(false);
          return;
        }

        const fallbackIssueNumber = Number.parseInt(normalizedExternalId, 10);
        const issueNumber = task.sourceIssue?.issueNumber ?? fallbackIssueNumber;
        if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
          addToast("Source issue identifier must be numeric for new metadata", "error");
          setIsSaving(false);
          return;
        }

        const nextSourceIssue: TaskSourceIssue = {
          provider: normalizedProvider,
          repository: normalizedRepository,
          externalIssueId: normalizedExternalId,
          issueNumber,
          ...(normalizedUrl ? { url: normalizedUrl } : {}),
        };

        const previousSourceIssue = task.sourceIssue;
        const sourceIssueChanged =
          !previousSourceIssue
          || previousSourceIssue.provider !== nextSourceIssue.provider
          || previousSourceIssue.repository !== nextSourceIssue.repository
          || previousSourceIssue.externalIssueId !== nextSourceIssue.externalIssueId
          || previousSourceIssue.issueNumber !== nextSourceIssue.issueNumber
          || (previousSourceIssue.url ?? undefined) !== nextSourceIssue.url;

        if (sourceIssueChanged) {
          updates.sourceIssue = nextSourceIssue;
        }
      }

      const hasTaskUpdates = Object.keys(updates).length > 0;
      if (hasTaskUpdates) {
        const updatedTask = await updateTask(task.id, updates, projectId);
        onTaskUpdated?.(updatedTask);
      }

      // Upload pending images as attachments
      if (editPendingImages.length > 0) {
        const failures: string[] = [];
        for (const img of editPendingImages) {
          try {
            const attachment = await uploadAttachment(task.id, img.file, projectId);
            setAttachments((prev) => [...prev, attachment]);
          } catch {
            failures.push(img.file.name);
          }
        }
        if (failures.length > 0) {
          addToast(`Failed to upload: ${failures.join(", ")}`, "error");
        }
      }

      // Clean up
      editPendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setEditPendingImages([]);
      addToast(`Updated ${task.id}`, "success");
      setIsEditing(false);
    } catch (err) {
      addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [task, editTitle, editDescription, editDependencies, editExecutorModel, editValidatorModel, editPlanningModel, editThinkingLevel, editReviewLevel, editPriority, editExecutionMode, editSelectedWorkflowSteps, editSourceIssueProvider, editSourceIssueRepository, editSourceIssueExternalId, editSourceIssueUrl, editPendingImages, addToast, projectId, onTaskUpdated]);

  const handleAutoSaveDescription = useCallback(async (description: string) => {
    try {
      await updateTask(task.id, { description }, projectId);
      addToast("Description saved", "success");
    } catch (err) {
      addToast(`Failed to save: ${getErrorMessage(err)}`, "error");
    }
  }, [task.id, addToast, projectId]);

  // Handle keyboard shortcuts for edit mode
  const handleEditKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isEditing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  }, [isEditing, exitEditMode, handleSave]);

  useEffect(() => {
    if (!isEditing) return;
    document.addEventListener("keydown", handleEditKeyDown);
    return () => document.removeEventListener("keydown", handleEditKeyDown);
  }, [isEditing, handleEditKeyDown]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    entries: agentLogEntries,
    loading: agentLogLoading,
    loadMore: loadMoreAgentLogs,
    hasMore: agentLogHasMore,
    total: agentLogTotal,
    loadingMore: agentLogLoadingMore,
  } = useAgentLogs(
    task.id,
    activeTab === "logs" && logSubview === "agent-log",
    projectId,
  );
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditing) onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, isEditing]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleMove = useCallback(
    async (column: Column) => {
      try {
        await onMoveTask(task.id, column);
        onClose();
        addToast(`Moved to ${COLUMN_LABELS[column]}`, "success");
      } catch (err) {
        addToast(getErrorMessage(err), "error");
      }
    },
    [task.id, onMoveTask, onClose, addToast],
  );

  const handleDelete = useCallback(async () => {
    if (!confirm(`Delete ${task.id}?`)) return;
    try {
      await onDeleteTask(task.id);
      onClose();
      addToast(`Deleted ${task.id}`, "info");
    } catch (err) {
      const conflict = extractDependencyDeleteConflict(err);
      if (!conflict || conflict.dependentIds.length === 0) {
        addToast(getErrorMessage(err), "error");
        return;
      }

      const dependentList = conflict.dependentIds.join(", ");
      const confirmed = confirm(
        `${task.id} is a dependency of ${dependentList}.\n\n` +
        "Delete anyway by removing these dependency references first?",
      );
      if (!confirmed) {
        return;
      }

      try {
        await onDeleteTask(task.id, { removeDependencyReferences: true });
        onClose();
        addToast(`Deleted ${task.id} after removing dependency references`, "info");
      } catch (retryErr) {
        addToast(getErrorMessage(retryErr), "error");
      }
    }
  }, [task.id, onDeleteTask, onClose, addToast]);

  const handleMerge = useCallback(() => {
    if (!confirm(`Merge ${task.id} into the current branch?`)) return;
    onClose();
    addToast(`Merging ${task.id}...`, "info");
    onMergeTask(task.id)
      .then((result) => {
        const msg = result.merged
          ? `Merged ${task.id} (branch: ${result.branch})`
          : `Closed ${task.id} (${result.error || "no branch to merge"})`;
        addToast(msg, "success");
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
      });
  }, [task.id, onMergeTask, onClose, addToast]);

  const handleRetry = useCallback(() => {
    if (!onRetryTask) return;
    onClose();
    onRetryTask(task.id)
      .then(() => {
        addToast(`Retried ${task.id}`, "success");
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
      });
  }, [task.id, onRetryTask, onClose, addToast]);

  const handleDuplicate = useCallback(async () => {
    if (!onDuplicateTask) return;
    if (!confirm(`Duplicate ${task.id}? This will create a new task in Triage with the same description and prompt.`)) return;
    try {
      const newTask = await onDuplicateTask(task.id);
      onClose();
      addToast(`Duplicated ${task.id} → ${newTask.id}`, "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, onDuplicateTask, onClose, addToast]);

  const handleTogglePause = useCallback(async () => {
    try {
      if (task.paused) {
        await unpauseTask(task.id, projectId);
        addToast(`Unpaused ${task.id}`, "success");
      } else {
        await pauseTask(task.id, projectId);
        addToast(`Paused ${task.id}`, "success");
      }
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, task.paused, onClose, addToast]);

  const handleApprovePlan = useCallback(async () => {
    try {
      await approvePlan(task.id, projectId);
      addToast(`Plan approved — ${task.id} moved to Todo`, "success");
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, onClose, addToast]);

  const handleRejectPlan = useCallback(async () => {
    if (!confirm("Reject this plan? The specification will be discarded and regenerated.")) return;
    try {
      await rejectPlan(task.id, projectId);
      addToast(`Plan rejected — ${task.id} returned to Triage for re-specification`, "info");
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, onClose, addToast]);

  const handleRespecify = useCallback(async () => {
    if (!confirm("Rebuild the specification for this task? The task will move to triage for re-specification.")) return;
    try {
      await rebuildTaskSpec(task.id, projectId);
      onClose();
      addToast(`Respecifying ${task.id}...`, "info");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, projectId, onClose, addToast]);

  const handleOpenRefineModal = useCallback(() => {
    setShowRefineModal(true);
    setRefineFeedback("");
  }, []);

  // Helper to close dropdown menus after action
  const closeMenus = useCallback(() => {
    setShowMoveMenu(false);
    setShowActionsMenu(false);
  }, []);

  // Menu item click handlers that close menus after action
  const handleMoveMenuItemClick = useCallback((column: Column) => {
    closeMenus();
    handleMove(column);
  }, [closeMenus]);

  const handleActionsMenuItemClick = useCallback((action: () => void) => {
    closeMenus();
    action();
  }, [closeMenus]);

  const handleMergeMenuItemClick = useCallback(() => {
    closeMenus();
    handleMerge();
  }, [closeMenus]);

  const handleCloseRefineModal = useCallback(() => {
    setShowRefineModal(false);
    setRefineFeedback("");
    setIsRefining(false);
  }, []);

  const handleSubmitRefine = useCallback(async () => {
    if (!refineFeedback.trim()) {
      addToast("Please enter feedback describing what needs refinement", "error");
      return;
    }
    if (refineFeedback.length > 2000) {
      addToast("Feedback must be 2000 characters or less", "error");
      return;
    }
    setIsRefining(true);
    try {
      const newTask = await refineTask(task.id, refineFeedback.trim(), projectId);
      addToast(`Refinement task created: ${newTask.id}`, "success");
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsRefining(false);
    }
  }, [task.id, refineFeedback, addToast, onClose]);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const attachment = await uploadAttachment(task.id, file, projectId);
      setAttachments((prev) => [...prev, attachment]);
      addToast("Screenshot attached", "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setUploading(false);
    }
  }, [task.id, addToast]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [uploadFile]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            uploadFile(file);
            return;
          }
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith("image/")) {
        uploadFile(file);
        return;
      }
    }
  }, [uploadFile]);

  const handleDeleteAttachment = useCallback(async (filename: string) => {
    try {
      await deleteAttachment(task.id, filename, projectId);
      setAttachments((prev) => prev.filter((a) => a.filename !== filename));
      addToast("Attachment deleted", "info");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, addToast]);

  const handleWorkflowStepsChange = useCallback(async (enabledWorkflowSteps: string[]) => {
    const previousSteps = workflowEnabledSteps;
    setWorkflowEnabledSteps(enabledWorkflowSteps);

    try {
      const updatedTask = await updateTask(task.id, { enabledWorkflowSteps }, projectId);
      addToast("Workflow steps updated", "success");
      onTaskUpdated?.(updatedTask);
    } catch (err) {
      setWorkflowEnabledSteps(previousSteps);
      addToast(`Failed to update workflow steps: ${getErrorMessage(err)}`, "error");
    }
  }, [task.id, projectId, workflowEnabledSteps, onTaskUpdated, addToast]);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const loadedAgents = await fetchAgents(undefined, projectId);
      setAgents(loadedAgents);
      setShowAgentPicker(true);
    } catch (err) {
      addToast(`Failed to load agents: ${getErrorMessage(err)}`, "error");
      setShowAgentPicker(false);
    } finally {
      setAgentsLoading(false);
    }
  }, [projectId, addToast]);

  const handleAssignAgent = useCallback(async (agentId: string) => {
    try {
      const updatedTask = await assignTask(task.id, agentId, projectId);
      const selected = agents.find((agent) => agent.id === agentId) ?? null;
      if (selected) {
        setAssignedAgent(selected);
      } else {
        setAssignedAgent((prev) => (prev?.id === agentId ? prev : null));
      }
      setShowAgentPicker(false);
      onTaskUpdated?.(updatedTask);
      addToast("Assigned agent updated", "success");
    } catch (err) {
      addToast(`Failed to assign agent: ${getErrorMessage(err)}`, "error");
    }
  }, [task.id, projectId, agents, onTaskUpdated, addToast]);

  const handleClearAgent = useCallback(async () => {
    try {
      const updatedTask = await assignTask(task.id, null, projectId);
      setAssignedAgent(null);
      setShowAgentPicker(false);
      onTaskUpdated?.(updatedTask);
      addToast("Agent unassigned", "success");
    } catch (err) {
      addToast(`Failed to unassign agent: ${getErrorMessage(err)}`, "error");
    }
  }, [task.id, projectId, onTaskUpdated, addToast]);

  const handleAddDep = useCallback(async (depId: string) => {
    const newDeps = [...dependencies, depId];
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps }, projectId);
    } catch (err) {
      setDependencies(dependencies);
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleRemoveDep = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent triggering dependency click
    const newDeps = dependencies.filter((d) => d !== depId);
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps }, projectId);
    } catch (err) {
      setDependencies(dependencies);
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleDepClick = useCallback(async (depId: string) => {
    try {
      const detail = await fetchTaskDetail(depId, projectId);
      onOpenDetail(detail);
    } catch {
      addToast(`Failed to load dependency ${depId}`, "error");
    }
  }, [onOpenDetail, addToast]);

  // Spec save handlers (must be declared before functions that use them)
  const handleSaveSpec = useCallback(async (newContent: string) => {
    setIsSavingSpec(true);
    try {
      await updateTask(workingTask.id, { prompt: newContent }, projectId);
      addToast("Spec updated", "success");
      // Update local detail data
      if (fullDetail) {
        fullDetail.prompt = newContent;
      }
    } catch (err) {
      addToast(getErrorMessage(err), "error");
      throw err;
    } finally {
      setIsSavingSpec(false);
    }
  }, [workingTask, fullDetail, addToast]);

  const handleRequestSpecRevision = useCallback(async (feedback: string) => {
    setIsRequestingRevision(true);
    try {
      await requestSpecRevision(task.id, feedback, projectId);
      addToast("AI revision requested. Task moved to triage.", "success");
      // Task has been moved to triage, close modal
      onClose();
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes("in-review") || msg.includes("done")) {
        addToast("Cannot request revision: Task must be in 'todo' or 'in-progress' column.", "error");
      } else {
        addToast(msg, "error");
      }
    } finally {
      setIsRequestingRevision(false);
    }
  }, [task.id, addToast, onClose]);

  // Spec editing handlers (depend on handleSaveSpec and handleRequestSpecRevision)
  const enterSpecEditMode = useCallback(() => {
    setIsEditingSpec(true);
    setSpecEditContent(workingTask.prompt || "");
    setSpecFeedback("");
  }, [workingTask.prompt]);

  const exitSpecEditMode = useCallback(() => {
    setIsEditingSpec(false);
    setSpecEditContent(workingTask.prompt || "");
    setSpecFeedback("");
  }, [workingTask.prompt]);

  const handleSaveSpecFromEdit = useCallback(async () => {
    if (specEditContent === (workingTask.prompt || "")) {
      exitSpecEditMode();
      return;
    }
    await handleSaveSpec(specEditContent);
    setIsEditingSpec(false);
  }, [specEditContent, workingTask.prompt, handleSaveSpec, exitSpecEditMode]);

  const handleRequestRevisionFromEdit = useCallback(async () => {
    if (!specFeedback.trim()) return;
    await handleRequestSpecRevision(specFeedback.trim());
  }, [specFeedback, handleRequestSpecRevision]);

  // Keyboard shortcuts for spec edit mode
  const handleSpecTextareaKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitSpecEditMode();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSaveSpecFromEdit();
    }
  }, [exitSpecEditMode, handleSaveSpecFromEdit]);

  const availableTasks = tasks
    .filter((t) => t.id !== task.id && !dependencies.includes(t.id))
    .sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return bNum - aNum;
    });

  const assignedAgentLabel = assignedAgent?.name ?? task.assignedAgentId ?? null;
  const detailProviders = useMemo(() => {
    const providers: string[] = [];
    if (workingTask.modelProvider) providers.push(workingTask.modelProvider);
    if (workingTask.validatorModelProvider && !providers.includes(workingTask.validatorModelProvider)) {
      providers.push(workingTask.validatorModelProvider);
    }
    if (workingTask.planningModelProvider && !providers.includes(workingTask.planningModelProvider)) {
      providers.push(workingTask.planningModelProvider);
    }
    return providers;
  }, [workingTask.modelProvider, workingTask.validatorModelProvider, workingTask.planningModelProvider]);

  const transitions = VALID_TRANSITIONS[task.column] || [];
  const prAutomationStatusLabels: Record<string, string> = {
    "creating-pr": "Creating PR…",
    "awaiting-pr-checks": "Awaiting PR checks",
    "merging-pr": "Merging PR…",
  };
  const prAutomationLabel = task.status ? prAutomationStatusLabels[task.status] : undefined;

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick} role="dialog" aria-modal="true">
      <div className="modal modal-lg" onDragOver={handleDragOver} onDrop={handleDrop}>
        <div className="modal-header">
          <div className="detail-title-row">
            <span className="detail-id">{task.id}</span>
            <span className={`detail-column-badge badge-${task.column}`}>
              {COLUMN_LABELS[task.column]}
            </span>
          </div>
          <div className="modal-header-actions">
            {!isEditing && canEdit && (
              <button
                className="modal-edit-btn"
                onClick={enterEditMode}
                title="Edit task"
                aria-label="Edit task"
              >
                <Pencil size={14} />
              </button>
            )}
            <button className="modal-close" onClick={onClose} aria-label="Close">
              &times;
            </button>
          </div>
        </div>
        <div className={`detail-body${activeTab === "logs" && logSubview === "agent-log" && !isEditing ? " detail-body--agent-log" : ""}`}>
          {isEditing ? (
            <div className="modal-edit-form">
              <TaskForm
                mode="edit"
                title={editTitle}
                onTitleChange={setEditTitle}
                description={editDescription}
                onDescriptionChange={setEditDescription}
                dependencies={editDependencies}
                onDependenciesChange={setEditDependencies}
                executorModel={editExecutorModel}
                onExecutorModelChange={setEditExecutorModel}
                validatorModel={editValidatorModel}
                onValidatorModelChange={setEditValidatorModel}
                planningModel={editPlanningModel}
                onPlanningModelChange={setEditPlanningModel}
                thinkingLevel={editThinkingLevel}
                onThinkingLevelChange={setEditThinkingLevel}
                presetMode={editPresetMode}
                onPresetModeChange={setEditPresetMode}
                selectedPresetId={editSelectedPresetId}
                onSelectedPresetIdChange={setEditSelectedPresetId}
                selectedWorkflowSteps={editSelectedWorkflowSteps}
                onWorkflowStepsChange={setEditSelectedWorkflowSteps}
                pendingImages={editPendingImages}
                onImagesChange={setEditPendingImages}
                tasks={tasks.filter((t) => t.id !== task.id)}
                projectId={projectId}
                disabled={isSaving}
                addToast={addToast}
                isActive={isEditing}
                onAutoSaveDescription={handleAutoSaveDescription}
                reviewLevel={editReviewLevel}
                onReviewLevelChange={setEditReviewLevel}
                priority={editPriority}
                onPriorityChange={setEditPriority}
                executionMode={editExecutionMode}
                onExecutionModeChange={setEditExecutionMode}
                renderBelowModelConfiguration={(
                  <div className="form-group detail-source-edit-group">
                    <label>Source Issue</label>
                    <div className="detail-source-edit-grid">
                      <input
                        type="text"
                        className="modal-edit-input"
                        placeholder="Provider (e.g. github)"
                        value={editSourceIssueProvider}
                        onChange={(e) => setEditSourceIssueProvider(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-provider-input"
                      />
                      <input
                        type="text"
                        className="modal-edit-input"
                        placeholder="Repository (e.g. owner/repo)"
                        value={editSourceIssueRepository}
                        onChange={(e) => setEditSourceIssueRepository(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-repository-input"
                      />
                      <input
                        type="text"
                        className="modal-edit-input"
                        placeholder="Issue identifier"
                        value={editSourceIssueExternalId}
                        onChange={(e) => setEditSourceIssueExternalId(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-external-id-input"
                      />
                      <input
                        type="url"
                        className="modal-edit-input"
                        placeholder="Issue URL"
                        value={editSourceIssueUrl}
                        onChange={(e) => setEditSourceIssueUrl(e.target.value)}
                        disabled={isSaving}
                        data-testid="task-source-url-input"
                      />
                    </div>
                    <small>Leave all fields empty to clear source issue metadata.</small>
                  </div>
                )}
              />
            </div>
          ) : (
            <>
              {(() => {
                const displayText = task.title || task.description || task.id;
                const shouldTruncate = !descriptionExpanded && displayText.length > DESCRIPTION_TRUNCATE_LENGTH;
                return (
                  <>
                    <h2 className="detail-title">
                      {shouldTruncate ? displayText.slice(0, DESCRIPTION_TRUNCATE_LENGTH) + "…" : displayText}
                    </h2>
                    {displayText.length > DESCRIPTION_TRUNCATE_LENGTH && (
                      <button
                        className="detail-description-toggle"
                        onClick={() => setDescriptionExpanded(!descriptionExpanded)}
                      >
                        {descriptionExpanded ? "Show less" : "Show more"}
                      </button>
                    )}
                  </>
                );
              })()}
              <div className="detail-meta">
                Created {new Date(task.createdAt).toLocaleDateString()} · Updated{" "}
                {new Date(task.updatedAt).toLocaleDateString()} ·
                <span className={`detail-priority-chip detail-priority-chip--${normalizeTaskPriorityValue(task.priority)}`}>
                  Priority: {normalizeTaskPriorityValue(task.priority)}
                </span>
              </div>
            </>
          )}
          {task.status === "failed" && task.error && (
            <div className="detail-error-alert">
              <span className="detail-error-icon">⚠</span>
              <div className="detail-error-content">
                <div className="detail-error-title">Task Failed</div>
                <div className="detail-error-message">{task.error}</div>
              </div>
            </div>
          )}
          {!isEditing && (
            <>
          <div className="detail-tabs">
            <button
              className={`detail-tab${activeTab === "definition" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("definition")}
            >
              Definition
            </button>
            <button
              className={`detail-tab${activeTab === "logs" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("logs")}
            >
              Logs
            </button>
            {(task.column === "in-progress" || task.column === "in-review" || task.column === "done") && (
              <button
                className={`detail-tab${activeTab === "changes" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("changes")}
              >
                Changes
              </button>
            )}
            <button
              className={`detail-tab${activeTab === "comments" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("comments")}
            >
              Comments
            </button>
            <button
              className={`detail-tab${activeTab === "documents" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("documents")}
            >
              Documents
            </button>
            <button
              className={`detail-tab${activeTab === "model" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("model")}
            >
              Model
            </button>
            <button
              className={`detail-tab${activeTab === "workflow" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("workflow")}
            >
              Workflow
            </button>
            <button
              className={`detail-tab${activeTab === "stats" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("stats")}
            >
              Stats
            </button>
            {/* Plugin tabs */}
            {pluginTabSlots.map((entry, index) => {
              const pluginTabId = `plugin-${index}` as TabId;
              return (
                <button
                  key={`plugin-tab-${entry.pluginId}`}
                  className={`detail-tab${activeTab === pluginTabId ? " detail-tab-active" : ""}`}
                  onClick={() => setActiveTab(pluginTabId)}
                >
                  {entry.slot.label}
                </button>
              );
            })}
          </div>
          {activeTab === "workflow" ? (
            <div className="detail-section">
              <WorkflowResultsTab
                taskId={task.id}
                results={workflowResults}
                loading={workflowResultsLoading}
                enabledWorkflowSteps={workflowEnabledSteps}
                canEdit={canEdit}
                projectId={projectId}
                isTaskInProgress={task.column === "in-progress" && task.status !== "paused"}
                onWorkflowStepsChange={handleWorkflowStepsChange}
              />
            </div>
          ) : activeTab === "model" ? (
            <div className="detail-section">
              <ModelSelectorTab task={task} addToast={addToast} onTaskUpdated={onTaskUpdated} settings={settings} />
            </div>
          ) : activeTab === "logs" ? (
            <div className={`detail-section${logSubview === "agent-log" ? " detail-section--agent-log" : ""}`}>
              <div className="log-subview-toggle">
                <button
                  className={`log-subview-btn${logSubview === "activity" ? " log-subview-btn-active" : ""}`}
                  onClick={() => setLogSubview("activity")}
                >
                  Activity
                </button>
                <button
                  className={`log-subview-btn${logSubview === "agent-log" ? " log-subview-btn-active" : ""}`}
                  onClick={() => setLogSubview("agent-log")}
                >
                  Agent Log
                </button>
              </div>
              {logSubview === "agent-log" ? (
                <AgentLogViewer
                  entries={agentLogEntries}
                  loading={agentLogLoading}
                  executorModel={resolveEffectiveExecutor(task, settings)}
                  validatorModel={resolveEffectiveValidator(task, settings)}
                  planningModel={resolveEffectivePlanning(task, agentLogEntries, settings)}
                  hasMore={agentLogHasMore}
                  onLoadMore={loadMoreAgentLogs}
                  loadingMore={agentLogLoadingMore}
                  totalCount={agentLogTotal}
                />
              ) : (
                <div className="detail-activity">
                  <h4>Activity</h4>
                  {(workingTask as typeof workingTask & { activityLogTruncatedCount?: number }).activityLogTruncatedCount ? (
                    <div className="detail-log-truncated">
                      Showing the most recent {workingTask.log.length} activity entries.
                    </div>
                  ) : null}
                  {workingTask.log && workingTask.log.length > 0 ? (
                    <div className="detail-activity-list">
                      {[...workingTask.log].reverse().map((entry, i) => (
                        <div key={i} className="detail-log-entry">
                          <div className="detail-log-header">
                            <span className="detail-log-timestamp">
                              {formatTimestamp(entry.timestamp)}
                            </span>
                            <span className="detail-log-action">{entry.action}</span>
                          </div>
                          {entry.outcome && (
                            <div className="detail-log-outcome">{entry.outcome}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="detail-log-empty">(no activity)</div>
                  )}
                </div>
              )}
            </div>
          ) : activeTab === "changes" ? (
            <TaskChangesTab taskId={task.id} worktree={task.worktree} projectId={projectId} column={task.column} mergeDetails={task.mergeDetails} modifiedFiles={task.modifiedFiles} />
          ) : activeTab === "comments" ? (
            <TaskComments task={task} addToast={addToast} projectId={projectId} onTaskUpdated={onTaskUpdated} />
          ) : activeTab === "documents" ? (
            <TaskDocumentsTab
              taskId={task.id}
              addToast={addToast}
              projectId={projectId}
              onTaskUpdated={onTaskUpdated}
              canEdit={canEdit}
            />
          ) : typeof activeTab === "string" && activeTab.startsWith("plugin-") ? (
            <div className="detail-section">
              <PluginSlot slotId="task-detail-tab" projectId={projectId} />
            </div>
          ) : activeTab === "stats" ? (
            <div className="detail-section">
              <TaskTokenStatsPanel
                tokenUsage={workingTask.tokenUsage}
                loading={detailLoading}
                task={workingTask}
              />
            </div>
          ) : (
          <>
          {/* Summary section - only for done tasks with summary */}
          {task.column === "done" && task.summary && (
            <div className="detail-section detail-summary">
              <h4>Summary</h4>
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {task.summary}
                </ReactMarkdown>
              </div>
            </div>
          )}
          <MergeDetails task={task} />
          {task.sourceIssue && (
            <div className="detail-section detail-source-section">
              <h4>Source Issue</h4>
              <dl className="detail-source-grid">
                <div>
                  <dt>Provider</dt>
                  <dd>{task.sourceIssue.provider}</dd>
                </div>
                <div>
                  <dt>Repository</dt>
                  <dd>{task.sourceIssue.repository}</dd>
                </div>
                <div>
                  <dt>Issue Identifier</dt>
                  <dd>{task.sourceIssue.externalIssueId}</dd>
                </div>
                <div>
                  <dt>URL</dt>
                  <dd>
                    {task.sourceIssue.url ? (
                      <a
                        className="detail-source-link"
                        href={task.sourceIssue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {task.sourceIssue.url}
                      </a>
                    ) : (
                      <span className="detail-source-empty">(none)</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          <div className="detail-section detail-agent-section">
            <div className="detail-meta-row">
              <div className="detail-meta-left">
                {detailProviders.length > 0 && (
                  <span className="detail-provider-icons" data-testid="detail-provider-icons">
                    {detailProviders.map((provider) => (
                      <ProviderIcon key={provider} provider={provider} size="sm" />
                    ))}
                  </span>
                )}
                <span className="detail-meta-label">
                  <Bot size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
                  Agent
                </span>
              </div>
              <div className="detail-agent-actions">
                {assignedAgentLabel ? (
                  <span className="detail-agent-chip">
                    <Bot size={14} />
                    {assignedAgentLabel}
                    <button
                      className="detail-agent-clear"
                      onClick={() => void handleClearAgent()}
                      title="Unassign agent"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      if (showAgentPicker) {
                        setShowAgentPicker(false);
                      } else {
                        void loadAgents();
                      }
                    }}
                  >
                    Assign Agent
                  </button>
                )}
                {showAgentPicker && (
                  <div className="agent-picker-dropdown">
                    {agentsLoading && <div className="agent-picker-loading">Loading agents...</div>}
                    {!agentsLoading && agents.filter((a) => a.state !== "terminated").map((a) => (
                      <button
                        key={a.id}
                        className={`agent-picker-item${task.assignedAgentId === a.id ? " selected" : ""}`}
                        onClick={() => void handleAssignAgent(a.id)}
                      >
                        <Bot size={14} />
                        <span className="agent-picker-name">{a.name}</span>
                        <span className="agent-picker-role">{a.role}</span>
                      </button>
                    ))}
                    {!agentsLoading && agents.filter((a) => a.state !== "terminated").length === 0 && (
                      <div className="agent-picker-empty">No agents available</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="detail-section detail-step-progress">
            <h4>Progress</h4>
            {workingTask.steps && workingTask.steps.length > 0 ? (
              <div className="step-progress-wrapper">
                <div className="step-progress-bar">
                  {workingTask.steps.map((step, index) => (
                    <div
                      key={index}
                      className={`step-progress-segment step-progress-segment--${step.status}`}
                      data-tooltip={`${step.name} (${step.status})`}
                      style={{ backgroundColor: getStepStatusColor(step.status) }}
                    />
                  ))}
                </div>
                <span className="step-progress-label">
                  {workingTask.steps.filter(s => s.status === "done").length}/{workingTask.steps.length} step{workingTask.steps.length === 1 ? "" : "s"}
                </span>
              </div>
            ) : (
              <div className="step-progress-empty">(no steps defined)</div>
            )}
          </div>
          <div className="detail-section">
            {!isEditingSpec && (
              <div className="detail-spec-edit-trigger">
                <button className="btn btn-sm" onClick={enterSpecEditMode}>
                  Edit
                </button>
              </div>
            )}
            {isEditingSpec ? (
              <div className="spec-editor-edit-mode">
                <textarea
                  className="spec-editor-textarea"
                  value={specEditContent}
                  onChange={(e) => setSpecEditContent(e.target.value)}
                  onKeyDown={handleSpecTextareaKeyDown}
                  disabled={isSavingSpec}
                  placeholder="Enter task specification in Markdown..."
                  rows={12}
                />
                <div className="spec-editor-actions-row">
                  <button
                    className="btn btn-sm"
                    onClick={exitSpecEditMode}
                    disabled={isSavingSpec}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveSpecFromEdit()}
                    disabled={specEditContent === (workingTask.prompt || "") || isSavingSpec}
                  >
                    {isSavingSpec ? "Saving…" : "Save"}
                  </button>
                </div>
                <div className="spec-editor-hint">
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to save · <kbd>Escape</kbd> to cancel
                </div>
                {/* AI Revision Section */}
                <div className="spec-editor-revision">
                  <h4>Ask AI to Revise</h4>
                  <p className="spec-editor-revision-help">
                    Provide feedback for the AI to improve this specification. The task will move to triage for re-specification.
                  </p>
                  <textarea
                    className="spec-editor-feedback"
                    value={specFeedback}
                    onChange={(e) => setSpecFeedback(e.target.value)}
                    placeholder="e.g., 'Add more details about error handling', 'Split this into smaller steps', 'Include tests for the API endpoints'..."
                    disabled={isRequestingRevision}
                    rows={4}
                    maxLength={2000}
                  />
                  <div className="spec-editor-revision-actions">
                    <span className="spec-editor-char-count">
                      {specFeedback.length}/2000
                    </span>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleRequestRevisionFromEdit()}
                      disabled={!specFeedback.trim() || isRequestingRevision}
                    >
                      {isRequestingRevision ? "Requesting…" : "Request AI Revision"}
                    </button>
                  </div>
                </div>
              </div>
            ) : detailLoading ? (
              <div className="spec-loading">Loading specification…</div>
            ) : workingTask.prompt ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {workingTask.prompt.replace(/^#\s+[^\n]*\n+/, "")}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="detail-prompt">(no prompt)</div>
            )}
          </div>
          <div className="detail-section">
            <h4>Attachments</h4>
            {attachments.length > 0 ? (
              <div className="detail-attachments-grid">
                {attachments.map((a) => {
                  const attachmentUrl = appendTokenQuery(`/api/tasks/${task.id}/attachments/${a.filename}`);
                  return (
                    <div key={a.filename} className="detail-attachment-card">
                      <a
                        className="detail-attachment-link"
                        href={attachmentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <img
                          src={attachmentUrl}
                          alt={a.originalName}
                          className="detail-attachment-image"
                        />
                      </a>
                      <div className="detail-attachment-meta">
                        {a.originalName} ({formatBytes(a.size)})
                      </div>
                      <button
                        className="detail-attachment-delete"
                        onClick={() => handleDeleteAttachment(a.filename)}
                        title="Delete attachment"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="detail-empty-inline">(no attachments)</div>
            )}
            <input
              className="detail-hidden-file-input"
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleUpload}
            />
            <button
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : "Attach Screenshot"}
            </button>
          </div>
          <div className="detail-deps">
            <h4>Dependencies</h4>
            {dependencies.length > 0 ? (
              <ul className="detail-dep-list">
                {dependencies.map((dep) => {
                  // Look up dependency metadata from tasks prop
                  const depTask = tasks.find((t) => t.id === dep);
                  const depLabel = depTask?.title || depTask?.description || dep;

                  return (
                    <li key={dep} className="detail-dep-item">
                      <span
                        className="detail-dep-link"
                        onClick={() => handleDepClick(dep)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleDepClick(dep);
                          }
                        }}
                        role="link"
                        tabIndex={0}
                        title={`Click to view ${dep}`}
                      >
                        <span className="detail-dep-id">{dep}</span>
                        <span className="detail-dep-label">{truncate(depLabel, 40)}</span>
                      </span>
                      <button
                        className="dep-remove-btn"
                        onClick={(e) => handleRemoveDep(e, dep)}
                        title={`Remove dependency ${dep}`}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="detail-empty-inline">(no dependencies)</div>
            )}
            <div className="dep-trigger-wrap">
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={() => {
                  if (showDepDropdown) setDepSearch("");
                  setShowDepDropdown((v) => !v);
                }}
              >
                Add Dependency
              </button>
              {showDepDropdown && (() => {
                const term = depSearch.toLowerCase();
                const filtered = term
                  ? availableTasks.filter((t) =>
                      t.id.toLowerCase().includes(term) ||
                      (t.title && t.title.toLowerCase().includes(term)) ||
                      (t.description && t.description.toLowerCase().includes(term))
                    )
                  : availableTasks;
                return (
                  <div className="dep-dropdown">
                    <input
                      className="dep-dropdown-search"
                      placeholder="Search tasks…"
                      autoFocus
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {filtered.length === 0 ? (
                      <div className="dep-dropdown-empty">No available tasks</div>
                    ) : (
                      filtered.map((t) => (
                        <div
                          key={t.id}
                          className="dep-dropdown-item"
                          onClick={() => {
                            handleAddDep(t.id);
                            setShowDepDropdown(false);
                          }}
                        >
                          <span className="dep-dropdown-id">{t.id}</span>
                          <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
          {/* PR Section - only for in-review tasks */}
          {task.column === "in-review" && (
            <PrSection
              taskId={task.id}
              projectId={projectId}
              prInfo={task.prInfo}
              automationStatus={task.status ?? null}
              autoMerge={settings?.autoMerge ?? false}
              prAuthAvailable={prAuthAvailable ?? false}
              onPrCreated={(prInfo) => {
                // Update task locally to show new PR
                (task as TaskDetail).prInfo = prInfo;
                addToast(`PR #${prInfo.number} created`, "success");
              }}
              onPrUpdated={(prInfo) => {
                (task as TaskDetail).prInfo = prInfo;
              }}
              addToast={addToast}
            />
          )}
          </>
          )}
          </>
          )}
        </div>
        <div className="modal-actions">
          {isEditing ? (
            <>
              <span className="modal-edit-hint">
                <kbd>Ctrl+Enter</kbd> to save · <kbd>Escape</kbd> to cancel
              </span>
              <div className="modal-actions-spacer" />
              <button
                className="btn btn-sm"
                onClick={exitEditMode}
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <>
              {/* Approve/Reject Plan buttons for tasks awaiting approval — always visible */}
              {task.column === "triage" && task.status === "awaiting-approval" && workingTask.prompt && (
                <>
                  <button className="btn btn-primary btn-sm" onClick={handleApprovePlan}>
                    Approve Plan
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={handleRejectPlan}>
                    Reject Plan
                  </button>
                </>
              )}

              {/* Standalone Delete button for triage-column tasks — triage tasks
                  hide the Actions dropdown (see condition below) so the user has
                  no quick way to delete a freshly-created task otherwise. */}
              {task.column === "triage" && task.status !== "awaiting-approval" && !canRetryTask && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={handleDelete}
                  aria-label="Delete task"
                  title="Delete task"
                >
                  Delete
                </button>
              )}

              {/* Actions dropdown — less common operations */}
              {(task.column !== "triage" || task.status === "awaiting-approval" || canRetryTask) && (
                <div className="detail-actions-dropdown" ref={actionsMenuRef}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setShowActionsMenu((prev) => !prev);
                      setShowMoveMenu(false);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={showActionsMenu}
                  >
                    Actions
                    <ChevronDown size={12} />
                  </button>
                  {showActionsMenu && (
                    <div className="detail-actions-menu" role="menu">
                      {/* Delete — destructive, always first */}
                      <button
                        className="detail-actions-menu-item detail-actions-menu-item-danger"
                        role="menuitem"
                        onClick={() => handleActionsMenuItemClick(handleDelete)}
                      >
                        Delete
                      </button>

                      {/* Duplicate */}
                      {onDuplicateTask && (
                        <button
                          className="detail-actions-menu-item"
                          role="menuitem"
                          onClick={() => handleActionsMenuItemClick(handleDuplicate)}
                        >
                          Duplicate
                        </button>
                      )}

                      {/* Refine */}
                      {(task.column === "done" || task.column === "in-review") && (
                        <button
                          className="detail-actions-menu-item"
                          role="menuitem"
                          onClick={() => handleActionsMenuItemClick(handleOpenRefineModal)}
                        >
                          Refine
                        </button>
                      )}

                      {/* Respecify */}
                      <button
                        className="detail-actions-menu-item"
                        role="menuitem"
                        onClick={() => handleActionsMenuItemClick(handleRespecify)}
                      >
                        Respecify
                      </button>

                      {/* Retry */}
                      {canRetryTask && onRetryTask && (
                        <button
                          className="detail-actions-menu-item"
                          role="menuitem"
                          onClick={() => handleActionsMenuItemClick(handleRetry)}
                        >
                          Retry
                        </button>
                      )}

                      {/* Pause/Unpause */}
                      {task.column !== "done" && (
                        <button
                          className="detail-actions-menu-item"
                          role="menuitem"
                          onClick={() => handleActionsMenuItemClick(handleTogglePause)}
                        >
                          {task.paused ? "Unpause" : "Pause"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="modal-actions-spacer" />

              {/* Move dropdown — column transitions and merge actions */}
              <div className="detail-move-dropdown" ref={moveMenuRef}>
                {task.column === "in-review" ? (
                  <>
                    {/* In-review: show merge controls inline with Move dropdown for secondary moves */}
                    <div className="detail-move-actions-in-review">
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setShowMoveMenu((prev) => !prev);
                          setShowActionsMenu(false);
                        }}
                        aria-haspopup="menu"
                        aria-expanded={showMoveMenu}
                      >
                        Move
                        <ChevronDown size={12} />
                      </button>
                      {prAutomationLabel ? (
                        <button className="btn btn-primary btn-sm" disabled>
                          {prAutomationLabel}
                        </button>
                      ) : (
                        <button className="btn btn-primary btn-sm" onClick={handleMergeMenuItemClick}>
                          Merge &amp; Close
                        </button>
                      )}
                    </div>
                    {showMoveMenu && (
                      <div className="detail-move-menu" role="menu">
                        <button
                          className="detail-move-menu-item"
                          role="menuitem"
                          onClick={() => handleMoveMenuItemClick("todo")}
                        >
                          Move to Todo
                        </button>
                        <button
                          className="detail-move-menu-item"
                          role="menuitem"
                          onClick={() => handleMoveMenuItemClick("in-progress")}
                        >
                          Back to In Progress
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  /* Other columns: primary action is the first transition, dropdown for more */
                  <>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleMoveMenuItemClick(transitions[0])}
                      disabled={transitions.length === 0}
                    >
                      Move to {transitions.length > 0 ? COLUMN_LABELS[transitions[0]] : ""}
                    </button>
                    {transitions.length > 1 && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            setShowMoveMenu((prev) => !prev);
                            setShowActionsMenu(false);
                          }}
                          aria-haspopup="menu"
                          aria-expanded={showMoveMenu}
                        >
                          <ChevronDown size={12} />
                        </button>
                        {showMoveMenu && (
                          <div className="detail-move-menu" role="menu">
                            {transitions.map((col) => (
                              <button
                                key={col}
                                className="detail-move-menu-item"
                                role="menuitem"
                                onClick={() => handleMoveMenuItemClick(col)}
                              >
                                Move to {COLUMN_LABELS[col]}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {showRefineModal && (
          <div
            className="modal-overlay open detail-refine-overlay"
            onClick={handleCloseRefineModal}
            role="dialog"
            aria-modal="true"
          >
            <div
              className="modal detail-refine-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h3 className="detail-refine-title">Refine</h3>
                <button className="modal-close" onClick={handleCloseRefineModal} aria-label="Close">
                  &times;
                </button>
              </div>
              <div className="detail-body">
                <p className="detail-refine-help">
                  Describe what needs to be refined or improved...
                </p>
                <textarea
                  className="detail-refine-textarea"
                  value={refineFeedback}
                  onChange={(e) => setRefineFeedback(e.target.value)}
                  placeholder="Enter your feedback here..."
                  rows={6}
                  maxLength={2000}
                  autoFocus
                />
                <div className="detail-refine-input-group">
                  <div className="detail-refine-char-count">
                    {refineFeedback.length}/2000 characters
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleSubmitRefine}
                    disabled={!refineFeedback.trim() || isRefining}
                  >
                    {isRefining ? "Creating..." : "Create Refinement Task"}
                  </button>
                </div>
              </div>
              <div className="modal-actions">
                <button className="btn btn-sm" onClick={handleCloseRefineModal} disabled={isRefining}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
