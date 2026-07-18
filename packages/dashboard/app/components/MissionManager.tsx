import "./MissionManager.css";
import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getErrorMessage, type Goal } from "@fusion/core";
import {
  X,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  Target,
  Layers,
  Package,
  Box,
  Check,
  Loader2,
  Link,
  Unlink,
  Play,
  Square,
  Sparkles,
  Zap,
  Activity,
  FileText,
  RefreshCw,
} from "lucide-react";
import { useConfirm } from "../hooks/useConfirm";
import type { ToastType } from "../hooks/useToast";
import { useViewportMode } from "../hooks/useViewportMode";
import { useNavigationHistoryContext } from "../hooks/useNavigationHistory";
import { subscribeSse } from "../sse-bus";
import { MissionInterviewModal } from "./MissionInterviewModal";
import { MilestoneSliceInterviewModal } from "./MilestoneSliceInterviewModal";
import type {
  Mission,
  MissionWithHierarchy,
  MissionWithSummary,
  Milestone,
  Slice,
  MissionFeature,
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  MissionHealth,
  MissionEvent,
  MissionEventType,
  MissionAssertionStatus,
  MissionContractAssertion,
  MilestoneValidationRollup,
  MilestoneValidationTelemetry,
  MissionFeatureLoopSnapshot,
  MissionValidatorRun,
} from "./mission-types";
import {
  fetchMissions,
  createMission,
  fetchMission,
  updateMission,
  deleteMission,
  ApiRequestError,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  createSlice,
  updateSlice,
  deleteSlice,
  activateSlice,
  createFeature,
  updateFeature,
  deleteFeature,
  linkFeatureToTask,
  unlinkFeatureFromTask,
  triageFeature,
  triageAllSliceFeatures,
  previewEnrichedDescription,
  resumeMission,
  stopMission,
  startMission,
  updateMissionAutopilot,
  fetchMissionsHealth,
  fetchMissionEvents,
  fetchAssertions,
  createAssertion,
  updateAssertion,
  linkFeatureToAssertion,
  unlinkFeatureFromAssertion,
  fetchFeaturesForAssertion,
  fetchMilestoneValidation,
  fetchMilestoneValidationTelemetry,
  triggerValidation,
  fetchValidationLoopState,
  fetchValidationRuns,
  fetchValidationRun,
  fetchAiSessions,
  fetchAiSession,
  fetchMissionInterviewDrafts,
  discardMissionInterviewDraft,
  fetchTaskDetail,
  apiGetBranchGroup,
  api,
  type AiSessionSummary,
  type BranchGroupSummary,
} from "../api";
import type { AutopilotState, MissionInterviewDraftSummary } from "./mission-types";
import { readCache, SWR_CACHE_KEYS, writeCache } from "../utils/swrCache";
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";

const MISSION_SIDEBAR_DEFAULT_WIDTH = 300;
const MISSION_SIDEBAR_MIN_WIDTH = 220;
const MISSION_SIDEBAR_MAX_WIDTH = 560;
const MISSION_SIDEBAR_STORAGE_KEY = "fusion:mission-sidebar-width";

interface MissionManagerProps {
  isOpen: boolean;
  isInline?: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  workflowId?: string | null;
  onSelectTask?: (taskId: string) => void;
  availableTasks?: Array<{ id: string; title?: string }>;
  resumeSessionId?: string;
  /** Pre-select and load this mission when the modal opens */
  targetMissionId?: string;
  /** Resume session ID for milestone/slice interview sessions */
  milestoneSliceResumeSessionId?: string;
  /** Called when milestone/slice resume session fetch fails */
  onMilestoneSliceResumeFetchError?: () => void;
  /** Navigate to the goals view anchored to a specific goal */
  onNavigateToGoal?: (goalId: string) => void;
}

// Status badge colors — use CSS custom-property-compatible tokens
const missionStatusColors: Record<MissionStatus, { bg: string; text: string }> = {
  planning: { bg: "var(--mission-planning-bg)", text: "var(--mission-planning-text)" },
  active: { bg: "var(--mission-active-bg)", text: "var(--mission-active-text)" },
  blocked: { bg: "var(--mission-blocked-bg)", text: "var(--mission-blocked-text)" },
  complete: { bg: "var(--mission-complete-bg)", text: "var(--mission-complete-text)" },
  archived: { bg: "var(--mission-archived-bg)", text: "var(--mission-archived-text)" },
};

const milestoneStatusColors: Record<MilestoneStatus, { bg: string; text: string }> = {
  planning: { bg: "var(--mission-planning-bg)", text: "var(--mission-planning-text)" },
  active: { bg: "var(--mission-active-bg)", text: "var(--mission-active-text)" },
  blocked: { bg: "var(--mission-blocked-bg)", text: "var(--mission-blocked-text)" },
  complete: { bg: "var(--mission-complete-bg)", text: "var(--mission-complete-text)" },
};

const sliceStatusColors: Record<SliceStatus, { bg: string; text: string }> = {
  pending: { bg: "var(--slice-pending-bg)", text: "var(--slice-pending-text)" },
  active: { bg: "var(--slice-active-bg)", text: "var(--slice-active-text)" },
  complete: { bg: "var(--slice-complete-bg)", text: "var(--slice-complete-text)" },
};

const featureStatusColors: Record<FeatureStatus, { bg: string; text: string }> = {
  defined: { bg: "var(--feature-defined-bg)", text: "var(--feature-defined-text)" },
  triaged: { bg: "var(--feature-triaged-bg)", text: "var(--feature-triaged-text)" },
  "in-progress": { bg: "var(--feature-in-progress-bg)", text: "var(--feature-in-progress-text)" },
  done: { bg: "var(--feature-done-bg)", text: "var(--feature-done-text)" },
  blocked: { bg: "var(--mission-blocked-bg)", text: "var(--mission-blocked-text)" },
};

const autopilotStateColors: Record<AutopilotState, { bg: string; text: string }> = {
  inactive: { bg: "var(--autopilot-inactive-bg)", text: "var(--autopilot-inactive-text)" },
  watching: { bg: "var(--autopilot-watching-bg)", text: "var(--autopilot-watching-text)" },
  activating: { bg: "var(--autopilot-activating-bg)", text: "var(--autopilot-activating-text)" },
  completing: { bg: "var(--autopilot-completing-bg)", text: "var(--autopilot-completing-text)" },
};


/** Assertion status colors */
const assertionStatusColors: Record<MissionAssertionStatus, { bg: string; text: string }> = {
  pending: { bg: "var(--assertion-pending-bg)", text: "var(--assertion-pending-text)" },
  passed: { bg: "var(--assertion-passed-bg)", text: "var(--assertion-passed-text)" },
  failed: { bg: "var(--assertion-failed-bg)", text: "var(--assertion-failed-text)" },
  blocked: { bg: "var(--assertion-blocked-bg)", text: "var(--assertion-blocked-text)" },
};

const validationStateColors: Record<string, { bg: string; text: string }> = {
  not_started: { bg: "var(--assertion-pending-bg)", text: "var(--assertion-pending-text)" },
  needs_coverage: { bg: "var(--loop-needs-fix-bg)", text: "var(--loop-needs-fix-text)" },
  ready: { bg: "var(--loop-validating-bg)", text: "var(--loop-validating-text)" },
  passed: { bg: "var(--loop-passed-bg)", text: "var(--loop-passed-text)" },
  failed: { bg: "var(--loop-blocked-bg)", text: "var(--loop-blocked-text)" },
  blocked: { bg: "var(--loop-blocked-bg)", text: "var(--loop-blocked-text)" },
};

const featureRetryBudgetMax = 3;
const missionInterviewListStatuses: ReadonlySet<AiSessionSummary["status"]> = new Set([
  "generating",
  "awaiting_input",
  "error",
  "complete",
]);

function getInterviewStatusLabel(status: AiSessionSummary["status"], t: (key: string, fallback: string) => string): string {
  switch (status) {
    case "generating":
      return t("missions.interviewStatusGenerating", "Generating plan");
    case "awaiting_input":
      return t("missions.interviewStatusAwaitingInput", "Awaiting input");
    case "error":
      return t("missions.interviewStatusError", "Needs retry");
    case "complete":
      return t("missions.interviewStatusComplete", "Plan ready");
    default:
      return status;
  }
}

function getMissionRunHelperText(status: MissionStatus, t: (key: string, fallback: string) => string): string | null {
  switch (status) {
    case "planning":
      return t("missions.runHelperPlanning", "Starting activates the first slice so work can begin.");
    case "active":
      return t("missions.runHelperActive", "Stopping pauses linked tasks and marks the mission blocked.");
    case "blocked":
      return t("missions.runHelperBlocked", "Resuming re-activates the mission and continues execution.");
    default:
      return null;
  }
}

function getAutopilotStateLabel(state: string, t: (key: string, fallback: string) => string): string {
  switch (state as AutopilotState) {
    case "inactive":
      return t("missions.autopilotStateInactive", "Off");
    case "watching":
      return t("missions.autopilotStateWatching", "Watching");
    case "activating":
      return t("missions.autopilotStateActivating", "Activating slice");
    case "completing":
      return t("missions.autopilotStateCompleting", "Completing");
    default:
      return state ? state.replace(/_/g, " ") : t("missions.autopilotStateUnknown", "Unknown");
  }
}

/** Get the plan state for a milestone (derived from interviewState) */
function getMilestonePlanState(interviewState?: string): "not_started" | "planned" | "needs_update" {
  if (interviewState === "completed") return "planned";
  if (interviewState === "needs_update") return "needs_update";
  return "not_started";
}

/** Render a plan state indicator badge */
function PlanStateIndicator({ state }: { state: "not_started" | "planned" | "needs_update" }) {
  const { t } = useTranslation("app");
  const stateClass =
    state === "planned"
      ? "mission-plan-state-indicator--planned"
      : state === "needs_update"
        ? "mission-plan-state-indicator--needs-update"
        : "mission-plan-state-indicator--not-started";

  const title =
    state === "planned"
      ? t("missions.planStatePlanned", "Planned")
      : state === "needs_update"
        ? t("missions.planStateNeedsUpdate", "Needs update")
        : t("missions.planStateNotPlanned", "Not planned");

  return (
    <span
      className={`mission-plan-state-indicator ${stateClass}`}
      title={title}
      aria-label={title}
    />
  );
}

/** Convert validation state snake_case to human-readable label */
function formatValidationState(state: string | undefined, t: (key: string, fallback: string) => string): string {
  if (!state) return t("missions.validationStateNotStarted", "Not started");
  // Replace underscores with spaces and title-case the result
  return state.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// Form types
type MissionBranchStrategyMode = "project-default" | "existing" | "custom-new" | "auto-per-task";

interface MissionBranchStrategy {
  mode: MissionBranchStrategyMode;
  branchName?: string;
}

type MissionAutoMergeOverride = "inherit" | "on" | "off";

interface MissionFormData {
  title: string;
  description: string;
  status: MissionStatus;
  autopilotEnabled: boolean;
  /** FNXC:MissionAutoMerge 2026-07-18-12:00: Preserve inherited project behavior until an operator explicitly selects an override. */
  autoMergeOverride: MissionAutoMergeOverride;
  baseBranch: string;
  branchStrategy: MissionBranchStrategy;
}

interface MilestoneFormData {
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: MilestoneStatus;
  dependencies: string[];
}

interface SliceFormData {
  title: string;
  description: string;
  status: SliceStatus;
}

interface FeatureFormData {
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: FeatureStatus;
}

const EMPTY_MISSION_FORM: MissionFormData = {
  title: "",
  description: "",
  status: "planning",
  autopilotEnabled: false,
  autoMergeOverride: "inherit",
  baseBranch: "",
  branchStrategy: {
    mode: "project-default",
  },
};

const EMPTY_MILESTONE_FORM: MilestoneFormData = {
  title: "",
  description: "",
  acceptanceCriteria: "",
  status: "planning",
  dependencies: [],
};

const EMPTY_SLICE_FORM: SliceFormData = {
  title: "",
  description: "",
  status: "pending",
};

const EMPTY_FEATURE_FORM: FeatureFormData = {
  title: "",
  description: "",
  acceptanceCriteria: "",
  status: "defined",
};

function missionAutoMergeOverride(autoMerge?: boolean): MissionAutoMergeOverride {
  return autoMerge === true ? "on" : autoMerge === false ? "off" : "inherit";
}

function resolveMissionAutoMerge(override: MissionAutoMergeOverride): boolean | undefined {
  return override === "on" ? true : override === "off" ? false : undefined;
}

function normalizeMissionBranchStrategy(strategy?: Mission["branchStrategy"]): MissionBranchStrategy {
  if (!strategy) {
    return { mode: "project-default" };
  }

  if (strategy.mode === "existing" || strategy.mode === "custom-new") {
    return {
      mode: strategy.mode,
      branchName: strategy.branchName ?? "",
    };
  }

  if (strategy.mode === "auto-per-task") {
    return { mode: "auto-per-task" };
  }

  return { mode: "project-default" };
}

function toMissionBranchOptions(mission?: Mission): Parameters<typeof triageFeature>[4] | undefined {
  if (!mission?.baseBranch && !mission?.branchStrategy) {
    return undefined;
  }

  const strategy = mission.branchStrategy;
  const branchSelection: NonNullable<Parameters<typeof triageFeature>[4]>["branchSelection"] = {
    mode: "project-default",
    ...(mission.baseBranch ? { baseBranch: mission.baseBranch } : {}),
  };
  const options: NonNullable<Parameters<typeof triageFeature>[4]> = { branchSelection };

  if (strategy?.mode === "existing" || strategy?.mode === "custom-new") {
    const branchName = strategy.branchName?.trim();
    if (branchName) {
      options.branchSelection = {
        mode: strategy.mode,
        branchName,
        ...(mission.baseBranch ? { baseBranch: mission.baseBranch } : {}),
      };
    }
  } else if (strategy?.mode === "auto-per-task") {
    options.branchAssignment = { mode: "per-task-derived" };
  }

  return options;
}

type MissionHealthState = "healthy" | "warning" | "error";

const HOUR_MS = 60 * 60 * 1000;

/*
FNXC:MissionTimestamps 2026-06-17-17:34:
FN-6601 uses the shared relative-time bucket helper while preserving MissionManager's missing-value em dash and days-forever fallback.
*/
function getRelativeTime(timestamp: string | undefined, t: (key: string, fallback: string, opts?: Record<string, unknown>) => string): string {
  if (!timestamp) return "—";

  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return "—";

  const bucket = getRelativeTimeBucket(timestamp);
  if (!bucket) return t("missions.relativeTimeJustNow", "just now");

  switch (bucket.bucket) {
    case "just-now":
      return t("missions.relativeTimeJustNow", "just now");
    case "minutes":
      return t("missions.relativeTimeMinutes", "{{count}}m ago", { count: bucket.count });
    case "hours":
      return t("missions.relativeTimeHours", "{{count}}h ago", { count: bucket.count });
    case "days":
    case "weeks":
    case "older":
      return t("missions.relativeTimeDays", "{{count}}d ago", { count: bucket.days });
  }
}

function getMissionHealthState(health?: MissionHealth): MissionHealthState {
  if (!health) return "healthy";

  const hasRecentError =
    typeof health.lastErrorAt === "string" &&
    Date.now() - new Date(health.lastErrorAt).getTime() <= HOUR_MS;

  const failureRateThresholdExceeded =
    health.totalTasks > 0 && health.tasksFailed > health.totalTasks * 0.3;

  if (hasRecentError || failureRateThresholdExceeded) {
    return "error";
  }

  if (health.tasksFailed > 0) {
    return "warning";
  }

  if (health.tasksFailed === 0 && health.tasksInFlight <= health.totalTasks) {
    return "healthy";
  }

  return "warning";
}

function isMissionHealth(value: unknown): value is MissionHealth {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MissionHealth>;
  return (
    typeof candidate.missionId === "string" &&
    typeof candidate.tasksCompleted === "number" &&
    typeof candidate.tasksFailed === "number" &&
    typeof candidate.tasksInFlight === "number" &&
    typeof candidate.totalTasks === "number" &&
    typeof candidate.estimatedCompletionPercent === "number"
  );
}

function isMissionEvent(value: unknown): value is MissionEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MissionEvent>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.missionId === "string" &&
    typeof candidate.eventType === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.timestamp === "string"
  );
}

function isMilestoneValidationTelemetry(value: unknown): value is MilestoneValidationTelemetry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<MilestoneValidationTelemetry>;
  return (
    typeof candidate.rollup?.milestoneId === "string" &&
    typeof candidate.rollup?.state === "string" &&
    Array.isArray(candidate.validationTelemetry?.validationRounds) &&
    typeof candidate.validationTelemetry?.totalRuns === "number" &&
    candidate.validationContract !== undefined &&
    Array.isArray(candidate.fixFeatures)
  );
}

const TASK_EVENT_TYPES: MissionEventType[] = ["feature_triaged", "feature_completed"];
const SLICE_EVENT_TYPES: MissionEventType[] = ["slice_activated", "slice_completed", "milestone_completed"];
const STATE_CHANGE_EVENT_TYPES: MissionEventType[] = [
  "mission_started",
  "mission_paused",
  "mission_resumed",
  "mission_completed",
];
const AUTOPILOT_EVENT_TYPES: MissionEventType[] = [
  "autopilot_enabled",
  "autopilot_disabled",
  "autopilot_state_changed",
  "autopilot_retry",
  "autopilot_stale",
];

function matchesEventFilter(
  eventType: MissionEventType,
  filter: "all" | "errors" | "state_changes" | "tasks" | "slices" | "autopilot",
): boolean {
  switch (filter) {
    case "errors":
      return eventType === "error" || eventType === "warning";
    case "state_changes":
      return STATE_CHANGE_EVENT_TYPES.includes(eventType);
    case "tasks":
      return TASK_EVENT_TYPES.includes(eventType);
    case "slices":
      return SLICE_EVENT_TYPES.includes(eventType);
    case "autopilot":
      return AUTOPILOT_EVENT_TYPES.includes(eventType);
    default:
      return true;
  }
}

function getEventTypeClassName(eventType: MissionEventType): string {
  if (eventType === "error" || eventType === "warning") {
    return "mission-event__type--error";
  }
  if (STATE_CHANGE_EVENT_TYPES.includes(eventType)) {
    return "mission-event__type--state";
  }
  if (TASK_EVENT_TYPES.includes(eventType)) {
    return "mission-event__type--task";
  }
  if (SLICE_EVENT_TYPES.includes(eventType)) {
    return "mission-event__type--slice";
  }
  if (AUTOPILOT_EVENT_TYPES.includes(eventType)) {
    return "mission-event__type--autopilot";
  }
  return "mission-event__type--default";
}

function getEventTypeLabel(eventType: MissionEventType): string {
  return eventType.replace(/_/g, " ");
}

function getActivityQueryEventType(
  _filter: "all" | "errors" | "state_changes" | "tasks" | "slices" | "autopilot",
): MissionEventType | undefined {
  // Keep query unfiltered to support grouped UI filters (e.g. errors + warnings).
  return undefined;
}

function renderMarkdownText(text: string): ReactNode {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function getAutopilotActivitySummary(state: AutopilotState, lastActivityAt: string | undefined, t: (key: string, fallback: string, opts?: Record<string, unknown>) => string): string | null {
  if (!lastActivityAt) {
    return null;
  }

  if (state === "watching") {
    return t("missions.autopilotWatchingSince", "Watching since {{time}}", { time: getRelativeTime(lastActivityAt, t) });
  }

  return t("missions.autopilotLastActivation", "Last activation {{time}}", { time: getRelativeTime(lastActivityAt, t) });
}

function buildMissionScopedPath(path: string, projectId?: string): string {
  if (!projectId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${new URLSearchParams({ projectId }).toString()}`;
}

function normalizeMissionHierarchy(mission: MissionWithHierarchy): MissionWithHierarchy {
  if (!Array.isArray(mission.milestones)) {
    throw new Error("Malformed mission detail response: missing milestones");
  }

  return {
    ...mission,
    linkedGoals: Array.isArray(mission.linkedGoals) ? mission.linkedGoals : [],
    milestones: mission.milestones.map((milestone) => {
      if (!Array.isArray(milestone.slices)) {
        throw new Error(`Malformed mission detail response: milestone ${milestone.id} is missing slices`);
      }

      return {
        ...milestone,
        slices: milestone.slices.map((slice) => {
          if (!Array.isArray(slice.features)) {
            throw new Error(`Malformed mission detail response: slice ${slice.id} is missing features`);
          }

          return {
            ...slice,
            features: slice.features,
          };
        }),
      };
    }),
  };
}

export function MissionManager({ isOpen, isInline = false, onClose, addToast, projectId, workflowId, onSelectTask, availableTasks = [], resumeSessionId, targetMissionId, milestoneSliceResumeSessionId, onMilestoneSliceResumeFetchError, onNavigateToGoal }: MissionManagerProps) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  /*
  FNXC:Missions 2026-06-27-20:25:
  Inline Missions can stay mounted while hidden, so tab visibility must drive active state. Re-opening the tab must reset to overview instead of preserving the previously selected mission.
  */
  const isActive = isOpen;
  const cacheSuffix = projectId ?? "";
  const missionsCacheKey = `${SWR_CACHE_KEYS.MISSIONS_PREFIX}${cacheSuffix}`;
  const initialMissions = readCache<MissionWithSummary[]>(missionsCacheKey);
  const [missions, setMissions] = useState<MissionWithSummary[]>(() => (Array.isArray(initialMissions) ? initialMissions : []));
  const [selectedMission, setSelectedMission] = useState<MissionWithHierarchy | null>(null);
  const [selectedMissionBranchGroup, setSelectedMissionBranchGroup] = useState<BranchGroupSummary | null>(null);
  const [loading, setLoading] = useState(!(Array.isArray(initialMissions) && initialMissions.length > 0));
  const hasHydratedRef = useRef(Array.isArray(initialMissions) && initialMissions.length > 0);
  const [detailLoading, setDetailLoading] = useState(false);
  const isMobile = useViewportMode() === "mobile";
  const { pushNav } = useNavigationHistoryContext();
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return MISSION_SIDEBAR_DEFAULT_WIDTH;
    const stored = window.localStorage.getItem(MISSION_SIDEBAR_STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    if (!Number.isFinite(parsed)) return MISSION_SIDEBAR_DEFAULT_WIDTH;
    return Math.max(MISSION_SIDEBAR_MIN_WIDTH, Math.min(MISSION_SIDEBAR_MAX_WIDTH, parsed));
  });

  const persistSidebarWidth = useCallback((width: number) => {
    try {
      window.localStorage.setItem(MISSION_SIDEBAR_STORAGE_KEY, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, []);

  const handleSidebarResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    if (typeof handle.setPointerCapture === "function") {
      handle.setPointerCapture(event.pointerId);
    }
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const nextWidth = Math.max(
        MISSION_SIDEBAR_MIN_WIDTH,
        Math.min(MISSION_SIDEBAR_MAX_WIDTH, startWidth + deltaX),
      );
      latestWidth = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (typeof handle.releasePointerCapture === "function") {
        handle.releasePointerCapture(upEvent.pointerId);
      }
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      persistSidebarWidth(latestWidth);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  const handleSidebarResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 50 : 10;
    const delta = event.key === "ArrowLeft" ? -step : step;
    const nextWidth = Math.max(
      MISSION_SIDEBAR_MIN_WIDTH,
      Math.min(MISSION_SIDEBAR_MAX_WIDTH, sidebarWidth + delta),
    );
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, [isMobile, persistSidebarWidth, sidebarWidth]);

  // Form states
  const [isCreatingMission, setIsCreatingMission] = useState(false);
  const [editingMissionId, setEditingMissionId] = useState<string | null>(null);
  const [missionForm, setMissionForm] = useState<MissionFormData>(EMPTY_MISSION_FORM);
  const [saving, setSaving] = useState(false);

  const [expandedMilestones, setExpandedMilestones] = useState<Set<string>>(new Set());
  const [expandedSlices, setExpandedSlices] = useState<Set<string>>(new Set());

  // Editing states for nested items
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [milestoneForm, setMilestoneForm] = useState<MilestoneFormData>(EMPTY_MILESTONE_FORM);
  const [isCreatingMilestone, setIsCreatingMilestone] = useState(false);

  const [editingSliceId, setEditingSliceId] = useState<string | null>(null);
  const [sliceForm, setSliceForm] = useState<SliceFormData>(EMPTY_SLICE_FORM);
  const [isCreatingSlice, setIsCreatingSlice] = useState(false);
  const [selectedMilestoneIdForNewSlice, setSelectedMilestoneIdForNewSlice] = useState<string | null>(null);

  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null);
  const [featureForm, setFeatureForm] = useState<FeatureFormData>(EMPTY_FEATURE_FORM);
  const [isCreatingFeature, setIsCreatingFeature] = useState(false);
  const [selectedSliceIdForNewFeature, setSelectedSliceIdForNewFeature] = useState<string | null>(null);

  // Link task modal state
  const [linkTaskFeatureId, setLinkTaskFeatureId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");

  const [activeGoals, setActiveGoals] = useState<Goal[]>([]);
  const [selectedGoalToLink, setSelectedGoalToLink] = useState("");
  const [goalLinkBusy, setGoalLinkBusy] = useState(false);
  const [unlinkingGoalId, setUnlinkingGoalId] = useState<string | null>(null);

  // AI Interview modal
  const [showInterviewModal, setShowInterviewModal] = useState(false);
  const [interviewLaunchMode, setInterviewLaunchMode] = useState<"new" | "resume">("new");
  const [interviewModalKey, setInterviewModalKey] = useState(0);

  // Pending mission interview sessions (for resume prompt after page reload)
  const [_pendingInterviewSessions, setPendingInterviewSessions] = useState<AiSessionSummary[]>([]);
  const [missionInterviewDrafts, setMissionInterviewDrafts] = useState<MissionInterviewDraftSummary[]>([]);
  const [localResumeSessionId, setLocalResumeSessionId] = useState<string | undefined>(undefined);
  const dismissedResumeSessionIdRef = useRef<string | null>(null);
  const effectiveResumeSessionId =
    localResumeSessionId ??
    (resumeSessionId && dismissedResumeSessionIdRef.current === resumeSessionId ? undefined : resumeSessionId);

  // Milestone/Slice interview modal
  const [interviewTarget, setInterviewTarget] = useState<{
    type: "milestone" | "slice";
    id: string;
    title: string;
    resumeSessionId?: string;
  } | null>(null);

  // Triage preview state
  const [triagePreview, setTriagePreview] = useState<{
    featureId: string;
    enrichedDescription: string;
  } | null>(null);
  const [triagePreviewLoading, setTriagePreviewLoading] = useState<string | null>(null);

  // Auto-open interview modal when resuming a session
  useEffect(() => {
    if (isActive && effectiveResumeSessionId) {
      setInterviewLaunchMode("resume");
      setShowInterviewModal(true);
    }
  }, [isActive, effectiveResumeSessionId]);

  // If parent requests a different resume session, allow it to open again.
  useEffect(() => {
    if (resumeSessionId && dismissedResumeSessionIdRef.current !== resumeSessionId) {
      dismissedResumeSessionIdRef.current = null;
    }
  }, [resumeSessionId]);

  const loadPendingInterviewSessions = useCallback(async () => {
    const sessions = await fetchAiSessions(projectId);
    const pending = sessions.filter((s) => {
      if (s.type !== "mission_interview" || !missionInterviewListStatuses.has(s.status)) {
        return false;
      }
      if (projectId) {
        return s.projectId === projectId;
      }
      return s.projectId == null;
    });
    setPendingInterviewSessions(pending);
  }, [projectId]);

  const loadMissionInterviewDraftRows = useCallback(async () => {
    const drafts = await fetchMissionInterviewDrafts(projectId);
    setMissionInterviewDrafts(drafts);
  }, [projectId]);

  const refreshMissionSidebar = useCallback(() => {
    void loadPendingInterviewSessions().catch((err) => {
      console.warn("[MissionManager] Failed to fetch pending interview sessions:", err);
    });
    void loadMissionInterviewDraftRows().catch((err) => {
      console.warn("[MissionManager] Failed to fetch mission interview drafts:", err);
    });
  }, [loadMissionInterviewDraftRows, loadPendingInterviewSessions]);

  const loadAssertionsForMilestone = useCallback(async (milestoneId: string) => {
    try {
      const assertions = await fetchAssertions(milestoneId, projectId);
      const linkedFeatureEntries = await Promise.all(
        assertions.map(async (assertion): Promise<readonly [string, MissionFeature[]]> => {
          try {
            const features = await fetchFeaturesForAssertion(assertion.id, projectId);
            return [assertion.id, features] as const;
          } catch {
            return [assertion.id, []] as const;
          }
        }),
      );

      setAssertionsByMilestone((prev) => {
        const next = new Map(prev);
        next.set(milestoneId, assertions);
        return next;
      });
      setLinkedFeaturesByAssertion((prev) => {
        const next = new Map(prev);
        for (const [assertionId, features] of linkedFeatureEntries) {
          next.set(assertionId, features);
        }
        return next;
      });
    } catch {
      // Silently fail - assertions are optional
    }
  }, [projectId]);

  // Detect pending mission interview sessions for resume prompt
  useEffect(() => {
    if (!isActive) return;
    refreshMissionSidebar();
  }, [effectiveResumeSessionId, isActive, refreshMissionSidebar]);

  // Auto-open milestone/slice interview modal when resuming from background session
  useEffect(() => {
    if (!isActive || !milestoneSliceResumeSessionId) return;
    let cancelled = false;

    fetchAiSession(milestoneSliceResumeSessionId).then((session) => {
      if (cancelled || !session) return;

      // Parse the inputPayload to get target info
      try {
        const payload = JSON.parse(session.inputPayload || "{}");
        if (payload.targetId && payload.targetType) {
          setInterviewTarget({
            type: payload.targetType as "milestone" | "slice",
            id: payload.targetId,
            title: payload.targetTitle || session.title,
            resumeSessionId: milestoneSliceResumeSessionId,
          });
        }
      } catch {
        // If parsing fails, try to use session title as fallback
        setInterviewTarget({
          type: "milestone",
          id: "",
          title: session.title,
          resumeSessionId: milestoneSliceResumeSessionId,
        });
      }
    }).catch((err) => {
      if (cancelled) return;
      console.warn("[MissionManager] Failed to fetch session for milestone/slice resume:", err);
      onMilestoneSliceResumeFetchError?.();
    });
    return () => { cancelled = true; };
  }, [isActive, milestoneSliceResumeSessionId, onMilestoneSliceResumeFetchError]);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<{ type: string; id: string } | null>(null);

  // Assertion panel state
  const [assertionsByMilestone, setAssertionsByMilestone] = useState<Map<string, MissionContractAssertion[]>>(new Map());
  const [editingAssertionId, setEditingAssertionId] = useState<string | null>(null);
  const [assertionForm, setAssertionForm] = useState<{ title: string; assertion: string; status: MissionAssertionStatus }>({
    title: "",
    assertion: "",
    status: "pending",
  });
  const [isCreatingAssertion, setIsCreatingAssertion] = useState(false);
  const [expandedAssertionId, setExpandedAssertionId] = useState<string | null>(null);
  const [linkedFeaturesByAssertion, setLinkedFeaturesByAssertion] = useState<Map<string, MissionFeature[]>>(new Map());
  const [linkingAssertions, setLinkingAssertions] = useState<Set<string>>(new Set());
  const [unlinkingFeatures, setUnlinkingFeatures] = useState<Set<string>>(new Set());
  const [featurePickerOpenForAssertion, setFeaturePickerOpenForAssertion] = useState<string | null>(null);
  const [validationRollupByMilestone, setValidationRollupByMilestone] = useState<Map<string, MilestoneValidationRollup>>(new Map());
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null);
  const [validationTelemetry, setValidationTelemetry] = useState<MilestoneValidationTelemetry | null>(null);
  const [validationRoundsExpanded, setValidationRoundsExpanded] = useState(true);
  const [validatingFeatures, setValidatingFeatures] = useState<Set<string>>(new Set());

  // Feature loop state
  const [featureLoopStates, setFeatureLoopStates] = useState<Map<string, MissionFeatureLoopSnapshot>>(new Map());

  // Expanded feature for run history display
  const [expandedFeatureId, setExpandedFeatureId] = useState<string | null>(null);

  // Validation runs by feature
  const [validationRunsByFeature, setValidationRunsByFeature] = useState<Map<string, MissionValidatorRun[]>>(new Map());

  // Expanded run ID for showing details with failures
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  // Run details with failures (keyed by runId)
  const [runDetailsByRunId, setRunDetailsByRunId] = useState<Map<string, MissionValidatorRun & { failures?: Array<{ id: string; assertionId: string; message?: string; expected?: string; actual?: string }> }>>(new Map());

  const [missionHealthById, setMissionHealthById] = useState<Map<string, MissionHealth>>(new Map());

  const [activeTab, setActiveTab] = useState<"structure" | "activity">("structure");
  const [missionEvents, setMissionEvents] = useState<MissionEvent[]>([]);
  const missionEventsRef = useRef<MissionEvent[]>([]);
  const missionsRef = useRef<MissionWithSummary[]>([]);
  const selectedMissionRef = useRef<MissionWithHierarchy | null>(null);
  const selectedMilestoneIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<"structure" | "activity">("structure");
  const eventsFilterRef = useRef<"all" | "errors" | "state_changes" | "tasks" | "slices" | "autopilot">("all");
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsFilter, setEventsFilter] = useState<
    "all" | "errors" | "state_changes" | "tasks" | "slices" | "autopilot"
  >("all");
  const [expandedEventMetadata, setExpandedEventMetadata] = useState<Set<string>>(new Set());

  const activityEventsContainerRef = useRef<HTMLDivElement>(null);

  const activityEventsEndRef = useRef<HTMLDivElement>(null);

  const activityTabEventCount = useMemo(() => {
    if (!selectedMission?.id) {
      return eventsTotal;
    }

    const baseCount = selectedMission.eventCount
      ?? missions.find((mission) => mission.id === selectedMission.id)?.summary?.eventCount;

    if (baseCount == null) {
      return eventsTotal;
    }

    return Math.max(baseCount, eventsTotal);
  }, [eventsTotal, missions, selectedMission?.eventCount, selectedMission?.id]);

  const displayedMissionEvents = useMemo(() => [...missionEvents].reverse(), [missionEvents]);

  // Keep latest state available to long-lived SSE handlers without reconnect churn.
  missionsRef.current = missions;
  selectedMissionRef.current = selectedMission;
  selectedMilestoneIdRef.current = selectedMilestoneId;
  activeTabRef.current = activeTab;
  eventsFilterRef.current = eventsFilter;

  const scrollActivityToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const endNode = activityEventsEndRef.current;
    if (endNode && typeof endNode.scrollIntoView === "function") {
      endNode.scrollIntoView({ block: "end", behavior });
      return;
    }

    const container = activityEventsContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  const isActivityScrolledNearBottom = useCallback(() => {
    const container = activityEventsContainerRef.current;
    if (!container) {
      return true;
    }

    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceToBottom <= 100;
  }, []);

  const loadMissionHealth = useCallback(async (missionList: MissionWithSummary[]) => {
    if (missionList.length === 0) {
      setMissionHealthById(new Map());
      return;
    }

    // Use batched endpoint for optimal performance (1 request instead of N)
    const healthRecord = await fetchMissionsHealth(projectId);

    setMissionHealthById((prev) => {
      const next = new Map(prev);
      for (const [missionId, health] of Object.entries(healthRecord)) {
        if (isMissionHealth(health)) {
          next.set(missionId, health);
        }
      }
      return next;
    });
  }, [projectId]);

  const loadMissions = useCallback(async () => {
    try {
      if (!hasHydratedRef.current) {
        setLoading(true);
      }
      const fetched = await fetchMissions(projectId);
      // Defensive: API helpers can return an envelope or non-array under
      // failure paths; downstream code (render, filter) assumes an array.
      const data = Array.isArray(fetched)
        ? fetched
        : fetched && Array.isArray((fetched as { data?: unknown }).data)
          ? ((fetched as { data: MissionWithSummary[] }).data)
          : [];
      setMissions(data);
      writeCache(
        missionsCacheKey,
        data.length > 200 ? data.slice(0, 200) : data,
        { maxBytes: 500_000 },
      );
      hasHydratedRef.current = true;
      void loadMissionHealth(data);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.loadFailed", "Failed to load missions"), "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, loadMissionHealth, missionsCacheKey, projectId]);

  const loadActiveGoals = useCallback(async () => {
    try {
      const result = await api<{ goals?: Goal[] }>(buildMissionScopedPath("/goals?status=active", projectId));
      setActiveGoals(Array.isArray(result.goals) ? result.goals : []);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.loadGoalsFailed", "Failed to load goals"), "error");
      setActiveGoals([]);
    }
  }, [addToast, projectId, t]);

  const loadMissionDetail = useCallback(async (missionId: string) => {
    try {
      setDetailLoading(true);
      const payload = await fetchMission(missionId, projectId);
      if (!payload || typeof payload !== "object") {
        throw new Error("Malformed mission detail response");
      }

      const data = normalizeMissionHierarchy(payload as MissionWithHierarchy);
      setSelectedMission(data);
      if (data.milestones.length > 0) {
        const firstMilestoneId = data.milestones[0].id;
        const milestoneIds = new Set(data.milestones.map((milestone) => milestone.id));
        const currentSelectedMilestoneId = selectedMilestoneIdRef.current;
        const selectedMilestoneStillExists =
          typeof currentSelectedMilestoneId === "string" && milestoneIds.has(currentSelectedMilestoneId);
        const nextSelectedMilestoneId = selectedMilestoneStillExists
          ? currentSelectedMilestoneId
          : firstMilestoneId;

        setSelectedMilestoneId(nextSelectedMilestoneId);
        setValidationRoundsExpanded(true);

        // FN-4613: preserve user-expanded milestones/slices across refetch instead of resetting to first-only.
        setExpandedMilestones((prev) => {
          const next = new Set(Array.from(prev).filter((milestoneId) => milestoneIds.has(milestoneId)));
          next.add(nextSelectedMilestoneId);
          return next;
        });

        const availableSliceIds = new Set(
          data.milestones.flatMap((milestone) => milestone.slices.map((slice) => slice.id)),
        );
        const selectedMilestone = data.milestones.find((milestone) => milestone.id === nextSelectedMilestoneId);
        const selectedMilestoneFirstSliceId = selectedMilestone?.slices[0]?.id ?? null;
        setExpandedSlices((prev) => {
          const next = new Set(Array.from(prev).filter((sliceId) => availableSliceIds.has(sliceId)));
          if (selectedMilestoneFirstSliceId) {
            const hasExpandedSliceForSelectedMilestone = selectedMilestone?.slices.some((slice) => next.has(slice.id)) ?? false;
            if (!hasExpandedSliceForSelectedMilestone) {
              next.add(selectedMilestoneFirstSliceId);
            }
          }
          return next;
        });

        // Load assertions and validation rollup for the selected milestone.
        void loadAssertionsForMilestone(nextSelectedMilestoneId);
        fetchMilestoneValidation(nextSelectedMilestoneId, projectId).then((rollup) => {
          setValidationRollupByMilestone((prev) => {
            const next = new Map(prev);
            next.set(nextSelectedMilestoneId, rollup);
            return next;
          });
        }).catch(() => { /* silently fail */ });
      } else {
        setSelectedMilestoneId(null);
        setValidationTelemetry(null);
      }
    } catch (err) {
      console.error("[MissionManager] loadMissionDetail:", err);
      addToast(getErrorMessage(err) || t("missions.loadDetailFailed", "Failed to load mission details"), "error");
    } finally {
      setDetailLoading(false);
    }
  }, [addToast, loadAssertionsForMilestone, projectId]);

  useEffect(() => {
    let cancelled = false;
    setSelectedMissionBranchGroup(null);

    const selectedMissionId = selectedMission?.id;
    const taskIds = selectedMission?.milestones.flatMap((milestone) =>
      milestone.slices.flatMap((slice) => slice.features.flatMap((feature) => feature.taskId ? [feature.taskId] : [])),
    ) ?? [];
    if (!selectedMissionId || taskIds.length === 0) return () => { cancelled = true; };

    void (async () => {
      for (const taskId of taskIds) {
        try {
          const task = await fetchTaskDetail(taskId, projectId);
          const groupId = task.branchContext?.source === "mission" ? task.branchContext.groupId : undefined;
          if (!groupId) continue;
          const { group } = await apiGetBranchGroup(groupId, projectId);
          /*
          FNXC:MissionAutoMerge 2026-07-19-00:00:
          A task can retain a stale or colliding branch-group id. Only show a group that
          is owned by the selected mission so its detail pane never reports another
          mission's branch or PR state.
          */
          if (group?.sourceType !== "mission" || group.sourceId !== selectedMissionId) continue;
          if (!cancelled) setSelectedMissionBranchGroup(group);
          return;
        } catch {
          // A stale/deleted linked task or unavailable group must not break mission detail rendering.
        }
      }
    })();

    return () => { cancelled = true; };
  }, [projectId, selectedMission]);

  useEffect(() => {
    if (!isActive || !selectedMilestoneId) {
      setValidationTelemetry(null);
      return;
    }

    let cancelled = false;
    setValidationTelemetry(null);

    fetchMilestoneValidationTelemetry(selectedMilestoneId, projectId)
      .then((telemetry) => {
        if (cancelled) {
          return;
        }
        if (!isMilestoneValidationTelemetry(telemetry)) {
          setValidationTelemetry(null);
          return;
        }

        setValidationTelemetry(telemetry);
        setValidationRollupByMilestone((prev) => {
          const next = new Map(prev);
          next.set(selectedMilestoneId, telemetry.rollup);
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setValidationTelemetry(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isActive, selectedMilestoneId, projectId]);

  useEffect(() => {
    setValidationRoundsExpanded(true);
    if (!selectedMilestoneId) {
      return;
    }
    // FN-4613: selecting a milestone from any navigation path keeps its acceptance criteria visible.
    setExpandedMilestones((prev) => {
      if (prev.has(selectedMilestoneId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(selectedMilestoneId);
      return next;
    });
  }, [selectedMilestoneId]);

  const refreshValidationTelemetry = useCallback((milestoneId: string) => {
    if (!milestoneId || milestoneId !== selectedMilestoneIdRef.current) {
      return;
    }

    void fetchMilestoneValidationTelemetry(milestoneId, projectId)
      .then((telemetry) => {
        if (selectedMilestoneIdRef.current !== milestoneId || !isMilestoneValidationTelemetry(telemetry)) {
          return;
        }
        setValidationTelemetry(telemetry);
        setValidationRollupByMilestone((prev) => {
          const next = new Map(prev);
          next.set(milestoneId, telemetry.rollup);
          return next;
        });
      })
      .catch(() => {
        // Silently fail - telemetry is supplemental
      });
  }, [projectId]);

  const loadMissionEvents = useCallback(async (
    missionId: string,
    options?: { append?: boolean },
  ) => {
    const append = options?.append ?? false;
    const offset = append ? missionEventsRef.current.length : 0;

    if (!append) {
      setEventsLoading(true);
      setExpandedEventMetadata(new Set());
    }

    try {
      const response = await fetchMissionEvents(
        missionId,
        {
          limit: 50,
          offset,
          eventType: getActivityQueryEventType(eventsFilter),
        },
        projectId,
      );

      const incomingEvents = response.events.filter((event) => matchesEventFilter(event.eventType, eventsFilter));

      setMissionEvents((prev) => {
        if (!append) {
          missionEventsRef.current = incomingEvents;
          return incomingEvents;
        }

        const existing = new Set(prev.map((event) => event.id));
        const merged = [...prev];
        for (const event of incomingEvents) {
          if (!existing.has(event.id)) {
            merged.push(event);
          }
        }
        missionEventsRef.current = merged;
        return merged;
      });

      setEventsTotal(response.total);

      if (!append) {
        requestAnimationFrame(() => {
          scrollActivityToLatest("auto");
        });
      }
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.loadActivityFailed", "Failed to load mission activity"), "error");
    } finally {
      if (!append) {
        setEventsLoading(false);
      }
    }
  }, [addToast, eventsFilter, projectId, scrollActivityToLatest]);

  useEffect(() => {
    missionEventsRef.current = missionEvents;
  }, [missionEvents]);

  useEffect(() => {
    const cachedMissions = readCache<MissionWithSummary[]>(missionsCacheKey);
    const hasCachedMissions = Array.isArray(cachedMissions) && cachedMissions.length > 0;
    setMissions(Array.isArray(cachedMissions) ? cachedMissions : []);
    setLoading(!hasCachedMissions);
    hasHydratedRef.current = hasCachedMissions;
  }, [missionsCacheKey]);

  useEffect(() => {
    if (isActive) {
      loadMissions();
      loadActiveGoals();
      setSelectedMission(null);
      setSelectedMilestoneId(null);
      setValidationTelemetry(null);
      setMissionEvents([]);
      setEventsTotal(0);
      setActiveTab("structure");
      setEventsFilter("all");
      setExpandedEventMetadata(new Set());
    }
  }, [isActive, loadActiveGoals, loadMissions]);

  /*
  FNXC:Missions 2026-06-27-00:00:
  Entering the Missions tab must always land on the overview list with an empty detail pane. Only explicit `targetMissionId` deep links or interview resume sessions may open a specific mission automatically; do not restore the last selected mission or default-select the first mission on tab entry.
  */
  // Auto-load target mission when specified
  const targetLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (isActive && targetMissionId && targetLoadedRef.current !== targetMissionId && missions.length > 0) {
      targetLoadedRef.current = targetMissionId;
      loadMissionDetail(targetMissionId);
    }
  }, [isActive, targetMissionId, missions, loadMissionDetail]);

  // Reset target tracking when modal closes
  useEffect(() => {
    if (!isActive) {
      targetLoadedRef.current = null;
    }
  }, [isActive]);

  useEffect(() => {
    if (!isActive || !selectedMission || activeTab !== "activity") {
      return;
    }

    void loadMissionEvents(selectedMission.id);
  }, [activeTab, isActive, loadMissionEvents, selectedMission, eventsFilter]);

  useEffect(() => {
    if (!isActive || typeof EventSource === "undefined") {
      return;
    }

    const search = new URLSearchParams();
    if (projectId) {
      search.set("projectId", projectId);
    }
    const eventUrl = `/api/events${search.size > 0 ? `?${search.toString()}` : ""}`;

    const refreshHealth = () => {
      void loadMissionHealth(missionsRef.current);
    };

    const handleMissionUpdated = (rawEvent: Event) => {
      refreshHealth();

      const messageEvent = rawEvent as MessageEvent<string>;
      if (messageEvent.data) {
        try {
          const updatedMission = JSON.parse(messageEvent.data) as Partial<MissionWithSummary> & { id?: string };
          if (updatedMission?.id) {
            setMissions((prev) =>
              prev.map((m) =>
                m.id === updatedMission.id ? { ...m, ...updatedMission } : m
              )
            );
            setSelectedMission((prev) =>
              prev && prev.id === updatedMission.id
                ? normalizeMissionHierarchy({ ...prev, ...updatedMission })
                : prev
            );
          }
        } catch {
          // ignore invalid payloads
        }
      }

      refreshMissionSidebar();

      // Reload the selected mission detail to reflect updated mission state (autopilot, status, etc.)
      if (selectedMissionRef.current) {
        void loadMissionDetail(selectedMissionRef.current.id);
      }
    };

    const handleMissionCreated = () => {
      refreshHealth();
      void loadMissions();
      refreshMissionSidebar();
    };

    const handleMissionDeleted = (rawEvent: Event) => {
      refreshHealth();
      const messageEvent = rawEvent as MessageEvent<string>;
      if (messageEvent.data) {
        try {
          const deletedMissionId = JSON.parse(messageEvent.data) as string;
          if (deletedMissionId && selectedMissionRef.current?.id === deletedMissionId) {
            setSelectedMission(null);
          }
        } catch {
          // ignore invalid payloads
        }
      }
      void loadMissions();
      refreshMissionSidebar();
    };

    const handleSliceUpdated = (_rawEvent: Event) => {
      refreshHealth();
      // Reload the selected mission detail to reflect updated slice status
      if (selectedMissionRef.current) {
        void loadMissionDetail(selectedMissionRef.current.id);
      }
    };

    const handleFeatureUpdated = () => {
      refreshHealth();
      // Reload the selected mission detail to reflect updated feature status
      if (selectedMissionRef.current) {
        void loadMissionDetail(selectedMissionRef.current.id);
      }
    };

    const handleMilestoneUpdated = (_rawEvent: Event) => {
      refreshHealth();
      // Reload the selected mission detail to reflect updated milestone status
      if (selectedMissionRef.current) {
        void loadMissionDetail(selectedMissionRef.current.id);
      }
    };

    const handleAiSessionUpdated = (rawEvent: Event) => {
      const messageEvent = rawEvent as MessageEvent<string>;
      if (!messageEvent.data) {
        return;
      }
      try {
        const updatedSession = JSON.parse(messageEvent.data) as AiSessionSummary;
        if (updatedSession.type !== "mission_interview") {
          return;
        }
      } catch {
        return;
      }
      void loadMissions();
      refreshMissionSidebar();
    };

    const handleAiSessionDeleted = () => {
      void loadMissions();
      refreshMissionSidebar();
    };

    // Handler for validator run started - refresh feature loop state and validation runs
    const handleValidatorRunStarted = (rawEvent: Event) => {
      const messageEvent = rawEvent as MessageEvent<string>;
      if (!messageEvent.data) return;
      try {
        const payload = JSON.parse(messageEvent.data);
        if (payload && payload.featureId) {
          // Refresh feature loop state
          void loadFeatureLoopState(payload.featureId);
          // Refresh validation runs
          void loadValidationRuns(payload.featureId);
          if (payload.milestoneId) {
            refreshValidationTelemetry(payload.milestoneId);
          }
        }
      } catch {
        // ignore invalid payloads
      }
    };

    // Handler for validator run completed - refresh feature loop state, runs, mission detail, and telemetry
    const handleValidatorRunCompleted = (rawEvent: Event) => {
      const messageEvent = rawEvent as MessageEvent<string>;
      if (!messageEvent.data) return;
      try {
        const payload = JSON.parse(messageEvent.data);
        if (payload && payload.featureId) {
          // Refresh feature loop state
          void loadFeatureLoopState(payload.featureId);
          // Refresh validation runs
          void loadValidationRuns(payload.featureId);
          if (payload.milestoneId) {
            refreshValidationTelemetry(payload.milestoneId);
          }
          // Refresh mission detail to update feature status
          if (selectedMissionRef.current) {
            void loadMissionDetail(selectedMissionRef.current.id);
          }
        }
      } catch {
        // ignore invalid payloads
      }
    };

    // Handler for milestone validation updated - refresh validation rollup
    const handleMilestoneValidationUpdated = (rawEvent: Event) => {
      const messageEvent = rawEvent as MessageEvent<string>;
      if (!messageEvent.data) return;
      try {
        const payload = JSON.parse(messageEvent.data);
        if (payload && payload.milestoneId) {
          void loadValidationRollup(payload.milestoneId);
          refreshValidationTelemetry(payload.milestoneId);
        }
      } catch {
        // ignore invalid payloads
      }
    };

    // Handler for assertion mutations - refresh assertions and validation rollup
    const handleAssertionMutation = (rawEvent: Event) => {
      const messageEvent = rawEvent as MessageEvent<string>;
      if (!messageEvent.data) return;
      try {
        const payload = JSON.parse(messageEvent.data);
        if (payload && payload.milestoneId) {
          void loadAssertionsForMilestone(payload.milestoneId);
          void loadValidationRollup(payload.milestoneId);
          refreshValidationTelemetry(payload.milestoneId);
        }
      } catch {
        // ignore invalid payloads
      }
    };

    // Handler for fix-feature:created - refresh mission detail to show new fix feature with lineage
    const handleFixFeatureCreated = (rawEvent: Event) => {
      const messageEvent = rawEvent as MessageEvent<string>;
      if (!messageEvent.data) return;
      try {
        const payload = JSON.parse(messageEvent.data);
        if (payload && payload.sourceFeatureId) {
          // Refresh feature loop state for the source feature
          void loadFeatureLoopState(payload.sourceFeatureId);

          const createdFeatureSliceId = payload?.feature?.sliceId as string | undefined;
          const selectedMission = selectedMissionRef.current;
          if (createdFeatureSliceId && selectedMission) {
            const containingMilestone = selectedMission.milestones.find((milestone) =>
              milestone.slices.some((slice) => slice.id === createdFeatureSliceId)
            );
            if (containingMilestone) {
              refreshValidationTelemetry(containingMilestone.id);
            }
          }

          // Refresh mission detail to show the new fix feature in the list
          if (selectedMissionRef.current) {
            void loadMissionDetail(selectedMissionRef.current.id);
          }
        }
      } catch {
        // ignore invalid payloads
      }
    };

    const handleMissionEvent = (rawEvent: Event) => {
      refreshHealth();

      const currentSelectedMission = selectedMissionRef.current;
      if (!currentSelectedMission || activeTabRef.current !== "activity") {
        return;
      }

      const shouldAutoScroll = isActivityScrolledNearBottom();
      const messageEvent = rawEvent as MessageEvent<string>;
      if (!messageEvent.data) {
        return;
      }

      try {
        const payload = JSON.parse(messageEvent.data);
        if (!isMissionEvent(payload)) {
          return;
        }
        if (payload.missionId !== currentSelectedMission.id) {
          return;
        }
        if (!matchesEventFilter(payload.eventType, eventsFilterRef.current)) {
          return;
        }

        setMissionEvents((prev) => {
          const withoutExisting = prev.filter((event) => event.id !== payload.id);
          return [payload, ...withoutExisting].slice(0, 100);
        });
        setEventsTotal((prev) => prev + 1);

        if (shouldAutoScroll) {
          requestAnimationFrame(() => {
            scrollActivityToLatest();
          });
        }
      } catch {
        // ignore invalid payloads
      }
    };

    return subscribeSse(eventUrl, {
      events: {
        "mission:created": handleMissionCreated,
        "mission:updated": handleMissionUpdated,
        "mission:deleted": handleMissionDeleted,
        "slice:updated": handleSliceUpdated,
        "feature:updated": handleFeatureUpdated,
        "milestone:updated": handleMilestoneUpdated,
        "mission:event": handleMissionEvent,
        "ai_session:updated": handleAiSessionUpdated,
        "ai_session:deleted": handleAiSessionDeleted,
        "validator-run:started": handleValidatorRunStarted,
        "validator-run:completed": handleValidatorRunCompleted,
        "milestone:validation:updated": handleMilestoneValidationUpdated,
        "assertion:created": handleAssertionMutation,
        "assertion:updated": handleAssertionMutation,
        "assertion:deleted": handleAssertionMutation,
        "assertion:linked": handleAssertionMutation,
        "assertion:unlinked": handleAssertionMutation,
        "fix-feature:created": handleFixFeatureCreated,
      },
      onReconnect: () => {
        void loadMissions();
        refreshMissionSidebar();
      },
    });
  }, [
    isActive,
    isActivityScrolledNearBottom,
    loadMissionDetail,
    loadMissionHealth,
    loadMissions,
    projectId,
    refreshMissionSidebar,
    refreshValidationTelemetry,
    scrollActivityToLatest,
  ]);

  // Mission handlers
  const handleEditMission = useCallback((mission: Mission) => {
    setEditingMissionId(mission.id);
    setIsCreatingMission(false);
    setMissionForm({
      title: mission.title,
      description: mission.description || "",
      status: mission.status,
      autopilotEnabled: mission.autopilotEnabled ?? false,
      autoMergeOverride: missionAutoMergeOverride(mission.autoMerge),
      baseBranch: mission.baseBranch ?? "",
      branchStrategy: normalizeMissionBranchStrategy(mission.branchStrategy),
    });
  }, []);

  const handleCancelMission = useCallback(() => {
    setEditingMissionId(null);
    setIsCreatingMission(false);
    setMissionForm(EMPTY_MISSION_FORM);
  }, []);

  const handleSaveMission = useCallback(async () => {
    if (!missionForm.title.trim()) {
      addToast(t("missions.titleRequired", "Mission title is required"), "error");
      return;
    }

    const branchNameRequired =
      missionForm.branchStrategy.mode === "existing" || missionForm.branchStrategy.mode === "custom-new";
    const branchName = missionForm.branchStrategy.branchName?.trim() ?? "";
    if (branchNameRequired && !branchName) {
      addToast(t("missions.branchNameRequired", "Branch name is required for selected branch strategy"), "error");
      return;
    }

    const branchStrategy: Mission["branchStrategy"] =
      missionForm.branchStrategy.mode === "existing" || missionForm.branchStrategy.mode === "custom-new"
        ? { mode: missionForm.branchStrategy.mode, branchName }
        : { mode: missionForm.branchStrategy.mode };

    try {
      setSaving(true);
      if (isCreatingMission) {
        await createMission({
          title: missionForm.title.trim(),
          description: missionForm.description.trim() || undefined,
          autopilotEnabled: missionForm.autopilotEnabled,
          ...(resolveMissionAutoMerge(missionForm.autoMergeOverride) !== undefined
            ? { autoMerge: resolveMissionAutoMerge(missionForm.autoMergeOverride) }
            : {}),
          baseBranch: missionForm.baseBranch.trim() || undefined,
          branchStrategy,
        }, projectId);
        addToast(t("missions.created", "Mission created"), "success");
      } else if (editingMissionId) {
        // Build update payload - when autopilot is enabled, also set autoAdvance
        // for backward compat with the engine (though engine no longer reads it)
        const updates: Record<string, unknown> = {
          title: missionForm.title.trim(),
          description: missionForm.description.trim() || undefined,
          status: missionForm.status,
          autopilotEnabled: missionForm.autopilotEnabled,
          // FNXC:MissionAutoMerge 2026-07-18-12:00: JSON drops undefined, so edit inheritance must use null to clear a saved override.
          autoMerge: resolveMissionAutoMerge(missionForm.autoMergeOverride) ?? null,
          baseBranch: missionForm.baseBranch.trim() || "",
          branchStrategy,
        };
        if (missionForm.autopilotEnabled) {
          updates.autoAdvance = true;
        }
        await updateMission(editingMissionId, updates as Parameters<typeof updateMission>[1], projectId);
        addToast(t("missions.updated", "Mission updated"), "success");
        // Refresh detail view if viewing this mission
        if (selectedMission?.id === editingMissionId) {
          await loadMissionDetail(editingMissionId);
        }
      }
      await loadMissions();
      handleCancelMission();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.saveFailed", "Failed to save mission"), "error");
    } finally {
      setSaving(false);
    }
  }, [missionForm, isCreatingMission, editingMissionId, addToast, loadMissions, loadMissionDetail, selectedMission, handleCancelMission, projectId]);

  const handleDeleteMission = useCallback(async (missionId: string) => {
    try {
      await deleteMission(missionId, projectId);
      addToast(t("missions.deleted", "Mission deleted"), "success");
      if (selectedMission?.id === missionId) {
        setSelectedMission(null);
      }
      await loadMissions();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.deleteFailed", "Failed to delete mission"), "error");
    }
  }, [addToast, loadMissions, selectedMission, projectId, t]);

  const requestDeleteMission = useCallback(async (missionId: string) => {
    /*
    FNXC:MissionManager 2026-06-24-00:00:
    Mission deletes are destructive and must use the app-level modal confirmation from both list and detail delete affordances. Keeping this path out of the inline mission-confirm-panel prevents the prompt from landing in the sidebar footer, detail pane, or below mobile scroll content.
    */
    const confirmed = await confirm({
      title: t("missions.deleteMission", "Delete mission"),
      message: t("missions.deleteConfirm", "Delete this {{type}}? This cannot be undone.", { type: "mission" }),
      confirmLabel: t("missions.deleteButton", "Delete"),
      cancelLabel: t("missions.cancelButton", "Cancel"),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    await handleDeleteMission(missionId);
  }, [confirm, handleDeleteMission, t]);

  // Milestone handlers
  const handleCreateMilestone = useCallback(() => {
    setIsCreatingMilestone(true);
    setEditingMilestoneId(null);
    setMilestoneForm(EMPTY_MILESTONE_FORM);
  }, []);

  const handleEditMilestone = useCallback((milestone: Milestone) => {
    setEditingMilestoneId(milestone.id);
    setIsCreatingMilestone(false);
    setMilestoneForm({
      title: milestone.title,
      description: milestone.description || "",
      acceptanceCriteria: milestone.acceptanceCriteria || "",
      status: milestone.status,
      dependencies: milestone.dependencies,
    });
  }, []);

  const handleCancelMilestone = useCallback(() => {
    setEditingMilestoneId(null);
    setIsCreatingMilestone(false);
    setMilestoneForm(EMPTY_MILESTONE_FORM);
  }, []);

  const handleSaveMilestone = useCallback(async () => {
    if (!milestoneForm.title.trim()) {
      addToast(t("missions.milestoneTitleRequired", "Milestone title is required"), "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingMilestone && selectedMission) {
        await createMilestone(selectedMission.id, {
          title: milestoneForm.title.trim(),
          description: milestoneForm.description.trim() || undefined,
          acceptanceCriteria: milestoneForm.acceptanceCriteria.trim() || undefined,
          dependencies: milestoneForm.dependencies,
        }, projectId);
        addToast(t("missions.milestoneCreated", "Milestone created"), "success");
      } else if (editingMilestoneId) {
        await updateMilestone(editingMilestoneId, {
          title: milestoneForm.title.trim(),
          description: milestoneForm.description.trim() || undefined,
          acceptanceCriteria: milestoneForm.acceptanceCriteria.trim() || undefined,
          status: milestoneForm.status,
          dependencies: milestoneForm.dependencies,
        }, projectId);
        addToast(t("missions.milestoneUpdated", "Milestone updated"), "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelMilestone();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.milestoneSaveFailed", "Failed to save milestone"), "error");
    } finally {
      setSaving(false);
    }
  }, [milestoneForm, isCreatingMilestone, editingMilestoneId, selectedMission, addToast, loadMissionDetail, handleCancelMilestone, missionForm.title, projectId]);

  const handleDeleteMilestone = useCallback(async (milestoneId: string) => {
    try {
      await deleteMilestone(milestoneId, projectId);
      addToast(t("missions.milestoneDeleted", "Milestone deleted"), "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.milestoneDeleteFailed", "Failed to delete milestone"), "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const toggleMilestoneExpanded = useCallback((milestoneId: string) => {
    setSelectedMilestoneId(milestoneId);
    setValidationRoundsExpanded(true);
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      const isExpanding = !next.has(milestoneId);
      if (isExpanding) {
        next.add(milestoneId);
        // Load assertions and validation rollup when expanding milestone
        void loadAssertionsForMilestone(milestoneId);
        fetchMilestoneValidation(milestoneId, projectId).then((rollup) => {
          setValidationRollupByMilestone((prev) => {
            const next = new Map(prev);
            next.set(milestoneId, rollup);
            return next;
          });
        }).catch(() => { /* silently fail */ });
      } else {
        next.delete(milestoneId);
      }
      return next;
    });
  }, [loadAssertionsForMilestone, projectId]);

  // Slice handlers
  const handleCreateSlice = useCallback((milestoneId: string) => {
    setSelectedMilestoneIdForNewSlice(milestoneId);
    setIsCreatingSlice(true);
    setEditingSliceId(null);
    setSliceForm(EMPTY_SLICE_FORM);
  }, []);

  const handleEditSlice = useCallback((slice: Slice) => {
    setEditingSliceId(slice.id);
    setIsCreatingSlice(false);
    setSliceForm({
      title: slice.title,
      description: slice.description || "",
      status: slice.status,
    });
  }, []);

  const handleCancelSlice = useCallback(() => {
    setEditingSliceId(null);
    setIsCreatingSlice(false);
    setSelectedMilestoneIdForNewSlice(null);
    setSliceForm(EMPTY_SLICE_FORM);
  }, []);

  const handleSaveSlice = useCallback(async () => {
    if (!sliceForm.title.trim()) {
      addToast(t("missions.sliceTitleRequired", "Slice title is required"), "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingSlice && selectedMilestoneIdForNewSlice) {
        await createSlice(selectedMilestoneIdForNewSlice, {
          title: sliceForm.title.trim(),
          description: sliceForm.description.trim() || undefined,
        }, projectId);
        addToast(t("missions.sliceCreated", "Slice created"), "success");
      } else if (editingSliceId) {
        await updateSlice(editingSliceId, {
          title: sliceForm.title.trim(),
          description: sliceForm.description.trim() || undefined,
          status: sliceForm.status,
        }, projectId);
        addToast(t("missions.sliceUpdated", "Slice updated"), "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelSlice();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.sliceSaveFailed", "Failed to save slice"), "error");
    } finally {
      setSaving(false);
    }
  }, [sliceForm, isCreatingSlice, editingSliceId, selectedMilestoneIdForNewSlice, selectedMission, addToast, loadMissionDetail, handleCancelSlice, projectId]);

  const handleDeleteSlice = useCallback(async (sliceId: string) => {
    try {
      await deleteSlice(sliceId, projectId);
      addToast(t("missions.sliceDeleted", "Slice deleted"), "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.sliceDeleteFailed", "Failed to delete slice"), "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const handleActivateSlice = useCallback(async (sliceId: string) => {
    try {
      await activateSlice(sliceId, projectId);
      addToast(t("missions.sliceActivated", "Slice activated"), "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.sliceActivateFailed", "Failed to activate slice"), "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const toggleSliceExpanded = useCallback((sliceId: string) => {
    setExpandedSlices((prev) => {
      const next = new Set(prev);
      if (next.has(sliceId)) {
        next.delete(sliceId);
      } else {
        next.add(sliceId);
      }
      return next;
    });
  }, []);

  // Feature handlers
  const handleCreateFeature = useCallback((sliceId: string) => {
    setSelectedSliceIdForNewFeature(sliceId);
    setIsCreatingFeature(true);
    setEditingFeatureId(null);
    setFeatureForm(EMPTY_FEATURE_FORM);
  }, []);

  const handleEditFeature = useCallback((feature: MissionFeature) => {
    setEditingFeatureId(feature.id);
    setIsCreatingFeature(false);
    setFeatureForm({
      title: feature.title,
      description: feature.description || "",
      acceptanceCriteria: feature.acceptanceCriteria || "",
      status: feature.status,
    });
  }, []);

  const handleCancelFeature = useCallback(() => {
    setEditingFeatureId(null);
    setIsCreatingFeature(false);
    setSelectedSliceIdForNewFeature(null);
    setFeatureForm(EMPTY_FEATURE_FORM);
  }, []);

  const handleSaveFeature = useCallback(async () => {
    if (!featureForm.title.trim()) {
      addToast(t("missions.featureTitleRequired", "Feature title is required"), "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingFeature && selectedSliceIdForNewFeature) {
        await createFeature(selectedSliceIdForNewFeature, {
          title: featureForm.title.trim(),
          description: featureForm.description.trim() || undefined,
          acceptanceCriteria: featureForm.acceptanceCriteria.trim() || undefined,
        }, projectId);
        addToast(t("missions.featureCreated", "Feature created"), "success");
      } else if (editingFeatureId) {
        await updateFeature(editingFeatureId, {
          title: featureForm.title.trim(),
          description: featureForm.description.trim() || undefined,
          acceptanceCriteria: featureForm.acceptanceCriteria.trim() || undefined,
          status: featureForm.status,
        }, projectId);
        addToast(t("missions.featureUpdated", "Feature updated"), "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelFeature();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.featureSaveFailed", "Failed to save feature"), "error");
    } finally {
      setSaving(false);
    }
  }, [featureForm, isCreatingFeature, editingFeatureId, selectedSliceIdForNewFeature, selectedMission, addToast, loadMissionDetail, handleCancelFeature, projectId]);

  const handleDeleteFeature = useCallback(async (featureId: string) => {
    try {
      await deleteFeature(featureId, projectId);
      addToast(t("missions.featureDeleted", "Feature deleted"), "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.featureDeleteFailed", "Failed to delete feature"), "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const handleLinkTask = useCallback(async () => {
    if (!linkTaskFeatureId || !selectedTaskId.trim()) {
      addToast(t("missions.taskIdRequired", "Task ID is required"), "error");
      return;
    }

    try {
      await linkFeatureToTask(linkTaskFeatureId, selectedTaskId.trim(), projectId);
      addToast(t("missions.featureLinkedToTask", "Feature linked to task"), "success");
      await loadMissionDetail(selectedMission!.id);
      setLinkTaskFeatureId(null);
      setSelectedTaskId("");
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.featureLinkTaskFailed", "Failed to link feature to task"), "error");
    }
  }, [linkTaskFeatureId, selectedTaskId, addToast, loadMissionDetail, selectedMission, projectId]);

  const handleUnlinkTask = useCallback(async (featureId: string) => {
    try {
      await unlinkFeatureFromTask(featureId, projectId);
      addToast(t("missions.featureUnlinkedFromTask", "Feature unlinked from task"), "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.featureUnlinkFailed", "Failed to unlink feature"), "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const missionTriageOptions = useMemo(() => {
    const branchOptions = toMissionBranchOptions(selectedMission ?? undefined);
    /*
    FNXC:MissionWorkflows 2026-06-25-00:00:
    Mission feature and slice triage must carry the active header workflow into task creation just like Planning. Omit the field when the switcher has no resolved selection so API/tool/autopilot paths continue inheriting the project default.
    */
    return {
      ...branchOptions,
      ...(workflowId ? { workflowId } : {}),
    } as NonNullable<Parameters<typeof triageFeature>[4]> & { workflowId?: string };
  }, [selectedMission, workflowId]);

  // Triage a single feature — creates a task and links it
  const handleTriageFeature = useCallback(async (featureId: string) => {
    try {
      setSaving(true);
      await triageFeature(featureId, undefined, undefined, projectId, missionTriageOptions);
      addToast(t("missions.featureTriaged", "Feature triaged — task created"), "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.featureTriageFailed", "Failed to triage feature"), "error");
    } finally {
      setSaving(false);
    }
  }, [addToast, loadMissionDetail, missionTriageOptions, selectedMission, projectId]);

  // Triage with preview — fetches enriched description first
  const handleTriageFeatureWithPreview = useCallback(async (featureId: string) => {
    setTriagePreviewLoading(featureId);
    try {
      const result = await previewEnrichedDescription(featureId, projectId);
      setTriagePreview({ featureId, enrichedDescription: result.description });
    } catch {
      // Fallback to direct triage if preview endpoint not available
      await handleTriageFeature(featureId);
    } finally {
      setTriagePreviewLoading(null);
    }
  }, [handleTriageFeature, projectId]);

  // Confirm triage from preview
  const handleConfirmTriageFromPreview = useCallback(async () => {
    if (!triagePreview) return;
    setTriagePreview(null);
    await handleTriageFeature(triagePreview.featureId);
  }, [handleTriageFeature, triagePreview]);

  // Cancel triage preview
  const handleCancelTriagePreview = useCallback(() => {
    setTriagePreview(null);
  }, []);

  // Triage all defined features in a slice
  const handleTriageAllSliceFeatures = useCallback(async (sliceId: string) => {
    try {
      setSaving(true);
      const result = await triageAllSliceFeatures(sliceId, projectId, missionTriageOptions);
      addToast(t("missions.sliceTriaged", { count: result.count, defaultValue_one: "Triaged {{count}} feature", defaultValue_other: "Triaged {{count}} features" }), "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.sliceTriageFailed", "Failed to triage slice features"), "error");
    } finally {
      setSaving(false);
    }
  }, [addToast, loadMissionDetail, missionTriageOptions, selectedMission, projectId]);

  // ── Assertion handlers ──

  const loadValidationRollup = useCallback(async (milestoneId: string) => {
    try {
      const rollup = await fetchMilestoneValidation(milestoneId, projectId);
      setValidationRollupByMilestone((prev) => {
        const next = new Map(prev);
        next.set(milestoneId, rollup);
        return next;
      });
    } catch {
      // Silently fail
    }
  }, [projectId]);

  const handleCreateAssertion = useCallback(async (milestoneId: string) => {
    if (!assertionForm.title.trim() || !assertionForm.assertion.trim()) {
      addToast(t("missions.assertionFieldsRequired", "Title and assertion text are required"), "error");
      return;
    }
    try {
      setSaving(true);
      await createAssertion(milestoneId, {
        title: assertionForm.title.trim(),
        assertion: assertionForm.assertion.trim(),
        status: assertionForm.status,
      }, projectId);
      addToast(t("missions.assertionCreated", "Assertion created"), "success");
      await loadAssertionsForMilestone(milestoneId);
      await loadValidationRollup(milestoneId);
      setIsCreatingAssertion(false);
      setAssertionForm({ title: "", assertion: "", status: "pending" });
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.assertionCreateFailed", "Failed to create assertion"), "error");
    } finally {
      setSaving(false);
    }
  }, [assertionForm, addToast, loadAssertionsForMilestone, loadValidationRollup, projectId]);

  const handleEditAssertion = useCallback((assertion: MissionContractAssertion) => {
    setEditingAssertionId(assertion.id);
    setAssertionForm({
      title: assertion.title,
      assertion: assertion.assertion,
      status: assertion.status,
    });
  }, []);

  const handleCancelAssertion = useCallback(() => {
    setEditingAssertionId(null);
    setIsCreatingAssertion(false);
    setAssertionForm({ title: "", assertion: "", status: "pending" });
  }, []);

  const handleSaveAssertion = useCallback(async (assertionId: string, milestoneId: string) => {
    if (!assertionForm.title.trim() || !assertionForm.assertion.trim()) {
      addToast(t("missions.assertionFieldsRequired", "Title and assertion text are required"), "error");
      return;
    }
    try {
      setSaving(true);
      await updateAssertion(assertionId, {
        title: assertionForm.title.trim(),
        assertion: assertionForm.assertion.trim(),
        status: assertionForm.status,
      }, projectId);
      addToast(t("missions.assertionUpdated", "Assertion updated"), "success");
      await loadAssertionsForMilestone(milestoneId);
      await loadValidationRollup(milestoneId);
      handleCancelAssertion();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.assertionUpdateFailed", "Failed to update assertion"), "error");
    } finally {
      setSaving(false);
    }
  }, [assertionForm, addToast, loadAssertionsForMilestone, loadValidationRollup, handleCancelAssertion, projectId]);

  const loadLinkedFeaturesForAssertion = useCallback(async (assertionId: string) => {
    try {
      const features = await fetchFeaturesForAssertion(assertionId, projectId);
      setLinkedFeaturesByAssertion((prev) => {
        const next = new Map(prev);
        next.set(assertionId, features);
        return next;
      });
    } catch {
      // Silently fail
    }
  }, [projectId]);

  const handleToggleAssertionExpanded = useCallback(async (assertionId: string) => {
    const isExpanding = expandedAssertionId !== assertionId;
    setExpandedAssertionId((prev) => (prev === assertionId ? null : assertionId));
    if (isExpanding) {
      await loadLinkedFeaturesForAssertion(assertionId);
    }
  }, [expandedAssertionId, loadLinkedFeaturesForAssertion]);

  const focusAssertion = useCallback((assertionId: string) => {
    setExpandedAssertionId(assertionId);
    void loadLinkedFeaturesForAssertion(assertionId);
    requestAnimationFrame(() => {
      const assertionElement = document.querySelector(`[data-mission-assertion-id="${assertionId}"]`);
      if (assertionElement instanceof HTMLElement && typeof assertionElement.scrollIntoView === "function") {
        assertionElement.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, [loadLinkedFeaturesForAssertion]);

  const handleLinkFeatureToAssertion = useCallback(async (featureId: string, assertionId: string) => {
    try {
      setLinkingAssertions((prev) => new Set(prev).add(assertionId));
      await linkFeatureToAssertion(featureId, assertionId, projectId);
      addToast(t("missions.featureLinkedToAssertion", "Feature linked to assertion"), "success");
      await loadLinkedFeaturesForAssertion(assertionId);
      setFeaturePickerOpenForAssertion(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.featureLinkFailed", "Failed to link feature"), "error");
    } finally {
      setLinkingAssertions((prev) => {
        const next = new Set(prev);
        next.delete(assertionId);
        return next;
      });
    }
  }, [addToast, loadLinkedFeaturesForAssertion, projectId]);

  const handleUnlinkFeatureFromAssertion = useCallback(async (featureId: string, assertionId: string) => {
    const key = `${featureId}-${assertionId}`;
    try {
      setUnlinkingFeatures((prev) => new Set(prev).add(key));
      await unlinkFeatureFromAssertion(featureId, assertionId, projectId);
      addToast(t("missions.featureUnlinkedFromAssertion", "Feature unlinked from assertion"), "success");
      await loadLinkedFeaturesForAssertion(assertionId);
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.featureUnlinkFromAssertionFailed", "Failed to unlink feature"), "error");
    } finally {
      setUnlinkingFeatures((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [addToast, loadLinkedFeaturesForAssertion, projectId]);

  // ── Validation trigger ──

  const handleTriggerValidation = useCallback(async (featureId: string) => {
    try {
      setValidatingFeatures((prev) => new Set(prev).add(featureId));
      await triggerValidation(featureId, projectId);
      addToast(t("missions.validationTriggered", "Validation triggered"), "success");
      // Reload feature loop state
      const snapshot = await fetchValidationLoopState(featureId, projectId);
      setFeatureLoopStates((prev) => {
        const next = new Map(prev);
        next.set(featureId, snapshot);
        return next;
      });
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.validationTriggerFailed", "Failed to trigger validation"), "error");
    } finally {
      setValidatingFeatures((prev) => {
        const next = new Set(prev);
        next.delete(featureId);
        return next;
      });
    }
  }, [addToast, projectId]);

  const loadFeatureLoopState = useCallback(async (featureId: string) => {
    try {
      const snapshot = await fetchValidationLoopState(featureId, projectId);
      setFeatureLoopStates((prev) => {
        const next = new Map(prev);
        next.set(featureId, snapshot);
        return next;
      });
    } catch {
      // Silently fail
    }
  }, [projectId]);

  // Load validation runs for a feature
  const loadValidationRuns = useCallback(async (featureId: string) => {
    try {
      const runs = await fetchValidationRuns(featureId, { limit: 10 }, projectId);
      setValidationRunsByFeature((prev) => {
        const next = new Map(prev);
        next.set(featureId, runs);
        return next;
      });
    } catch {
      // Silently fail
    }
  }, [projectId]);

  const focusFeature = useCallback((featureId: string) => {
    const mission = selectedMissionRef.current;
    if (!mission) {
      return;
    }

    for (const milestone of mission.milestones) {
      for (const slice of milestone.slices) {
        const targetFeature = slice.features.find((feature) => feature.id === featureId);
        if (!targetFeature) {
          continue;
        }

        setExpandedMilestones((prev) => {
          const next = new Set(prev);
          next.add(milestone.id);
          return next;
        });
        setExpandedSlices((prev) => {
          const next = new Set(prev);
          next.add(slice.id);
          return next;
        });
        setExpandedFeatureId(featureId);
        setSelectedMilestoneId(milestone.id);

        void loadFeatureLoopState(featureId);
        void loadValidationRuns(featureId);

        requestAnimationFrame(() => {
          const featureElement = document.querySelector(`[data-mission-feature-id="${featureId}"]`);
          if (featureElement instanceof HTMLElement && typeof featureElement.scrollIntoView === "function") {
            featureElement.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        });
        return;
      }
    }
  }, [loadFeatureLoopState, loadValidationRuns]);

  // Load run detail with failures
  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      const detail = await fetchValidationRun(runId, projectId);
      setRunDetailsByRunId((prev) => {
        const next = new Map(prev);
        next.set(runId, detail);
        return next;
      });
    } catch {
      // Silently fail
    }
  }, [projectId]);

  // Toggle feature expansion to show run history
  const toggleFeatureExpanded = useCallback(async (featureId: string) => {
    if (expandedFeatureId === featureId) {
      setExpandedFeatureId(null);
    } else {
      setExpandedFeatureId(featureId);
      // Load loop state and validation runs when expanding
      await loadFeatureLoopState(featureId);
      await loadValidationRuns(featureId);
    }
  }, [expandedFeatureId, loadFeatureLoopState, loadValidationRuns]);

  // Toggle run expansion to show failures
  const toggleRunExpanded = useCallback(async (runId: string) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
    } else {
      setExpandedRunId(runId);
      await loadRunDetail(runId);
    }
  }, [expandedRunId, loadRunDetail]);

  // Resume a paused mission — set status back to "active"
  const handleResumeMission = useCallback(async (missionId: string) => {
    try {
      await resumeMission(missionId, projectId);
      addToast(t("missions.resumed", "Mission resumed"), "success");
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.resumeFailed", "Failed to resume mission"), "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  // Stop mission — set status to "blocked" and pause all linked tasks
  const handleStopMission = useCallback(async (missionId: string) => {
    try {
      const result = await stopMission(missionId, projectId);
      const count = result.pausedTaskIds?.length ?? 0;
      addToast(t("missions.stopped", { count, defaultValue_one: "Mission stopped ({{count}} task paused)", defaultValue_other: "Mission stopped ({{count}} tasks paused)" }), "success");
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.stopFailed", "Failed to stop mission"), "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  // Start a planning mission — set status to "active" and activate first slice
  const handleStartMission = useCallback(async (missionId: string) => {
    try {
      await startMission(missionId, projectId);
      addToast(t("missions.started", "Mission started — first slice activated"), "success");
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.startFailed", "Failed to start mission"), "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  const linkableGoalsForSelectedMission = useMemo(() => {
    const linkedIds = new Set((selectedMission?.linkedGoals ?? []).map((goal) => goal.id));
    return activeGoals.filter((goal) => goal.status === "active" && !linkedIds.has(goal.id));
  }, [activeGoals, selectedMission?.linkedGoals]);

  useEffect(() => {
    if (selectedGoalToLink && !linkableGoalsForSelectedMission.some((goal) => goal.id === selectedGoalToLink)) {
      setSelectedGoalToLink("");
    }
  }, [linkableGoalsForSelectedMission, selectedGoalToLink]);

  /**
   * FNXC:Missions 2026-06-15-15:04:
   * Mission detail is one side of the bidirectional goal-mission graph, so users must be able to link active goals and unlink existing chips without losing chip navigation.
   * Refresh both detail and mission summaries after mutations because the sidebar unlinked indicator reads summary.linkedGoalCount.
   */
  const handleLinkGoalToSelectedMission = useCallback(async () => {
    if (!selectedMission || !selectedGoalToLink) return;
    try {
      setGoalLinkBusy(true);
      await api(buildMissionScopedPath(`/missions/${encodeURIComponent(selectedMission.id)}/goals/${encodeURIComponent(selectedGoalToLink)}`, projectId), { method: "POST" });
      await loadMissionDetail(selectedMission.id);
      await loadMissions();
      setSelectedGoalToLink("");
      addToast(t("missions.goalLinked", "Goal linked to mission"), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.goalLinkFailed", "Failed to link goal"), "error");
    } finally {
      setGoalLinkBusy(false);
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId, selectedGoalToLink, selectedMission, t]);

  const handleUnlinkGoalFromSelectedMission = useCallback(async (goalId: string) => {
    if (!selectedMission) return;
    try {
      setUnlinkingGoalId(goalId);
      await api(buildMissionScopedPath(`/missions/${encodeURIComponent(selectedMission.id)}/goals/${encodeURIComponent(goalId)}`, projectId), { method: "DELETE" });
      await loadMissionDetail(selectedMission.id);
      await loadMissions();
      addToast(t("missions.goalUnlinked", "Goal unlinked from mission"), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.goalUnlinkFailed", "Failed to unlink goal"), "error");
    } finally {
      setUnlinkingGoalId(null);
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId, selectedMission, t]);

  // ── Autopilot handlers ──

  const handleToggleAutopilot = useCallback(async (missionId: string, enabled: boolean) => {
    try {
      await updateMissionAutopilot(missionId, { enabled }, projectId);
      addToast(enabled ? t("missions.autopilotEnabled", "Autopilot enabled") : t("missions.autopilotDisabled", "Autopilot disabled"), "success");
      // Reload mission detail to reflect updated fields
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err) {
      addToast(getErrorMessage(err) || t("missions.autopilotUpdateFailed", "Failed to update autopilot"), "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  const handleSelectMission = useCallback((mission: Mission) => {
    setActiveTab("structure");
    setSelectedMilestoneId(null);
    setValidationTelemetry(null);
    setMissionEvents([]);
    setEventsTotal(0);
    setEventsFilter("all");
    setExpandedEventMetadata(new Set());
    loadMissionDetail(mission.id);
  }, [loadMissionDetail]);

  const handleBackToList = useCallback(() => {
    setSelectedMission(null);
    setSelectedMilestoneId(null);
    setValidationTelemetry(null);
    setActiveTab("structure");
    setMissionEvents([]);
    setEventsTotal(0);
    setEventsFilter("all");
    setExpandedEventMetadata(new Set());
    loadMissions();
  }, [loadMissions]);

  const hasMoreEvents = missionEvents.length < eventsTotal;
  const autopilotState = (selectedMission?.autopilotState ?? "inactive") as AutopilotState;
  const autopilotPulseActive = autopilotState === "watching" || autopilotState === "activating";
  const autopilotActivitySummary = getAutopilotActivitySummary(
    autopilotState,
    selectedMission?.lastAutopilotActivityAt,
    t,
  );

  const previousMobileDetailVisibleRef = useRef(false);

  useEffect(() => {
    if (!isActive) {
      previousMobileDetailVisibleRef.current = false;
    }
  }, [isActive]);

  useEffect(() => {
    const isMobileDetailVisible = isActive && isMobile && Boolean(selectedMission);

    if (!isMobile) {
      // Keep the mobile detail flag untouched on desktop so split-pane refreshes do not consume or create mobile nav entries.
      return;
    }

    if (!isMobileDetailVisible) {
      previousMobileDetailVisibleRef.current = false;
      return;
    }

    /*
    FNXC:MissionNavigation 2026-06-24-23:48:
    Mobile Missions treats Structure and Activity as tabs inside one detail view. Push one view entry when detail becomes visible so browser/Android Back exits to the Missions list before any outer modal or app navigation, and do not push again for tab switches, SSE refreshes, or cached mission rehydration.
    */
    if (!previousMobileDetailVisibleRef.current) {
      pushNav({ type: "view", revert: handleBackToList });
    }

    previousMobileDetailVisibleRef.current = true;
  }, [handleBackToList, isActive, isMobile, pushNav, selectedMission]);

  const selectedMilestoneTelemetry = useMemo(() => {
    if (!validationTelemetry || !selectedMilestoneId || !isMilestoneValidationTelemetry(validationTelemetry)) {
      return null;
    }
    return validationTelemetry.rollup.milestoneId === selectedMilestoneId ? validationTelemetry : null;
  }, [selectedMilestoneId, validationTelemetry]);

  const latestRoundsByFeatureId = useMemo(() => {
    const roundsByFeature = new Map<string, MilestoneValidationTelemetry["validationTelemetry"]["validationRounds"][number]>();
    for (const round of selectedMilestoneTelemetry?.validationTelemetry.validationRounds ?? []) {
      const existing = roundsByFeature.get(round.featureId);
      if (!existing || round.startedAt > existing.startedAt) {
        roundsByFeature.set(round.featureId, round);
      }
    }
    return roundsByFeature;
  }, [selectedMilestoneTelemetry]);

  const handleLoadMoreEvents = useCallback(() => {
    if (!selectedMission || eventsLoading || !hasMoreEvents) {
      return;
    }

    void loadMissionEvents(selectedMission.id, { append: true });
  }, [eventsLoading, hasMoreEvents, loadMissionEvents, selectedMission]);

  const toggleEventMetadata = useCallback((eventId: string) => {
    setExpandedEventMetadata((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  }, []);

  // Keyboard handler for mission form
  const handleMissionFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveMission();
    }
  }, [handleSaveMission]);

  const handleMilestoneFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveMilestone();
    }
  }, [handleSaveMilestone]);

  const handleSliceFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveSlice();
    }
  }, [handleSaveSlice]);

  const handleFeatureFormKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSaveFeature();
    }
  }, [handleSaveFeature]);

  // Ref for focus management
  const modalRef = useRef<HTMLDivElement>(null);

  // Escape key handling
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActive, onClose]);

  if (!isActive) return null;

  const renderMissionDetailContent = () => {
    if (!selectedMission) {
      return null;
    }

    return (
            <div className="mission-detail">
              <div className="mission-detail__header">
                <div className="mission-detail__title-row">
                  <div className="mission-detail__title-text">
                    {autopilotPulseActive && (
                      <span className="mission-detail__autopilot-dot" title={t("missions.autopilotWatching", "Autopilot watching")} />
                    )}
                    <h3 className="mission-detail__title">{selectedMission.title}</h3>
                  </div>
                  <span
                    className="mission-status-badge"
                    style={{
                      backgroundColor: (missionStatusColors[selectedMission.status] || missionStatusColors.planning).bg,
                      color: (missionStatusColors[selectedMission.status] || missionStatusColors.planning).text,
                    }}
                  >
                    {selectedMission.status}
                  </span>
                </div>
                {selectedMission.description && (
                  <div className="mission-detail__description">{renderMarkdownText(selectedMission.description)}</div>
                )}
                <div className="mission-detail__meta">
                  <span className="mission-detail__meta-info">
                    {t("missions.milestonesCount", "{{count}} milestones", { count: selectedMission.milestones.length })}
                  </span>
                </div>

                <section className="mission-detail__linked-goals" aria-label={t("missions.linkedGoals", "Linked goals")}>
                  <div className="mission-detail__linked-goals-header">
                    <h4 className="mission-detail__linked-goals-title">{t("missions.linkedGoalsTitle", "Linked Goals")}</h4>
                    <span className="mission-detail__meta-info">
                      {t("missions.linkedCount", { count: selectedMission.linkedGoals?.length ?? 0, defaultValue_one: "{{count}} linked", defaultValue_other: "{{count}} linked" })}
                    </span>
                  </div>
                  <div className="mission-detail__linked-goal-controls">
                    <select
                      className="input mission-detail__linked-goal-picker"
                      data-testid="mission-goal-picker"
                      value={selectedGoalToLink}
                      onChange={(event) => setSelectedGoalToLink(event.target.value)}
                      aria-label={t("missions.goalPicker", "Goal to link")}
                      disabled={goalLinkBusy || linkableGoalsForSelectedMission.length === 0}
                    >
                      <option value="">{t("missions.selectGoal", "Select an active goal")}</option>
                      {linkableGoalsForSelectedMission.map((goal) => (
                        <option key={goal.id} value={goal.id}>{goal.title}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary mission-detail__linked-goal-link-button"
                      data-testid="mission-goal-link-button"
                      disabled={!selectedGoalToLink || goalLinkBusy}
                      onClick={handleLinkGoalToSelectedMission}
                    >
                      <Link size={16} aria-hidden="true" />
                      {goalLinkBusy ? t("missions.linkingGoal", "Linking…") : t("missions.linkGoal", "Link goal")}
                    </button>
                  </div>
                  {(selectedMission.linkedGoals?.length ?? 0) > 0 ? (
                    <div className="mission-detail__linked-goals-list">
                      {(selectedMission.linkedGoals ?? []).map((goal) => (
                        <div
                          key={goal.id}
                          className="mission-detail__linked-goal-chip"
                          data-testid={`mission-linked-goal-chip-${goal.id}`}
                        >
                          <button
                            type="button"
                            className="btn mission-detail__linked-goal-chip-link"
                            onClick={() => onNavigateToGoal?.(goal.id)}
                          >
                            {goal.title}
                          </button>
                          <button
                            type="button"
                            className="btn-icon mission-detail__linked-goal-unlink"
                            data-testid={`mission-linked-goal-unlink-${goal.id}`}
                            aria-label={t("missions.unlinkGoal", "Unlink goal")}
                            disabled={unlinkingGoalId === goal.id}
                            onClick={() => handleUnlinkGoalFromSelectedMission(goal.id)}
                          >
                            <X size={16} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mission-detail__linked-goals-empty">{t("missions.noLinkedGoals", "No linked goals.")}</p>
                  )}
                </section>

                <section className="mission-detail__run-settings" aria-label={t("missions.runSettings", "Mission run settings")}>
                  <h4 className="mission-detail__run-settings-title">{t("missions.runSettingsTitle", "Mission run settings")}</h4>
                  {/* ── Autopilot section ── */}
                  <div className="mission-detail__autopilot">
                    <div className="mission-detail__autopilot-toggle">
                      <label className="mission-toggle" data-testid="mission-autopilot-toggle">
                        <input
                          type="checkbox"
                          checked={selectedMission.autopilotEnabled ?? false}
                          onChange={(e) => handleToggleAutopilot(selectedMission.id, e.target.checked)}
                          aria-label={t("missions.autopilotLabel", "Autopilot")}
                        />
                        <span className="mission-toggle__track" aria-hidden="true">
                          <span className="mission-toggle__thumb" />
                        </span>
                        <span className="mission-toggle__label">
                          <Zap size={14} className="mission-detail__autopilot-icon" />
                          {t("missions.autopilotLabel", "Autopilot")}
                        </span>
                      </label>
                      <span
                        className="mission-status-badge mission-status-badge--sm"
                        style={{
                          backgroundColor: (autopilotStateColors[autopilotState] || autopilotStateColors.inactive).bg,
                          color: (autopilotStateColors[autopilotState] || autopilotStateColors.inactive).text,
                        }}
                        data-testid="autopilot-state-badge"
                      >
                        {autopilotPulseActive && <span className="mission-detail__autopilot-pulse" />}
                        {autopilotState === "inactive" ? t("missions.autopilotOff", "Off")
                          : autopilotState === "watching" ? t("missions.autopilotWatchingState", "Watching")
                          : autopilotState === "activating" ? t("missions.autopilotActivatingSlice", "Activating slice")
                          : autopilotState === "completing" ? t("missions.autopilotCompleting", "Completing")
                          : getAutopilotStateLabel(autopilotState, t)}
                      </span>
                    </div>
                    <span className="mission-detail__autopilot-description">
                      {t("missions.autopilotDescription", "When on, Fusion automatically activates the next slice and plans its features as work completes.")}
                    </span>
                    {autopilotActivitySummary && (
                      <span className="mission-detail__autopilot-activity mission-relative-time">
                        {autopilotActivitySummary}
                      </span>
                    )}
                  </div>

                  {/*
                  FNXC:MissionAutoMerge 2026-07-19-00:00:
                  A mission detail must show its actual shared branch, member count, and PR state. Resolve the group through linked member tasks' branchContext.groupId rather than source ownership because branch-name collisions can reuse another mission's group.
                  */}
                  {selectedMissionBranchGroup && (
                    <div className="mission-detail__autopilot" data-testid="mission-shared-branch-summary">
                      <div className="mission-detail__autopilot-toggle">
                        <span>{t("missions.sharedBranch", "Shared branch")}: {selectedMissionBranchGroup.branchName}</span>
                        <span
                          className="mission-status-badge mission-status-badge--sm"
                          style={{ backgroundColor: "var(--surface-hover)", color: "var(--text-muted)" }}
                        >
                          {selectedMissionBranchGroup.prState === "none"
                            ? t("missions.noPullRequest", "No PR")
                            : t(`missions.prState.${selectedMissionBranchGroup.prState}`, selectedMissionBranchGroup.prState)}
                        </span>
                      </div>
                      <span className="mission-detail__autopilot-description">
                        {t("missions.sharedBranchMembers", "{{count}} member", { count: selectedMissionBranchGroup.completion.total })}
                      </span>
                    </div>
                  )}

                  <div className="mission-detail__actions">
                    <div className="mission-detail__run-controls">
                    {selectedMission.status === "active" && (
                      <button
                        className="mission-btn mission-btn--danger"
                        onClick={() => handleStopMission(selectedMission.id)}
                        title={t("missions.stopMission", "Stop mission")}
                        aria-label={t("missions.stopMission", "Stop mission")}
                      >
                        <Square size={14} />
                        <span>{t("missions.stopMission", "Stop mission")}</span>
                      </button>
                    )}
                    {selectedMission.status === "blocked" && (
                      <button
                        className="mission-btn mission-btn--primary"
                        onClick={() => handleResumeMission(selectedMission.id)}
                        title={t("missions.resumeMission", "Resume mission")}
                        aria-label={t("missions.resumeMission", "Resume mission")}
                      >
                        <Play size={14} />
                        <span>{t("missions.resumeMission", "Resume mission")}</span>
                      </button>
                    )}
                    {selectedMission.status === "planning" && (
                      <button
                        className="mission-btn mission-btn--primary"
                        onClick={() => handleStartMission(selectedMission.id)}
                        title={t("missions.startMission", "Start mission")}
                        aria-label={t("missions.startMission", "Start mission")}
                      >
                        <Play size={14} />
                        <span>{t("missions.startMission", "Start mission")}</span>
                      </button>
                    )}
                    {getMissionRunHelperText(selectedMission.status, t) && (
                      <span className="mission-detail__run-help">{getMissionRunHelperText(selectedMission.status, t)}</span>
                    )}
                  </div>
                    <div className="mission-detail__management-actions">
                      <button
                        className="mission-icon-btn"
                        onClick={() => handleEditMission(selectedMission)}
                        title={t("missions.editMission", "Edit mission")}
                        aria-label={t("missions.editMission", "Edit mission")}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        className="mission-icon-btn mission-icon-btn--danger"
                        onClick={() => void requestDeleteMission(selectedMission.id)}
                        title={t("missions.deleteMission", "Delete mission")}
                        aria-label={t("missions.deleteMission", "Delete mission")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </section>
              </div>

              {/* Inline edit mission form (detail view) */}
              {editingMissionId === selectedMission.id && (
                <div className="mission-form-card">
                  <input
                    type="text"
                    placeholder={t("missions.missionTitlePlaceholder", "Mission title")}
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder={t("missions.descriptionOptional", "Description (optional)")}
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <label>
                    {t("missions.targetBranch", "Target branch")}
                    <input
                      type="text"
                      placeholder={t("missions.targetBranchPlaceholder", "e.g. main")}
                      value={missionForm.baseBranch}
                      onChange={(e) => setMissionForm({ ...missionForm, baseBranch: e.target.value })}
                      aria-label={t("missions.missionTargetBranchAriaLabel", "Mission target branch")}
                    />
                  </label>
                  <label>
                    {t("missions.branchStrategy", "Branch strategy")}
                    <select
                      value={missionForm.branchStrategy.mode}
                      onChange={(e) =>
                        setMissionForm({
                          ...missionForm,
                          branchStrategy: {
                            mode: e.target.value as MissionBranchStrategyMode,
                            branchName: missionForm.branchStrategy.branchName,
                          },
                        })
                      }
                      aria-label={t("missions.branchStrategyAriaLabel", "Mission branch strategy")}
                    >
                      <option value="project-default">{t("missions.branchStrategyProjectDefault", "Use project/default branch")}</option>
                      <option value="auto-per-task">{t("missions.branchStrategyAutoPerTask", "Auto-name a branch per task (from details)")}</option>
                      <option value="existing">{t("missions.branchStrategyExisting", "Use existing branch")}</option>
                      <option value="custom-new">{t("missions.branchStrategyCustomNew", "Create custom branch")}</option>
                    </select>
                  </label>
                  <label>
                    {t("missions.autoMergeOverride", "Merge behavior")}
                    <select
                      value={missionForm.autoMergeOverride}
                      onChange={(e) => setMissionForm({ ...missionForm, autoMergeOverride: e.target.value as MissionAutoMergeOverride })}
                      aria-label={t("missions.autoMergeOverrideAriaLabel", "Mission auto-merge override")}
                    >
                      <option value="inherit">{t("missions.autoMergeInherited", "Use project default")}</option>
                      <option value="on">{t("missions.autoMergeOn", "Auto-merge")}</option>
                      <option value="off">{t("missions.singlePullRequest", "Single pull request")}</option>
                    </select>
                    {/*
                    FNXC:MissionAutoMerge 2026-07-19-00:00:
                    Operators need in-context guidance for the per-mission merge choice: auto-merge lands each feature independently, while a single pull request keeps all features on one shared branch for joint review.
                    */}
                    <span className="mission-detail__autopilot-description">
                      {t("missions.autoMergeOverrideDescription", "Auto-merge merges each feature as it passes. Single pull request keeps every feature on one shared branch to review and merge together.")}
                    </span>
                  </label>
                  {(missionForm.branchStrategy.mode === "existing" || missionForm.branchStrategy.mode === "custom-new") && (
                    <label>
                      {t("missions.branchName", "Branch name")}
                      <input
                        type="text"
                        placeholder={t("missions.branchNamePlaceholder", "e.g. feature/mission-work")}
                        value={missionForm.branchStrategy.branchName ?? ""}
                        onChange={(e) =>
                          setMissionForm({
                            ...missionForm,
                            branchStrategy: {
                              ...missionForm.branchStrategy,
                              branchName: e.target.value,
                            },
                          })
                        }
                        aria-label={t("missions.branchNameAriaLabel", "Mission branch name")}
                      />
                    </label>
                  )}
                  <div className="mission-form-card__row">
                    <select
                      value={missionForm.status}
                      onChange={(e) => setMissionForm({ ...missionForm, status: e.target.value as MissionStatus })}
                    >
                      <option value="planning">{t("missions.statusPlanning", "Planning")}</option>
                      <option value="active">{t("missions.statusActive", "Active")}</option>
                      <option value="blocked">{t("missions.statusBlocked", "Blocked")}</option>
                      <option value="complete">{t("missions.statusComplete", "Complete")}</option>
                      <option value="archived">{t("missions.statusArchived", "Archived")}</option>
                    </select>
                    <label className="mission-checkbox">
                      <input
                        type="checkbox"
                        checked={missionForm.autopilotEnabled}
                        onChange={(e) => setMissionForm({ ...missionForm, autopilotEnabled: e.target.checked })}
                      />
                      <Zap size={12} /> {t("missions.autopilotLabel", "Autopilot")}
                    </label>
                  </div>
                  <div className="mission-form-card__actions">
                    <button className="mission-btn mission-btn--primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      {t("missions.updateButton", "Update")}
                    </button>
                    <button className="mission-btn mission-btn--ghost" onClick={handleCancelMission}>
                      {t("missions.cancelButton", "Cancel")}
                    </button>
                  </div>
                </div>
              )}

              <div className="mission-detail__tabs" role="tablist" aria-label={t("missions.detailTabs", "Mission detail tabs")}>
                <button
                  className={`mission-btn ${activeTab === "structure" ? "mission-btn--primary" : "mission-btn--ghost"} mission-btn--sm mission-detail__tab`}
                  onClick={() => setActiveTab("structure")}
                  role="tab"
                  aria-selected={activeTab === "structure"}
                  data-testid="mission-tab-structure"
                >
                  {t("missions.tabStructure", "Structure")}
                </button>
                <button
                  className={`mission-btn ${activeTab === "activity" ? "mission-btn--primary" : "mission-btn--ghost"} mission-btn--sm mission-detail__tab`}
                  onClick={() => setActiveTab("activity")}
                  role="tab"
                  aria-selected={activeTab === "activity"}
                  data-testid="mission-tab-activity"
                >
                  {t("missions.tabActivity", "Activity ({{count}})", { count: activityTabEventCount })}
                </button>
              </div>

              {activeTab === "structure" ? (
                <div className="mission-detail__milestones">
                {selectedMission.milestones.map((milestone) => {
                  const milestoneTelemetry = selectedMilestoneTelemetry?.rollup.milestoneId === milestone.id
                    ? selectedMilestoneTelemetry
                    : null;
                  const milestoneRollup = milestoneTelemetry?.rollup ?? validationRollupByMilestone.get(milestone.id);
                  const milestoneRounds = milestoneTelemetry?.validationTelemetry.validationRounds ?? [];
                  const milestoneFixFeatures = milestoneTelemetry?.fixFeatures ?? [];
                  const milestoneValidationColors = validationStateColors[milestoneRollup?.state ?? "not_started"]
                    ?? validationStateColors.not_started;
                  const milestoneBlockedReason =
                    milestoneRollup && (milestoneRollup.state === "blocked" || milestoneRollup.state === "failed")
                      ? milestoneTelemetry?.validationTelemetry.validationRounds.find((round) => round.blockedReason)?.blockedReason
                      : undefined;
                  const featuresWithAcceptanceCriteria = milestone.slices
                    .flatMap((slice) => slice.features)
                    .filter((feature) => (feature.acceptanceCriteria ?? "").trim().length > 0);
                  const milestoneAssertions = Array.isArray(assertionsByMilestone.get(milestone.id))
                    ? assertionsByMilestone.get(milestone.id)!
                    : [] as MissionContractAssertion[];

                  return (
                  <div key={milestone.id} className="mission-milestone">
                    <div className="mission-milestone__header" onClick={() => toggleMilestoneExpanded(milestone.id)}>
                      <button className="mission-milestone__expand">
                        {expandedMilestones.has(milestone.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                      <Layers size={16} className="mission-milestone__icon" />
                      <span className="mission-milestone__title">{milestone.title}</span>
                      <span
                        className="mission-status-badge mission-status-badge--sm"
                        style={{
                          backgroundColor: milestoneStatusColors[milestone.status].bg,
                          color: milestoneStatusColors[milestone.status].text,
                        }}
                      >
                        {milestone.status}
                      </span>
                      <span className="mission-milestone__count">{t("missions.slicesCount", "{{count}} slices", { count: milestone.slices.length })}</span>
                      <PlanStateIndicator state={getMilestonePlanState(milestone.interviewState)} />
                      {/* Validation state badge and coverage bar in milestone header */}
                      {milestoneRollup && (
                        <>
                          <span
                            className="mission-status-badge mission-status-badge--sm"
                            style={{
                              backgroundColor: milestoneValidationColors.bg,
                              color: milestoneValidationColors.text,
                            }}
                            title={t("missions.validationState", "Validation state")}
                          >
                            {formatValidationState(milestoneRollup.state, t)}
                          </span>
                          {milestoneRollup.totalAssertions > 0 && (
                            <div
                              className="mission-milestone__coverage-bar"
                              title={`${(milestoneRollup.passedAssertions ?? 0)} of ${milestoneRollup.totalAssertions} assertions passing`}
                            >
                              <div
                                className="mission-milestone__coverage-bar-fill"
                                style={{
                                  width: `${((milestoneRollup.passedAssertions ?? 0) / milestoneRollup.totalAssertions) * 100}%`,
                                  backgroundColor: (milestoneRollup.passedAssertions ?? 0) === milestoneRollup.totalAssertions
                                    ? "var(--color-success)"
                                    : "var(--color-warning)",
                                }}
                              />
                            </div>
                          )}
                        </>
                      )}
                      {milestone.status !== "complete" && (
                        <button
                          className="mission-icon-btn"
                          onClick={() => setInterviewTarget({ type: "milestone", id: milestone.id, title: milestone.title })}
                          title={t("missions.planMilestone", "Plan milestone")}
                          aria-label={t("missions.planMilestone", "Plan milestone")}
                        >
                          <FileText size={14} />
                        </button>
                      )}
                      <div className="mission-milestone__actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="mission-icon-btn"
                          onClick={() => handleCreateSlice(milestone.id)}
                          title={t("missions.addSlice", "Add slice")}
                        >
                          <Plus size={14} />
                        </button>
                        <button
                          className="mission-icon-btn"
                          onClick={() => handleEditMilestone(milestone)}
                          title={t("missions.editMilestone", "Edit milestone")}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="mission-icon-btn mission-icon-btn--danger"
                          onClick={() => setDeleteConfirmId({ type: "milestone", id: milestone.id })}
                          title={t("missions.deleteMilestone", "Delete milestone")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {expandedMilestones.has(milestone.id) && (
                      <div className="mission-milestone__body">
                        {milestone.acceptanceCriteria && (
                          <div className="mission-feature__criteria">
                            <strong>{t("missions.acceptance", "Acceptance:")}</strong>
                            {renderMarkdownText(milestone.acceptanceCriteria)}
                          </div>
                        )}

                        {/* Create milestone form (inline edit) */}
                        {(isCreatingMilestone || editingMilestoneId === milestone.id) && (
                          <div className="mission-form-card">
                            <input
                              type="text"
                              placeholder={t("missions.milestoneTitlePlaceholder", "Milestone title")}
                              value={milestoneForm.title}
                              onChange={(e) => setMilestoneForm({ ...milestoneForm, title: e.target.value })}
                              onKeyDown={handleMilestoneFormKeyDown}
                              autoFocus
                            />
                            <textarea
                              placeholder={t("missions.descriptionOptional", "Description (optional)")}
                              value={milestoneForm.description}
                              onChange={(e) => setMilestoneForm({ ...milestoneForm, description: e.target.value })}
                              rows={2}
                            />
                            <textarea
                              placeholder={t("missions.acceptanceCriteriaOptional", "Acceptance criteria (optional)")}
                              value={milestoneForm.acceptanceCriteria}
                              onChange={(e) => setMilestoneForm({ ...milestoneForm, acceptanceCriteria: e.target.value })}
                              rows={2}
                            />
                            <div className="mission-form-card__actions">
                              <button className="mission-btn mission-btn--primary" onClick={handleSaveMilestone} disabled={saving}>
                                {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                {editingMilestoneId ? t("missions.updateButton", "Update") : t("missions.createButton", "Create")}
                              </button>
                              <button className="mission-btn mission-btn--ghost" onClick={handleCancelMilestone}>
                                {t("missions.cancelButton", "Cancel")}
                              </button>
                            </div>
                          </div>
                        )}

                        {milestoneTelemetry && (
                          <div className="mission-validation-telemetry">
                            <div className="mission-validation-telemetry__header">
                              <span className="mission-validation-telemetry__title">{t("missions.validationTelemetry", "Validation Telemetry")}</span>
                              <span className="mission-validation-telemetry__meta">
                                {t("missions.validationRoundsCount", { count: milestoneTelemetry.validationTelemetry.totalRuns, defaultValue_one: "{{count}} round", defaultValue_other: "{{count}} rounds" })}
                                {milestoneTelemetry.validationTelemetry.lastValidatorStatus
                                  ? ` · ${t("missions.lastValidatorStatus", "Last {{status}}", { status: milestoneTelemetry.validationTelemetry.lastValidatorStatus })}`
                                  : ""}
                              </span>
                            </div>

                            {milestoneBlockedReason && (
                              <div className="mission-blocked-reason">
                                <strong>{t("missions.blockedReason", "Blocked reason:")}</strong> {milestoneBlockedReason}
                              </div>
                            )}

                            {milestoneRounds.length > 0 && (
                              <div className="mission-validation-rounds">
                                <button
                                  className="mission-btn mission-btn--ghost mission-btn--sm mission-validation-rounds__toggle"
                                  onClick={() => setValidationRoundsExpanded((prev) => !prev)}
                                  title={validationRoundsExpanded ? t("missions.hideValidationRounds", "Hide validation rounds") : t("missions.showValidationRounds", "Show validation rounds")}
                                >
                                  {validationRoundsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  {t("missions.validationRoundsLabel", "Validation rounds ({{count}})", { count: milestoneRounds.length })}
                                </button>

                                {validationRoundsExpanded && (
                                  <div className="mission-validation-rounds__list">
                                    {milestoneRounds.map((round) => (
                                      <div key={round.roundId} className="mission-validation-round">
                                        <div className="mission-validation-round__header">
                                          <span className={`mission-status-badge mission-status-badge--sm mission-validation-round__status mission-validation-round__status--${round.validatorStatus}`}>
                                            {round.validatorStatus}
                                          </span>
                                          <span className="mission-validation-round__feature">{round.featureTitle}</span>
                                          <span className="mission-validation-round__attempts">
                                            {t("missions.validationRoundAttempts", "impl #{{implementation}} · reviewer #{{reviewer}}", { implementation: round.implementationAttempt, reviewer: round.validatorAttempt })}
                                          </span>
                                        </div>

                                        <div className="mission-validation-round__links">
                                          <span className="mission-validation-round__label">{t("missions.failedAssertions", "Failed assertions:")}</span>
                                          {round.failedAssertionIds.length > 0 ? (
                                            <div className="mission-validation-round__chip-list">
                                              {round.failedAssertionIds.map((assertionId) => (
                                                <button
                                                  key={`${round.roundId}-${assertionId}`}
                                                  className="mission-validation-round__link-chip"
                                                  onClick={() => focusAssertion(assertionId)}
                                                  title={`Jump to assertion ${assertionId}`}
                                                >
                                                  {assertionId}
                                                </button>
                                              ))}
                                            </div>
                                          ) : (
                                            <span className="mission-validation-round__empty">{t("missions.none", "None")}</span>
                                          )}
                                        </div>

                                        <div className="mission-validation-round__links">
                                          <span className="mission-validation-round__label">{t("missions.generatedFixFeatures", "Generated fix features:")}</span>
                                          {round.generatedFixFeatureIds.length > 0 ? (
                                            <div className="mission-validation-round__chip-list">
                                              {round.generatedFixFeatureIds.map((fixFeatureId) => (
                                                <button
                                                  key={`${round.roundId}-${fixFeatureId}`}
                                                  className="mission-validation-round__link-chip"
                                                  onClick={() => focusFeature(fixFeatureId)}
                                                  title={`Jump to fix feature ${fixFeatureId}`}
                                                >
                                                  {fixFeatureId}
                                                </button>
                                              ))}
                                            </div>
                                          ) : (
                                            <span className="mission-validation-round__empty">{t("missions.none", "None")}</span>
                                          )}
                                        </div>

                                        {round.blockedReason && (
                                          <div className="mission-validation-round__blocked-reason">
                                            {round.blockedReason}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {milestoneFixFeatures.length > 0 && (
                              <div className="mission-fix-features">
                                <div className="mission-fix-features__title">{t("missions.generatedFixFeaturesTitle", "Generated Fix Features")}</div>
                                <div className="mission-fix-features__list">
                                  {milestoneFixFeatures.map((fixFeature) => (
                                    <div key={fixFeature.id} className="mission-fix-feature">
                                      <div className="mission-fix-feature__header">
                                        <button
                                          className="mission-fix-feature__title"
                                          onClick={() => focusFeature(fixFeature.id)}
                                          title={`Jump to feature ${fixFeature.id}`}
                                        >
                                          {fixFeature.title}
                                        </button>
                                        <span
                                          className="mission-status-badge mission-status-badge--sm"
                                          style={{
                                            backgroundColor: featureStatusColors[fixFeature.status].bg,
                                            color: featureStatusColors[fixFeature.status].text,
                                          }}
                                        >
                                          {fixFeature.status}
                                        </span>
                                        {fixFeature.loopState && (
                                          <span className={`mission-loop-state mission-loop-state--${fixFeature.loopState}`}>
                                            {fixFeature.loopState}
                                          </span>
                                        )}
                                      </div>
                                      <div className="mission-fix-feature__meta">
                                        <span>{t("missions.source", "Source:")}</span>
                                        <button
                                          className="mission-validation-round__link-chip"
                                          onClick={() => focusFeature(fixFeature.sourceFeatureId)}
                                          title={`Jump to source feature ${fixFeature.sourceFeatureId}`}
                                        >
                                          {fixFeature.sourceFeatureId}
                                        </button>
                                        <span>{t("missions.run", "Run:")}</span>
                                        <span className="mission-fix-feature__run">{fixFeature.runId}</span>
                                      </div>
                                      {fixFeature.failedAssertionIds.length > 0 && (
                                        <div className="mission-fix-feature__assertions">
                                          <span className="mission-validation-round__label">{t("missions.failedAssertions", "Failed assertions:")}</span>
                                          <div className="mission-validation-round__chip-list">
                                            {fixFeature.failedAssertionIds.map((assertionId) => (
                                              <button
                                                key={`${fixFeature.id}-${assertionId}`}
                                                className="mission-validation-round__link-chip"
                                                onClick={() => focusAssertion(assertionId)}
                                                title={`Jump to assertion ${assertionId}`}
                                              >
                                                {assertionId}
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Slices */}
                        <div className="mission-slices">
                          {milestone.slices.map((slice) => (
                            <div key={slice.id} className="mission-slice">
                              <div className="mission-slice__header" onClick={() => toggleSliceExpanded(slice.id)}>
                                <button className="mission-slice__expand">
                                  {expandedSlices.has(slice.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                </button>
                                <Package size={16} className="mission-slice__icon" />
                                <span className="mission-slice__title">{slice.title}</span>
                                <span
                                  className="mission-status-badge mission-status-badge--sm"
                                  style={{
                                    backgroundColor: sliceStatusColors[slice.status].bg,
                                    color: sliceStatusColors[slice.status].text,
                                  }}
                                >
                                  {slice.status}
                                </span>
                                <span className="mission-slice__count">{t("missions.featuresCount", "{{count}} features", { count: slice.features?.length || 0 })}</span>
                                <PlanStateIndicator state={slice.planState ?? "not_started"} />
                                {slice.status !== "complete" && (
                                  <button
                                    className="mission-icon-btn"
                                    onClick={() => setInterviewTarget({ type: "slice", id: slice.id, title: slice.title })}
                                    title={t("missions.planSlice", "Plan slice")}
                                    aria-label={t("missions.planSlice", "Plan slice")}
                                  >
                                    <FileText size={14} />
                                  </button>
                                )}
                                <div className="mission-slice__actions" onClick={(e) => e.stopPropagation()}>
                                  {slice.status === "pending" && (
                                    <button
                                      className="mission-icon-btn mission-icon-btn--success"
                                      onClick={() => handleActivateSlice(slice.id)}
                                      title={t("missions.activateSlice", "Activate slice")}
                                    >
                                      <Play size={14} />
                                    </button>
                                  )}
                                  {slice.status === "active" && slice.features?.some((f) => f.status === "defined") && (
                                    <button
                                      className="mission-icon-btn"
                                      onClick={() => handleTriageAllSliceFeatures(slice.id)}
                                      title={t("missions.triageAllFeatures", "Triage all features")}
                                      disabled={saving}
                                    >
                                      {saving ? <Loader2 size={14} className="spinner" /> : <Zap size={14} />}
                                    </button>
                                  )}
                                  <button
                                    className="mission-icon-btn"
                                    onClick={() => handleCreateFeature(slice.id)}
                                    title={t("missions.addFeature", "Add feature")}
                                  >
                                    <Plus size={14} />
                                  </button>
                                  <button
                                    className="mission-icon-btn"
                                    onClick={() => handleEditSlice(slice)}
                                    title={t("missions.editSlice", "Edit slice")}
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    className="mission-icon-btn mission-icon-btn--danger"
                                    onClick={() => setDeleteConfirmId({ type: "slice", id: slice.id })}
                                    title={t("missions.deleteSlice", "Delete slice")}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>

                              {expandedSlices.has(slice.id) && (
                                <div className="mission-slice__body">
                                  {slice.verification?.trim() && (
                                    <div className="mission-feature__criteria">
                                      <strong>{t("missions.verification", "Verification:")}</strong>
                                      {renderMarkdownText(slice.verification)}
                                    </div>
                                  )}

                                  {/* Create slice form */}
                                  {(isCreatingSlice && selectedMilestoneIdForNewSlice === milestone.id && !editingSliceId) && (
                                    <div className="mission-form-card">
                                      <input
                                        type="text"
                                        placeholder={t("missions.sliceTitlePlaceholder", "Slice title")}
                                        value={sliceForm.title}
                                        onChange={(e) => setSliceForm({ ...sliceForm, title: e.target.value })}
                                        onKeyDown={handleSliceFormKeyDown}
                                        autoFocus
                                      />
                                      <textarea
                                        placeholder={t("missions.descriptionOptional", "Description (optional)")}
                                        value={sliceForm.description}
                                        onChange={(e) => setSliceForm({ ...sliceForm, description: e.target.value })}
                                        rows={2}
                                      />
                                      <div className="mission-form-card__actions">
                                        <button className="mission-btn mission-btn--primary" onClick={handleSaveSlice} disabled={saving}>
                                          {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                          {t("missions.createButton", "Create")}
                                        </button>
                                        <button className="mission-btn mission-btn--ghost" onClick={handleCancelSlice}>
                                          {t("missions.cancelButton", "Cancel")}
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Edit slice form */}
                                  {editingSliceId === slice.id && (
                                    <div className="mission-form-card">
                                      <input
                                        type="text"
                                        placeholder={t("missions.sliceTitlePlaceholder", "Slice title")}
                                        value={sliceForm.title}
                                        onChange={(e) => setSliceForm({ ...sliceForm, title: e.target.value })}
                                        onKeyDown={handleSliceFormKeyDown}
                                        autoFocus
                                      />
                                      <textarea
                                        placeholder={t("missions.descriptionOptional", "Description (optional)")}
                                        value={sliceForm.description}
                                        onChange={(e) => setSliceForm({ ...sliceForm, description: e.target.value })}
                                        rows={2}
                                      />
                                      <select
                                        value={sliceForm.status}
                                        onChange={(e) => setSliceForm({ ...sliceForm, status: e.target.value as SliceStatus })}
                                      >
                                        <option value="pending">{t("missions.statusPending", "Pending")}</option>
                                        <option value="active">{t("missions.statusActive", "Active")}</option>
                                        <option value="complete">{t("missions.statusComplete", "Complete")}</option>
                                      </select>
                                      <div className="mission-form-card__actions">
                                        <button className="mission-btn mission-btn--primary" onClick={handleSaveSlice} disabled={saving}>
                                          {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                          {t("missions.updateButton", "Update")}
                                        </button>
                                        <button className="mission-btn mission-btn--ghost" onClick={handleCancelSlice}>
                                          {t("missions.cancelButton", "Cancel")}
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Features */}
                                  <div className="mission-features">
                                    {slice.features?.map((feature) => (
                                      <div
                                        key={feature.id}
                                        className="mission-feature"
                                        data-mission-feature-id={feature.id}
                                      >
                                        <div className="mission-feature__header">
                                          <button
                                            className="mission-feature__expand"
                                            onClick={() => toggleFeatureExpanded(feature.id)}
                                            title={expandedFeatureId === feature.id ? t("missions.collapseDetails", "Collapse details") : t("missions.expandRunHistory", "Expand to show run history")}
                                          >
                                            {expandedFeatureId === feature.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                          </button>
                                          <Box size={14} className="mission-feature__icon" />
                                          <span className="mission-feature__title">{feature.title}</span>
                                          <span
                                            className="mission-status-badge mission-status-badge--sm"
                                            style={{
                                              backgroundColor: featureStatusColors[feature.status].bg,
                                              color: featureStatusColors[feature.status].text,
                                            }}
                                          >
                                            {feature.status}
                                          </span>
                                          {/* Loop state indicator */}
                                          {(feature.loopState && feature.loopState !== "idle") && (
                                            <span
                                              className={`mission-loop-state mission-loop-state--${feature.loopState}`}
                                              title={t("missions.loopState", "Loop state: {{state}}", { state: feature.loopState })}
                                            >
                                              {feature.loopState === "implementing" && "⏳"}
                                              {feature.loopState === "validating" && "🔄"}
                                              {feature.loopState === "needs_fix" && "🔧"}
                                              {feature.loopState === "passed" && "✅"}
                                              {feature.loopState === "blocked" && "🚫"}
                                            </span>
                                          )}
                                          {/* Lineage indicator for fix features - click to navigate to source feature */}
                                          {feature.generatedFromFeatureId && (
                                            <button
                                              className="mission-feature__lineage"
                                              onClick={() => focusFeature(feature.generatedFromFeatureId!)}
                                              title={t("missions.generatedFromFeature", "Generated from feature: {{id}}", { id: feature.generatedFromFeatureId })}
                                            >
                                              {t("missions.fixLineageButton", "🔗 Fix")}
                                            </button>
                                          )}
                                          {/* Retry/iteration display for validating and needs-fix states */}
                                          {(feature.loopState === "validating" || feature.loopState === "needs_fix") && (() => {
                                            const loopSnapshot = featureLoopStates.get(feature.id);
                                            const latestRound = latestRoundsByFeatureId.get(feature.id);
                                            const implementationAttempt = loopSnapshot?.implementationAttemptCount
                                              ?? latestRound?.implementationAttempt
                                              ?? feature.implementationAttemptCount
                                              ?? 0;
                                            const retryBudgetRemaining = loopSnapshot?.retryBudgetRemaining
                                              ?? Math.max(0, featureRetryBudgetMax - implementationAttempt);

                                            return (
                                              <span
                                                className="mission-feature__retry-budget"
                                                title={t("missions.retryBudgetTitle", "Implementation attempts and remaining retry budget")}
                                              >
                                                {t("missions.attemptRetries", "Attempt {{attempt}} · {{count}} {{label}} left", { attempt: implementationAttempt, count: retryBudgetRemaining, label: retryBudgetRemaining === 1 ? t("missions.retry", "retry") : t("missions.retries", "retries") })}
                                              </span>
                                            );
                                          })()}
                                          {/* Validation trigger button for implementing features */}
                                          {feature.loopState === "implementing" && (
                                            <button
                                              className="mission-icon-btn mission-icon-btn--validate"
                                              onClick={() => handleTriggerValidation(feature.id)}
                                              title={t("missions.validateFeature", "Validate feature")}
                                              disabled={validatingFeatures.has(feature.id)}
                                            >
                                              {validatingFeatures.has(feature.id) ? (
                                                <Loader2 size={14} className="spinner" />
                                              ) : (
                                                <Sparkles size={14} />
                                              )}
                                            </button>
                                          )}
                                          {feature.taskId && (
                                            <span
                                              className="mission-feature__task-link"
                                              onClick={() => onSelectTask?.(feature.taskId!)}
                                              title={t("missions.clickToViewTask", "Click to view task")}
                                            >
                                              {feature.taskId}
                                            </span>
                                          )}
                                          <div className="mission-feature__actions">
                                            {feature.status === "defined" && !feature.taskId && (
                                              <button
                                                className="mission-icon-btn"
                                                onClick={() => handleTriageFeatureWithPreview(feature.id)}
                                                title={t("missions.triageCreateTask", "Triage — create task")}
                                                disabled={saving || triagePreviewLoading === feature.id}
                                              >
                                                {triagePreviewLoading === feature.id ? (
                                                  <Loader2 size={14} className="spinner" />
                                                ) : (
                                                  <Zap size={14} />
                                                )}
                                              </button>
                                            )}
                                            {feature.taskId ? (
                                              <button
                                                className="mission-icon-btn"
                                                onClick={() => handleUnlinkTask(feature.id)}
                                                title={t("missions.unlinkTask", "Unlink task")}
                                              >
                                                <Unlink size={14} />
                                              </button>
                                            ) : feature.status !== "defined" ? (
                                              <button
                                                className="mission-icon-btn"
                                                onClick={() => setLinkTaskFeatureId(feature.id)}
                                                title={t("missions.linkToTask", "Link to task")}
                                              >
                                                <Link size={14} />
                                              </button>
                                            ) : null}
                                            <button
                                              className="mission-icon-btn"
                                              onClick={() => handleEditFeature(feature)}
                                              title={t("missions.editFeature", "Edit feature")}
                                            >
                                              <Pencil size={14} />
                                            </button>
                                            <button
                                              className="mission-icon-btn mission-icon-btn--danger"
                                              onClick={() => setDeleteConfirmId({ type: "feature", id: feature.id })}
                                              title={t("missions.deleteFeature", "Delete feature")}
                                            >
                                              <Trash2 size={14} />
                                            </button>
                                          </div>
                                        </div>

                                        {feature.description && (
                                          <div className="mission-feature__description">{renderMarkdownText(feature.description)}</div>
                                        )}
                                        {feature.acceptanceCriteria && (
                                          <div className="mission-feature__criteria">
                                            <strong>{t("missions.acceptance", "Acceptance:")}</strong>
                                            {renderMarkdownText(feature.acceptanceCriteria)}
                                          </div>
                                        )}

                                        {/* Triage preview panel */}
                                        {triagePreview?.featureId === feature.id && (
                                          <div className="mission-triage-preview">
                                            <div className="mission-triage-preview__header">
                                              {t("missions.enrichedDescPreview", "Enriched Description Preview")}
                                            </div>
                                            <div className="mission-triage-preview__content">
                                              {triagePreview.enrichedDescription}
                                            </div>
                                            <div className="mission-triage-preview__actions">
                                              <button
                                                className="btn btn-primary"
                                                onClick={handleConfirmTriageFromPreview}
                                                disabled={saving}
                                              >
                                                {saving ? <Loader2 size={14} className="spinner" /> : null}
                                                {t("missions.createTask", "Create Task")}
                                              </button>
                                              <button
                                                className="btn"
                                                onClick={handleCancelTriagePreview}
                                                disabled={saving}
                                              >
                                                {t("missions.cancelButton", "Cancel")}
                                              </button>
                                            </div>
                                          </div>
                                        )}

                                        {/* Edit feature form */}
                                        {editingFeatureId === feature.id && (
                                          <div className="mission-form-card">
                                            <input
                                              type="text"
                                              placeholder={t("missions.featureTitlePlaceholder", "Feature title")}
                                              value={featureForm.title}
                                              onChange={(e) => setFeatureForm({ ...featureForm, title: e.target.value })}
                                              onKeyDown={handleFeatureFormKeyDown}
                                              autoFocus
                                            />
                                            <textarea
                                              placeholder={t("missions.descriptionOptional", "Description (optional)")}
                                              value={featureForm.description}
                                              onChange={(e) => setFeatureForm({ ...featureForm, description: e.target.value })}
                                              rows={2}
                                            />
                                            <textarea
                                              placeholder={t("missions.acceptanceCriteriaOptional", "Acceptance criteria (optional)")}
                                              value={featureForm.acceptanceCriteria}
                                              onChange={(e) => setFeatureForm({ ...featureForm, acceptanceCriteria: e.target.value })}
                                              rows={2}
                                            />
                                            <select
                                              value={featureForm.status}
                                              onChange={(e) => setFeatureForm({ ...featureForm, status: e.target.value as FeatureStatus })}
                                            >
                                              <option value="defined">{t("missions.statusDefined", "Defined")}</option>
                                              <option value="triaged">{t("missions.statusTriaged", "Triaged")}</option>
                                              <option value="in-progress">{t("missions.statusInProgress", "In Progress")}</option>
                                              <option value="done">{t("missions.statusDone", "Done")}</option>
                                            </select>
                                            <div className="mission-form-card__actions">
                                              <button className="mission-btn mission-btn--primary" onClick={handleSaveFeature} disabled={saving}>
                                                {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                                {t("missions.updateButton", "Update")}
                                              </button>
                                              <button className="mission-btn mission-btn--ghost" onClick={handleCancelFeature}>
                                                {t("missions.cancelButton", "Cancel")}
                                              </button>
                                            </div>
                                          </div>
                                        )}

                                        {/* Validation Run History - shown when feature is expanded */}
                                        {expandedFeatureId === feature.id && (
                                          <div className="mission-feature__run-history">
                                            <div className="mission-feature__run-history-header">
                                              <span className="mission-feature__run-history-title">{t("missions.validationRuns", "Validation Runs")}</span>
                                            </div>
                                            {(validationRunsByFeature.get(feature.id) ?? []).map((run) => (
                                              <div key={run.id} className="mission-run">
                                                <div
                                                  className="mission-run__header"
                                                  onClick={() => toggleRunExpanded(run.id)}
                                                >
                                                  <span
                                                    className={`mission-status-badge mission-status-badge--sm mission-run__status mission-run__status--${run.status}`}
                                                    title={run.status}
                                                  >
                                                    {run.status}
                                                  </span>
                                                  <span className="mission-run__time">
                                                    {new Date(run.startedAt).toLocaleString()}
                                                  </span>
                                                  {run.completedAt && (
                                                    <span className="mission-run__duration">
                                                      {Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s
                                                    </span>
                                                  )}
                                                  {run.triggerType && (
                                                    <span className="mission-run__trigger">
                                                      {run.triggerType}
                                                    </span>
                                                  )}
                                                  <button
                                                    className="mission-icon-btn"
                                                    title={expandedRunId === run.id ? t("missions.hideDetails", "Hide details") : t("missions.showDetails", "Show details")}
                                                  >
                                                    {expandedRunId === run.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                                  </button>
                                                </div>
                                                {expandedRunId === run.id && runDetailsByRunId.get(run.id) && (
                                                  <div className="mission-run__details">
                                                    {run.summary && (
                                                      <p className="mission-run__summary">{run.summary}</p>
                                                    )}
                                                    {run.blockedReason && (
                                                      <p className="mission-run__blocked-reason">
                                                        <strong>{t("missions.blocked", "Blocked:")}</strong> {run.blockedReason}
                                                      </p>
                                                    )}
                                                    {runDetailsByRunId.get(run.id)?.failures && runDetailsByRunId.get(run.id)!.failures!.length > 0 && (
                                                      <div className="mission-run__failures">
                                                        <span className="mission-run__failures-title">{t("missions.failedAssertionsTitle", "Failed Assertions:")}</span>
                                                        {runDetailsByRunId.get(run.id)!.failures!.map((failure) => (
                                                          <div key={failure.id} className="mission-run__failure">
                                                            <span className="mission-run__failure-message">{failure.message}</span>
                                                            {failure.expected && (
                                                              <span className="mission-run__failure-expected">
                                                                {t("missions.expected", "Expected: {{value}}", { value: failure.expected })}
                                                              </span>
                                                            )}
                                                            {failure.actual && (
                                                              <span className="mission-run__failure-actual">
                                                                {t("missions.actual", "Actual: {{value}}", { value: failure.actual })}
                                                              </span>
                                                            )}
                                                          </div>
                                                        ))}
                                                      </div>
                                                    )}
                                                    {(!runDetailsByRunId.get(run.id)?.failures || runDetailsByRunId.get(run.id)!.failures!.length === 0) && (
                                                      <p className="mission-run__no-failures">{t("missions.noAssertionFailures", "No assertion failures")}</p>
                                                    )}
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                            {(!validationRunsByFeature.get(feature.id) || validationRunsByFeature.get(feature.id)!.length === 0) && (
                                              <div className="mission-run-history__empty">
                                                {t("missions.noValidationRunsYet", "No validation runs yet.")}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    ))}

                                    {/* Create feature form */}
                                    {isCreatingFeature && selectedSliceIdForNewFeature === slice.id && (
                                      <div className="mission-form-card">
                                        <input
                                          type="text"
                                          placeholder={t("missions.featureTitlePlaceholder", "Feature title")}
                                          value={featureForm.title}
                                          onChange={(e) => setFeatureForm({ ...featureForm, title: e.target.value })}
                                          onKeyDown={handleFeatureFormKeyDown}
                                          autoFocus
                                        />
                                        <textarea
                                          placeholder={t("missions.descriptionOptional", "Description (optional)")}
                                          value={featureForm.description}
                                          onChange={(e) => setFeatureForm({ ...featureForm, description: e.target.value })}
                                          rows={2}
                                        />
                                        <textarea
                                          placeholder={t("missions.acceptanceCriteriaOptional", "Acceptance criteria (optional)")}
                                          value={featureForm.acceptanceCriteria}
                                          onChange={(e) => setFeatureForm({ ...featureForm, acceptanceCriteria: e.target.value })}
                                          rows={2}
                                        />
                                        <div className="mission-form-card__actions">
                                          <button className="mission-btn mission-btn--primary" onClick={handleSaveFeature} disabled={saving}>
                                            {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                            {t("missions.createButton", "Create")}
                                          </button>
                                          <button className="mission-btn mission-btn--ghost" onClick={handleCancelFeature}>
                                            {t("missions.cancelButton", "Cancel")}
                                          </button>
                                        </div>
                                      </div>
                                    )}

                                    {/* Empty state when no features exist and not creating */}
                                    {!isCreatingFeature && (!slice.features || slice.features.length === 0) && (
                                      <div className="mission-manager__empty mission-features__empty">
                                        <Box size={16} />
                                        <span>{t("missions.noFixFeaturesGenerated", "No fix features generated.")}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}

                          {milestone.slices.length === 0 && !isCreatingSlice && (
                            <div className="mission-manager__empty">
                              <Package size={16} />
                              <span>{t("missions.noSlicesYet", "No slices yet")}</span>
                            </div>
                          )}

                          {/* Assertions Panel */}
                          <div className="mission-assertions">
                            <div className="mission-assertions__header">
                              <span className="mission-assertions__title">{t("missions.contractAssertions", "Contract assertions (AI-validated)")}</span>
                              <span className="mission-assertions__mode-tag" data-testid="milestone-assertions-enforced-indicator">
                                <span className="status-dot status-dot--running" />
                                {t("missions.aiValidatedMissionGate", "AI-validated mission gate")}
                              </span>
                              {milestoneRollup && (
                                <span
                                  className="mission-status-badge mission-status-badge--sm"
                                  style={{
                                    backgroundColor: milestoneValidationColors.bg,
                                    color: milestoneValidationColors.text,
                                  }}
                                >
                                  {formatValidationState(milestoneRollup.state, t)}
                                </span>
                              )}
                              {/* Assertion coverage bar */}
                              {milestoneRollup && milestoneRollup.totalAssertions > 0 && (
                                <div className="mission-assertions__coverage-bar" title={`${(milestoneRollup.passedAssertions ?? 0)} of ${milestoneRollup.totalAssertions} assertions passing`}>
                                  <div
                                    className="mission-assertions__coverage-bar-fill"
                                    style={{
                                      width: `${((milestoneRollup.passedAssertions ?? 0) / milestoneRollup.totalAssertions) * 100}%`,
                                      backgroundColor: (milestoneRollup.passedAssertions ?? 0) === milestoneRollup.totalAssertions
                                        ? "var(--color-success)"
                                        : "var(--color-warning)",
                                    }}
                                  />
                                </div>
                              )}
                              <button
                                className="mission-icon-btn"
                                onClick={() => {
                                  setIsCreatingAssertion(true);
                                  setEditingAssertionId(null);
                                  setAssertionForm({ title: "", assertion: "", status: "pending" });
                                }}
                                title={t("missions.addAssertion", "Add assertion")}
                              >
                                <Plus size={14} />
                              </button>
                            </div>

                            {/* Create assertion form */}
                            {isCreatingAssertion && (
                              <div className="mission-form-card">
                                <input
                                  type="text"
                                  placeholder={t("missions.assertionTitlePlaceholder", "Assertion title")}
                                  value={assertionForm.title}
                                  onChange={(e) => setAssertionForm({ ...assertionForm, title: e.target.value })}
                                  autoFocus
                                />
                                <textarea
                                  placeholder={t("missions.assertionTextPlaceholder", "Assertion text (what should be true when complete)")}
                                  value={assertionForm.assertion}
                                  onChange={(e) => setAssertionForm({ ...assertionForm, assertion: e.target.value })}
                                  rows={2}
                                />
                                <select
                                  value={assertionForm.status}
                                  onChange={(e) => setAssertionForm({ ...assertionForm, status: e.target.value as MissionAssertionStatus })}
                                >
                                  <option value="pending">{t("missions.statusPending", "Pending")}</option>
                                  <option value="passed">{t("missions.statusPassed", "Passed")}</option>
                                  <option value="failed">{t("missions.statusFailed", "Failed")}</option>
                                  <option value="blocked">{t("missions.statusBlocked", "Blocked")}</option>
                                </select>
                                <div className="mission-form-card__actions">
                                  <button className="mission-btn mission-btn--primary" onClick={() => handleCreateAssertion(milestone.id)} disabled={saving}>
                                    {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                    {t("missions.createButton", "Create")}
                                  </button>
                                  <button className="mission-btn mission-btn--ghost" onClick={handleCancelAssertion}>
                                    {t("missions.cancelButton", "Cancel")}
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Assertions list */}
                            <div className="mission-assertions__list">
                              {milestoneAssertions.map((assertion) => (
                                <div
                                  key={assertion.id}
                                  className="mission-assertion"
                                  data-mission-assertion-id={assertion.id}
                                >
                                  <div className="mission-assertion__header">
                                    {editingAssertionId === assertion.id ? (
                                      <div className="mission-form-card">
                                        <input
                                          type="text"
                                          placeholder={t("missions.assertionTitlePlaceholder", "Assertion title")}
                                          value={assertionForm.title}
                                          onChange={(e) => setAssertionForm({ ...assertionForm, title: e.target.value })}
                                          autoFocus
                                        />
                                        <textarea
                                          placeholder={t("missions.assertionTextEditPlaceholder", "Assertion text")}
                                          value={assertionForm.assertion}
                                          onChange={(e) => setAssertionForm({ ...assertionForm, assertion: e.target.value })}
                                          rows={2}
                                        />
                                        <select
                                          value={assertionForm.status}
                                          onChange={(e) => setAssertionForm({ ...assertionForm, status: e.target.value as MissionAssertionStatus })}
                                        >
                                          <option value="pending">{t("missions.statusPending", "Pending")}</option>
                                          <option value="passed">{t("missions.statusPassed", "Passed")}</option>
                                          <option value="failed">{t("missions.statusFailed", "Failed")}</option>
                                          <option value="blocked">{t("missions.statusBlocked", "Blocked")}</option>
                                        </select>
                                        <div className="mission-form-card__actions">
                                          <button className="mission-btn mission-btn--primary" onClick={() => handleSaveAssertion(assertion.id, milestone.id)} disabled={saving}>
                                            {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                            {t("missions.saveButton", "Save")}
                                          </button>
                                          <button className="mission-btn mission-btn--ghost" onClick={handleCancelAssertion}>
                                            {t("missions.cancelButton", "Cancel")}
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <>
                                        <span
                                          className="mission-status-badge mission-status-badge--sm"
                                          style={{
                                            backgroundColor: (assertionStatusColors[assertion.status] ?? assertionStatusColors.pending).bg,
                                            color: (assertionStatusColors[assertion.status] ?? assertionStatusColors.pending).text,
                                          }}
                                        >
                                          {assertion.status}
                                        </span>
                                        <span className="mission-assertion__title">{assertion.title}</span>
                                        {(() => {
                                          const linked = linkedFeaturesByAssertion.get(assertion.id);
                                          const count = linked?.length ?? 0;
                                          return count > 0 ? (
                                            <span className="mission-assertion__linked-count" title={t("missions.linkedFeaturesCount", { count, defaultValue_one: "{{count}} linked feature", defaultValue_other: "{{count}} linked features" })}>
                                              {t("missions.linkedCountShort", "({{count}} linked)", { count })}
                                            </span>
                                          ) : null;
                                        })()}
                                        <button
                                          className="mission-icon-btn"
                                          onClick={() => handleToggleAssertionExpanded(assertion.id)}
                                          title={t("missions.toggleDetails", "Toggle details")}
                                        >
                                          {expandedAssertionId === assertion.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                        </button>
                                        <button
                                          className="mission-icon-btn"
                                          onClick={() => handleEditAssertion(assertion)}
                                          title={t("missions.editAssertion", "Edit assertion")}
                                        >
                                          <Pencil size={14} />
                                        </button>
                                        <button
                                          className="mission-icon-btn mission-icon-btn--danger"
                                          onClick={() => setDeleteConfirmId({ type: "assertion", id: assertion.id })}
                                          title={t("missions.deleteAssertion", "Delete assertion")}
                                        >
                                          <Trash2 size={14} />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                  {expandedAssertionId === assertion.id && (
                                    <div className="mission-assertion__body">
                                      <p className="mission-assertion__text">{assertion.assertion}</p>
                                      {/* Linked features section */}
                                      <div className="mission-assertion__linked-features">
                                        <div className="mission-assertion__linked-features-header">
                                          <span className="mission-assertion__linked-features-label">{t("missions.linkedFeaturesLabel", "Linked Features")}</span>
                                          <button
                                            className="mission-btn mission-btn--ghost mission-btn--sm"
                                            onClick={async () => {
                                              // First expand the assertion if it's not already expanded
                                              if (expandedAssertionId !== assertion.id) {
                                                await handleToggleAssertionExpanded(assertion.id);
                                              }
                                              // Then toggle the picker
                                              setFeaturePickerOpenForAssertion(featurePickerOpenForAssertion === assertion.id ? null : assertion.id);
                                            }}
                                            title={t("missions.linkAFeature", "Link a feature")}
                                          >
                                            <Link size={12} />
                                            {t("missions.linkFeatureButton", "Link Feature")}
                                          </button>
                                        </div>
                                        {/* Feature picker dropdown */}
                                        {featurePickerOpenForAssertion === assertion.id && (
                                          <div className="mission-assertion__feature-picker">
                                            <div className="mission-assertion__feature-picker-dropdown">
                                              {(() => {
                                                const linkedFeatureIds = new Set((linkedFeaturesByAssertion.get(assertion.id) ?? []).map((f) => f.id));
                                                const allFeatures: MissionFeature[] = [];
                                                selectedMission?.milestones.forEach((m) =>
                                                  m.slices.forEach((s) => allFeatures.push(...s.features.filter((f) => !linkedFeatureIds.has(f.id))))
                                                );
                                                if (allFeatures.length === 0) {
                                                  return <span className="mission-assertion__feature-picker-empty">{t("missions.allFeaturesLinked", "All features already linked")}</span>;
                                                }
                                                return allFeatures.map((feature) => (
                                                  <button
                                                    key={feature.id}
                                                    className="mission-assertion__feature-picker-item"
                                                    onClick={() => handleLinkFeatureToAssertion(feature.id, assertion.id)}
                                                    disabled={linkingAssertions.has(assertion.id)}
                                                  >
                                                    <span className="mission-assertion__feature-picker-title">{feature.title}</span>
                                                    {linkingAssertions.has(assertion.id) && <Loader2 size={12} className="spinner" />}
                                                  </button>
                                                ));
                                              })()}
                                            </div>
                                          </div>
                                        )}
                                        {/* Linked features list */}
                                        {(() => {
                                          const linked = linkedFeaturesByAssertion.get(assertion.id) ?? [];
                                          if (linked.length === 0) {
                                            return <span className="mission-assertion__linked-empty">{t("missions.noFeaturesLinkedYet", "No features linked yet")}</span>;
                                          }
                                          return linked.map((feature) => {
                                            const key = `${feature.id}-${assertion.id}`;
                                            const isUnlinking = unlinkingFeatures.has(key);
                                            return (
                                              <div key={feature.id} className="mission-assertion__linked-feature">
                                                <span className="mission-assertion__linked-feature-title">{feature.title}</span>
                                                <button
                                                  className="mission-icon-btn mission-icon-btn--danger"
                                                  onClick={() => handleUnlinkFeatureFromAssertion(feature.id, assertion.id)}
                                                  disabled={isUnlinking}
                                                  title={t("missions.unlinkFeature", "Unlink feature")}
                                                >
                                                  {isUnlinking ? <Loader2 size={12} className="spinner" /> : <Unlink size={12} />}
                                                </button>
                                              </div>
                                            );
                                          });
                                        })()}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ))}
                              {(milestoneAssertions.length === 0)
                                && !isCreatingAssertion
                                && (
                                  // Render from feature prose presence directly. Legacy
                                  // hasProseButNoAssertions telemetry is no longer the gate.
                                  featuresWithAcceptanceCriteria.length > 0 ? (
                                    <>
                                      <div className="mission-manager__empty mission-assertions__empty">
                                        <span>{t("missions.noAssertionsYet", "No linked contract assertions are loaded yet. Feature criteria below will still be AI-validated when mission validation runs.")}</span>
                                      </div>
                                      <div className="mission-assertions__list" data-testid="milestone-feature-acceptance-rollup">
                                        <div className="mission-assertions__rollup-header">
                                          <span className="mission-assertions__title">{t("missions.featureCriteriaAwaitingSync", "Feature criteria awaiting assertion sync")}</span>
                                          <span className="mission-assertions__mode-tag" data-testid="milestone-feature-acceptance-ai-validated-indicator">
                                            <span className="status-dot status-dot--running" />
                                            {t("missions.aiValidatedAtRuntime", "AI-validated at runtime")}
                                          </span>
                                        </div>
                                        {featuresWithAcceptanceCriteria.map((feature) => (
                                          <div key={feature.id} className="mission-assertion">
                                            <div className="mission-assertion__header">
                                              <span className="mission-assertion__title">{feature.title}</span>
                                              <span
                                                className="mission-status-badge mission-status-badge--sm"
                                                data-testid={`mission-feature-acceptance-status-${feature.id}`}
                                                style={{
                                                  backgroundColor: featureStatusColors[feature.status].bg,
                                                  color: featureStatusColors[feature.status].text,
                                                }}
                                              >
                                                {feature.status}
                                              </span>
                                            </div>
                                            <div className="mission-assertion__text">
                                              <strong>{t("missions.acceptance", "Acceptance:")}</strong>
                                              {renderMarkdownText(feature.acceptanceCriteria ?? "")}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </>
                                  ) : (
                                    !milestone.acceptanceCriteria?.trim() ? (
                                      <div className="mission-manager__empty mission-assertions__empty">
                                        <span>{t("missions.noAssertionsDefined", "No feature acceptance criteria or contract assertions defined yet.")}</span>
                                      </div>
                                    ) : null
                                  )
                                )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}

                {/* Create milestone button/form */}
                {selectedMission && !isCreatingMilestone && editingMilestoneId === null && (
                  <button className="mission-add-btn" onClick={handleCreateMilestone}>
                    <Plus size={16} />
                    {t("missions.addMilestone", "Add Milestone")}
                  </button>
                )}

                {/* Global create milestone form */}
                {isCreatingMilestone && editingMilestoneId === null && (
                  <div className="mission-form-card">
                    <input
                      type="text"
                      placeholder={t("missions.milestoneTitlePlaceholder", "Milestone title")}
                      value={milestoneForm.title}
                      onChange={(e) => setMilestoneForm({ ...milestoneForm, title: e.target.value })}
                      onKeyDown={handleMilestoneFormKeyDown}
                      autoFocus
                    />
                    <textarea
                      placeholder={t("missions.descriptionOptional", "Description (optional)")}
                      value={milestoneForm.description}
                      onChange={(e) => setMilestoneForm({ ...milestoneForm, description: e.target.value })}
                      rows={2}
                    />
                    <textarea
                      placeholder={t("missions.acceptanceCriteriaOptional", "Acceptance criteria (optional)")}
                      value={milestoneForm.acceptanceCriteria}
                      onChange={(e) => setMilestoneForm({ ...milestoneForm, acceptanceCriteria: e.target.value })}
                      rows={2}
                    />
                    <div className="mission-form-card__actions">
                      <button className="mission-btn mission-btn--primary" onClick={handleSaveMilestone} disabled={saving}>
                        {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                        {t("missions.createButton", "Create")}
                      </button>
                      <button className="mission-btn mission-btn--ghost" onClick={handleCancelMilestone}>
                        {t("missions.cancelButton", "Cancel")}
                      </button>
                    </div>
                  </div>
                )}

                {selectedMission.milestones.length === 0 && !isCreatingMilestone && (
                  <div className="mission-manager__empty">
                    <Layers size={24} />
                    <span>{t("missions.noMilestonesYet", "No milestones yet. Add one to get started.")}</span>
                  </div>
                )}
                </div>
              ) : (
                <div className="mission-detail__activity" data-testid="mission-activity-tab">
                  <div className="mission-detail__activity-controls">
                    <label className="mission-detail__activity-filter">
                      <span>{t("missions.filterLabel", "Filter")}</span>
                      <select
                        value={eventsFilter}
                        onChange={(event) => setEventsFilter(event.target.value as typeof eventsFilter)}
                        data-testid="mission-activity-filter"
                      >
                        <option value="all">{t("missions.filterAll", "All events")}</option>
                        <option value="errors">{t("missions.filterErrors", "Errors & warnings")}</option>
                        <option value="state_changes">{t("missions.filterStateChanges", "State changes")}</option>
                        <option value="tasks">{t("missions.filterTasks", "Task events")}</option>
                        <option value="slices">{t("missions.filterSlices", "Slice & milestone events")}</option>
                        <option value="autopilot">{t("missions.filterAutopilot", "Autopilot events")}</option>
                      </select>
                    </label>
                    <span className="mission-detail__activity-count">
                      {t("missions.activityCount", "{{visible}} of {{total}}", { visible: missionEvents.length, total: eventsTotal })}
                    </span>
                  </div>

                  {!eventsLoading && hasMoreEvents && (
                    <div className="mission-detail__activity-load-more mission-detail__activity-load-more--top">
                      <button
                        className="mission-btn mission-btn--ghost"
                        onClick={handleLoadMoreEvents}
                        data-testid="mission-activity-load-more"
                      >
                        {t("missions.loadMore", "Load more")}
                      </button>
                    </div>
                  )}

                  {eventsLoading ? (
                    <div className="mission-manager__loading mission-detail__activity-loading">
                      <Loader2 size={18} className="spinner" />
                      <span>{t("missions.loadingActivity", "Loading mission activity...")}</span>
                    </div>
                  ) : missionEvents.length === 0 ? (
                    <div className="mission-manager__empty">
                      <Activity size={18} />
                      <span>{t("missions.noEventsYet", "No events yet.")}</span>
                    </div>
                  ) : (
                    <div
                      ref={activityEventsContainerRef}
                      className="mission-events"
                      data-testid="mission-activity-events"
                    >
                      {displayedMissionEvents.map((event) => {
                        const hasMetadata = Boolean(event.metadata && Object.keys(event.metadata).length > 0);
                        const metadataExpanded = expandedEventMetadata.has(event.id);

                        return (
                          <div key={event.id} className="mission-event">
                            <div className="mission-event__header">
                              <span className={`mission-event__type ${getEventTypeClassName(event.eventType)}`}>
                                {getEventTypeLabel(event.eventType)}
                              </span>
                              <span className="mission-event__time">{getRelativeTime(event.timestamp, t)}</span>
                            </div>
                            <p className="mission-event__description">{event.description}</p>
                            <span className="mission-event__timestamp">
                              {new Date(event.timestamp).toLocaleString()}
                            </span>
                            {hasMetadata && (
                              <div className="mission-event__metadata">
                                <button
                                  className="mission-btn mission-btn--ghost mission-btn--sm"
                                  onClick={() => toggleEventMetadata(event.id)}
                                  data-testid={`mission-event-metadata-${event.id}`}
                                >
                                  {metadataExpanded ? t("missions.hideMetadata", "Hide metadata") : t("missions.showMetadata", "Show metadata")}
                                </button>
                                {metadataExpanded && (
                                  <pre className="mission-event__metadata-content">
                                    {JSON.stringify(event.metadata, null, 2)}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <div ref={activityEventsEndRef} />
                    </div>
                  )}

                </div>
              )}
            </div>

    );
  };

  const openNewMissionInterview = () => {
    if (resumeSessionId) {
      dismissedResumeSessionIdRef.current = resumeSessionId;
    }
    setInterviewLaunchMode("new");
    setLocalResumeSessionId(undefined);
    setInterviewModalKey((current) => current + 1);
    setShowInterviewModal(true);
  };

  const handleResumeInterviewSession = (sessionId: string) => {
    setInterviewLaunchMode("resume");
    setLocalResumeSessionId(sessionId);
    setInterviewModalKey((current) => current + 1);
    setShowInterviewModal(true);
  };

  const shouldRenderSidebarDeleteConfirm =
    deleteConfirmId != null && deleteConfirmId.type === "interview_draft";

  const handleInterviewModalClose = () => {
    dismissedResumeSessionIdRef.current = effectiveResumeSessionId ?? null;
    setInterviewLaunchMode("new");
    setLocalResumeSessionId(undefined);
    setShowInterviewModal(false);
  };

  const handleDiscardInterviewSession = async (sessionId: string) => {
    try {
      /*
      FNXC:MissionDraftDiscard 2026-06-24-02:42:
      The mission draft Discard confirmation must send the current browser tab id so a draft locked by this tab can be removed while a draft actively owned by another tab returns the lock warning and stays visible.
      */
      await discardMissionInterviewDraft(sessionId, projectId);
      setMissionInterviewDrafts((current) => current.filter((session) => session.id !== sessionId));
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        addToast(t("missions.draftOpenInAnotherTab", "Draft is open in another tab"), "error");
        return;
      }
      if (err instanceof ApiRequestError && err.status === 404) {
        setMissionInterviewDrafts((current) => current.filter((session) => session.id !== sessionId));
        return;
      }
      addToast(getErrorMessage(err) || t("missions.draftDiscardFailed", "Failed to discard draft"), "error");
      return;
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const renderInterviewSessionItems = () => missionInterviewDrafts.map((session) => {
    const isErrored = session.status === "error";
    const isGenerating = session.status === "generating";
    const isComplete = session.status === "complete";
    const resumeActionLabel = session.status === "error" ? t("missions.interviewActionRetry", "Retry interview")
      : session.status === "generating" ? t("missions.interviewActionGenerating", "Generating plan")
      : session.status === "complete" ? t("missions.interviewActionReview", "Review plan")
      : t("missions.interviewActionResume", "Resume interview");
    const description = isGenerating
      ? t("missions.interviewGenerating", "Generating mission hierarchy from interview context.")
      : isErrored
        ? t("missions.interviewErrored", "Interview hit an error. Retry from this list item.")
        : isComplete
          ? t("missions.interviewComplete", "Plan ready — review and approve to create the mission.")
          : t("missions.interviewWaiting", "Interview is waiting for your next response.");
    const actionText = isGenerating ? t("missions.actionGenerating", "Generating…") : isErrored ? t("missions.actionRetry", "Retry") : isComplete ? t("missions.actionReview", "Review") : t("missions.actionResume", "Resume");

    return (
      <div
        key={session.id}
        className="mission-list__item mission-list__item--interview"
        role="button"
        tabIndex={0}
        aria-label={t("missions.resumeInterviewAriaLabel", "Resume interview {{title}}", { title: session.title || t("missions.defaultInterviewTitle", "Mission interview") })}
        onClick={() => handleResumeInterviewSession(session.id)}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) return;
          if (event.key === "Enter") {
            handleResumeInterviewSession(session.id);
            return;
          }
          if (event.key === " ") {
            event.preventDefault();
            handleResumeInterviewSession(session.id);
          }
        }}
      >
        <div className="mission-list__item-content">
          <div className="mission-list__item-header">
            <Sparkles size={16} className="mission-list__item-icon" />
            <span className="mission-list__item-title">{session.title || t("missions.defaultInterviewTitle", "Mission interview")}</span>
          </div>
          <div className="mission-list__item-tags">
            <span className={`mission-status-badge mission-status-badge--sm mission-interview-status mission-interview-status--${session.status}`}>
              {getInterviewStatusLabel(session.status, t)}
            </span>
          </div>
          <p className="mission-list__item-description">{description}</p>
        </div>
        <div className="mission-list__item-actions mission-list__resume-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="mission-btn mission-btn--ghost mission-btn--sm"
            onClick={() => handleResumeInterviewSession(session.id)}
            title={resumeActionLabel}
            aria-label={resumeActionLabel}
            disabled={isGenerating}
          >
            {isGenerating ? <Loader2 size={14} className="spinner" /> : isErrored ? <RefreshCw size={14} /> : <Sparkles size={14} />}
            <span>{actionText}</span>
          </button>
          <button
            className="mission-btn mission-btn--danger mission-btn--sm"
            onClick={() => setDeleteConfirmId({ type: "interview_draft", id: session.id })}
            title={t("missions.discardDraft", "Discard draft")}
            aria-label={t("missions.discardDraft", "Discard draft")}
          >
            <Trash2 size={14} />
            <span>{t("missions.discardButton", "Discard")}</span>
          </button>
        </div>
      </div>
    );
  });

  const renderMissionListItems = (missionList: MissionWithSummary[], options?: { interviewStyle?: boolean }) => missionList.map((mission) => {
    const m = mission;
    const isSelected = selectedMission?.id === m.id;
    const statusColors = missionStatusColors[m.status as MissionStatus] || { bg: "", text: "" };
    const summary = m.summary;
    const health = missionHealthById.get(m.id);
    const healthState = getMissionHealthState(health);
    const hasContent = Boolean(summary && (summary.totalMilestones > 0 || summary.totalFeatures > 0));
    const totalTasks = health?.totalTasks ?? 0;
    const tasksCompleted = health?.tasksCompleted ?? 0;
    const tasksFailed = health?.tasksFailed ?? 0;
    const progressPercent = health?.estimatedCompletionPercent ?? summary?.progressPercent ?? 0;
    const showSummaryBlock = hasContent || totalTasks > 0 || tasksFailed > 0 || Boolean(health?.lastActivityAt);
    const isInterviewStyle = options?.interviewStyle === true;
    const showUnlinkedIndicator =
      m.status === "active" &&
      !isInterviewStyle &&
      (mission.summary?.linkedGoalCount ?? 0) === 0;

    return (
      <div
        key={m.id}
        className={`mission-list__item ${isSelected ? "mission-list__item--selected" : ""} ${isInterviewStyle ? "mission-list__item--interview" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={t("missions.openMissionAriaLabel", "Open mission {{title}}", { title: m.title })}
        aria-pressed={isSelected}
        onClick={() => handleSelectMission(mission)}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) return;
          if (event.key === "Enter") {
            handleSelectMission(mission);
            return;
          }
          if (event.key === " ") {
            event.preventDefault();
            handleSelectMission(mission);
          }
        }}
      >
        <div className="mission-list__item-content">
          <div className="mission-list__item-header">
            <Target size={16} className="mission-list__item-icon" />
            <span className="mission-list__item-title">{m.title}</span>
          </div>
          <div className="mission-list__item-tags">
            {mission.autopilotEnabled && (
              <span title={t("missions.autopilotEnabledLabel", "Autopilot enabled")}><Zap size={12} className="mission-list__item-autopilot-icon" /></span>
            )}
            <span
              className={`mission-health-badge mission-health-badge--${healthState}`}
              data-testid={`mission-health-badge-${m.id}`}
              aria-label={t("missions.missionHealthAriaLabel", "Mission health: {{state}}", { state: healthState })}
            />
            <span
              className="mission-status-badge mission-status-badge--sm"
              style={{
                backgroundColor: statusColors.bg,
                color: statusColors.text,
              }}
            >
              {m.status}
            </span>
            {showUnlinkedIndicator && (
              <span
                className="mission-status-badge mission-status-badge--sm mission-status-badge--unlinked"
                title={t("missions.noGoalsLinked", "No goals linked to this mission")}
                aria-label={t("missions.noGoalsLinked", "No goals linked to this mission")}
                data-testid={`mission-unlinked-indicator-${m.id}`}
              >
                {t("missions.unlinkedBadge", "Unlinked")}
              </span>
            )}
            {isInterviewStyle && (
              <span className="mission-status-badge mission-status-badge--sm mission-interview-status mission-interview-status--awaiting_input">
                {t("missions.interviewInProgress", "Interview in progress")}
              </span>
            )}
          </div>
          {isInterviewStyle ? (
            <p className="mission-list__item-description">{t("missions.missionInterviewInProgressDesc", "Mission interview is still in progress. Open this mission to continue planning.")}</p>
          ) : m.description ? (
            <div className="mission-list__item-description">{renderMarkdownText(m.description)}</div>
          ) : null}
          {showSummaryBlock && (
            <div className="mission-list__item-summary">
              {hasContent && (
                <>
                  <span className="mission-list__item-stat">
                    {t("missions.completedMilestones", "{{completed}}/{{total}} milestones", { completed: summary!.completedMilestones, total: summary!.totalMilestones })}
                  </span>
                  <span className="mission-list__item-stat">
                    {t("missions.completedFeatures", "{{completed}}/{{total}} features", { completed: summary!.completedFeatures, total: summary!.totalFeatures })}
                  </span>
                </>
              )}
              <span className="mission-list__item-stat" data-testid={`mission-task-stats-${m.id}`}>
                {t("missions.completedTasks", "{{completed}}/{{total}} tasks", { completed: tasksCompleted, total: totalTasks })}
              </span>
              {tasksFailed > 0 && (
                <button
                  className="mission-list__item-failed"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleSelectMission(mission);
                  }}
                  data-testid={`mission-failed-${m.id}`}
                  title={t("missions.viewMissionFailures", "View mission failures")}
                >
                  {t("missions.tasksFailed", { count: tasksFailed, defaultValue_one: "{{count}} failed", defaultValue_other: "{{count}} failed" })}
                </button>
              )}
              <div className={`mission-list__item-progress mission-list__item-progress--${healthState}`}>
                <div
                  className="mission-list__item-progress-bar"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
          {showSummaryBlock && (
            <div className="mission-list__item-activity">
              <span className="mission-relative-time" data-testid={`mission-last-activity-${m.id}`}>
                {t("missions.activityTime", "Activity {{time}}", { time: getRelativeTime(health?.lastActivityAt, t) })}
              </span>
            </div>
          )}
        </div>
        <div className="mission-list__item-actions" onClick={(e) => e.stopPropagation()}>
          <div className="mission-list__item-run-controls">
            {m.status === "active" && (
              <button
                className="mission-btn mission-btn--danger mission-btn--sm"
                onClick={() => handleStopMission(m.id)}
                title={t("missions.stopMission", "Stop mission")}
                aria-label={t("missions.stopMission", "Stop mission")}
              >
                <Square size={14} />
                <span>{t("missions.stopMission", "Stop mission")}</span>
              </button>
            )}
            {m.status === "blocked" && (
              <button
                className="mission-btn mission-btn--primary mission-btn--sm"
                onClick={() => handleResumeMission(m.id)}
                title={t("missions.resumeMission", "Resume mission")}
                aria-label={t("missions.resumeMission", "Resume mission")}
              >
                <Play size={14} />
                <span>{t("missions.resumeMission", "Resume mission")}</span>
              </button>
            )}
            {m.status === "planning" && (
              <button
                className="mission-btn mission-btn--primary mission-btn--sm"
                onClick={() => handleStartMission(m.id)}
                title={t("missions.startMission", "Start mission")}
                aria-label={t("missions.startMission", "Start mission")}
              >
                <Play size={14} />
                <span>{t("missions.startMission", "Start mission")}</span>
              </button>
            )}
            {getMissionRunHelperText(m.status, t) && (
              <span className="mission-list__item-run-help">{getMissionRunHelperText(m.status, t)}</span>
            )}
          </div>
          <button
            className="mission-icon-btn"
            onClick={() => handleEditMission(mission)}
            title={t("missions.editMission", "Edit mission")}
            aria-label={t("missions.editMission", "Edit mission")}
          >
            <Pencil size={14} />
          </button>
          <button
            className="mission-icon-btn mission-icon-btn--danger"
            onClick={() => void requestDeleteMission(m.id)}
            title={t("missions.deleteMission", "Delete mission")}
            aria-label={t("missions.deleteMission", "Delete mission")}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    );
  });

  const renderMissionListContent = ({ hideBottomButtons = false }: { hideBottomButtons?: boolean } = {}) => {
    const persistedInterviewMissions = missions.filter((mission) => mission.interviewState === "in_progress");
    const standardMissions = missions.filter((mission) => mission.interviewState !== "in_progress");
    const showBottomPlanButton = !hideBottomButtons;

    return (
      <div className="mission-list">
              {/* Create mission form */}
              {isCreatingMission && (
                <div className="mission-form-card">
                  <input
                    type="text"
                    placeholder={t("missions.missionTitlePlaceholder", "Mission title")}
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder={t("missions.descriptionOptional", "Description (optional)")}
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <label>
                    {t("missions.targetBranch", "Target branch")}
                    <input
                      type="text"
                      placeholder={t("missions.targetBranchPlaceholder", "e.g. main")}
                      value={missionForm.baseBranch}
                      onChange={(e) => setMissionForm({ ...missionForm, baseBranch: e.target.value })}
                      aria-label={t("missions.missionTargetBranchAriaLabel", "Mission target branch")}
                    />
                  </label>
                  <label>
                    {t("missions.branchStrategy", "Branch strategy")}
                    <select
                      value={missionForm.branchStrategy.mode}
                      onChange={(e) =>
                        setMissionForm({
                          ...missionForm,
                          branchStrategy: {
                            mode: e.target.value as MissionBranchStrategyMode,
                            branchName: missionForm.branchStrategy.branchName,
                          },
                        })
                      }
                      aria-label={t("missions.branchStrategyAriaLabel", "Mission branch strategy")}
                    >
                      <option value="project-default">{t("missions.branchStrategyProjectDefault", "Use project/default branch")}</option>
                      <option value="auto-per-task">{t("missions.branchStrategyAutoPerTask", "Auto-name a branch per task (from details)")}</option>
                      <option value="existing">{t("missions.branchStrategyExisting", "Use existing branch")}</option>
                      <option value="custom-new">{t("missions.branchStrategyCustomNew", "Create custom branch")}</option>
                    </select>
                  </label>
                  <label>
                    {t("missions.autoMergeOverride", "Merge behavior")}
                    <select
                      value={missionForm.autoMergeOverride}
                      onChange={(e) => setMissionForm({ ...missionForm, autoMergeOverride: e.target.value as MissionAutoMergeOverride })}
                      aria-label={t("missions.autoMergeOverrideAriaLabel", "Mission auto-merge override")}
                    >
                      <option value="inherit">{t("missions.autoMergeInherited", "Use project default")}</option>
                      <option value="on">{t("missions.autoMergeOn", "Auto-merge")}</option>
                      <option value="off">{t("missions.singlePullRequest", "Single pull request")}</option>
                    </select>
                    <span className="mission-detail__autopilot-description">
                      {t("missions.autoMergeOverrideDescription", "Auto-merge merges each feature as it passes. Single pull request keeps every feature on one shared branch to review and merge together.")}
                    </span>
                  </label>
                  {(missionForm.branchStrategy.mode === "existing" || missionForm.branchStrategy.mode === "custom-new") && (
                    <label>
                      {t("missions.branchName", "Branch name")}
                      <input
                        type="text"
                        placeholder={t("missions.branchNamePlaceholder", "e.g. feature/mission-work")}
                        value={missionForm.branchStrategy.branchName ?? ""}
                        onChange={(e) =>
                          setMissionForm({
                            ...missionForm,
                            branchStrategy: {
                              ...missionForm.branchStrategy,
                              branchName: e.target.value,
                            },
                          })
                        }
                        aria-label={t("missions.branchNameAriaLabel", "Mission branch name")}
                      />
                    </label>
                  )}
                  <div className="mission-form-card__actions">
                    <button className="mission-btn mission-btn--primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      {t("missions.createButton", "Create")}
                    </button>
                    <button className="mission-btn mission-btn--ghost" onClick={handleCancelMission}>
                      {t("missions.cancelButton", "Cancel")}
                    </button>
                  </div>
                </div>
              )}

              {/* Mission and interview items */}
              {missionInterviewDrafts.length > 0 && (
                <div className="mission-list__drafts-group">
                  <div className="mission-list__drafts-header">
                    <Sparkles size={16} className="mission-list__item-icon" />
                    <span>{t("missions.draftsLabel", "Drafts")}</span>
                    <span>({missionInterviewDrafts.length})</span>
                  </div>
                  {renderInterviewSessionItems()}
                </div>
              )}
              {renderMissionListItems(persistedInterviewMissions, { interviewStyle: true })}
              {renderMissionListItems(standardMissions)}

              {/* Edit mission form */}
              {editingMissionId && selectedMission?.id !== editingMissionId && (
                <div className="mission-form-card">
                  <input
                    type="text"
                    placeholder={t("missions.missionTitlePlaceholder", "Mission title")}
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder={t("missions.descriptionOptional", "Description (optional)")}
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <label>
                    {t("missions.targetBranch", "Target branch")}
                    <input
                      type="text"
                      placeholder={t("missions.targetBranchPlaceholder", "e.g. main")}
                      value={missionForm.baseBranch}
                      onChange={(e) => setMissionForm({ ...missionForm, baseBranch: e.target.value })}
                      aria-label={t("missions.missionTargetBranchAriaLabel", "Mission target branch")}
                    />
                  </label>
                  <label>
                    {t("missions.branchStrategy", "Branch strategy")}
                    <select
                      value={missionForm.branchStrategy.mode}
                      onChange={(e) =>
                        setMissionForm({
                          ...missionForm,
                          branchStrategy: {
                            mode: e.target.value as MissionBranchStrategyMode,
                            branchName: missionForm.branchStrategy.branchName,
                          },
                        })
                      }
                      aria-label={t("missions.branchStrategyAriaLabel", "Mission branch strategy")}
                    >
                      <option value="project-default">{t("missions.branchStrategyProjectDefault", "Use project/default branch")}</option>
                      <option value="auto-per-task">{t("missions.branchStrategyAutoPerTask", "Auto-name a branch per task (from details)")}</option>
                      <option value="existing">{t("missions.branchStrategyExisting", "Use existing branch")}</option>
                      <option value="custom-new">{t("missions.branchStrategyCustomNew", "Create custom branch")}</option>
                    </select>
                  </label>
                  <label>
                    {t("missions.autoMergeOverride", "Merge behavior")}
                    <select
                      value={missionForm.autoMergeOverride}
                      onChange={(e) => setMissionForm({ ...missionForm, autoMergeOverride: e.target.value as MissionAutoMergeOverride })}
                      aria-label={t("missions.autoMergeOverrideAriaLabel", "Mission auto-merge override")}
                    >
                      <option value="inherit">{t("missions.autoMergeInherited", "Use project default")}</option>
                      <option value="on">{t("missions.autoMergeOn", "Auto-merge")}</option>
                      <option value="off">{t("missions.singlePullRequest", "Single pull request")}</option>
                    </select>
                    <span className="mission-detail__autopilot-description">
                      {t("missions.autoMergeOverrideDescription", "Auto-merge merges each feature as it passes. Single pull request keeps every feature on one shared branch to review and merge together.")}
                    </span>
                  </label>
                  {(missionForm.branchStrategy.mode === "existing" || missionForm.branchStrategy.mode === "custom-new") && (
                    <label>
                      {t("missions.branchName", "Branch name")}
                      <input
                        type="text"
                        placeholder={t("missions.branchNamePlaceholder", "e.g. feature/mission-work")}
                        value={missionForm.branchStrategy.branchName ?? ""}
                        onChange={(e) =>
                          setMissionForm({
                            ...missionForm,
                            branchStrategy: {
                              ...missionForm.branchStrategy,
                              branchName: e.target.value,
                            },
                          })
                        }
                        aria-label={t("missions.branchNameAriaLabel", "Mission branch name")}
                      />
                    </label>
                  )}
                  <div className="mission-form-card__row">
                    <select
                      value={missionForm.status}
                      onChange={(e) => setMissionForm({ ...missionForm, status: e.target.value as MissionStatus })}
                    >
                      <option value="planning">{t("missions.statusPlanning", "Planning")}</option>
                      <option value="active">{t("missions.statusActive", "Active")}</option>
                      <option value="blocked">{t("missions.statusBlocked", "Blocked")}</option>
                      <option value="complete">{t("missions.statusComplete", "Complete")}</option>
                      <option value="archived">{t("missions.statusArchived", "Archived")}</option>
                    </select>
                    <label className="mission-checkbox">
                      <input
                        type="checkbox"
                        checked={missionForm.autopilotEnabled}
                        onChange={(e) => setMissionForm({ ...missionForm, autopilotEnabled: e.target.checked })}
                      />
                      <Zap size={12} /> {t("missions.autopilotLabel", "Autopilot")}
                    </label>
                  </div>
                  <div className="mission-form-card__actions">
                    <button className="mission-btn mission-btn--primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      {t("missions.updateButton", "Update")}
                    </button>
                    <button className="mission-btn mission-btn--ghost" onClick={handleCancelMission}>
                      {t("missions.cancelButton", "Cancel")}
                    </button>
                  </div>
                </div>
              )}

              {missions.length === 0 && missionInterviewDrafts.length === 0 && persistedInterviewMissions.length === 0 && !isCreatingMission && (
                <div className="mission-manager__empty mission-manager__empty--large mission-manager__empty--mission">
                  <Target size={32} />
                  <h3 className="mission-manager__empty-title">{t("missions.noMissionsYetTitle", "No missions yet")}</h3>
                  <p className="mission-manager__empty-body">
                    {t("missions.noMissionsYetBody", "Missions are large initiatives that bundle milestones, slices, and features into a single plan. Plan a mission to break down a goal end-to-end and let agents work through it autopilot-style.")}
                  </p>
                  <button
                    className="btn btn-sm btn-primary mission-manager__empty-cta"
                    onClick={openNewMissionInterview}
                  >
                    <Sparkles size={14} />
                    {t("missions.planNewMission", "Plan New Mission")}
                  </button>
                </div>
              )}

              {!isCreatingMission && (
                <div className="mission-list__footer">
                  {showBottomPlanButton && (
                    <div className="mission-list__footer-actions">
                      <button className="btn btn-sm btn-primary mission-list__primary-cta" onClick={openNewMissionInterview}>
                        <Sparkles size={14} />
                        {t("missions.planNewMission", "Plan New Mission")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
    );
  };

  const renderDeleteConfirmPanel = () => {
    if (deleteConfirmId?.type === "mission") {
      return null;
    }
    const isInterviewDraftDelete = deleteConfirmId?.type === "interview_draft";

    return (
      <div className="mission-confirm-panel mission-confirm-panel--danger">
        <div className="mission-confirm-panel__content">
          <p>
            {isInterviewDraftDelete
              ? t("missions.discardDraftConfirm", "Discard this interview draft? This removes the saved draft and cannot be undone.")
              : t("missions.deleteConfirm", "Delete this {{type}}? This cannot be undone.", { type: deleteConfirmId?.type })}
          </p>
          <div className="mission-confirm-panel__actions">
            <button
              className="mission-btn mission-btn--danger"
              onClick={async () => {
                if (!deleteConfirmId) return;
                if (deleteConfirmId.type === "milestone") {
                  await handleDeleteMilestone(deleteConfirmId.id);
                } else if (deleteConfirmId.type === "slice") {
                  await handleDeleteSlice(deleteConfirmId.id);
                } else if (deleteConfirmId.type === "feature") {
                  await handleDeleteFeature(deleteConfirmId.id);
                } else if (deleteConfirmId.type === "interview_draft") {
                  await handleDiscardInterviewSession(deleteConfirmId.id);
                }
              }}
            >
              {isInterviewDraftDelete ? t("missions.discardButton", "Discard") : t("missions.deleteButton", "Delete")}
            </button>
            <button className="mission-btn mission-btn--ghost" onClick={() => setDeleteConfirmId(null)}>
              {t("missions.cancelButton", "Cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderLinkTaskPanel = () => (
    <div className="mission-confirm-panel mission-confirm-panel--link">
      <div className="mission-confirm-panel__content">
        <p>{t("missions.linkFeatureToTask", "Link feature to task:")}</p>
        <input
          type="text"
          placeholder={t("missions.taskIdPlaceholder", "Task ID (e.g., FN-001)")}
          value={selectedTaskId}
          onChange={(e) => setSelectedTaskId(e.target.value)}
          autoFocus
        />
        {availableTasks.length > 0 && (
          <div className="mission-task-suggestions">
            <small>{t("missions.orSelect", "Or select:")}</small>
            <div className="mission-task-suggestions__list">
              {availableTasks.slice(0, 5).map((task) => (
                <button
                  key={task.id}
                  className="mission-task-suggestions__item"
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  {task.id}: {task.title || t("missions.untitled", "Untitled")}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mission-confirm-panel__actions">
          <button className="mission-btn mission-btn--primary" onClick={handleLinkTask}>
            {t("missions.linkButton", "Link")}
          </button>
          <button className="mission-btn mission-btn--ghost" onClick={() => { setLinkTaskFeatureId(null); setSelectedTaskId(""); }}>
            {t("missions.cancelButton", "Cancel")}
          </button>
        </div>
      </div>
    </div>
  );

  const manager = (
    <div
      ref={modalRef}
      className={`mission-manager mission-manager--desktop${isInline ? " mission-manager--inline" : ""}`}
      role={isInline ? undefined : "dialog"}
      aria-modal={isInline ? undefined : true}
      aria-label={isInline ? undefined : t("missions.missionManagerAriaLabel", "Mission Manager")}
      data-testid="mission-manager-dialog"
    >
      {/*
      FNXC:Navigation 2026-06-22-01:10:
      Missions keeps its own header element (not the shared ViewHeader component) because it owns a dynamic mobile title (mission title when one is selected), a back button for stacked list->detail nav, an inline-vs-modal padding variant, and the mission-header-title test id. To stay visually consistent with the Command Center-modeled ViewHeader, the title uses the same icon size (20) and 1.125rem title metric via .mission-manager__title.
      */}
      <div className={`mission-manager__header${isInline ? " mission-manager__header--inline" : ""}`}>
        <div className="mission-manager__header-title">
          {selectedMission && (
            <button
              className="mission-manager__back-btn"
              onClick={handleBackToList}
              title={t("missions.backToMissions", "Back to missions")}
              aria-label={t("missions.backToMissionsList", "Back to missions list")}
              data-testid="mission-back-btn"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <Target size={20} className="mission-manager__header-icon" />
          <h2 className="mission-manager__title" data-testid="mission-header-title">
            <span className="mission-manager__title-text mission-manager__title-text--desktop">{t("missions.title", "Missions")}</span>
            <span className="mission-manager__title-text mission-manager__title-text--mobile">
              {selectedMission ? selectedMission.title : t("missions.title", "Missions")}
            </span>
          </h2>
        </div>
        {!isInline && (
          <button
            className="modal-close"
            onClick={onClose}
            title={t("missions.close", "Close")}
            aria-label={t("missions.closeMissionManager", "Close Mission Manager")}
            data-testid="mission-close-btn"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {isMobile ? (
        <div className="mission-manager__body mission-manager__body--stacked">
          {loading ? (
            <div className="mission-manager__loading">
              <Loader2 size={24} className="spinner" />
              <span>{t("missions.loadingMissions", "Loading missions...")}</span>
            </div>
          ) : detailLoading ? (
            <div className="mission-manager__loading">
              <Loader2 size={24} className="spinner" />
              <span>{t("missions.loadingMissionDetails", "Loading mission details...")}</span>
            </div>
          ) : selectedMission ? (
            renderMissionDetailContent()
          ) : (
            renderMissionListContent()
          )}
          {deleteConfirmId && renderDeleteConfirmPanel()}
          {linkTaskFeatureId && renderLinkTaskPanel()}
        </div>
      ) : (
        <div className="mission-manager__split">
          <aside
            className="mission-manager__sidebar"
            data-testid="mission-sidebar"
            aria-label={t("missions.missionList", "Mission list")}
            style={isMobile ? undefined : { width: `${sidebarWidth}px` }}
          >
            <div className="mission-manager__sidebar-list">
              {loading ? (
                <div className="mission-manager__loading">
                  <Loader2 size={24} className="spinner" />
                  <span>{t("missions.loadingMissions", "Loading missions...")}</span>
                </div>
              ) : (
                renderMissionListContent({ hideBottomButtons: true })
              )}
            </div>
            <div className="mission-manager__sidebar-footer" data-testid="mission-sidebar-footer">
              {shouldRenderSidebarDeleteConfirm && renderDeleteConfirmPanel()}
              <button
                className="btn btn-primary mission-manager__sidebar-cta"
                onClick={openNewMissionInterview}
                title={t("missions.planNewMission", "Plan New Mission")}
                aria-label={t("missions.planNewMission", "Plan New Mission")}
              >
                <Sparkles size={14} />
                {t("missions.planNewMission", "Plan New Mission")}
              </button>
            </div>
          </aside>

          {!isMobile && (
            <div
              className="mission-manager__sidebar-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={MISSION_SIDEBAR_MIN_WIDTH}
              aria-valuemax={MISSION_SIDEBAR_MAX_WIDTH}
              aria-valuenow={sidebarWidth}
              aria-label={t("missions.resizeSidebar", "Resize mission sidebar")}
              tabIndex={0}
              onPointerDown={handleSidebarResizeStart}
              onKeyDown={handleSidebarResizeKeyDown}
            />
          )}

          <div className="mission-manager__detail-pane">
            {detailLoading ? (
              <div className="mission-manager__loading">
                <Loader2 size={24} className="spinner" />
                <span>{t("missions.loadingMissionDetails", "Loading mission details...")}</span>
              </div>
            ) : selectedMission ? (
              renderMissionDetailContent()
            ) : (
              <div className="mission-manager__detail-pane-empty" data-testid="mission-empty-detail">
                <Target size={32} />
                <span>{t("missions.selectMissionToView", "Select a mission to view details")}</span>
              </div>
            )}
            {deleteConfirmId && !shouldRenderSidebarDeleteConfirm && renderDeleteConfirmPanel()}
            {linkTaskFeatureId && renderLinkTaskPanel()}
          </div>
        </div>
      )}
    </div>
  );

  const interviewModal = (
    <MissionInterviewModal
      key={interviewModalKey}
      isOpen={showInterviewModal}
      onClose={handleInterviewModalClose}
      onSendToBackground={handleInterviewModalClose}
      showSendToBackgroundButton={interviewLaunchMode === "resume"}
      onMissionCreated={() => {
        loadMissions();
        addToast(t("missions.createdFromInterview", "Mission created from AI interview"), "success");
      }}
      projectId={projectId}
      resumeSessionId={interviewLaunchMode === "resume" ? effectiveResumeSessionId : undefined}
    />
  );

  const milestoneSliceInterviewModal = interviewTarget ? (
    <MilestoneSliceInterviewModal
      isOpen={true}
      onClose={() => setInterviewTarget(null)}
      onApplied={() => {
        setInterviewTarget(null);
        if (selectedMission) loadMissionDetail(selectedMission.id);
      }}
      targetType={interviewTarget.type}
      targetId={interviewTarget.id}
      targetTitle={interviewTarget.title}
      missionContext={selectedMission?.title}
      projectId={projectId}
      resumeSessionId={interviewTarget.resumeSessionId}
    />
  ) : null;

  if (isInline) {
    return (
      <>
        {manager}
        {interviewModal}
        {milestoneSliceInterviewModal}
      </>
    );
  }

  return (
    <>
      <div
        className="mission-manager-overlay open"
        onClick={(e) => e.target === e.currentTarget && onClose()}
        data-testid="mission-manager-overlay"
        role="dialog"
        aria-modal="true"
      >
        {manager}
      </div>
      {interviewModal}
      {milestoneSliceInterviewModal}
    </>
  );
}
