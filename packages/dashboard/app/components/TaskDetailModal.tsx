import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Bot, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskDetail, TaskAttachment, Column, MergeResult, PrInfo, Settings, AgentLogEntry, Agent } from "@fusion/core";
import { COLUMN_LABELS, VALID_TRANSITIONS } from "@fusion/core";
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
import { CommitDiffTab } from "./CommitDiffTab";
import { TaskForm, type PendingImage } from "./TaskForm";
import { WorkflowResultsTab } from "./WorkflowResultsTab";

interface ModelSelection {
  provider?: string;
  modelId?: string;
}

function normalizeModelField(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function getExecutorSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.modelProvider),
    modelId: normalizeModelField(task.modelId),
  };
}

function getValidatorSelection(task: Task | TaskDetail): ModelSelection {
  return {
    provider: normalizeModelField(task.validatorModelProvider),
    modelId: normalizeModelField(task.validatorModelId),
  };
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

type TabId = "definition" | "logs" | "changes" | "commits" | "comments" | "model" | "workflow";

interface TaskDetailModalProps {
  task: TaskDetail;
  projectId?: string;
  tasks?: Task[];
  onClose: () => void;
  onOpenDetail: (task: TaskDetail) => void; // For clicking dependencies
  onMoveTask: (id: string, column: Column) => Promise<Task>;
  onDeleteTask: (id: string) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
  githubTokenConfigured?: boolean;
  /** Open the modal with this tab active instead of "definition" */
  initialTab?: TabId;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

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
  githubTokenConfigured,
  initialTab = "definition",
}: TaskDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  // Sync activeTab when the caller changes initialTab (e.g. opening a different tab)
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const [logSubview, setLogSubview] = useState<"activity" | "agent-log">("activity");
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
  const [specEditContent, setSpecEditContent] = useState(task.prompt || "");
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
  const [editPresetMode, setEditPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [editSelectedPresetId, setEditSelectedPresetId] = useState("");
  const [editSelectedWorkflowSteps, setEditSelectedWorkflowSteps] = useState<string[]>(task.enabledWorkflowSteps || []);
  const [editPendingImages, setEditPendingImages] = useState<PendingImage[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const mountedRef = useRef(false);

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
    setIsEditing(false);
  }, [task.id, task.title, task.description]);

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
      .catch((err: any) => {
        if (!cancelled) {
          addToast(`Failed to load workflow results: ${err.message}`, "error");
        }
      })
      .finally(() => {
        if (!cancelled) setWorkflowResultsLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab, task.id, projectId, addToast]);

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

  // Reset spec edit state when task changes
  useEffect(() => {
    setIsEditingSpec(false);
    setSpecEditContent(task.prompt || "");
    setSpecFeedback("");
  }, [task.id, task.prompt]);

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
    setEditPresetMode(execModel || valModel || planModel ? "custom" : "default");
    setEditSelectedPresetId("");
    setEditSelectedWorkflowSteps(task.enabledWorkflowSteps || []);
    setEditPendingImages([]);
  }, [canEdit, task]);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditDependencies(task.dependencies || []);
    editPendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setEditPendingImages([]);
  }, [task.title, task.description, task.dependencies, editPendingImages]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      // Build update payload with all changed fields
      const executorSlashIdx = editExecutorModel.indexOf("/");
      const validatorSlashIdx = editValidatorModel.indexOf("/");
      const planningSlashIdx = editPlanningModel.indexOf("/");

      const updates: Parameters<typeof updateTask>[1] = {
        title: editTitle.trim() || undefined,
        description: editDescription.trim() || undefined,
        dependencies: editDependencies,
        enabledWorkflowSteps: editSelectedWorkflowSteps,
        modelProvider: editExecutorModel && executorSlashIdx !== -1 ? editExecutorModel.slice(0, executorSlashIdx) : null,
        modelId: editExecutorModel && executorSlashIdx !== -1 ? editExecutorModel.slice(executorSlashIdx + 1) : null,
        validatorModelProvider: editValidatorModel && validatorSlashIdx !== -1 ? editValidatorModel.slice(0, validatorSlashIdx) : null,
        validatorModelId: editValidatorModel && validatorSlashIdx !== -1 ? editValidatorModel.slice(validatorSlashIdx + 1) : null,
        planningModelProvider: editPlanningModel && planningSlashIdx !== -1 ? editPlanningModel.slice(0, planningSlashIdx) : null,
        planningModelId: editPlanningModel && planningSlashIdx !== -1 ? editPlanningModel.slice(planningSlashIdx + 1) : null,
      };

      await updateTask(task.id, updates, projectId);

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
    } catch (err: any) {
      addToast(`Failed to update ${task.id}: ${err.message}`, "error");
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [task.id, editTitle, editDescription, editDependencies, editExecutorModel, editValidatorModel, editPlanningModel, editSelectedWorkflowSteps, editPendingImages, addToast, projectId]);

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
  const { entries: agentLogEntries, loading: agentLogLoading } = useAgentLogs(
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
      } catch (err: any) {
        addToast(err.message, "error");
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
    } catch (err: any) {
      addToast(err.message, "error");
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
      .catch((err: any) => {
        addToast(err.message, "error");
      });
  }, [task.id, onMergeTask, onClose, addToast]);

  const handleRetry = useCallback(async () => {
    if (!onRetryTask) return;
    try {
      await onRetryTask(task.id);
      onClose();
      addToast(`Retrying ${task.id}...`, "info");
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onRetryTask, onClose, addToast]);

  const handleDuplicate = useCallback(async () => {
    if (!onDuplicateTask) return;
    if (!confirm(`Duplicate ${task.id}? This will create a new task in Triage with the same description and prompt.`)) return;
    try {
      const newTask = await onDuplicateTask(task.id);
      onClose();
      addToast(`Duplicated ${task.id} → ${newTask.id}`, "success");
    } catch (err: any) {
      addToast(err.message, "error");
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
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, task.paused, onClose, addToast]);

  const handleApprovePlan = useCallback(async () => {
    try {
      await approvePlan(task.id, projectId);
      addToast(`Plan approved — ${task.id} moved to Todo`, "success");
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onClose, addToast]);

  const handleRejectPlan = useCallback(async () => {
    if (!confirm("Reject this plan? The specification will be discarded and regenerated.")) return;
    try {
      await rejectPlan(task.id, projectId);
      addToast(`Plan rejected — ${task.id} returned to Triage for re-specification`, "info");
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, onClose, addToast]);

  const handleRespecify = useCallback(async () => {
    if (!confirm("Rebuild the specification for this task? The task will move to triage for re-specification.")) return;
    try {
      await rebuildTaskSpec(task.id, projectId);
      onClose();
      addToast(`Respecifying ${task.id}...`, "info");
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, projectId, onClose, addToast]);

  const handleOpenRefineModal = useCallback(() => {
    setShowRefineModal(true);
    setRefineFeedback("");
  }, []);

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
    } catch (err: any) {
      addToast(err.message, "error");
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
    } catch (err: any) {
      addToast(err.message, "error");
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
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [task.id, addToast]);

  const handleWorkflowStepsChange = useCallback(async (enabledWorkflowSteps: string[]) => {
    const previousSteps = workflowEnabledSteps;
    setWorkflowEnabledSteps(enabledWorkflowSteps);

    try {
      const updatedTask = await updateTask(task.id, { enabledWorkflowSteps }, projectId);
      addToast("Workflow steps updated", "success");
      onTaskUpdated?.(updatedTask);
    } catch (err: any) {
      setWorkflowEnabledSteps(previousSteps);
      addToast(`Failed to update workflow steps: ${err.message}`, "error");
    }
  }, [task.id, projectId, workflowEnabledSteps, onTaskUpdated, addToast]);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const loadedAgents = await fetchAgents(undefined, projectId);
      setAgents(loadedAgents);
      setShowAgentPicker(true);
    } catch (err: any) {
      addToast(`Failed to load agents: ${err.message}`, "error");
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
    } catch (err: any) {
      addToast(`Failed to assign agent: ${err.message}`, "error");
    }
  }, [task.id, projectId, agents, onTaskUpdated, addToast]);

  const handleClearAgent = useCallback(async () => {
    try {
      const updatedTask = await assignTask(task.id, null, projectId);
      setAssignedAgent(null);
      setShowAgentPicker(false);
      onTaskUpdated?.(updatedTask);
      addToast("Agent unassigned", "success");
    } catch (err: any) {
      addToast(`Failed to unassign agent: ${err.message}`, "error");
    }
  }, [task.id, projectId, onTaskUpdated, addToast]);

  const handleAddDep = useCallback(async (depId: string) => {
    const newDeps = [...dependencies, depId];
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps }, projectId);
    } catch (err: any) {
      setDependencies(dependencies);
      addToast(err.message, "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleRemoveDep = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent triggering dependency click
    const newDeps = dependencies.filter((d) => d !== depId);
    setDependencies(newDeps);
    try {
      await updateTask(task.id, { dependencies: newDeps }, projectId);
    } catch (err: any) {
      setDependencies(dependencies);
      addToast(err.message, "error");
    }
  }, [task.id, dependencies, addToast]);

  const handleDepClick = useCallback(async (depId: string) => {
    try {
      const detail = await fetchTaskDetail(depId, projectId);
      onOpenDetail(detail);
    } catch (err: any) {
      addToast(`Failed to load dependency ${depId}`, "error");
    }
  }, [onOpenDetail, addToast]);

  // Spec save handlers (must be declared before functions that use them)
  const handleSaveSpec = useCallback(async (newContent: string) => {
    setIsSavingSpec(true);
    try {
      await updateTask(task.id, { prompt: newContent }, projectId);
      addToast("Spec updated", "success");
      // Update local task data
      task.prompt = newContent;
    } catch (err: any) {
      addToast(err.message, "error");
      throw err;
    } finally {
      setIsSavingSpec(false);
    }
  }, [task, addToast]);

  const handleRequestSpecRevision = useCallback(async (feedback: string) => {
    setIsRequestingRevision(true);
    try {
      await requestSpecRevision(task.id, feedback, projectId);
      addToast("AI revision requested. Task moved to triage.", "success");
      // Task has been moved to triage, close modal
      onClose();
    } catch (err: any) {
      if (err.message?.includes("in-review") || err.message?.includes("done")) {
        addToast("Cannot request revision: Task must be in 'todo' or 'in-progress' column.", "error");
      } else {
        addToast(err.message, "error");
      }
    } finally {
      setIsRequestingRevision(false);
    }
  }, [task.id, addToast, onClose]);

  // Spec editing handlers (depend on handleSaveSpec and handleRequestSpecRevision)
  const enterSpecEditMode = useCallback(() => {
    setIsEditingSpec(true);
    setSpecEditContent(task.prompt || "");
    setSpecFeedback("");
  }, [task.prompt]);

  const exitSpecEditMode = useCallback(() => {
    setIsEditingSpec(false);
    setSpecEditContent(task.prompt || "");
    setSpecFeedback("");
  }, [task.prompt]);

  const handleSaveSpecFromEdit = useCallback(async () => {
    if (specEditContent === (task.prompt || "")) {
      exitSpecEditMode();
      return;
    }
    await handleSaveSpec(specEditContent);
    setIsEditingSpec(false);
  }, [specEditContent, task.prompt, handleSaveSpec, exitSpecEditMode]);

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

  const transitions = VALID_TRANSITIONS[task.column] || [];
  const prAutomationStatusLabels: Record<string, string> = {
    "creating-pr": "Creating PR…",
    "awaiting-pr-checks": "Awaiting PR checks",
    "merging-pr": "Merging PR…",
  };
  const prAutomationLabel = task.status ? prAutomationStatusLabels[task.status] : undefined;

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
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
            <button className="modal-close" onClick={onClose}>
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
              />
            </div>
          ) : (
            <>
              <h2 className="detail-title">{task.title || task.description}</h2>
              <div className="detail-meta">
                Created {new Date(task.createdAt).toLocaleDateString()} · Updated{" "}
                {new Date(task.updatedAt).toLocaleDateString()}
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
            {task.column === "done" && task.mergeDetails?.commitSha && (
              <button
                className={`detail-tab${activeTab === "commits" ? " detail-tab-active" : ""}`}
                onClick={() => setActiveTab("commits")}
              >
                Commits
              </button>
            )}
            <button
              className={`detail-tab${activeTab === "comments" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("comments")}
            >
              Comments
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
                />
              ) : (
                <div className="detail-activity">
                  <h4>Activity</h4>
                  {task.log && task.log.length > 0 ? (
                    <div className="detail-activity-list">
                      {[...task.log].reverse().map((entry, i) => (
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
            <TaskChangesTab taskId={task.id} worktree={task.worktree} projectId={projectId} column={task.column} mergeDetails={task.mergeDetails} />
          ) : activeTab === "commits" ? (
            <CommitDiffTab commitSha={task.mergeDetails?.commitSha ?? ""} mergeDetails={task.mergeDetails} />
          ) : activeTab === "comments" ? (
            <TaskComments task={task} addToast={addToast} projectId={projectId} onTaskUpdated={onTaskUpdated} />
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
          <div className="detail-section detail-agent-section">
            <div className="detail-meta-row">
              <span className="detail-meta-label">
                <Bot size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
                Agent
              </span>
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
            {task.steps && task.steps.length > 0 ? (
              <div className="step-progress-wrapper">
                <div className="step-progress-bar">
                  {task.steps.map((step, index) => (
                    <div
                      key={index}
                      className={`step-progress-segment step-progress-segment--${step.status}`}
                      data-tooltip={`${step.name} (${step.status})`}
                      style={{ backgroundColor: getStepStatusColor(step.status) }}
                    />
                  ))}
                </div>
                <span className="step-progress-label">
                  {task.steps.filter(s => s.status === "done").length}/{task.steps.length} steps
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
                    disabled={specEditContent === (task.prompt || "") || isSavingSpec}
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
            ) : task.prompt ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {task.prompt.replace(/^#\s+[^\n]*\n+/, "")}
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
                {attachments.map((a) => (
                  <div key={a.filename} className="detail-attachment-card">
                    <a
                      className="detail-attachment-link"
                      href={`/api/tasks/${task.id}/attachments/${a.filename}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <img
                        src={`/api/tasks/${task.id}/attachments/${a.filename}`}
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
                ))}
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
                {dependencies.map((dep) => (
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
                      {dep}
                    </span>
                    <button
                      className="dep-remove-btn"
                      onClick={(e) => handleRemoveDep(e, dep)}
                      title={`Remove dependency ${dep}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
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
              hasGitHubToken={githubTokenConfigured ?? false}
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
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>
            Delete
          </button>
          {onDuplicateTask && (
            <button className="btn btn-sm" onClick={handleDuplicate}>
              Duplicate
            </button>
          )}
          {(task.column === "done" || task.column === "in-review") && (
            <button className="btn btn-sm" onClick={handleOpenRefineModal}>
              Refine
            </button>
          )}
          {task.column !== "triage" && (
            <button className="btn btn-sm" onClick={handleRespecify}>
              Respecify
            </button>
          )}
          {(task.status === "failed" || task.status === "stuck-killed") && onRetryTask && (
            <button className="btn btn-warning btn-sm" onClick={handleRetry}>
              Retry
            </button>
          )}
          {task.column !== "done" && (
            <button className="btn btn-sm" onClick={handleTogglePause}>
              {task.paused ? "Unpause" : "Pause"}
            </button>
          )}
          {/* Approve/Reject Plan buttons for tasks awaiting approval */}
          {task.column === "triage" && task.status === "awaiting-approval" && task.prompt && (
            <>
              <button className="btn btn-primary btn-sm" onClick={handleApprovePlan}>
                Approve Plan
              </button>
              <button className="btn btn-danger btn-sm" onClick={handleRejectPlan}>
                Reject Plan
              </button>
            </>
          )}
          <div className="modal-actions-spacer" />
          {task.column === "in-review" ? (
            <>
              <button className="btn btn-sm" onClick={() => handleMove("todo")}>
                Retry
              </button>
              <button className="btn btn-sm" onClick={() => handleMove("in-progress")}>
                Back to In Progress
              </button>
              {prAutomationLabel ? (
                <button className="btn btn-primary btn-sm" disabled>
                  {prAutomationLabel}
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={handleMerge}>
                  Merge &amp; Close
                </button>
              )}
            </>
          ) : (
            transitions.map((col) => (
              <button key={col} className="btn btn-sm" onClick={() => handleMove(col)}>
                Move to {COLUMN_LABELS[col]}
              </button>
            ))
          )}
            </>
          )}
        </div>
        {showRefineModal && (
          <div
            className="modal-overlay open detail-refine-overlay"
            onClick={handleCloseRefineModal}
          >
            <div
              className="modal detail-refine-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h3 className="detail-refine-title">Refine</h3>
                <button className="modal-close" onClick={handleCloseRefineModal}>
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
