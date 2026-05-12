import "./TaskDetailModal.css";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Bot, X, ChevronDown, ChevronRight, GitBranch, ArrowLeft, Zap } from "lucide-react";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Task, TaskDetail, TaskAttachment, Column, MergeResult, Settings, GlobalSettings, AgentLogEntry, Agent, TaskPriority, TaskSourceIssue, WorkflowStepResult } from "@fusion/core";
import {
  COLUMN_LABELS,
  DEFAULT_TASK_PRIORITY,
  REPO_OVERRIDE_RE,
  TASK_PRIORITIES,
  VALID_TRANSITIONS,
  getErrorMessage,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
} from "@fusion/core";
import { uploadAttachment, deleteAttachment, updateTask, pauseTask, unpauseTask, fetchTaskDetail, fetchSettings, fetchGlobalSettings, requestSpecRevision, rebuildTaskSpec, approvePlan, rejectPlan, refineTask, fetchWorkflowResults, assignTask, fetchAgents, fetchAgent } from "../api";
import type { ToastType } from "../hooks/useToast";
import { useAgentLogs } from "../hooks/useAgentLogs";
import { useConfirm } from "../hooks/useConfirm";
import { AgentLogViewer } from "./AgentLogViewer";
import { ModelSelectorTab } from "./ModelSelectorTab";
import { PrSection } from "./PrSection";
import { TaskComments } from "./TaskComments";
import { TaskReviewTab } from "./TaskReviewTab";
import { MergeDetails } from "./MergeDetails";
import { TaskChangesTab } from "./TaskChangesTab";
import { TaskForm, type PendingImage } from "./TaskForm";
import { useNodes } from "../hooks/useNodes";
import { WorkflowResultsTab } from "./WorkflowResultsTab";
import { RoutingTab } from "./RoutingTab";
import { TaskDocumentsTab } from "./TaskDocumentsTab";
import { TaskTokenStatsPanel } from "./TaskTokenStatsPanel";
import { PluginSlot } from "./PluginSlot";
import { ProviderIcon } from "./ProviderIcon";
import { subscribeSse } from "../sse-bus";
import { usePluginUiSlots } from "../hooks/usePluginUiSlots";
import { appendTokenQuery } from "../auth";
import { extractDependencyDeleteConflict } from "../utils/taskDelete";
import { computeBlockerFanoutMap } from "../hooks/useBlockerFanout";
import { resolveEffectiveGithubRepoDefault } from "./githubTracking";

interface ModelSelection {
  provider?: string;
  modelId?: string;
}

const ACTIVE_STATUSES = new Set(["planning", "researching", "executing", "finalizing", "merging", "merging-fix"]);



/**
 * Resolve the effective executor model following the engine's resolution order:
 * 1. Per-task modelProvider/modelId (both must be set)
 * 2. Project/global execution lane fallback
 */
function extractExecutorModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  for (const entry of entries) {
    if (entry.agent !== "executor" || entry.type !== "text") continue;
    const match = entry.text.match(/^Executor using model: (.+?)\/(.+)$/);
    if (match) {
      result = { provider: match[1], modelId: match[2] };
    }
  }
  return result;
}

function extractReviewerModelFromLog(entries: AgentLogEntry[]): { provider: string; modelId: string } | null {
  let result: { provider: string; modelId: string } | null = null;
  for (const entry of entries) {
    if (entry.agent !== "reviewer" || entry.type !== "text") continue;
    const match = entry.text.match(/^Reviewer using model: (.+?)\/(.+)$/);
    if (match) {
      result = { provider: match[1], modelId: match[2] };
    }
  }
  return result;
}

function extractAssignedRuntimeModel(agent: Agent | null | undefined): ModelSelection {
  const runtimeConfig = (agent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined;
  const model = typeof runtimeConfig?.model === "string" ? runtimeConfig.model.trim() : "";
  if (model) {
    const slashIdx = model.indexOf("/");
    if (slashIdx > 0 && slashIdx < model.length - 1) {
      return {
        provider: model.slice(0, slashIdx),
        modelId: model.slice(slashIdx + 1),
      };
    }
  }

  const provider = typeof runtimeConfig?.modelProvider === "string" ? runtimeConfig.modelProvider.trim() : "";
  const modelId = typeof runtimeConfig?.modelId === "string" ? runtimeConfig.modelId.trim() : "";
  return {
    provider: provider || undefined,
    modelId: modelId || undefined,
  };
}

/**
 * Resolve the effective executor model following the engine's resolution order:
 * 1. Runtime executor model from agent log marker
 * 2. Assigned agent runtime model (active runs only)
 * 3. Per-task modelProvider/modelId override
 * 4. Project/global execution lane fallback
 */
function resolveEffectiveExecutor(
  task: Task | TaskDetail,
  logEntries: AgentLogEntry[],
  assignedAgent: Agent | null,
  settings?: Settings,
): ModelSelection {
  const fromLog = extractExecutorModelFromLog(logEntries);
  if (fromLog) return fromLog;

  if (ACTIVE_STATUSES.has(task.status ?? "") || task.column === "in-progress") {
    const assignedModel = extractAssignedRuntimeModel(assignedAgent);
    if (assignedModel.provider && assignedModel.modelId) {
      return assignedModel;
    }
  }

  return resolveTaskExecutionModel(task, settings);
}

/**
 * Resolve the effective validator model following the engine's resolution order:
 * 1. Runtime reviewer model from agent log marker
 * 2. Assigned agent runtime model (active runs only)
 * 3. Per-task validatorModelProvider/validatorModelId override
 * 4. Project/global validator lane fallback
 */
function resolveEffectiveValidator(
  task: Task | TaskDetail,
  logEntries: AgentLogEntry[],
  assignedAgent: Agent | null,
  settings?: Settings,
): ModelSelection {
  const fromLog = extractReviewerModelFromLog(logEntries);
  if (fromLog) return fromLog;

  if (ACTIVE_STATUSES.has(task.status ?? "") || task.column === "in-progress") {
    const assignedModel = extractAssignedRuntimeModel(assignedAgent);
    if (assignedModel.provider && assignedModel.modelId) {
      return assignedModel;
    }
  }

  return resolveTaskValidatorModel(task, settings);
}

/**
 * Extract planning model from agent log entries.
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
 * Resolve the effective planning model following the resolution order:
 * 1. Per-task planningModelProvider/planningModelId override
 * 2. Runtime triage model from agent log marker (if present)
 * 3. Project/global planning lane fallback
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
  return resolveTaskPlanningModel(task, settings);
}

function getStepStatusColor(status: string): string {
  switch (status) {
    case "done":
      return "var(--color-success)";
    case "in-progress":
      return "var(--in-progress)";
    case "skipped":
      return "var(--text-dim)";
    case "pending":
    default:
      return "var(--border)";
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
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type TabId = "definition" | "logs" | "changes" | "review" | "comments" | "model" | "workflow" | "documents" | "stats" | "routing" | `plugin-${string}`;

export interface TaskDetailModalProps {
  task: Task | TaskDetail;
  projectId?: string;
  tasks?: Task[];
  onClose: () => void;
  onOpenDetail: (task: Task | TaskDetail) => void; // For clicking dependencies
  onMoveTask: (id: string, column: Column, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onDeleteTask: (id: string, options?: { removeDependencyReferences?: boolean }) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onTaskUpdated?: (task: Task) => void;
  addToast: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  /** Open the modal with this tab active instead of "definition" */
  initialTab?: TabId;
  /** Mobile-only header affordance mode. */
  mobileHeaderMode?: "close" | "back";
}

export type TaskDetailContentProps = Omit<TaskDetailModalProps, "onClose"> & {
  embedded?: boolean;
  onRequestClose?: () => void;
};

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

interface ProvenanceDisplay {
  label: string;
  parentTaskId?: string;
  contextInfo?: string;
  sourceAgentId?: string;
}

interface ProvenanceLabelOptions {
  sourceAgentName?: string;
}

function getIssueUrlFromMetadata(metadata: Task["sourceMetadata"]): string | undefined {
  const issueUrl = metadata?.issueUrl;
  return typeof issueUrl === "string" && issueUrl.length > 0 ? issueUrl : undefined;
}

function getResearchContextInfo(metadata: Task["sourceMetadata"]): string | undefined {
  const findingLabel = metadata?.findingLabel;
  if (typeof findingLabel === "string" && findingLabel.length > 0) {
    return findingLabel;
  }

  const runId = metadata?.runId;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

const AgentDetailView = lazy(() => import("./AgentDetailView").then((m) => ({ default: m.AgentDetailView })));

function getProvenanceLabel(task: Task | TaskDetail, options: ProvenanceLabelOptions = {}): ProvenanceDisplay | null {
  switch (task.sourceType) {
    case "dashboard_ui":
      return { label: "Dashboard" };
    case "quick_chat":
      return { label: "Quick Chat" };
    case "chat_session":
      return { label: "Chat Session" };
    case "agent_heartbeat": {
      const sourceLabel = options.sourceAgentName ?? task.sourceAgentId;
      return {
        label: sourceLabel ?? "agent",
        sourceAgentId: task.sourceAgentId,
      };
    }
    case "automation":
      return { label: "Automation" };
    case "cron":
      return { label: "Scheduled Task" };
    case "workflow_step":
      return { label: "Workflow Step" };
    case "github_import": {
      const issueUrl = getIssueUrlFromMetadata(task.sourceMetadata);
      return {
        label: "GitHub Import",
        contextInfo: issueUrl,
      };
    }
    case "research": {
      const contextInfo = getResearchContextInfo(task.sourceMetadata);
      return {
        label: "Research",
        contextInfo,
      };
    }
    case "task_refine":
      return {
        label: "Refinement",
        parentTaskId: task.sourceParentTaskId,
      };
    case "task_duplicate":
      return {
        label: "Duplicate",
        parentTaskId: task.sourceParentTaskId,
      };
    case "cli":
      return { label: "CLI" };
    case "api":
      return { label: "API" };
    case "recovery":
      return { label: "Recovery" };
    case "unknown":
    default:
      return null;
  }
}

const DESCRIPTION_TRUNCATE_LENGTH = 200;

const EDITABLE_COLUMNS: Set<Column> = new Set(["triage", "todo"]);
const GITHUB_TRACKING_EDITABLE_COLUMNS: Set<Column> = new Set(["triage", "todo", "in-progress", "in-review"]);

export function TaskDetailContent({
  task,
  projectId,
  tasks = [],
  onOpenDetail,
  onMoveTask,
  onDeleteTask,
  onMergeTask,
  onRetryTask,
  onResetTask,
  onDuplicateTask,
  onTaskUpdated,
  addToast,
  prAuthAvailable,
  initialTab = "definition",
  mobileHeaderMode = "close",
  embedded = false,
  onRequestClose,
}: TaskDetailContentProps) {
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
  // Live fields (tokenUsage, workflowStepResults, status, column, …) are taken
  // from the parent `task` prop which receives SSE updates, so the stats tab
  // keeps populating while a task runs after the modal was opened. `log` is
  // stripped to [] in SSE payloads (stripTaskListHeavyFields), so we preserve
  // fullDetail.log to keep the Activity timeline populated.
  // FN-4161: board/restart flows open the modal from slim task rows where
  // `githubTracking` is intentionally omitted; preserve the fetched full-detail
  // tracking blob instead of letting the sparse parent prop overwrite it.
  const workingTask: TaskDetail = fullDetail
    ? ({
      ...fullDetail,
      ...task,
      prompt: fullDetail.prompt,
      log: fullDetail.log,
      githubTracking: task.githubTracking ?? fullDetail.githubTracking,
    } as TaskDetail)
    : ({ ...task, prompt: "" } as TaskDetail);
  const canRetryTask =
    task.status === "failed" ||
    task.status === "stuck-killed" ||
    task.status === "planning" ||
    task.status === "needs-replan" ||
    (task.stuckKillCount ?? 0) > 0 ||
    (task.recoveryRetryCount ?? 0) > 0 ||
    Boolean(task.nextRecoveryAt);
  const [sourceAgent, setSourceAgent] = useState<Agent | null>(null);
  const [selectedSourceAgentId, setSelectedSourceAgentId] = useState<string | null>(null);
  const provenanceDisplay = getProvenanceLabel(workingTask, {
    sourceAgentName: sourceAgent?.name,
  });

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
  const [editBranch, setEditBranch] = useState(task.branch ?? "");
  const [editBaseBranch, setEditBaseBranch] = useState(task.baseBranch ?? "");
  const [editExecutorModel, setEditExecutorModel] = useState("");
  const [editValidatorModel, setEditValidatorModel] = useState("");
  const [editPlanningModel, setEditPlanningModel] = useState("");
  const [editThinkingLevel, setEditThinkingLevel] = useState("");
  const [editPresetMode, setEditPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [editReviewLevel, setEditReviewLevel] = useState<number | undefined>(undefined);
  const [editPriority, setEditPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [editNodeId, setEditNodeId] = useState<string | undefined>(task.nodeId);
  const [editExecutionMode, setEditExecutionMode] = useState<"standard" | "fast">(normalizeExecutionModeValue(task.executionMode));
  const [editSelectedPresetId, setEditSelectedPresetId] = useState("");
  const [editSelectedWorkflowSteps, setEditSelectedWorkflowSteps] = useState<string[]>(task.enabledWorkflowSteps || []);
  const [editSourceIssueProvider, setEditSourceIssueProvider] = useState(task.sourceIssue?.provider ?? "");
  const [editSourceIssueRepository, setEditSourceIssueRepository] = useState(task.sourceIssue?.repository ?? "");
  const [editSourceIssueExternalId, setEditSourceIssueExternalId] = useState(task.sourceIssue?.externalIssueId ?? "");
  const [editSourceIssueUrl, setEditSourceIssueUrl] = useState(task.sourceIssue?.url ?? "");
  const [editPendingImages, setEditPendingImages] = useState<PendingImage[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [inlinePriority, setInlinePriority] = useState<TaskPriority>(normalizeTaskPriorityValue(task.priority));
  const [isSavingInlinePriority, setIsSavingInlinePriority] = useState(false);
  const [inlineExecutionMode, setInlineExecutionMode] = useState<"standard" | "fast">(normalizeExecutionModeValue(task.executionMode));
  const [isSavingInlineExecutionMode, setIsSavingInlineExecutionMode] = useState(false);
  const mountedRef = useRef(false);

  // Split-menu dropdown state for footer actions
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [sourceIssueExpanded, setSourceIssueExpanded] = useState(false);
  const [githubTrackingExpanded, setGithubTrackingExpanded] = useState(false);
  const [githubRepoOverrideDraft, setGithubRepoOverrideDraft] = useState(task.githubTracking?.repoOverride ?? "");
  const [githubTrackingEnabledDraft, setGithubTrackingEnabledDraft] = useState<boolean | null>(null);
  const [githubRepoOverrideError, setGithubRepoOverrideError] = useState<string | null>(null);
  const [isSavingGithubTracking, setIsSavingGithubTracking] = useState(false);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  // Plugin UI slots for task-detail-tab
  const { getSlotsForId: getPluginSlots } = usePluginUiSlots(projectId);
  const pluginTabSlots = getPluginSlots("task-detail-tab");
  const pluginTabs = pluginTabSlots.map((entry, index) => ({
    entry,
    tabId: `plugin-${entry.pluginId}-${index}` as TabId,
  }));
  const activePluginTab =
    typeof activeTab === "string" && activeTab.startsWith("plugin-")
      ? pluginTabs.find((tab) => tab.tabId === activeTab) ?? null
      : null;

  // Track mount state to avoid setting state on unmounted component
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Merged project settings for effective model resolution in Agent Log header
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);

  // Workflow results state
  const [workflowResults, setWorkflowResults] = useState<WorkflowStepResult[]>([]);
  const [workflowResultsLoading, setWorkflowResultsLoading] = useState(false);
  const [workflowEnabledSteps, setWorkflowEnabledSteps] = useState<string[]>(task.enabledWorkflowSteps || []);
  const isNodeOverrideLocked = task.column === "in-progress" || ACTIVE_STATUSES.has(task.status as string);

  // Reset edit state when task changes
  useEffect(() => {
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditBranch(task.branch ?? "");
    setEditBaseBranch(task.baseBranch ?? "");
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    setSourceIssueExpanded(false);
    setGithubTrackingExpanded(false);
    setGithubRepoOverrideDraft(workingTask.githubTracking?.repoOverride ?? "");
    setGithubTrackingEnabledDraft(null);
    setGithubRepoOverrideError(null);
    setIsEditing(false);
  }, [task.id, task.title, task.description, task.branch, task.baseBranch, task.sourceIssue, task.executionMode, workingTask.githubTracking]);

  useEffect(() => {
    setWorkflowEnabledSteps(task.enabledWorkflowSteps || []);
  }, [task.id, task.enabledWorkflowSteps]);

  useEffect(() => {
    setInlinePriority(normalizeTaskPriorityValue(task.priority));
  }, [task.id, task.priority]);

  useEffect(() => {
    setInlineExecutionMode(normalizeExecutionModeValue(task.executionMode));
  }, [task.id, task.executionMode]);

  useEffect(() => {
    if (githubTrackingEnabledDraft === null) return;
    if ((workingTask.githubTracking?.enabled === true) === githubTrackingEnabledDraft) {
      setGithubTrackingEnabledDraft(null);
    }
  }, [githubTrackingEnabledDraft, workingTask.githubTracking?.enabled]);

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
    fetchGlobalSettings()
      .then((nextGlobalSettings) => {
        if (!cancelled) setGlobalSettings(nextGlobalSettings);
      })
      .catch(() => {
        if (!cancelled) setGlobalSettings(null);
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
    if (!task.sourceAgentId) {
      setSourceAgent(null);
      return;
    }

    const knownAgent = agents.find((agent) => agent.id === task.sourceAgentId);
    if (knownAgent) {
      setSourceAgent(knownAgent);
      return;
    }

    let cancelled = false;
    void Promise.resolve(fetchAgent(task.sourceAgentId, projectId))
      .then((agent) => {
        if (!cancelled) setSourceAgent(agent ?? null);
      })
      .catch(() => {
        if (!cancelled) setSourceAgent(null);
      });

    return () => {
      cancelled = true;
    };
  }, [task.sourceAgentId, projectId, agents]);

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
  const canEditGithubTracking = GITHUB_TRACKING_EDITABLE_COLUMNS.has(task.column) && !isSaving;
  const githubTrackingEnabled = githubTrackingEnabledDraft ?? (workingTask.githubTracking?.enabled === true);
  const githubTrackedIssue = workingTask.githubTracking?.issue;
  const showInlineGithubTrackingEnableButton =
    canEditGithubTracking && !githubTrackedIssue && (!githubTrackingEnabled || (isSavingGithubTracking && workingTask.githubTracking?.enabled !== true));
  const showGithubTrackingSection = canEditGithubTracking || githubTrackingEnabled || Boolean(githubTrackedIssue);
  const githubTrackingStatus = githubTrackedIssue ? "Linked" : githubTrackingEnabled ? "Enabled" : "Disabled";
  const effectiveGithubRepoDefault = resolveEffectiveGithubRepoDefault(settings ?? null, globalSettings);
  const githubRepoOverrideTrimmed = githubRepoOverrideDraft.trim();

  const handleToggleGithubTracking = useCallback(async () => {
    if (!canEditGithubTracking || isSavingGithubTracking) return;
    const nextEnabled = !githubTrackingEnabled;
    setGithubTrackingEnabledDraft(nextEnabled);
    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, {
        githubTracking: {
          enabled: nextEnabled,
        },
      }, projectId);
      onTaskUpdated?.(updatedTask);
    } catch (err) {
      setGithubTrackingEnabledDraft(workingTask.githubTracking?.enabled === true);
      addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
    } finally {
      if (mountedRef.current) setIsSavingGithubTracking(false);
    }
  }, [addToast, canEditGithubTracking, githubTrackingEnabled, isSavingGithubTracking, onTaskUpdated, projectId, workingTask.githubTracking?.enabled, task.id]);

  const handleSaveGithubRepoOverride = useCallback(async () => {
    if (!canEditGithubTracking || isSavingGithubTracking) return;
    if (githubRepoOverrideTrimmed.length > 0 && !REPO_OVERRIDE_RE.test(githubRepoOverrideTrimmed)) {
      setGithubRepoOverrideError("Repository override must be in owner/repo format");
      return;
    }
    setGithubRepoOverrideError(null);
    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, {
        githubTracking: {
          repoOverride: githubRepoOverrideTrimmed.length > 0 ? githubRepoOverrideTrimmed : null,
        },
      }, projectId);
      onTaskUpdated?.(updatedTask);
    } catch (err) {
      addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
    } finally {
      if (mountedRef.current) setIsSavingGithubTracking(false);
    }
  }, [addToast, canEditGithubTracking, githubRepoOverrideTrimmed, isSavingGithubTracking, onTaskUpdated, projectId, task.id]);

  const handleRetryGithubTrackingIssueCreate = useCallback(async () => {
    if (!githubTrackingEnabled || githubTrackedIssue || isSavingGithubTracking) return;
    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, {
        githubTracking: {
          enabled: true,
        },
      }, projectId);
      onTaskUpdated?.(updatedTask);
      addToast("Requested GitHub tracking issue creation", "info");
    } catch (err) {
      addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
    } finally {
      if (mountedRef.current) setIsSavingGithubTracking(false);
    }
  }, [addToast, githubTrackedIssue, githubTrackingEnabled, isSavingGithubTracking, onTaskUpdated, projectId, task.id]);

  const enterEditMode = useCallback(() => {
    if (!canEdit) return;
    setIsEditing(true);
    setEditTitle(task.title || "");
    setEditDescription(task.description || "");
    setEditDependencies(task.dependencies || []);
    setEditBranch(task.branch ?? "");
    setEditBaseBranch(task.baseBranch ?? "");
    // Populate model overrides from task
    const execModel = task.modelProvider && task.modelId ? `${task.modelProvider}/${task.modelId}` : "";
    const valModel = task.validatorModelProvider && task.validatorModelId ? `${task.validatorModelProvider}/${task.validatorModelId}` : "";
    const planModel = task.planningModelProvider && task.planningModelId ? `${task.planningModelProvider}/${task.planningModelId}` : "";
    setEditExecutorModel(execModel);
    setEditValidatorModel(valModel);
    setEditPlanningModel(planModel);
    setEditThinkingLevel(task.thinkingLevel ?? "");
    setEditNodeId(task.nodeId);
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
    setEditBranch(task.branch ?? "");
    setEditBaseBranch(task.baseBranch ?? "");
    setEditNodeId(task.nodeId);
    setEditSourceIssueProvider(task.sourceIssue?.provider ?? "");
    setEditSourceIssueRepository(task.sourceIssue?.repository ?? "");
    setEditSourceIssueExternalId(task.sourceIssue?.externalIssueId ?? "");
    setEditSourceIssueUrl(task.sourceIssue?.url ?? "");
    setEditPriority(normalizeTaskPriorityValue(task.priority));
    setEditExecutionMode(normalizeExecutionModeValue(task.executionMode));
    editPendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setEditPendingImages([]);
  }, [task.title, task.description, task.dependencies, task.nodeId, task.priority, task.executionMode, editPendingImages]);

  const [editAutoSaveStatus, setEditAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const editAutoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editAutoSaveRevisionRef = useRef(0);

  const buildEditUpdates = useCallback((includeDescription: boolean) => {
    const updates: Record<string, unknown> = {};
    const trimmedTitle = editTitle.trim();
    const trimmedDescription = editDescription.trim();

    if (trimmedTitle && trimmedTitle !== (task.title ?? "")) updates.title = trimmedTitle;
    if (includeDescription && trimmedDescription && trimmedDescription !== (task.description ?? "")) updates.description = trimmedDescription;
    if (!sameStringArray(editDependencies, task.dependencies ?? [])) updates.dependencies = editDependencies;
    if (!sameStringArray(editSelectedWorkflowSteps, task.enabledWorkflowSteps ?? [])) updates.enabledWorkflowSteps = editSelectedWorkflowSteps;

    const normalizedBranch = editBranch.trim() || null;
    const currentBranch = task.branch ?? null;
    if (normalizedBranch !== currentBranch) updates.branch = normalizedBranch;

    const normalizedBaseBranch = editBaseBranch.trim() || null;
    const currentBaseBranch = task.baseBranch ?? null;
    if (normalizedBaseBranch !== currentBaseBranch) updates.baseBranch = normalizedBaseBranch;

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
    if (editThinkingLevel !== currentThinkingLevel) updates.thinkingLevel = editThinkingLevel !== "" ? (editThinkingLevel as "minimal" | "low" | "medium" | "high") : null;
    if ((task.nodeId ?? undefined) !== editNodeId) updates.nodeId = editNodeId ?? null;
    if (editReviewLevel !== task.reviewLevel) updates.reviewLevel = editReviewLevel;
    if (editPriority !== normalizeTaskPriorityValue(task.priority)) updates.priority = editPriority;
    if (editExecutionMode !== normalizeExecutionModeValue(task.executionMode)) updates.executionMode = editExecutionMode === "fast" ? "fast" : null;

    const normalizedProvider = normalizeSourceIssueText(editSourceIssueProvider);
    const normalizedRepository = normalizeSourceIssueText(editSourceIssueRepository);
    const normalizedExternalId = normalizeSourceIssueText(editSourceIssueExternalId);
    const normalizedUrl = normalizeSourceIssueUrl(editSourceIssueUrl);
    const allSourceFieldsEmpty = normalizedProvider.length === 0 && normalizedRepository.length === 0 && normalizedExternalId.length === 0 && !normalizedUrl;

    if (allSourceFieldsEmpty) {
      if (task.sourceIssue) updates.sourceIssue = null;
    } else {
      if (!normalizedProvider || !normalizedRepository || !normalizedExternalId) {
        return { updates: null, error: "Source issue provider, repository, and issue identifier are required" };
      }
      const fallbackIssueNumber = Number.parseInt(normalizedExternalId, 10);
      const issueNumber = task.sourceIssue?.issueNumber ?? fallbackIssueNumber;
      if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
        return { updates: null, error: "Source issue identifier must be numeric for new metadata" };
      }
      const nextSourceIssue: TaskSourceIssue = {
        provider: normalizedProvider,
        repository: normalizedRepository,
        externalIssueId: normalizedExternalId,
        issueNumber,
        ...(normalizedUrl ? { url: normalizedUrl } : {}),
      };
      const previousSourceIssue = task.sourceIssue;
      const sourceIssueChanged = !previousSourceIssue
        || previousSourceIssue.provider !== nextSourceIssue.provider
        || previousSourceIssue.repository !== nextSourceIssue.repository
        || previousSourceIssue.externalIssueId !== nextSourceIssue.externalIssueId
        || previousSourceIssue.issueNumber !== nextSourceIssue.issueNumber
        || (previousSourceIssue.url ?? undefined) !== nextSourceIssue.url;
      if (sourceIssueChanged) updates.sourceIssue = nextSourceIssue;
    }

    return { updates, error: null as string | null };
  }, [editBaseBranch, editBranch, editDependencies, editDescription, editExecutionMode, editExecutorModel, editNodeId, editPlanningModel, editPriority, editReviewLevel, editSelectedWorkflowSteps, editSourceIssueExternalId, editSourceIssueProvider, editSourceIssueRepository, editSourceIssueUrl, editThinkingLevel, editTitle, editValidatorModel, task]);

  const persistEditChanges = useCallback(async (includeDescription: boolean) => {
    const { updates, error } = buildEditUpdates(includeDescription);
    if (!updates) {
      setEditAutoSaveStatus("error");
      if (error) {
        addToast(`Failed to update ${task.id}: ${error}`, "error");
      }
      return false;
    }
    if (Object.keys(updates).length === 0) {
      return true;
    }
    const revision = ++editAutoSaveRevisionRef.current;
    setIsSaving(true);
    setEditAutoSaveStatus("saving");
    try {
      const updatedTask = await updateTask(task.id, updates as never, projectId);
      if (revision !== editAutoSaveRevisionRef.current) return;
      onTaskUpdated?.(updatedTask);
      setEditAutoSaveStatus("saved");
      return true;
    } catch (err) {
      if (revision === editAutoSaveRevisionRef.current) {
        setEditAutoSaveStatus("error");
        addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
      }
      return false;
    } finally {
      if (mountedRef.current && revision === editAutoSaveRevisionRef.current) {
        setIsSaving(false);
      }
    }
  }, [addToast, buildEditUpdates, onTaskUpdated, projectId, task.id]);

  const handleAutoSaveDescription = useCallback(async (_description: string) => {
    await persistEditChanges(true);
  }, [persistEditChanges]);

  const handleSave = useCallback(async () => {
    const didSave = await persistEditChanges(true);
    if (!didSave) {
      return;
    }
    addToast(`Updated ${task.id}`, "success");
    if (mountedRef.current) {
      setIsEditing(false);
    }
  }, [addToast, persistEditChanges, task.id]);

  useEffect(() => {
    if (!isEditing) return;
    if (editAutoSaveTimeoutRef.current) {
      clearTimeout(editAutoSaveTimeoutRef.current);
    }
    editAutoSaveTimeoutRef.current = setTimeout(() => {
      void persistEditChanges(false);
    }, 700);

    return () => {
      if (editAutoSaveTimeoutRef.current) {
        clearTimeout(editAutoSaveTimeoutRef.current);
        editAutoSaveTimeoutRef.current = null;
      }
    };
  }, [
    isEditing,
    editTitle,
    editDependencies,
    editBranch,
    editBaseBranch,
    editExecutorModel,
    editValidatorModel,
    editPlanningModel,
    editThinkingLevel,
    editNodeId,
    editReviewLevel,
    editPriority,
    editExecutionMode,
    editSelectedWorkflowSteps,
    editSourceIssueProvider,
    editSourceIssueRepository,
    editSourceIssueExternalId,
    editSourceIssueUrl,
    persistEditChanges,
  ]);

  const handleInlinePriorityChange = useCallback(async (nextValue: string) => {
    const normalizedNextPriority = normalizeTaskPriorityValue(nextValue as Task["priority"]);
    const currentPriority = normalizeTaskPriorityValue(task.priority);

    if (normalizedNextPriority === currentPriority) {
      setInlinePriority(currentPriority);
      return;
    }

    const previousPriority = inlinePriority;
    setInlinePriority(normalizedNextPriority);
    setIsSavingInlinePriority(true);

    try {
      const updatedTask = await updateTask(task.id, { priority: normalizedNextPriority }, projectId);
      setInlinePriority(normalizeTaskPriorityValue(updatedTask.priority));
      onTaskUpdated?.(updatedTask);
      addToast(`Priority updated to ${normalizeTaskPriorityValue(updatedTask.priority)}`, "success");
    } catch (err) {
      setInlinePriority(previousPriority);
      addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
    } finally {
      if (mountedRef.current) {
        setIsSavingInlinePriority(false);
      }
    }
  }, [task.id, task.priority, projectId, inlinePriority, onTaskUpdated, addToast]);

  const handleInlineExecutionModeToggle = useCallback(async () => {
    const currentMode = normalizeExecutionModeValue(task.executionMode);
    const nextMode = currentMode === "fast" ? "standard" : "fast";
    const previousMode = inlineExecutionMode;

    setInlineExecutionMode(nextMode);
    setIsSavingInlineExecutionMode(true);

    try {
      const updatedTask = await updateTask(task.id, { executionMode: nextMode === "fast" ? "fast" : null }, projectId);
      const normalizedUpdatedMode = normalizeExecutionModeValue(updatedTask.executionMode);
      setInlineExecutionMode(normalizedUpdatedMode);
      onTaskUpdated?.(updatedTask);
      addToast(`Execution mode updated to ${normalizedUpdatedMode}`, "success");
    } catch (err) {
      setInlineExecutionMode(previousMode);
      addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
    } finally {
      if (mountedRef.current) {
        setIsSavingInlineExecutionMode(false);
      }
    }
  }, [task.id, task.executionMode, projectId, inlineExecutionMode, onTaskUpdated, addToast]);

  // Handle keyboard shortcuts for edit mode
  const handleEditKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isEditing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      exitEditMode();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSave();
    }
  }, [isEditing, exitEditMode, handleSave]);

  useEffect(() => {
    if (!isEditing) return;
    document.addEventListener("keydown", handleEditKeyDown);
    return () => document.removeEventListener("keydown", handleEditKeyDown);
  }, [isEditing, handleEditKeyDown]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { nodes } = useNodes();
  const { confirm } = useConfirm();

  const handleUnlinkGithubIssue = useCallback(async () => {
    if (!canEdit || !githubTrackedIssue || isSavingGithubTracking) return;
    const confirmed = await confirm({
      title: "Unlink GitHub issue?",
      message: "This stops Fusion from syncing with the linked GitHub issue. The issue itself will not be modified.",
      confirmLabel: "Unlink",
      danger: true,
    });
    if (!confirmed) return;

    setIsSavingGithubTracking(true);
    try {
      const updatedTask = await updateTask(task.id, { githubTracking: { issue: null } }, projectId);
      onTaskUpdated?.(updatedTask);
      addToast("GitHub issue unlinked", "success");
    } catch (err) {
      addToast(`Failed to update ${task.id}: ${getErrorMessage(err)}`, "error");
    } finally {
      if (mountedRef.current) setIsSavingGithubTracking(false);
    }
  }, [addToast, canEdit, confirm, githubTrackedIssue, isSavingGithubTracking, onTaskUpdated, projectId, task.id]);

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
  const requestClose = useCallback(() => {
    onRequestClose?.();
  }, [onRequestClose]);

  useEffect(() => {
    if (embedded) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditing) requestClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [embedded, requestClose, isEditing]);

  const handleMove = useCallback(
    async (column: Column) => {
      try {
        const hasStepProgress = task.steps.some((step) => step.status !== "pending");
        const shouldPrompt = (column === "todo" || column === "triage") && hasStepProgress;

        let moveOptions: { preserveProgress?: boolean } | undefined;
        if (shouldPrompt) {
          const keepProgress = await confirm({
            title: "Preserve Progress?",
            message: "This task has completed steps. Keep progress before moving?",
            confirmLabel: "Keep Progress",
            cancelLabel: "Reset Progress",
          });

          if (keepProgress) {
            moveOptions = { preserveProgress: true };
          } else {
            const resetProgress = await confirm({
              title: "Reset Progress?",
              message: "Reset all step progress before moving this task?",
              confirmLabel: "Reset Progress",
              cancelLabel: "Cancel Move",
              danger: true,
            });
            if (!resetProgress) {
              return;
            }
          }
        }

        await onMoveTask(task.id, column, moveOptions);
        requestClose();
        addToast(`Moved to ${COLUMN_LABELS[column]}`, "success");
      } catch (err) {
        addToast(getErrorMessage(err), "error");
      }
    },
    [task.id, task.steps, onMoveTask, requestClose, addToast, confirm],
  );

  const handleDelete = useCallback(async () => {
    const shouldDelete = await confirm({
      title: "Delete Task",
      message: `Delete ${task.id}?`,
      danger: true,
    });
    if (!shouldDelete) return;
    try {
      await onDeleteTask(task.id);
      requestClose();
      addToast(`Deleted ${task.id}`, "info");
    } catch (err) {
      const conflict = extractDependencyDeleteConflict(err);
      if (!conflict || conflict.dependentIds.length === 0) {
        addToast(getErrorMessage(err), "error");
        return;
      }

      const dependentList = conflict.dependentIds.join(", ");
      const confirmed = await confirm({
        title: "Force Delete Task",
        message:
          `${task.id} is a dependency of ${dependentList}.\n\n` +
          "Delete anyway by removing these dependency references first?",
        danger: true,
      });
      if (!confirmed) {
        return;
      }

      try {
        await onDeleteTask(task.id, { removeDependencyReferences: true });
        requestClose();
        addToast(`Deleted ${task.id} after removing dependency references`, "info");
      } catch (retryErr) {
        addToast(getErrorMessage(retryErr), "error");
      }
    }
  }, [task.id, onDeleteTask, requestClose, addToast, confirm]);

  const handleMerge = useCallback(async () => {
    const shouldMerge = await confirm({
      title: "Merge Task",
      message: `Merge ${task.id} into the current branch?`,
    });
    if (!shouldMerge) return;
    requestClose();
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
  }, [task.id, onMergeTask, requestClose, addToast, confirm]);

  const handleRetry = useCallback(() => {
    if (!onRetryTask) return;
    requestClose();
    onRetryTask(task.id)
      .then(() => {
        addToast(`Retried ${task.id}`, "success");
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
      });
  }, [task.id, onRetryTask, requestClose, addToast]);

  const handleReset = useCallback(() => {
    if (!onResetTask) return;
    if (!window.confirm(`This will erase all progress for ${task.id} and start the task from scratch. Continue?`)) return;
    requestClose();
    onResetTask(task.id)
      .then(() => {
        addToast(`Reset ${task.id} — fresh run will be allocated`, "success");
      })
      .catch((err) => {
        addToast(getErrorMessage(err), "error");
      });
  }, [task.id, onResetTask, requestClose, addToast]);

  const handleDuplicate = useCallback(async () => {
    if (!onDuplicateTask) return;
    const shouldDuplicate = await confirm({
      title: "Duplicate Task",
      message: `Duplicate ${task.id}? This will create a new task in Triage with the same description and prompt.`,
    });
    if (!shouldDuplicate) return;
    try {
      const newTask = await onDuplicateTask(task.id);
      requestClose();
      addToast(`Duplicated ${task.id} → ${newTask.id}`, "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, onDuplicateTask, requestClose, addToast, confirm]);

  const handleTogglePause = useCallback(async () => {
    try {
      if (task.paused) {
        await unpauseTask(task.id, projectId);
        addToast(`Unpaused ${task.id}`, "success");
      } else {
        await pauseTask(task.id, projectId);
        addToast(`Paused ${task.id}`, "success");
      }
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, task.paused, requestClose, addToast]);

  const handleApprovePlan = useCallback(async () => {
    try {
      await approvePlan(task.id, projectId);
      addToast(`Plan approved — ${task.id} moved to Todo`, "success");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, requestClose, addToast]);

  const handleRejectPlan = useCallback(async () => {
    const shouldReject = await confirm({
      title: "Reject Plan",
      message: "Reject this plan? The specification will be discarded and regenerated.",
      danger: true,
    });
    if (!shouldReject) return;
    try {
      await rejectPlan(task.id, projectId);
      addToast(`Plan rejected — ${task.id} returned to Planning for replanning`, "info");
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, requestClose, addToast, confirm]);

  const handleRespecify = useCallback(async () => {
    const shouldRebuild = await confirm({
      title: "Rebuild Plan",
      message: "Rebuild the plan for this task? The task will move to planning for replanning.",
    });
    if (!shouldRebuild) return;
    try {
      await rebuildTaskSpec(task.id, projectId);
      requestClose();
      addToast(`Replanning ${task.id}...`, "info");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [task.id, projectId, requestClose, addToast, confirm]);

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
    void handleMerge();
  }, [closeMenus, handleMerge]);

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
      requestClose();
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsRefining(false);
    }
  }, [task.id, refineFeedback, addToast, requestClose]);

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
      addToast("AI revision requested. Task moved to planning.", "success");
      // Task has been moved to planning, close modal
      requestClose();
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes("done") || msg.includes("archived")) {
        addToast("Cannot request revision: Task must be in 'triage', 'todo', 'in-progress', or 'in-review' column.", "error");
      } else {
        addToast(msg, "error");
      }
    } finally {
      setIsRequestingRevision(false);
    }
  }, [task.id, addToast, requestClose]);

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

    // Exit edit mode immediately so the UI transitions back to preview as soon
    // as save is initiated. If save fails, restore edit mode for retry.
    setIsEditingSpec(false);
    try {
      await handleSaveSpec(specEditContent);
    } catch (err) {
      setIsEditingSpec(true);
      throw err;
    }
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

  const blockerFanoutMap = useMemo(() => computeBlockerFanoutMap(tasks), [tasks]);
  const blockingEntry = blockerFanoutMap.get(task.id);
  const blockingDependents = useMemo(() => {
    if (!blockingEntry) return [] as Array<{ id: string; label: string; stale: boolean }>;
    const staleSet = new Set(blockingEntry.staleBlockedByDependentIds);
    return blockingEntry.dependentIds.map((dependentId) => {
      const dependentTask = tasks.find((candidate) => candidate.id === dependentId);
      return {
        id: dependentId,
        label: dependentTask?.title || dependentTask?.description || dependentId,
        stale: staleSet.has(dependentId),
      };
    });
  }, [blockingEntry, tasks]);

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
  const inReviewMoveTransitions: Column[] = ["todo", "in-progress"];
  const moveTransitions = task.column === "in-review" ? inReviewMoveTransitions : transitions;
  const primaryMoveTransition = moveTransitions[0];
  const secondaryMoveTransitions = moveTransitions.slice(1);
  const hasSecondaryMoveOptions = secondaryMoveTransitions.length > 0;

  const closeMoveMenuAndFocusTrigger = useCallback(() => {
    setShowMoveMenu(false);
    moveButtonRef.current?.focus();
  }, []);

  const handleMoveButtonClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!hasSecondaryMoveOptions) {
      if (primaryMoveTransition) {
        void handleMoveMenuItemClick(primaryMoveTransition);
      }
      return;
    }

    const arrowZone = event.currentTarget.querySelector<HTMLSpanElement>(".detail-move-btn__arrow");
    const clickedArrow = Boolean(
      (event.target instanceof Element && event.target.closest(".detail-move-btn__arrow")) ||
      (arrowZone && event.clientX > 0 && event.clientX >= arrowZone.getBoundingClientRect().left),
    );

    if (clickedArrow) {
      setShowMoveMenu((prev) => !prev);
      setShowActionsMenu(false);
      return;
    }

    if (primaryMoveTransition) {
      void handleMoveMenuItemClick(primaryMoveTransition);
    }
  }, [hasSecondaryMoveOptions, primaryMoveTransition, handleMoveMenuItemClick]);

  const handleMoveButtonKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!hasSecondaryMoveOptions) {
      return;
    }

    const shouldOpenMenu = event.key === "ArrowDown" || (event.altKey && event.key === "ArrowDown");
    if (!shouldOpenMenu) {
      return;
    }

    event.preventDefault();
    setShowMoveMenu(true);
    setShowActionsMenu(false);
  }, [hasSecondaryMoveOptions]);

  const handleMoveMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeMoveMenuAndFocusTrigger();
  }, [closeMoveMenuAndFocusTrigger]);

  useEffect(() => {
    if (!showMoveMenu) {
      return;
    }

    const firstMenuItem = moveMenuRef.current?.querySelector<HTMLButtonElement>(".detail-move-menu-item");
    firstMenuItem?.focus();
  }, [showMoveMenu]);

  const prAutomationStatusLabels: Record<string, string> = {
    "creating-pr": "Creating PR…",
    "awaiting-pr-checks": "Awaiting PR checks",
    "merging-pr": "Merging PR…",
    "merging-fix": "Merging fixes…",
  };
  const prAutomationLabel = task.status ? prAutomationStatusLabels[task.status] : undefined;
  const mergeStrategy = settings?.mergeStrategy ?? "direct";
  const autoMergeEnabled = settings?.autoMerge ?? false;
  const isManualPrFlow = mergeStrategy === "pull-request" && !autoMergeEnabled;

  let manualReviewActionLabel = "Merge & Close";
  if (isManualPrFlow && !prAutomationLabel) {
    if (!task.prInfo) {
      manualReviewActionLabel = "Start PR Review";
    } else if (task.prInfo.status === "open") {
      manualReviewActionLabel = "Check PR Status";
    } else if (task.prInfo.status === "merged") {
      manualReviewActionLabel = "Finish & Close";
    }
  }

  return (
    <div
      className={embedded ? "task-detail-content task-detail-content--embedded" : "task-detail-content"}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
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
            {!embedded && mobileHeaderMode === "back" && (
              <button
                className="modal-close task-detail-mobile-back"
                onClick={requestClose}
                aria-label="Back to task list"
                type="button"
              >
                <ArrowLeft aria-hidden="true" />
                <span>Back</span>
              </button>
            )}
            {!embedded && mobileHeaderMode !== "back" && (
              <button className="modal-close" onClick={requestClose} aria-label="Close" type="button">
                &times;
              </button>
            )}
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
                branch={editBranch}
                onBranchChange={setEditBranch}
                baseBranch={editBaseBranch}
                onBaseBranchChange={setEditBaseBranch}
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
                nodeId={editNodeId}
                onNodeIdChange={setEditNodeId}
                nodeOptions={nodes}
                nodeOverrideDisabled={isNodeOverrideLocked}
                nodeOverrideDisabledReason={isNodeOverrideLocked ? "Execution node override is locked while a task is active/in progress." : undefined}
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
                <div className="detail-meta-inline-controls" data-testid="detail-meta-inline-controls">
                  <label
                    className={`card-priority-badge card-priority-badge--${inlinePriority} detail-priority-chip ${isSavingInlinePriority ? "detail-priority-chip--saving" : ""}`}
                  >
                    <span>Priority:</span>
                    <select
                      className="detail-priority-select"
                      value={inlinePriority}
                      onChange={(event) => {
                        void handleInlinePriorityChange(event.target.value);
                      }}
                      disabled={isSavingInlinePriority}
                      aria-label="Task priority"
                    >
                      {TASK_PRIORITIES.map((priorityOption) => (
                        <option key={priorityOption} value={priorityOption}>
                          {priorityOption}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={`btn btn-sm detail-execution-mode-toggle ${inlineExecutionMode === "fast" ? "detail-execution-mode-toggle--fast" : ""} ${isSavingInlineExecutionMode ? "detail-execution-mode-toggle--saving" : ""}`}
                    onClick={() => {
                      void handleInlineExecutionModeToggle();
                    }}
                    disabled={isSavingInlineExecutionMode}
                    aria-label={`Execution mode: ${inlineExecutionMode}`}
                    aria-pressed={inlineExecutionMode === "fast"}
                  >
                    <Zap aria-hidden="true" />
                    <span>{inlineExecutionMode === "fast" ? "Fast" : "Standard"}</span>
                  </button>
                </div>
                {provenanceDisplay && (
                  <div className="detail-provenance">
                    <GitBranch aria-hidden="true" />
                    <span>
                      {workingTask.sourceType === "agent_heartbeat" ? (
                        <>
                          Created by{" "}
                          {provenanceDisplay.sourceAgentId ? (
                            <button
                              type="button"
                              className="detail-provenance-link"
                              onClick={() => setSelectedSourceAgentId(provenanceDisplay.sourceAgentId!)}
                            >
                              {provenanceDisplay.label}
                            </button>
                          ) : (
                            provenanceDisplay.label
                          )}
                        </>
                      ) : (
                        <>Created via {provenanceDisplay.label}</>
                      )}
                      {provenanceDisplay.parentTaskId && (
                        <>
                          {" "}of{" "}
                          <button
                            type="button"
                            className="detail-provenance-link"
                            onClick={() => handleDepClick(provenanceDisplay.parentTaskId!)}
                          >
                            {provenanceDisplay.parentTaskId}
                          </button>
                        </>
                      )}
                      {provenanceDisplay.contextInfo ? ` (${provenanceDisplay.contextInfo})` : ""}
                    </span>
                  </div>
                )}
                {(task.prInfo?.number || task.mergeDetails?.prNumber) && (
                  <div className="detail-provenance detail-pr-link-row">
                    <GitBranch aria-hidden="true" />
                    <span>
                      PR{" "}
                      {task.prInfo?.url ? (
                        <a
                          className="detail-provenance-link"
                          href={task.prInfo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          #{task.prInfo.number}
                        </a>
                      ) : (
                        <span>#{task.prInfo?.number ?? task.mergeDetails?.prNumber}</span>
                      )}
                    </span>
                  </div>
                )}
                <div className="detail-timestamps" aria-label="Task timestamps">
                  <span className="detail-timestamp-item">
                    <span className="detail-timestamp-label">Created</span>{" "}
                    <time dateTime={task.createdAt} title={new Date(task.createdAt).toLocaleString()}>
                      {formatTimestamp(task.createdAt)}
                    </time>
                  </span>
                  <span className="detail-timestamp-separator" aria-hidden="true">
                    ·
                  </span>
                  <span className="detail-timestamp-item">
                    <span className="detail-timestamp-label">Updated</span>{" "}
                    <time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()}>
                      {formatTimestamp(task.updatedAt)}
                    </time>
                  </span>
                </div>
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
              className={`detail-tab${activeTab === "review" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("review")}
            >
              Review
            </button>
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
            <button
              className={`detail-tab${activeTab === "routing" ? " detail-tab-active" : ""}`}
              onClick={() => setActiveTab("routing")}
            >
              Routing
            </button>
            {/* Plugin tabs */}
            {pluginTabs.map(({ entry, tabId }) => {
              return (
                <button
                  key={`plugin-tab-${entry.pluginId}-${tabId}`}
                  className={`detail-tab${activeTab === tabId ? " detail-tab-active" : ""}`}
                  onClick={() => setActiveTab(tabId)}
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
                  executorModel={resolveEffectiveExecutor(task, agentLogEntries, assignedAgent, settings)}
                  validatorModel={resolveEffectiveValidator(task, agentLogEntries, assignedAgent, settings)}
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
          ) : activeTab === "review" ? (
            <TaskReviewTab task={task} addToast={addToast} projectId={projectId} onTaskUpdated={onTaskUpdated} />
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
          ) : activePluginTab ? (
            <div className="detail-section">
              <PluginSlot
                slotId="task-detail-tab"
                projectId={projectId}
                pluginIds={[activePluginTab.entry.pluginId]}
              />
            </div>
          ) : activeTab === "stats" ? (
            <div className="detail-section">
              <TaskTokenStatsPanel
                tokenUsage={workingTask.tokenUsage}
                loading={detailLoading}
                task={workingTask}
              />
            </div>
          ) : activeTab === "routing" ? (
            <div className="detail-section">
              <RoutingTab
                task={task}
                settings={settings}
                addToast={addToast}
                onTaskUpdated={onTaskUpdated}
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
              <div className="detail-source-header">
                <div className="detail-source-summary">
                  <span className="detail-source-label">Source issue</span>
                  {task.sourceIssue.provider.toLowerCase() === "github" && (
                    <span className="detail-source-provider-badge" aria-label="GitHub source issue">
                      <GitBranch aria-hidden="true" />
                      <span>GitHub</span>
                    </span>
                  )}
                  {task.sourceIssue.url ? (
                    <a
                      className="detail-source-link detail-source-link--summary detail-source-number"
                      href={task.sourceIssue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {`(#${task.sourceIssue.issueNumber})`}
                    </a>
                  ) : (
                    <span className="detail-source-number">{`(#${task.sourceIssue.issueNumber})`}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="detail-source-toggle"
                  aria-expanded={sourceIssueExpanded}
                  aria-label={sourceIssueExpanded ? "Collapse source issue details" : "Expand source issue details"}
                  onClick={() => setSourceIssueExpanded((expanded) => !expanded)}
                >
                  <ChevronRight
                    size={16}
                    className={sourceIssueExpanded ? "detail-source-chevron--expanded" : undefined}
                  />
                </button>
              </div>
              {sourceIssueExpanded && (
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
              )}
            </div>
          )}
          {showGithubTrackingSection && (
            <div className="detail-section detail-github-tracking-section">
              <div className="detail-source-header">
                <div className="detail-source-summary">
                  <span className="detail-source-label">GitHub tracking</span>
                  <span className="detail-source-provider-badge" aria-label="GitHub tracking status">
                    <GitBranch aria-hidden="true" />
                    <span>{githubTrackingStatus}</span>
                  </span>
                  {!githubTrackedIssue && (
                    <span className="detail-source-empty">
                      {githubTrackingEnabled ? "Issue not yet created" : "Tracking is currently disabled"}
                    </span>
                  )}
                </div>
                {showInlineGithubTrackingEnableButton && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary detail-github-tracking-enable"
                    aria-label="Enable GitHub tracking"
                    onClick={() => void handleToggleGithubTracking()}
                    disabled={isSavingGithubTracking}
                  >
                    {isSavingGithubTracking ? "Saving…" : "Enable"}
                  </button>
                )}
                <button
                  type="button"
                  className="detail-source-toggle"
                  aria-expanded={githubTrackingExpanded}
                  aria-label={githubTrackingExpanded ? "Collapse GitHub tracking details" : "Expand GitHub tracking details"}
                  onClick={() => setGithubTrackingExpanded((expanded) => !expanded)}
                >
                  <ChevronRight
                    size={16}
                    className={githubTrackingExpanded ? "detail-source-chevron--expanded" : undefined}
                  />
                </button>
              </div>
              {githubTrackingExpanded && (
                <div className="detail-github-tracking-content">
                  {githubTrackedIssue && (
                    <dl className="detail-source-grid detail-github-tracking-grid">
                      <div>
                        <dt>Issue</dt>
                        <dd>
                          {githubTrackedIssue.url ? (
                            <a className="detail-source-link" href={githubTrackedIssue.url} target="_blank" rel="noopener noreferrer">
                              {`${githubTrackedIssue.owner}/${githubTrackedIssue.repo}#${githubTrackedIssue.number}`}
                            </a>
                          ) : (
                            <span>{`${githubTrackedIssue.owner}/${githubTrackedIssue.repo}#${githubTrackedIssue.number}`}</span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>State</dt>
                        <dd>
                          <span className={`detail-github-issue-state ${task.issueInfo?.state === "closed" ? "detail-github-issue-state--closed" : "detail-github-issue-state--open"}`}>
                            {task.issueInfo?.state ?? "open"}
                          </span>
                        </dd>
                      </div>
                    </dl>
                  )}
                  <div className="detail-github-tracking-controls">
                    {!githubTrackedIssue && githubTrackingEnabled && (
                      <button className="btn btn-sm touch-target" onClick={() => void handleRetryGithubTrackingIssueCreate()} disabled={isSavingGithubTracking}>
                        Create tracking issue
                      </button>
                    )}
                    {canEditGithubTracking && (
                      <>
                        <label className="checkbox-label" htmlFor="detail-github-tracking-toggle">
                          <input
                            id="detail-github-tracking-toggle"
                            type="checkbox"
                            checked={githubTrackingEnabled}
                            disabled={isSavingGithubTracking}
                            onChange={() => void handleToggleGithubTracking()}
                          />
                          Enable GitHub tracking
                        </label>
                        <div className="detail-github-tracking-repo-row">
                          <input
                            className="input"
                            value={githubRepoOverrideDraft}
                            onChange={(event) => {
                              setGithubRepoOverrideDraft(event.target.value);
                              setGithubRepoOverrideError(null);
                            }}
                            placeholder={effectiveGithubRepoDefault || "owner/repo"}
                          />
                          <button className="btn btn-sm" onClick={() => void handleSaveGithubRepoOverride()} disabled={isSavingGithubTracking}>
                            Save
                          </button>
                        </div>
                        {githubRepoOverrideError && <small className="detail-github-tracking-error">{githubRepoOverrideError}</small>}
                        {githubTrackedIssue && (
                          <button className="btn btn-sm touch-target" onClick={() => void handleUnlinkGithubIssue()} disabled={isSavingGithubTracking}>
                            Unlink GitHub issue
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
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
                  <Bot size={14} className="detail-meta-label-icon" />
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
                    {!agentsLoading && agents.map((a) => (
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
                    {!agentsLoading && agents.length === 0 && (
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
                    Provide feedback for the AI to improve this specification. The task will move to planning for replanning.
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
          <div className="detail-deps detail-blocking">
            <h4>Blocking</h4>
            {blockingDependents.length > 0 ? (
              <ul className="detail-dep-list">
                {blockingDependents.map((dependent) => (
                  <li key={dependent.id} className="detail-dep-item">
                    <span
                      className="detail-dep-link"
                      onClick={() => handleDepClick(dependent.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleDepClick(dependent.id);
                        }
                      }}
                      role="link"
                      tabIndex={0}
                      title={`Click to view ${dependent.id}`}
                    >
                      <span className="detail-dep-id">{dependent.id}</span>
                      <span className="detail-dep-label">{truncate(dependent.label, 40)}</span>
                    </span>
                    {dependent.stale && (
                      <span
                        className="detail-blocking-item--stale"
                        title="Stale blockedBy edge: self-healing clearStaleBlockedBy should clear this automatically"
                      >
                        (stale)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="detail-empty-inline">(no downstream tasks blocked)</div>
            )}
          </div>
          {/* PR Section - only for in-review tasks */}
          {task.column === "in-review" && (
            <div className="detail-section detail-pr-section">
              <PrSection
                taskId={task.id}
                projectId={projectId}
                prInfo={task.prInfo}
                automationStatus={task.status ?? null}
                autoMerge={settings?.autoMerge ?? false}
                isManualPrFlow={isManualPrFlow}
                prAuthAvailable={prAuthAvailable ?? false}
                onPrCreated={(prInfo) => {
                  // Update task locally to show new PR
                  (task as TaskDetail).prInfo = prInfo;
                }}
                onPrUpdated={(prInfo) => {
                  (task as TaskDetail).prInfo = prInfo;
                }}
                addToast={addToast}
              />
            </div>
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
                {editAutoSaveStatus === "saving" ? "Autosaving…" : editAutoSaveStatus === "saved" ? "Saved" : editAutoSaveStatus === "error" ? "Save failed" : "Changes autosave as you edit"}
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
                onClick={() => void handleSave()}
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
              {(task.column !== "triage" || task.status === "awaiting-approval" || canRetryTask || task.paused) && (
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

                      {/* Reset (nuclear) — wipes all progress and reallocates worktree */}
                      {onResetTask && task.column !== "done" && task.column !== "archived" && (
                        <button
                          className="detail-actions-menu-item detail-actions-menu-item-danger"
                          role="menuitem"
                          onClick={() => handleActionsMenuItemClick(handleReset)}
                        >
                          Reset
                        </button>
                      )}

                      {/* Pause/Unpause */}
                      {task.column !== "done" && !task.assignedAgentId && (
                        <button
                          className="detail-actions-menu-item"
                          role="menuitem"
                          onClick={() => handleActionsMenuItemClick(handleTogglePause)}
                        >
                          {task.paused ? "Unpause" : "Pause"}
                        </button>
                      )}
                      {task.column !== "done" && task.paused && task.pausedByAgentId && (
                        <span
                          className="detail-actions-menu-item detail-actions-menu-note"
                          role="note"
                        >
                          Paused by agent
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="modal-actions-spacer" />

              {/* Move dropdown — column transitions and merge actions */}
              <div className="detail-move-dropdown" ref={moveMenuRef}>
                {task.column === "in-review" ? (
                  <div className="detail-move-actions-in-review">
                    <div>
                      <button
                        ref={moveButtonRef}
                        className="btn btn-primary btn-sm detail-move-btn"
                        onClick={handleMoveButtonClick}
                        onKeyDown={handleMoveButtonKeyDown}
                        disabled={!primaryMoveTransition}
                        aria-label={primaryMoveTransition ? `Move to ${COLUMN_LABELS[primaryMoveTransition]}` : undefined}
                        aria-haspopup={hasSecondaryMoveOptions ? "menu" : undefined}
                        aria-expanded={hasSecondaryMoveOptions ? showMoveMenu : undefined}
                      >
                        <span className="detail-move-btn__label">
                          Move to {primaryMoveTransition ? COLUMN_LABELS[primaryMoveTransition] : ""}
                        </span>
                        {hasSecondaryMoveOptions && (
                          <span className="detail-move-btn__arrow" aria-hidden="true">
                            <ChevronDown size={12} />
                          </span>
                        )}
                      </button>
                      {showMoveMenu && hasSecondaryMoveOptions && (
                        <div className="detail-move-menu" role="menu" onKeyDown={handleMoveMenuKeyDown}>
                          {secondaryMoveTransitions.map((col) => (
                            <button
                              key={col}
                              className="detail-move-menu-item"
                              role="menuitem"
                              onClick={() => handleMoveMenuItemClick(col)}
                              onKeyDown={handleMoveMenuKeyDown}
                            >
                              {col === "in-progress" ? "Back to In Progress" : `Move to ${COLUMN_LABELS[col]}`}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {prAutomationLabel ? (
                      <button className="btn btn-primary btn-sm" disabled>
                        {prAutomationLabel}
                      </button>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={handleMergeMenuItemClick}>
                        {manualReviewActionLabel}
                      </button>
                    )}
                  </div>
                ) : (
                  <div>
                    <button
                      ref={moveButtonRef}
                      className="btn btn-primary btn-sm detail-move-btn"
                      onClick={handleMoveButtonClick}
                      onKeyDown={handleMoveButtonKeyDown}
                      disabled={!primaryMoveTransition}
                      aria-label={primaryMoveTransition ? `Move to ${COLUMN_LABELS[primaryMoveTransition]}` : undefined}
                      aria-haspopup={hasSecondaryMoveOptions ? "menu" : undefined}
                      aria-expanded={hasSecondaryMoveOptions ? showMoveMenu : undefined}
                    >
                      <span className="detail-move-btn__label">
                        Move to {primaryMoveTransition ? COLUMN_LABELS[primaryMoveTransition] : ""}
                      </span>
                      {hasSecondaryMoveOptions && (
                        <span className="detail-move-btn__arrow" aria-hidden="true">
                          <ChevronDown size={12} />
                        </span>
                      )}
                    </button>
                    {showMoveMenu && hasSecondaryMoveOptions && (
                      <div className="detail-move-menu" role="menu" onKeyDown={handleMoveMenuKeyDown}>
                        {secondaryMoveTransitions.map((col) => (
                          <button
                            key={col}
                            className="detail-move-menu-item"
                            role="menuitem"
                            onClick={() => handleMoveMenuItemClick(col)}
                            onKeyDown={handleMoveMenuKeyDown}
                          >
                            Move to {COLUMN_LABELS[col]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
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
        {selectedSourceAgentId && (
          <Suspense fallback={null}>
            <AgentDetailView
              agentId={selectedSourceAgentId}
              projectId={projectId}
              onClose={() => setSelectedSourceAgentId(null)}
              addToast={addToast}
            />
          </Suspense>
        )}
    </div>
  );
}

export function TaskDetailModal({ onClose, ...props }: TaskDetailModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, true, "task-detail-modal-size");
  useMobileScrollLock(true);
  const overlayDismissProps = useOverlayDismiss(onClose);

  return (
    <div
      className="modal-overlay open"
      {...overlayDismissProps}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal modal-lg task-detail-modal" ref={modalRef}>
        <TaskDetailContent
          {...props}
          onRequestClose={onClose}
        />
      </div>
    </div>
  );
}
