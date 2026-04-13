import { useState, useEffect, useCallback, useRef } from "react";
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
  AlertCircle,
} from "lucide-react";
import type { ToastType } from "../hooks/useToast";
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
  MilestoneWithSlices,
  SliceWithFeatures,
  MissionHealth,
  MissionEvent,
  MissionEventType,
  FeatureLoopState,
  MissionAssertionStatus,
  MissionContractAssertion,
  ContractAssertionCreateInput,
  ContractAssertionUpdateInput,
  MilestoneValidationRollup,
  MissionFeatureLoopSnapshot,
  MissionValidatorRun,
} from "./mission-types";
import {
  fetchMissions,
  createMission,
  fetchMission,
  updateMission,
  deleteMission,
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
  fetchMissionHealth,
  fetchMissionsHealth,
  fetchMissionEvents,
  fetchAssertions,
  createAssertion,
  updateAssertion,
  deleteAssertion,
  reorderAssertions,
  linkFeatureToAssertion,
  unlinkFeatureFromAssertion,
  fetchAssertionsForFeature,
  fetchFeaturesForAssertion,
  fetchMilestoneValidation,
  triggerValidation,
  fetchValidationLoopState,
  fetchValidationRuns,
  fetchValidationRun,
  fetchAssertion,
  fetchAiSessions,
  fetchAiSession,
  type AiSessionSummary,
} from "../api";
import type { AutopilotStatus as AutopilotStatusType, AutopilotState } from "./mission-types";

interface MissionManagerProps {
  isOpen: boolean;
  isInline?: boolean;
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  onSelectTask?: (taskId: string) => void;
  availableTasks?: Array<{ id: string; title?: string }>;
  resumeSessionId?: string;
  /** Pre-select and load this mission when the modal opens */
  targetMissionId?: string;
  /** Resume session ID for milestone/slice interview sessions */
  milestoneSliceResumeSessionId?: string;
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
};

const autopilotStateColors: Record<AutopilotState, { bg: string; text: string }> = {
  inactive: { bg: "var(--autopilot-inactive-bg)", text: "var(--autopilot-inactive-text)" },
  watching: { bg: "var(--autopilot-watching-bg)", text: "var(--autopilot-watching-text)" },
  activating: { bg: "var(--autopilot-activating-bg)", text: "var(--autopilot-activating-text)" },
  completing: { bg: "var(--autopilot-completing-bg)", text: "var(--autopilot-completing-text)" },
};

/** Loop state colors for feature execution loop */
const loopStateColors: Record<FeatureLoopState, { bg: string; text: string; indicator: string }> = {
  idle: { bg: "var(--loop-idle-bg)", text: "var(--loop-idle-text)", indicator: "var(--loop-idle-indicator)" },
  implementing: { bg: "var(--loop-implementing-bg)", text: "var(--loop-implementing-text)", indicator: "var(--loop-implementing-indicator)" },
  validating: { bg: "var(--loop-validating-bg)", text: "var(--loop-validating-text)", indicator: "var(--loop-validating-indicator)" },
  needs_fix: { bg: "var(--loop-needs-fix-bg)", text: "var(--loop-needs-fix-text)", indicator: "var(--loop-needs-fix-indicator)" },
  passed: { bg: "var(--loop-passed-bg)", text: "var(--loop-passed-text)", indicator: "var(--loop-passed-indicator)" },
  blocked: { bg: "var(--loop-blocked-bg)", text: "var(--loop-blocked-text)", indicator: "var(--loop-blocked-indicator)" },
};

/** Assertion status colors */
const assertionStatusColors: Record<MissionAssertionStatus, { bg: string; text: string }> = {
  pending: { bg: "var(--assertion-pending-bg)", text: "var(--assertion-pending-text)" },
  passed: { bg: "var(--assertion-passed-bg)", text: "var(--assertion-passed-text)" },
  failed: { bg: "var(--assertion-failed-bg)", text: "var(--assertion-failed-text)" },
  blocked: { bg: "var(--assertion-blocked-bg)", text: "var(--assertion-blocked-text)" },
};

/** Get the plan state for a milestone (derived from interviewState) */
function getMilestonePlanState(interviewState?: string): "not_started" | "planned" | "needs_update" {
  if (interviewState === "completed") return "planned";
  if (interviewState === "needs_update") return "needs_update";
  return "not_started";
}

/** Render a plan state indicator badge */
function PlanStateIndicator({ state }: { state: "not_started" | "planned" | "needs_update" }) {
  const stateClass =
    state === "planned"
      ? "mission-plan-state-indicator--planned"
      : state === "needs_update"
        ? "mission-plan-state-indicator--needs-update"
        : "mission-plan-state-indicator--not-started";

  const title =
    state === "planned"
      ? "Planned"
      : state === "needs_update"
        ? "Needs update"
        : "Not planned";

  return (
    <span
      className={`mission-plan-state-indicator ${stateClass}`}
      title={title}
      aria-label={title}
    />
  );
}

// Form types
interface MissionFormData {
  title: string;
  description: string;
  status: MissionStatus;
  autopilotEnabled: boolean;
}

interface MilestoneFormData {
  title: string;
  description: string;
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
};

const EMPTY_MILESTONE_FORM: MilestoneFormData = {
  title: "",
  description: "",
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

type MissionHealthState = "healthy" | "warning" | "error";

const HOUR_MS = 60 * 60 * 1000;

function getRelativeTime(timestamp?: string): string {
  if (!timestamp) return "—";

  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return "—";

  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";

  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
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

function getAutopilotActivitySummary(state: AutopilotState, lastActivityAt?: string): string | null {
  if (!lastActivityAt) {
    return null;
  }

  if (state === "watching") {
    return `Watching since ${getRelativeTime(lastActivityAt)}`;
  }

  return `Last activation ${getRelativeTime(lastActivityAt)}`;
}

export function MissionManager({ isOpen, isInline = false, onClose, addToast, projectId, onSelectTask, availableTasks = [], resumeSessionId, targetMissionId, milestoneSliceResumeSessionId }: MissionManagerProps) {
  const isActive = isInline || isOpen;
  const [missions, setMissions] = useState<MissionWithSummary[]>([]);
  const [selectedMission, setSelectedMission] = useState<MissionWithHierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

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

  // AI Interview modal
  const [showInterviewModal, setShowInterviewModal] = useState(false);

  // Pending mission interview sessions (for resume prompt after page reload)
  const [pendingInterviewSessions, setPendingInterviewSessions] = useState<AiSessionSummary[]>([]);
  const [localResumeSessionId, setLocalResumeSessionId] = useState<string | undefined>(undefined);
  const effectiveResumeSessionId = localResumeSessionId ?? resumeSessionId;

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
      setShowInterviewModal(true);
    }
  }, [isActive, effectiveResumeSessionId]);

  // Detect pending mission interview sessions for resume prompt
  useEffect(() => {
    if (!isActive || effectiveResumeSessionId) return;
    let cancelled = false;
    fetchAiSessions(projectId).then((sessions) => {
      if (cancelled) return;
      const pending = sessions.filter(
        (s) => s.type === "mission_interview" && (s.status === "awaiting_input" || s.status === "error"),
      );
      setPendingInterviewSessions(pending);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isActive, projectId, effectiveResumeSessionId]);

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
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isActive, milestoneSliceResumeSessionId]);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<{ type: string; id: string } | null>(null);

  // Assertion panel state
  const [assertionsByMilestone, setAssertionsByMilestone] = useState<Map<string, MissionContractAssertion[]>>(new Map());
  const [assertionsLoading, setAssertionsLoading] = useState(false);
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
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsFilter, setEventsFilter] = useState<
    "all" | "errors" | "state_changes" | "tasks" | "slices" | "autopilot"
  >("all");
  const [expandedEventMetadata, setExpandedEventMetadata] = useState<Set<string>>(new Set());

  const activityEventsContainerRef = useRef<HTMLDivElement>(null);
  const activityEventsEndRef = useRef<HTMLDivElement>(null);

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
      setLoading(true);
      const data = await fetchMissions(projectId);
      setMissions(data);
      void loadMissionHealth(data);
    } catch (err: any) {
      addToast(err.message || "Failed to load missions", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, projectId, loadMissionHealth]);

  const loadMissionDetail = useCallback(async (missionId: string) => {
    try {
      setDetailLoading(true);
      const data = await fetchMission(missionId, projectId);
      setSelectedMission(data);
      // Auto-expand first milestone and slice
      if (data.milestones.length > 0) {
        const firstMilestoneId = data.milestones[0].id;
        setExpandedMilestones(new Set([firstMilestoneId]));
        // Load assertions and validation rollup for the first milestone (inline to avoid forward ref)
        fetchAssertions(firstMilestoneId, projectId).then((assertions) => {
          setAssertionsByMilestone((prev) => {
            const next = new Map(prev);
            next.set(firstMilestoneId, assertions);
            return next;
          });
        }).catch(() => { /* silently fail */ });
        fetchMilestoneValidation(firstMilestoneId, projectId).then((rollup) => {
          setValidationRollupByMilestone((prev) => {
            const next = new Map(prev);
            next.set(firstMilestoneId, rollup);
            return next;
          });
        }).catch(() => { /* silently fail */ });
        if (data.milestones[0].slices.length > 0) {
          setExpandedSlices(new Set([data.milestones[0].slices[0].id]));
        }
      }
    } catch (err: any) {
      addToast(err.message || "Failed to load mission details", "error");
    } finally {
      setDetailLoading(false);
    }
  }, [addToast, projectId]);

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
          return incomingEvents;
        }

        const existing = new Set(prev.map((event) => event.id));
        const merged = [...prev];
        for (const event of incomingEvents) {
          if (!existing.has(event.id)) {
            merged.push(event);
          }
        }
        return merged;
      });

      setEventsTotal(response.total);

      if (!append) {
        requestAnimationFrame(() => {
          scrollActivityToLatest("auto");
        });
      }
    } catch (err: any) {
      addToast(err.message || "Failed to load mission activity", "error");
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
    if (isActive) {
      loadMissions();
      setSelectedMission(null);
      setMissionEvents([]);
      setEventsTotal(0);
      setActiveTab("structure");
      setEventsFilter("all");
      setExpandedEventMetadata(new Set());
    }
  }, [isActive, loadMissions]);

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
    if (!isActive || missions.length === 0 || typeof EventSource === "undefined") {
      return;
    }

    const search = new URLSearchParams();
    if (projectId) {
      search.set("projectId", projectId);
    }
    const eventUrl = `/api/events${search.size > 0 ? `?${search.toString()}` : ""}`;
    const eventSource = new EventSource(eventUrl);

    const refreshHealth = () => {
      void loadMissionHealth(missions);
    };

    const handleMissionUpdated = (rawEvent: Event) => {
      refreshHealth();
      // Reload the selected mission detail to reflect updated mission state (autopilot, status, etc.)
      if (selectedMission) {
        void loadMissionDetail(selectedMission.id);
      }
    };

    const handleSliceUpdated = (rawEvent: Event) => {
      refreshHealth();
      // Reload the selected mission detail to reflect updated slice status
      if (selectedMission) {
        void loadMissionDetail(selectedMission.id);
      }
    };

    const handleFeatureUpdated = () => {
      refreshHealth();
      // Reload the selected mission detail to reflect updated feature status
      if (selectedMission) {
        void loadMissionDetail(selectedMission.id);
      }
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
        }
      } catch {
        // ignore invalid payloads
      }
    };

    // Handler for validator run completed - refresh feature loop state, runs, and mission detail
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
          // Refresh mission detail to update feature status
          if (selectedMission) {
            void loadMissionDetail(selectedMission.id);
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
          // Refresh mission detail to show the new fix feature in the list
          if (selectedMission) {
            void loadMissionDetail(selectedMission.id);
          }
        }
      } catch {
        // ignore invalid payloads
      }
    };

    const handleMissionEvent = (rawEvent: Event) => {
      refreshHealth();

      if (!selectedMission || activeTab !== "activity") {
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
        if (payload.missionId !== selectedMission.id) {
          return;
        }
        if (!matchesEventFilter(payload.eventType, eventsFilter)) {
          return;
        }

        setMissionEvents((prev) => {
          const withoutExisting = prev.filter((event) => event.id !== payload.id);
          return [payload, ...withoutExisting].slice(0, 100);
        });
        setEventsTotal((prev) => prev + 1);

        if (shouldAutoScroll) {
          requestAnimationFrame(() => {
            const container = activityEventsContainerRef.current;
            if (container) {
              container.scrollTop = 0;
            }
          });
        }
      } catch {
        // ignore invalid payloads
      }
    };

    eventSource.addEventListener("mission:updated", handleMissionUpdated);
    eventSource.addEventListener("slice:updated", handleSliceUpdated);
    eventSource.addEventListener("feature:updated", handleFeatureUpdated);
    eventSource.addEventListener("mission:event", handleMissionEvent);
    // Validation events
    eventSource.addEventListener("validator-run:started", handleValidatorRunStarted);
    eventSource.addEventListener("validator-run:completed", handleValidatorRunCompleted);
    eventSource.addEventListener("milestone:validation:updated", handleMilestoneValidationUpdated);
    eventSource.addEventListener("assertion:created", handleAssertionMutation);
    eventSource.addEventListener("assertion:updated", handleAssertionMutation);
    eventSource.addEventListener("assertion:deleted", handleAssertionMutation);
    eventSource.addEventListener("assertion:linked", handleAssertionMutation);
    eventSource.addEventListener("assertion:unlinked", handleAssertionMutation);
    eventSource.addEventListener("fix-feature:created", handleFixFeatureCreated);

    return () => {
      eventSource.removeEventListener("mission:updated", handleMissionUpdated);
      eventSource.removeEventListener("slice:updated", handleSliceUpdated);
      eventSource.removeEventListener("feature:updated", handleFeatureUpdated);
      eventSource.removeEventListener("mission:event", handleMissionEvent);
      eventSource.removeEventListener("validator-run:started", handleValidatorRunStarted);
      eventSource.removeEventListener("validator-run:completed", handleValidatorRunCompleted);
      eventSource.removeEventListener("milestone:validation:updated", handleMilestoneValidationUpdated);
      eventSource.removeEventListener("assertion:created", handleAssertionMutation);
      eventSource.removeEventListener("assertion:updated", handleAssertionMutation);
      eventSource.removeEventListener("assertion:deleted", handleAssertionMutation);
      eventSource.removeEventListener("assertion:linked", handleAssertionMutation);
      eventSource.removeEventListener("assertion:unlinked", handleAssertionMutation);
      eventSource.removeEventListener("fix-feature:created", handleFixFeatureCreated);
      eventSource.close();
    };
  }, [
    activeTab,
    eventsFilter,
    isActive,
    isActivityScrolledNearBottom,
    loadMissionDetail,
    loadMissionHealth,
    missions,
    projectId,
    scrollActivityToLatest,
    selectedMission,
  ]);

  // Mission handlers
  const handleCreateMission = useCallback(() => {
    setIsCreatingMission(true);
    setEditingMissionId(null);
    setMissionForm(EMPTY_MISSION_FORM);
  }, []);

  const handleEditMission = useCallback((mission: Mission) => {
    setEditingMissionId(mission.id);
    setIsCreatingMission(false);
    setMissionForm({
      title: mission.title,
      description: mission.description || "",
      status: mission.status,
      autopilotEnabled: mission.autopilotEnabled ?? false,
    });
  }, []);

  const handleCancelMission = useCallback(() => {
    setEditingMissionId(null);
    setIsCreatingMission(false);
    setMissionForm(EMPTY_MISSION_FORM);
  }, []);

  const handleSaveMission = useCallback(async () => {
    if (!missionForm.title.trim()) {
      addToast("Mission title is required", "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingMission) {
        await createMission({
          title: missionForm.title.trim(),
          description: missionForm.description.trim() || undefined,
          autopilotEnabled: missionForm.autopilotEnabled,
        }, projectId);
        addToast("Mission created", "success");
      } else if (editingMissionId) {
        // Build update payload - when autopilot is enabled, also set autoAdvance
        // for backward compat with the engine (though engine no longer reads it)
        const updates: Record<string, unknown> = {
          title: missionForm.title.trim(),
          description: missionForm.description.trim() || undefined,
          status: missionForm.status,
          autopilotEnabled: missionForm.autopilotEnabled,
        };
        if (missionForm.autopilotEnabled) {
          updates.autoAdvance = true;
        }
        await updateMission(editingMissionId, updates as Parameters<typeof updateMission>[1], projectId);
        addToast("Mission updated", "success");
        // Refresh detail view if viewing this mission
        if (selectedMission?.id === editingMissionId) {
          await loadMissionDetail(editingMissionId);
        }
      }
      await loadMissions();
      handleCancelMission();
    } catch (err: any) {
      addToast(err.message || "Failed to save mission", "error");
    } finally {
      setSaving(false);
    }
  }, [missionForm, isCreatingMission, editingMissionId, addToast, loadMissions, loadMissionDetail, selectedMission, handleCancelMission, projectId]);

  const handleDeleteMission = useCallback(async (missionId: string) => {
    try {
      await deleteMission(missionId, projectId);
      addToast("Mission deleted", "success");
      if (selectedMission?.id === missionId) {
        setSelectedMission(null);
      }
      await loadMissions();
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete mission", "error");
    }
  }, [addToast, loadMissions, selectedMission, projectId]);

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
      addToast("Milestone title is required", "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingMilestone && selectedMission) {
        await createMilestone(selectedMission.id, {
          title: milestoneForm.title.trim(),
          description: milestoneForm.description.trim() || undefined,
          dependencies: milestoneForm.dependencies,
        }, projectId);
        addToast("Milestone created", "success");
      } else if (editingMilestoneId) {
        await updateMilestone(editingMilestoneId, {
          title: milestoneForm.title.trim(),
          description: milestoneForm.description.trim() || undefined,
          status: milestoneForm.status,
          dependencies: milestoneForm.dependencies,
        }, projectId);
        addToast("Milestone updated", "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelMilestone();
    } catch (err: any) {
      addToast(err.message || "Failed to save milestone", "error");
    } finally {
      setSaving(false);
    }
  }, [milestoneForm, isCreatingMilestone, editingMilestoneId, selectedMission, addToast, loadMissionDetail, handleCancelMilestone, missionForm.title, projectId]);

  const handleDeleteMilestone = useCallback(async (milestoneId: string) => {
    try {
      await deleteMilestone(milestoneId, projectId);
      addToast("Milestone deleted", "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete milestone", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const toggleMilestoneExpanded = useCallback((milestoneId: string) => {
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      const isExpanding = !next.has(milestoneId);
      if (isExpanding) {
        next.add(milestoneId);
        // Load assertions and validation rollup when expanding milestone
        fetchAssertions(milestoneId, projectId).then((assertions) => {
          setAssertionsByMilestone((prev) => {
            const next = new Map(prev);
            next.set(milestoneId, assertions);
            return next;
          });
        }).catch(() => { /* silently fail */ });
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
  }, [projectId]);

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
      addToast("Slice title is required", "error");
      return;
    }

    try {
      setSaving(true);
      if (isCreatingSlice && selectedMilestoneIdForNewSlice) {
        await createSlice(selectedMilestoneIdForNewSlice, {
          title: sliceForm.title.trim(),
          description: sliceForm.description.trim() || undefined,
        }, projectId);
        addToast("Slice created", "success");
      } else if (editingSliceId) {
        await updateSlice(editingSliceId, {
          title: sliceForm.title.trim(),
          description: sliceForm.description.trim() || undefined,
          status: sliceForm.status,
        }, projectId);
        addToast("Slice updated", "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelSlice();
    } catch (err: any) {
      addToast(err.message || "Failed to save slice", "error");
    } finally {
      setSaving(false);
    }
  }, [sliceForm, isCreatingSlice, editingSliceId, selectedMilestoneIdForNewSlice, selectedMission, addToast, loadMissionDetail, handleCancelSlice, projectId]);

  const handleDeleteSlice = useCallback(async (sliceId: string) => {
    try {
      await deleteSlice(sliceId, projectId);
      addToast("Slice deleted", "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete slice", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const handleActivateSlice = useCallback(async (sliceId: string) => {
    try {
      await activateSlice(sliceId, projectId);
      addToast("Slice activated", "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err: any) {
      addToast(err.message || "Failed to activate slice", "error");
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
      addToast("Feature title is required", "error");
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
        addToast("Feature created", "success");
      } else if (editingFeatureId) {
        await updateFeature(editingFeatureId, {
          title: featureForm.title.trim(),
          description: featureForm.description.trim() || undefined,
          acceptanceCriteria: featureForm.acceptanceCriteria.trim() || undefined,
          status: featureForm.status,
        }, projectId);
        addToast("Feature updated", "success");
      }
      await loadMissionDetail(selectedMission!.id);
      handleCancelFeature();
    } catch (err: any) {
      addToast(err.message || "Failed to save feature", "error");
    } finally {
      setSaving(false);
    }
  }, [featureForm, isCreatingFeature, editingFeatureId, selectedSliceIdForNewFeature, selectedMission, addToast, loadMissionDetail, handleCancelFeature, projectId]);

  const handleDeleteFeature = useCallback(async (featureId: string) => {
    try {
      await deleteFeature(featureId, projectId);
      addToast("Feature deleted", "success");
      await loadMissionDetail(selectedMission!.id);
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete feature", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  const handleLinkTask = useCallback(async () => {
    if (!linkTaskFeatureId || !selectedTaskId.trim()) {
      addToast("Task ID is required", "error");
      return;
    }

    try {
      await linkFeatureToTask(linkTaskFeatureId, selectedTaskId.trim(), projectId);
      addToast("Feature linked to task", "success");
      await loadMissionDetail(selectedMission!.id);
      setLinkTaskFeatureId(null);
      setSelectedTaskId("");
    } catch (err: any) {
      addToast(err.message || "Failed to link feature to task", "error");
    }
  }, [linkTaskFeatureId, selectedTaskId, addToast, loadMissionDetail, selectedMission, projectId]);

  const handleUnlinkTask = useCallback(async (featureId: string) => {
    try {
      await unlinkFeatureFromTask(featureId, projectId);
      addToast("Feature unlinked from task", "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err: any) {
      addToast(err.message || "Failed to unlink feature", "error");
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  // Triage a single feature — creates a task and links it
  const handleTriageFeature = useCallback(async (featureId: string) => {
    try {
      setSaving(true);
      await triageFeature(featureId, undefined, undefined, projectId);
      addToast("Feature triaged — task created", "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err: any) {
      addToast(err.message || "Failed to triage feature", "error");
    } finally {
      setSaving(false);
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

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
      const result = await triageAllSliceFeatures(sliceId, projectId);
      addToast(`Triaged ${result.count} feature${result.count !== 1 ? "s" : ""}`, "success");
      await loadMissionDetail(selectedMission!.id);
    } catch (err: any) {
      addToast(err.message || "Failed to triage slice features", "error");
    } finally {
      setSaving(false);
    }
  }, [addToast, loadMissionDetail, selectedMission, projectId]);

  // ── Assertion handlers ──

  const loadAssertionsForMilestone = useCallback(async (milestoneId: string) => {
    try {
      const assertions = await fetchAssertions(milestoneId, projectId);
      setAssertionsByMilestone((prev) => {
        const next = new Map(prev);
        next.set(milestoneId, assertions);
        return next;
      });
    } catch (err: any) {
      // Silently fail - assertions are optional
    }
  }, [projectId]);

  const loadValidationRollup = useCallback(async (milestoneId: string) => {
    try {
      const rollup = await fetchMilestoneValidation(milestoneId, projectId);
      setValidationRollupByMilestone((prev) => {
        const next = new Map(prev);
        next.set(milestoneId, rollup);
        return next;
      });
    } catch (err: any) {
      // Silently fail
    }
  }, [projectId]);

  const handleCreateAssertion = useCallback(async (milestoneId: string) => {
    if (!assertionForm.title.trim() || !assertionForm.assertion.trim()) {
      addToast("Title and assertion text are required", "error");
      return;
    }
    try {
      setSaving(true);
      await createAssertion(milestoneId, {
        title: assertionForm.title.trim(),
        assertion: assertionForm.assertion.trim(),
        status: assertionForm.status,
      }, projectId);
      addToast("Assertion created", "success");
      await loadAssertionsForMilestone(milestoneId);
      await loadValidationRollup(milestoneId);
      setIsCreatingAssertion(false);
      setAssertionForm({ title: "", assertion: "", status: "pending" });
    } catch (err: any) {
      addToast(err.message || "Failed to create assertion", "error");
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
      addToast("Title and assertion text are required", "error");
      return;
    }
    try {
      setSaving(true);
      await updateAssertion(assertionId, {
        title: assertionForm.title.trim(),
        assertion: assertionForm.assertion.trim(),
        status: assertionForm.status,
      }, projectId);
      addToast("Assertion updated", "success");
      await loadAssertionsForMilestone(milestoneId);
      await loadValidationRollup(milestoneId);
      handleCancelAssertion();
    } catch (err: any) {
      addToast(err.message || "Failed to update assertion", "error");
    } finally {
      setSaving(false);
    }
  }, [assertionForm, addToast, loadAssertionsForMilestone, loadValidationRollup, handleCancelAssertion, projectId]);

  const handleDeleteAssertion = useCallback(async (assertionId: string, milestoneId: string) => {
    try {
      await deleteAssertion(assertionId, projectId);
      addToast("Assertion deleted", "success");
      await loadAssertionsForMilestone(milestoneId);
      await loadValidationRollup(milestoneId);
      setDeleteConfirmId(null);
    } catch (err: any) {
      addToast(err.message || "Failed to delete assertion", "error");
    }
  }, [addToast, loadAssertionsForMilestone, loadValidationRollup, projectId]);

  const loadLinkedFeaturesForAssertion = useCallback(async (assertionId: string) => {
    try {
      const features = await fetchFeaturesForAssertion(assertionId, projectId);
      setLinkedFeaturesByAssertion((prev) => {
        const next = new Map(prev);
        next.set(assertionId, features);
        return next;
      });
    } catch (err: any) {
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

  const handleLinkFeatureToAssertion = useCallback(async (featureId: string, assertionId: string) => {
    try {
      setLinkingAssertions((prev) => new Set(prev).add(assertionId));
      await linkFeatureToAssertion(featureId, assertionId, projectId);
      addToast("Feature linked to assertion", "success");
      await loadLinkedFeaturesForAssertion(assertionId);
      setFeaturePickerOpenForAssertion(null);
    } catch (err: any) {
      addToast(err.message || "Failed to link feature", "error");
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
      addToast("Feature unlinked from assertion", "success");
      await loadLinkedFeaturesForAssertion(assertionId);
    } catch (err: any) {
      addToast(err.message || "Failed to unlink feature", "error");
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
      addToast("Validation triggered", "success");
      // Reload feature loop state
      const snapshot = await fetchValidationLoopState(featureId, projectId);
      setFeatureLoopStates((prev) => {
        const next = new Map(prev);
        next.set(featureId, snapshot);
        return next;
      });
    } catch (err: any) {
      addToast(err.message || "Failed to trigger validation", "error");
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
    } catch (err: any) {
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
    } catch (err: any) {
      // Silently fail
    }
  }, [projectId]);

  // Load run detail with failures
  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      const detail = await fetchValidationRun(runId, projectId);
      setRunDetailsByRunId((prev) => {
        const next = new Map(prev);
        next.set(runId, detail);
        return next;
      });
    } catch (err: any) {
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
      addToast("Mission resumed", "success");
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err: any) {
      addToast(err.message || "Failed to resume mission", "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  // Stop mission — set status to "blocked" and pause all linked tasks
  const handleStopMission = useCallback(async (missionId: string) => {
    try {
      const result = await stopMission(missionId, projectId);
      const count = result.pausedTaskIds?.length ?? 0;
      addToast(`Mission stopped (${count} task${count !== 1 ? "s" : ""} paused)`, "success");
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err: any) {
      addToast(err.message || "Failed to stop mission", "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  // Start a planning mission — set status to "active" and activate first slice
  const handleStartMission = useCallback(async (missionId: string) => {
    try {
      await startMission(missionId, projectId);
      addToast("Mission started — first slice activated", "success");
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err: any) {
      addToast(err.message || "Failed to start mission", "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  // ── Autopilot handlers ──

  const handleToggleAutopilot = useCallback(async (missionId: string, enabled: boolean) => {
    try {
      await updateMissionAutopilot(missionId, { enabled }, projectId);
      addToast(enabled ? "Autopilot enabled" : "Autopilot disabled", "success");
      // Reload mission detail to reflect updated fields
      await loadMissionDetail(missionId);
      loadMissions();
    } catch (err: any) {
      addToast(err.message || "Failed to update autopilot", "error");
    }
  }, [addToast, loadMissionDetail, loadMissions, projectId]);

  const handleSelectMission = useCallback((mission: Mission) => {
    setActiveTab("structure");
    setMissionEvents([]);
    setEventsTotal(0);
    setEventsFilter("all");
    setExpandedEventMetadata(new Set());
    loadMissionDetail(mission.id);
  }, [loadMissionDetail]);

  const handleBackToList = useCallback(() => {
    setSelectedMission(null);
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
  );

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

  const manager = (
    <div
      ref={modalRef}
      className={`mission-manager${isInline ? " mission-manager--inline" : ""}`}
      role={isInline ? undefined : "dialog"}
      aria-modal={isInline ? undefined : true}
      aria-label={isInline ? undefined : "Mission Manager"}
      data-testid="mission-manager-dialog"
    >
        {/* ── Header ── */}
        <div className={`mission-manager__header${isInline ? " mission-manager__header--inline" : ""}`}>
          <div className="mission-manager__header-title">
            {selectedMission ? (
              <button
                className="mission-manager__back-btn"
                onClick={handleBackToList}
                title="Back to missions"
                aria-label="Back to missions list"
                data-testid="mission-back-btn"
              >
                <ChevronLeft size={18} />
              </button>
            ) : null}
            <Target size={18} className="mission-manager__header-icon" />
            <h2 className="mission-manager__title">
              {selectedMission ? selectedMission.title : "Missions"}
            </h2>
          </div>
          {!isInline && (
            /* Modal mode: show close button */
            <button
              className="modal-close"
              onClick={onClose}
              title="Close"
              aria-label="Close Mission Manager"
              data-testid="mission-close-btn"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* ── Body ── */}
        <div className="mission-manager__body">
          {loading ? (
            <div className="mission-manager__loading">
              <Loader2 size={24} className="spinner" />
              <span>Loading missions...</span>
            </div>
          ) : detailLoading ? (
            <div className="mission-manager__loading">
              <Loader2 size={24} className="spinner" />
              <span>Loading mission details...</span>
            </div>
          ) : selectedMission ? (
            /* ── Detail View ── */
            <div className="mission-detail">
              <div className="mission-detail__header">
                <div className="mission-detail__title-row">
                  <div className="mission-detail__title-text">
                    {autopilotPulseActive && (
                      <span className="mission-detail__autopilot-dot" title="Autopilot watching" />
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
                  <p className="mission-detail__description">{selectedMission.description}</p>
                )}
                <div className="mission-detail__meta">
                  <span className="mission-detail__meta-info">
                    {selectedMission.milestones.length} milestones
                  </span>
                </div>

                {/* ── Autopilot section ── */}
                <div className="mission-detail__autopilot">
                  <div className="mission-detail__autopilot-toggle">
                    <label className="mission-toggle" data-testid="mission-autopilot-toggle">
                      <input
                        type="checkbox"
                        checked={selectedMission.autopilotEnabled ?? false}
                        onChange={(e) => handleToggleAutopilot(selectedMission.id, e.target.checked)}
                        aria-label="Autopilot"
                      />
                      <span className="mission-toggle__track" aria-hidden="true">
                        <span className="mission-toggle__thumb" />
                      </span>
                      <span className="mission-toggle__label">
                        <Zap size={14} className="mission-detail__autopilot-icon" />
                        Autopilot
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
                      {autopilotState}
                    </span>
                  </div>
                  {autopilotActivitySummary && (
                    <span className="mission-detail__autopilot-activity mission-relative-time">
                      {autopilotActivitySummary}
                    </span>
                  )}
                </div>

                <div className="mission-detail__actions">
                  {selectedMission.status === "active" && (
                    <button
                      className="mission-icon-btn mission-icon-btn--danger"
                      onClick={() => handleStopMission(selectedMission.id)}
                      title="Stop mission"
                      aria-label="Stop mission"
                    >
                      <Square size={14} />
                    </button>
                  )}
                  {selectedMission.status === "blocked" && (
                    <button
                      className="mission-icon-btn mission-icon-btn--success"
                      onClick={() => handleResumeMission(selectedMission.id)}
                      title="Resume mission"
                      aria-label="Resume mission"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  {selectedMission.status === "planning" && (
                    <button
                      className="mission-icon-btn mission-icon-btn--success"
                      onClick={() => handleStartMission(selectedMission.id)}
                      title="Start mission"
                      aria-label="Start mission"
                    >
                      <Play size={14} />
                    </button>
                  )}
                  <button
                    className="mission-icon-btn"
                    onClick={() => handleEditMission(selectedMission)}
                    title="Edit mission"
                    aria-label="Edit mission"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="mission-icon-btn mission-icon-btn--danger"
                    onClick={() => setDeleteConfirmId({ type: "mission", id: selectedMission.id })}
                    title="Delete mission"
                    aria-label="Delete mission"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Inline edit mission form (detail view) */}
              {editingMissionId === selectedMission.id && (
                <div className="mission-form-card">
                  <input
                    type="text"
                    placeholder="Mission title"
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <div className="mission-form-card__row">
                    <select
                      value={missionForm.status}
                      onChange={(e) => setMissionForm({ ...missionForm, status: e.target.value as MissionStatus })}
                    >
                      <option value="planning">Planning</option>
                      <option value="active">Active</option>
                      <option value="blocked">Blocked</option>
                      <option value="complete">Complete</option>
                      <option value="archived">Archived</option>
                    </select>
                    <label className="mission-checkbox">
                      <input
                        type="checkbox"
                        checked={missionForm.autopilotEnabled}
                        onChange={(e) => setMissionForm({ ...missionForm, autopilotEnabled: e.target.checked })}
                      />
                      <Zap size={12} /> Autopilot
                    </label>
                  </div>
                  <div className="mission-form-card__actions">
                    <button className="mission-btn mission-btn--primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      Update
                    </button>
                    <button className="mission-btn mission-btn--ghost" onClick={handleCancelMission}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="mission-detail__tabs" role="tablist" aria-label="Mission detail tabs">
                <button
                  className={`mission-btn ${activeTab === "structure" ? "mission-btn--primary" : "mission-btn--ghost"} mission-btn--sm mission-detail__tab`}
                  onClick={() => setActiveTab("structure")}
                  role="tab"
                  aria-selected={activeTab === "structure"}
                  data-testid="mission-tab-structure"
                >
                  Structure
                </button>
                <button
                  className={`mission-btn ${activeTab === "activity" ? "mission-btn--primary" : "mission-btn--ghost"} mission-btn--sm mission-detail__tab`}
                  onClick={() => setActiveTab("activity")}
                  role="tab"
                  aria-selected={activeTab === "activity"}
                  data-testid="mission-tab-activity"
                >
                  Activity ({eventsTotal})
                </button>
              </div>

              {activeTab === "structure" ? (
                <div className="mission-detail__milestones">
                {selectedMission.milestones.map((milestone) => (
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
                      <span className="mission-milestone__count">{milestone.slices.length} slices</span>
                      <PlanStateIndicator state={getMilestonePlanState(milestone.interviewState)} />
                      {/* Validation state badge and coverage bar in milestone header */}
                      {validationRollupByMilestone.get(milestone.id) && (
                        <>
                          <span
                            className="mission-status-badge mission-status-badge--sm"
                            style={{
                              backgroundColor: validationRollupByMilestone.get(milestone.id)?.state === "passed"
                                ? "var(--loop-passed-bg)"
                                : validationRollupByMilestone.get(milestone.id)?.state === "failed"
                                  ? "var(--loop-blocked-bg)"
                                  : validationRollupByMilestone.get(milestone.id)?.state === "blocked"
                                    ? "var(--loop-blocked-bg)"
                                    : "var(--assertion-pending-bg)",
                              color: validationRollupByMilestone.get(milestone.id)?.state === "passed"
                                ? "var(--loop-passed-text)"
                                : validationRollupByMilestone.get(milestone.id)?.state === "failed"
                                  ? "var(--loop-blocked-text)"
                                  : validationRollupByMilestone.get(milestone.id)?.state === "blocked"
                                    ? "var(--loop-blocked-text)"
                                    : "var(--assertion-pending-text)",
                            }}
                            title="Validation state"
                          >
                            {validationRollupByMilestone.get(milestone.id)?.state || "not_started"}
                          </span>
                          {validationRollupByMilestone.get(milestone.id)!.totalAssertions > 0 && (
                            <div
                              className="mission-milestone__coverage-bar"
                              title={`${(validationRollupByMilestone.get(milestone.id)!.passedAssertions ?? 0)} of ${validationRollupByMilestone.get(milestone.id)!.totalAssertions} assertions passing`}
                            >
                              <div
                                className="mission-milestone__coverage-bar-fill"
                                style={{
                                  width: `${((validationRollupByMilestone.get(milestone.id)!.passedAssertions ?? 0) / validationRollupByMilestone.get(milestone.id)!.totalAssertions) * 100}%`,
                                  backgroundColor: (validationRollupByMilestone.get(milestone.id)!.passedAssertions ?? 0) === validationRollupByMilestone.get(milestone.id)!.totalAssertions
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
                          title="Plan milestone"
                          aria-label="Plan milestone"
                        >
                          <FileText size={14} />
                        </button>
                      )}
                      <div className="mission-milestone__actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="mission-icon-btn"
                          onClick={() => handleCreateSlice(milestone.id)}
                          title="Add slice"
                        >
                          <Plus size={14} />
                        </button>
                        <button
                          className="mission-icon-btn"
                          onClick={() => handleEditMilestone(milestone)}
                          title="Edit milestone"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="mission-icon-btn mission-icon-btn--danger"
                          onClick={() => setDeleteConfirmId({ type: "milestone", id: milestone.id })}
                          title="Delete milestone"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {expandedMilestones.has(milestone.id) && (
                      <div className="mission-milestone__body">
                        {/* Create milestone form (inline edit) */}
                        {(isCreatingMilestone || editingMilestoneId === milestone.id) && (
                          <div className="mission-form-card">
                            <input
                              type="text"
                              placeholder="Milestone title"
                              value={milestoneForm.title}
                              onChange={(e) => setMilestoneForm({ ...milestoneForm, title: e.target.value })}
                              onKeyDown={handleMilestoneFormKeyDown}
                              autoFocus
                            />
                            <textarea
                              placeholder="Description (optional)"
                              value={milestoneForm.description}
                              onChange={(e) => setMilestoneForm({ ...milestoneForm, description: e.target.value })}
                              rows={2}
                            />
                            <div className="mission-form-card__actions">
                              <button className="mission-btn mission-btn--primary" onClick={handleSaveMilestone} disabled={saving}>
                                {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                {editingMilestoneId ? "Update" : "Create"}
                              </button>
                              <button className="mission-btn mission-btn--ghost" onClick={handleCancelMilestone}>
                                Cancel
                              </button>
                            </div>
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
                                <span className="mission-slice__count">{slice.features?.length || 0} features</span>
                                <PlanStateIndicator state={slice.planState ?? "not_started"} />
                                {slice.status !== "complete" && (
                                  <button
                                    className="mission-icon-btn"
                                    onClick={() => setInterviewTarget({ type: "slice", id: slice.id, title: slice.title })}
                                    title="Plan slice"
                                    aria-label="Plan slice"
                                  >
                                    <FileText size={14} />
                                  </button>
                                )}
                                <div className="mission-slice__actions" onClick={(e) => e.stopPropagation()}>
                                  {slice.status === "pending" && (
                                    <button
                                      className="mission-icon-btn mission-icon-btn--success"
                                      onClick={() => handleActivateSlice(slice.id)}
                                      title="Activate slice"
                                    >
                                      <Play size={14} />
                                    </button>
                                  )}
                                  {slice.status === "active" && slice.features?.some((f) => f.status === "defined") && (
                                    <button
                                      className="mission-icon-btn"
                                      onClick={() => handleTriageAllSliceFeatures(slice.id)}
                                      title="Triage all features"
                                      disabled={saving}
                                    >
                                      {saving ? <Loader2 size={14} className="spinner" /> : <Zap size={14} />}
                                    </button>
                                  )}
                                  <button
                                    className="mission-icon-btn"
                                    onClick={() => handleCreateFeature(slice.id)}
                                    title="Add feature"
                                  >
                                    <Plus size={14} />
                                  </button>
                                  <button
                                    className="mission-icon-btn"
                                    onClick={() => handleEditSlice(slice)}
                                    title="Edit slice"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    className="mission-icon-btn mission-icon-btn--danger"
                                    onClick={() => setDeleteConfirmId({ type: "slice", id: slice.id })}
                                    title="Delete slice"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>

                              {expandedSlices.has(slice.id) && (
                                <div className="mission-slice__body">
                                  {/* Create slice form */}
                                  {(isCreatingSlice && selectedMilestoneIdForNewSlice === milestone.id && !editingSliceId) && (
                                    <div className="mission-form-card">
                                      <input
                                        type="text"
                                        placeholder="Slice title"
                                        value={sliceForm.title}
                                        onChange={(e) => setSliceForm({ ...sliceForm, title: e.target.value })}
                                        onKeyDown={handleSliceFormKeyDown}
                                        autoFocus
                                      />
                                      <textarea
                                        placeholder="Description (optional)"
                                        value={sliceForm.description}
                                        onChange={(e) => setSliceForm({ ...sliceForm, description: e.target.value })}
                                        rows={2}
                                      />
                                      <div className="mission-form-card__actions">
                                        <button className="mission-btn mission-btn--primary" onClick={handleSaveSlice} disabled={saving}>
                                          {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                          Create
                                        </button>
                                        <button className="mission-btn mission-btn--ghost" onClick={handleCancelSlice}>
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Edit slice form */}
                                  {editingSliceId === slice.id && (
                                    <div className="mission-form-card">
                                      <input
                                        type="text"
                                        placeholder="Slice title"
                                        value={sliceForm.title}
                                        onChange={(e) => setSliceForm({ ...sliceForm, title: e.target.value })}
                                        onKeyDown={handleSliceFormKeyDown}
                                        autoFocus
                                      />
                                      <textarea
                                        placeholder="Description (optional)"
                                        value={sliceForm.description}
                                        onChange={(e) => setSliceForm({ ...sliceForm, description: e.target.value })}
                                        rows={2}
                                      />
                                      <select
                                        value={sliceForm.status}
                                        onChange={(e) => setSliceForm({ ...sliceForm, status: e.target.value as SliceStatus })}
                                      >
                                        <option value="pending">Pending</option>
                                        <option value="active">Active</option>
                                        <option value="complete">Complete</option>
                                      </select>
                                      <div className="mission-form-card__actions">
                                        <button className="mission-btn mission-btn--primary" onClick={handleSaveSlice} disabled={saving}>
                                          {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                          Update
                                        </button>
                                        <button className="mission-btn mission-btn--ghost" onClick={handleCancelSlice}>
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* Features */}
                                  <div className="mission-features">
                                    {slice.features?.map((feature) => (
                                      <div key={feature.id} className="mission-feature">
                                        <div className="mission-feature__header">
                                          <button
                                            className="mission-feature__expand"
                                            onClick={() => toggleFeatureExpanded(feature.id)}
                                            title={expandedFeatureId === feature.id ? "Collapse details" : "Expand to show run history"}
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
                                              title={`Loop state: ${feature.loopState}`}
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
                                              onClick={() => {
                                                // Navigate to source feature: find its milestone/slice and expand to it
                                                // Find the source feature in the mission hierarchy
                                                for (const m of selectedMission?.milestones ?? []) {
                                                  for (const s of m.slices) {
                                                    const sourceFeature = s.features.find((f) => f.id === feature.generatedFromFeatureId);
                                                    if (sourceFeature) {
                                                      setExpandedMilestones((prev) => {
                                                        const next = new Set(prev);
                                                        next.add(m.id);
                                                        return next;
                                                      });
                                                      setExpandedSlices((prev) => {
                                                        const next = new Set(prev);
                                                        next.add(s.id);
                                                        return next;
                                                      });
                                                      setExpandedFeatureId(sourceFeature.id);
                                                      // Load loop state for source feature
                                                      void loadFeatureLoopState(sourceFeature.id);
                                                      void loadValidationRuns(sourceFeature.id);
                                                      return;
                                                    }
                                                  }
                                                }
                                              }}
                                              title={`Generated from feature: ${feature.generatedFromFeatureId}`}
                                            >
                                              🔗 Fix
                                            </button>
                                          )}
                                          {/* Retry budget display */}
                                          {feature.loopState && feature.loopState !== "idle" && featureLoopStates.get(feature.id) && (
                                            <span
                                              className="mission-feature__retry-budget"
                                              title="Implementation attempts remaining"
                                            >
                                              Attempt {featureLoopStates.get(feature.id)!.implementationAttemptCount} of {featureLoopStates.get(feature.id)!.implementationAttemptCount + featureLoopStates.get(feature.id)!.retryBudgetRemaining}
                                            </span>
                                          )}
                                          {/* Validation trigger button for implementing features */}
                                          {feature.loopState === "implementing" && (
                                            <button
                                              className="mission-icon-btn mission-icon-btn--validate"
                                              onClick={() => handleTriggerValidation(feature.id)}
                                              title="Validate feature"
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
                                              title="Click to view task"
                                            >
                                              {feature.taskId}
                                            </span>
                                          )}
                                          <div className="mission-feature__actions">
                                            {feature.status === "defined" && !feature.taskId && (
                                              <button
                                                className="mission-icon-btn"
                                                onClick={() => handleTriageFeatureWithPreview(feature.id)}
                                                title="Triage — create task"
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
                                                title="Unlink task"
                                              >
                                                <Unlink size={14} />
                                              </button>
                                            ) : feature.status !== "defined" ? (
                                              <button
                                                className="mission-icon-btn"
                                                onClick={() => setLinkTaskFeatureId(feature.id)}
                                                title="Link to task"
                                              >
                                                <Link size={14} />
                                              </button>
                                            ) : null}
                                            <button
                                              className="mission-icon-btn"
                                              onClick={() => handleEditFeature(feature)}
                                              title="Edit feature"
                                            >
                                              <Pencil size={14} />
                                            </button>
                                            <button
                                              className="mission-icon-btn mission-icon-btn--danger"
                                              onClick={() => setDeleteConfirmId({ type: "feature", id: feature.id })}
                                              title="Delete feature"
                                            >
                                              <Trash2 size={14} />
                                            </button>
                                          </div>
                                        </div>

                                        {feature.description && (
                                          <p className="mission-feature__description">{feature.description}</p>
                                        )}
                                        {feature.acceptanceCriteria && (
                                          <p className="mission-feature__criteria">
                                            <strong>Acceptance:</strong> {feature.acceptanceCriteria}
                                          </p>
                                        )}

                                        {/* Triage preview panel */}
                                        {triagePreview?.featureId === feature.id && (
                                          <div className="mission-triage-preview">
                                            <div className="mission-triage-preview__header">
                                              Enriched Description Preview
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
                                                Create Task
                                              </button>
                                              <button
                                                className="btn"
                                                onClick={handleCancelTriagePreview}
                                                disabled={saving}
                                              >
                                                Cancel
                                              </button>
                                            </div>
                                          </div>
                                        )}

                                        {/* Edit feature form */}
                                        {editingFeatureId === feature.id && (
                                          <div className="mission-form-card">
                                            <input
                                              type="text"
                                              placeholder="Feature title"
                                              value={featureForm.title}
                                              onChange={(e) => setFeatureForm({ ...featureForm, title: e.target.value })}
                                              onKeyDown={handleFeatureFormKeyDown}
                                              autoFocus
                                            />
                                            <textarea
                                              placeholder="Description (optional)"
                                              value={featureForm.description}
                                              onChange={(e) => setFeatureForm({ ...featureForm, description: e.target.value })}
                                              rows={2}
                                            />
                                            <textarea
                                              placeholder="Acceptance criteria (optional)"
                                              value={featureForm.acceptanceCriteria}
                                              onChange={(e) => setFeatureForm({ ...featureForm, acceptanceCriteria: e.target.value })}
                                              rows={2}
                                            />
                                            <select
                                              value={featureForm.status}
                                              onChange={(e) => setFeatureForm({ ...featureForm, status: e.target.value as FeatureStatus })}
                                            >
                                              <option value="defined">Defined</option>
                                              <option value="triaged">Triaged</option>
                                              <option value="in-progress">In Progress</option>
                                              <option value="done">Done</option>
                                            </select>
                                            <div className="mission-form-card__actions">
                                              <button className="mission-btn mission-btn--primary" onClick={handleSaveFeature} disabled={saving}>
                                                {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                                Update
                                              </button>
                                              <button className="mission-btn mission-btn--ghost" onClick={handleCancelFeature}>
                                                Cancel
                                              </button>
                                            </div>
                                          </div>
                                        )}

                                        {/* Validation Run History - shown when feature is expanded */}
                                        {expandedFeatureId === feature.id && (
                                          <div className="mission-feature__run-history">
                                            <div className="mission-feature__run-history-header">
                                              <span className="mission-feature__run-history-title">Validation Runs</span>
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
                                                    title={expandedRunId === run.id ? "Hide details" : "Show details"}
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
                                                        <strong>Blocked:</strong> {run.blockedReason}
                                                      </p>
                                                    )}
                                                    {runDetailsByRunId.get(run.id)?.failures && runDetailsByRunId.get(run.id)!.failures!.length > 0 && (
                                                      <div className="mission-run__failures">
                                                        <span className="mission-run__failures-title">Failed Assertions:</span>
                                                        {runDetailsByRunId.get(run.id)!.failures!.map((failure) => (
                                                          <div key={failure.id} className="mission-run__failure">
                                                            <span className="mission-run__failure-message">{failure.message}</span>
                                                            {failure.expected && (
                                                              <span className="mission-run__failure-expected">
                                                                Expected: {failure.expected}
                                                              </span>
                                                            )}
                                                            {failure.actual && (
                                                              <span className="mission-run__failure-actual">
                                                                Actual: {failure.actual}
                                                              </span>
                                                            )}
                                                          </div>
                                                        ))}
                                                      </div>
                                                    )}
                                                    {(!runDetailsByRunId.get(run.id)?.failures || runDetailsByRunId.get(run.id)!.failures!.length === 0) && (
                                                      <p className="mission-run__no-failures">No assertion failures</p>
                                                    )}
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                            {(!validationRunsByFeature.get(feature.id) || validationRunsByFeature.get(feature.id)!.length === 0) && (
                                              <div className="mission-run-history__empty">
                                                No validation runs yet.
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
                                          placeholder="Feature title"
                                          value={featureForm.title}
                                          onChange={(e) => setFeatureForm({ ...featureForm, title: e.target.value })}
                                          onKeyDown={handleFeatureFormKeyDown}
                                          autoFocus
                                        />
                                        <textarea
                                          placeholder="Description (optional)"
                                          value={featureForm.description}
                                          onChange={(e) => setFeatureForm({ ...featureForm, description: e.target.value })}
                                          rows={2}
                                        />
                                        <textarea
                                          placeholder="Acceptance criteria (optional)"
                                          value={featureForm.acceptanceCriteria}
                                          onChange={(e) => setFeatureForm({ ...featureForm, acceptanceCriteria: e.target.value })}
                                          rows={2}
                                        />
                                        <div className="mission-form-card__actions">
                                          <button className="mission-btn mission-btn--primary" onClick={handleSaveFeature} disabled={saving}>
                                            {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                            Create
                                          </button>
                                          <button className="mission-btn mission-btn--ghost" onClick={handleCancelFeature}>
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    )}

                                    {/* Empty state when no features exist and not creating */}
                                    {!isCreatingFeature && (!slice.features || slice.features.length === 0) && (
                                      <div className="mission-manager__empty mission-features__empty">
                                        <Box size={16} />
                                        <span>No fix features generated.</span>
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
                              <span>No slices yet</span>
                            </div>
                          )}

                          {/* Assertions Panel */}
                          <div className="mission-assertions">
                            <div className="mission-assertions__header">
                              <span className="mission-assertions__title">Assertions</span>
                              {validationRollupByMilestone.get(milestone.id) && (
                                <span
                                  className="mission-status-badge mission-status-badge--sm"
                                  style={{
                                    backgroundColor: validationRollupByMilestone.get(milestone.id)?.state === "passed"
                                      ? "var(--loop-passed-bg)"
                                      : validationRollupByMilestone.get(milestone.id)?.state === "failed"
                                        ? "var(--loop-blocked-bg)"
                                        : "var(--assertion-pending-bg)",
                                    color: validationRollupByMilestone.get(milestone.id)?.state === "passed"
                                      ? "var(--loop-passed-text)"
                                      : validationRollupByMilestone.get(milestone.id)?.state === "failed"
                                        ? "var(--loop-blocked-text)"
                                        : "var(--assertion-pending-text)",
                                  }}
                                >
                                  {validationRollupByMilestone.get(milestone.id)?.state || "not_started"}
                                </span>
                              )}
                              {/* Assertion coverage bar */}
                              {validationRollupByMilestone.get(milestone.id) && validationRollupByMilestone.get(milestone.id)!.totalAssertions > 0 && (
                                <div className="mission-assertions__coverage-bar" title={`${(validationRollupByMilestone.get(milestone.id)!.passedAssertions ?? 0)} of ${validationRollupByMilestone.get(milestone.id)!.totalAssertions} assertions passing`}>
                                  <div
                                    className="mission-assertions__coverage-bar-fill"
                                    style={{
                                      width: `${((validationRollupByMilestone.get(milestone.id)!.passedAssertions ?? 0) / validationRollupByMilestone.get(milestone.id)!.totalAssertions) * 100}%`,
                                      backgroundColor: (validationRollupByMilestone.get(milestone.id)!.passedAssertions ?? 0) === validationRollupByMilestone.get(milestone.id)!.totalAssertions
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
                                title="Add assertion"
                              >
                                <Plus size={14} />
                              </button>
                            </div>

                            {/* Create assertion form */}
                            {isCreatingAssertion && (
                              <div className="mission-form-card">
                                <input
                                  type="text"
                                  placeholder="Assertion title"
                                  value={assertionForm.title}
                                  onChange={(e) => setAssertionForm({ ...assertionForm, title: e.target.value })}
                                  autoFocus
                                />
                                <textarea
                                  placeholder="Assertion text (what should be true when complete)"
                                  value={assertionForm.assertion}
                                  onChange={(e) => setAssertionForm({ ...assertionForm, assertion: e.target.value })}
                                  rows={2}
                                />
                                <select
                                  value={assertionForm.status}
                                  onChange={(e) => setAssertionForm({ ...assertionForm, status: e.target.value as MissionAssertionStatus })}
                                >
                                  <option value="pending">Pending</option>
                                  <option value="passed">Passed</option>
                                  <option value="failed">Failed</option>
                                  <option value="blocked">Blocked</option>
                                </select>
                                <div className="mission-form-card__actions">
                                  <button className="mission-btn mission-btn--primary" onClick={() => handleCreateAssertion(milestone.id)} disabled={saving}>
                                    {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                    Create
                                  </button>
                                  <button className="mission-btn mission-btn--ghost" onClick={handleCancelAssertion}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Assertions list */}
                            <div className="mission-assertions__list">
                              {(Array.isArray(assertionsByMilestone.get(milestone.id)) ? assertionsByMilestone.get(milestone.id)! : [] as MissionContractAssertion[]).map((assertion) => (
                                <div key={assertion.id} className="mission-assertion">
                                  <div className="mission-assertion__header">
                                    {editingAssertionId === assertion.id ? (
                                      <div className="mission-form-card">
                                        <input
                                          type="text"
                                          placeholder="Assertion title"
                                          value={assertionForm.title}
                                          onChange={(e) => setAssertionForm({ ...assertionForm, title: e.target.value })}
                                          autoFocus
                                        />
                                        <textarea
                                          placeholder="Assertion text"
                                          value={assertionForm.assertion}
                                          onChange={(e) => setAssertionForm({ ...assertionForm, assertion: e.target.value })}
                                          rows={2}
                                        />
                                        <select
                                          value={assertionForm.status}
                                          onChange={(e) => setAssertionForm({ ...assertionForm, status: e.target.value as MissionAssertionStatus })}
                                        >
                                          <option value="pending">Pending</option>
                                          <option value="passed">Passed</option>
                                          <option value="failed">Failed</option>
                                          <option value="blocked">Blocked</option>
                                        </select>
                                        <div className="mission-form-card__actions">
                                          <button className="mission-btn mission-btn--primary" onClick={() => handleSaveAssertion(assertion.id, milestone.id)} disabled={saving}>
                                            {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                                            Save
                                          </button>
                                          <button className="mission-btn mission-btn--ghost" onClick={handleCancelAssertion}>
                                            Cancel
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
                                            <span className="mission-assertion__linked-count" title={`${count} linked feature${count !== 1 ? "s" : ""}`}>
                                              ({count} linked)
                                            </span>
                                          ) : null;
                                        })()}
                                        <button
                                          className="mission-icon-btn"
                                          onClick={() => handleToggleAssertionExpanded(assertion.id)}
                                          title="Toggle details"
                                        >
                                          {expandedAssertionId === assertion.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                        </button>
                                        <button
                                          className="mission-icon-btn"
                                          onClick={() => handleEditAssertion(assertion)}
                                          title="Edit assertion"
                                        >
                                          <Pencil size={14} />
                                        </button>
                                        <button
                                          className="mission-icon-btn mission-icon-btn--danger"
                                          onClick={() => setDeleteConfirmId({ type: "assertion", id: assertion.id })}
                                          title="Delete assertion"
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
                                          <span className="mission-assertion__linked-features-label">Linked Features</span>
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
                                            title="Link a feature"
                                          >
                                            <Link size={12} />
                                            Link Feature
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
                                                  return <span className="mission-assertion__feature-picker-empty">All features already linked</span>;
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
                                            return <span className="mission-assertion__linked-empty">No features linked yet</span>;
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
                                                  title="Unlink feature"
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
                              {(!assertionsByMilestone.get(milestone.id) || assertionsByMilestone.get(milestone.id)?.length === 0) && !isCreatingAssertion && (
                                <div className="mission-manager__empty mission-assertions__empty">
                                  <span>No assertions defined. Add one to define completion criteria.</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Create milestone button/form */}
                {selectedMission && !isCreatingMilestone && editingMilestoneId === null && (
                  <button className="mission-add-btn" onClick={handleCreateMilestone}>
                    <Plus size={16} />
                    Add Milestone
                  </button>
                )}

                {/* Global create milestone form */}
                {isCreatingMilestone && editingMilestoneId === null && (
                  <div className="mission-form-card">
                    <input
                      type="text"
                      placeholder="Milestone title"
                      value={milestoneForm.title}
                      onChange={(e) => setMilestoneForm({ ...milestoneForm, title: e.target.value })}
                      onKeyDown={handleMilestoneFormKeyDown}
                      autoFocus
                    />
                    <textarea
                      placeholder="Description (optional)"
                      value={milestoneForm.description}
                      onChange={(e) => setMilestoneForm({ ...milestoneForm, description: e.target.value })}
                      rows={2}
                    />
                    <div className="mission-form-card__actions">
                      <button className="mission-btn mission-btn--primary" onClick={handleSaveMilestone} disabled={saving}>
                        {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                        Create
                      </button>
                      <button className="mission-btn mission-btn--ghost" onClick={handleCancelMilestone}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {selectedMission.milestones.length === 0 && !isCreatingMilestone && (
                  <div className="mission-manager__empty">
                    <Layers size={24} />
                    <span>No milestones yet. Add one to get started.</span>
                  </div>
                )}
                </div>
              ) : (
                <div className="mission-detail__activity" data-testid="mission-activity-tab">
                  <div className="mission-detail__activity-controls">
                    <label className="mission-detail__activity-filter">
                      <span>Filter</span>
                      <select
                        value={eventsFilter}
                        onChange={(event) => setEventsFilter(event.target.value as typeof eventsFilter)}
                        data-testid="mission-activity-filter"
                      >
                        <option value="all">All events</option>
                        <option value="errors">Errors &amp; warnings</option>
                        <option value="state_changes">State changes</option>
                        <option value="tasks">Task events</option>
                        <option value="slices">Slice &amp; milestone events</option>
                        <option value="autopilot">Autopilot events</option>
                      </select>
                    </label>
                    <span className="mission-detail__activity-count">
                      {missionEvents.length} of {eventsTotal}
                    </span>
                  </div>

                  {!eventsLoading && hasMoreEvents && (
                    <div className="mission-detail__activity-load-more mission-detail__activity-load-more--top">
                      <button
                        className="mission-btn mission-btn--ghost"
                        onClick={handleLoadMoreEvents}
                        data-testid="mission-activity-load-more"
                      >
                        Load more
                      </button>
                    </div>
                  )}

                  {eventsLoading ? (
                    <div className="mission-manager__loading mission-detail__activity-loading">
                      <Loader2 size={18} className="spinner" />
                      <span>Loading mission activity...</span>
                    </div>
                  ) : missionEvents.length === 0 ? (
                    <div className="mission-manager__empty">
                      <Activity size={18} />
                      <span>No events yet.</span>
                    </div>
                  ) : (
                    <div
                      ref={activityEventsContainerRef}
                      className="mission-events"
                      data-testid="mission-activity-events"
                    >
                      {missionEvents.map((event) => {
                        const hasMetadata = Boolean(event.metadata && Object.keys(event.metadata).length > 0);
                        const metadataExpanded = expandedEventMetadata.has(event.id);

                        return (
                          <div key={event.id} className="mission-event">
                            <div className="mission-event__header">
                              <span className={`mission-event__type ${getEventTypeClassName(event.eventType)}`}>
                                {getEventTypeLabel(event.eventType)}
                              </span>
                              <span className="mission-event__time">{getRelativeTime(event.timestamp)}</span>
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
                                  {metadataExpanded ? "Hide" : "Show"} metadata
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
          ) : (
            /* ── List View ── */
            <div className="mission-list">
              {/* Create mission form */}
              {isCreatingMission && (
                <div className="mission-form-card">
                  <input
                    type="text"
                    placeholder="Mission title"
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <div className="mission-form-card__actions">
                    <button className="mission-btn mission-btn--primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      Create
                    </button>
                    <button className="mission-btn mission-btn--ghost" onClick={handleCancelMission}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Mission items */}
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {missions.map((mission: any) => {
                const m = mission as { id: string; title: string; description?: string; status: string; summary?: { totalMilestones: number; completedMilestones: number; totalFeatures: number; completedFeatures: number; progressPercent: number } };
                const selId = selectedMission as { id: string } | null;
                const isSelected = selId && selId.id === m.id;
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

                const activeSliceLabel = m.status === "active" && (health?.currentMilestoneId || health?.currentSliceId)
                  ? "Current milestone/slice in progress"
                  : null;

                return (
                <div
                  key={m.id}
                  className={`mission-list__item ${isSelected ? "mission-list__item--selected" : ""}`}
                  onClick={() => handleSelectMission(mission)}
                >
                  <div className="mission-list__item-content">
                    <div className="mission-list__item-header">
                      <Target size={16} className="mission-list__item-icon" />
                      <span className="mission-list__item-title">{m.title}</span>
                      {mission.autopilotEnabled && (
                        <span title="Autopilot enabled"><Zap size={12} className="mission-list__item-autopilot-icon" /></span>
                      )}
                      <span
                        className={`mission-health-badge mission-health-badge--${healthState}`}
                        data-testid={`mission-health-badge-${m.id}`}
                        aria-label={`Mission health: ${healthState}`}
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
                    </div>
                    {m.description && (
                      <p className="mission-list__item-description">{m.description}</p>
                    )}
                    {activeSliceLabel && (
                      <p className="mission-list__item-active-slice">Active: {activeSliceLabel}</p>
                    )}
                    {showSummaryBlock && (
                      <div className="mission-list__item-summary">
                        {hasContent && (
                          <>
                            <span className="mission-list__item-stat">
                              {summary!.completedMilestones}/{summary!.totalMilestones} milestones
                            </span>
                            <span className="mission-list__item-stat">
                              {summary!.completedFeatures}/{summary!.totalFeatures} features
                            </span>
                          </>
                        )}
                        <span className="mission-list__item-stat" data-testid={`mission-task-stats-${m.id}`}>
                          {tasksCompleted}/{totalTasks} tasks
                        </span>
                        {tasksFailed > 0 && (
                          <button
                            className="mission-list__item-failed"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleSelectMission(mission);
                            }}
                            data-testid={`mission-failed-${m.id}`}
                            title="View mission failures"
                          >
                            {tasksFailed} failed
                          </button>
                        )}
                        <span className="mission-relative-time" data-testid={`mission-last-activity-${m.id}`}>
                          Activity {getRelativeTime(health?.lastActivityAt)}
                        </span>
                        <div className={`mission-list__item-progress mission-list__item-progress--${healthState}`}>
                          <div
                            className="mission-list__item-progress-bar"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="mission-list__item-actions" onClick={(e) => e.stopPropagation()}>
                    {m.status === "active" && (
                      <button
                        className="mission-icon-btn mission-icon-btn--danger"
                        onClick={() => handleStopMission(m.id)}
                        title="Stop mission"
                      >
                        <Square size={14} />
                      </button>
                    )}
                    {m.status === "blocked" && (
                      <button
                        className="mission-icon-btn mission-icon-btn--success"
                        onClick={() => handleResumeMission(m.id)}
                        title="Resume mission"
                      >
                        <Play size={14} />
                      </button>
                    )}
                    {m.status === "planning" && (
                      <button
                        className="mission-icon-btn mission-icon-btn--success"
                        onClick={() => handleStartMission(m.id)}
                        title="Start mission"
                      >
                        <Play size={14} />
                      </button>
                    )}
                    <button
                      className="mission-icon-btn"
                      onClick={() => handleEditMission(mission)}
                      title="Edit mission"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="mission-icon-btn mission-icon-btn--danger"
                      onClick={() => setDeleteConfirmId({ type: "mission", id: m.id })}
                      title="Delete mission"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                );
              })}

              {/* Edit mission form */}
              {editingMissionId && (
                <div className="mission-form-card">
                  <input
                    type="text"
                    placeholder="Mission title"
                    value={missionForm.title}
                    onChange={(e) => setMissionForm({ ...missionForm, title: e.target.value })}
                    onKeyDown={handleMissionFormKeyDown}
                    autoFocus
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={missionForm.description}
                    onChange={(e) => setMissionForm({ ...missionForm, description: e.target.value })}
                    rows={2}
                  />
                  <div className="mission-form-card__row">
                    <select
                      value={missionForm.status}
                      onChange={(e) => setMissionForm({ ...missionForm, status: e.target.value as MissionStatus })}
                    >
                      <option value="planning">Planning</option>
                      <option value="active">Active</option>
                      <option value="blocked">Blocked</option>
                      <option value="complete">Complete</option>
                      <option value="archived">Archived</option>
                    </select>
                    <label className="mission-checkbox">
                      <input
                        type="checkbox"
                        checked={missionForm.autopilotEnabled}
                        onChange={(e) => setMissionForm({ ...missionForm, autopilotEnabled: e.target.checked })}
                      />
                      <Zap size={12} /> Autopilot
                    </label>
                  </div>
                  <div className="mission-form-card__actions">
                    <button className="mission-btn mission-btn--primary" onClick={handleSaveMission} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
                      Update
                    </button>
                    <button className="mission-btn mission-btn--ghost" onClick={handleCancelMission}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {missions.length === 0 && !isCreatingMission && (
                <div className="mission-manager__empty mission-manager__empty--large">
                  <Target size={32} />
                  <span>No missions yet. Create one to start planning.</span>
                </div>
              )}

              {!isCreatingMission && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {pendingInterviewSessions.length > 0 && (
                    <div className="mission-resume-prompt">
                      <AlertCircle size={16} />
                      <span>
                        {pendingInterviewSessions.length === 1
                          ? `Resume "${pendingInterviewSessions[0].title}"?`
                          : `${pendingInterviewSessions.length} interview sessions pending`}
                      </span>
                      <div style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
                        {pendingInterviewSessions.map((s) => (
                          <button
                            key={s.id}
                            className="mission-add-btn"
                            onClick={() => {
                              setLocalResumeSessionId(s.id);
                              setShowInterviewModal(true);
                              setPendingInterviewSessions([]);
                            }}
                          >
                            {s.status === "error" ? <RefreshCw size={14} /> : <Sparkles size={14} />}
                            {s.status === "error" ? "Retry" : "Resume"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button className="mission-add-btn" onClick={() => setShowInterviewModal(true)}>
                      <Sparkles size={16} />
                      Plan with AI
                    </button>
                    <button className="mission-add-btn" onClick={handleCreateMission}>
                      <Plus size={16} />
                      New Mission
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Delete confirmation panel ── */}
        {deleteConfirmId && (
          <div className="mission-confirm-panel mission-confirm-panel--danger">
            <div className="mission-confirm-panel__content">
              <p>
                Delete this {deleteConfirmId.type}? This cannot be undone.
              </p>
              <div className="mission-confirm-panel__actions">
                <button
                  className="mission-btn mission-btn--danger"
                  onClick={async () => {
                    if (deleteConfirmId.type === "mission") {
                      await handleDeleteMission(deleteConfirmId.id);
                    } else if (deleteConfirmId.type === "milestone") {
                      await handleDeleteMilestone(deleteConfirmId.id);
                    } else if (deleteConfirmId.type === "slice") {
                      await handleDeleteSlice(deleteConfirmId.id);
                    } else if (deleteConfirmId.type === "feature") {
                      await handleDeleteFeature(deleteConfirmId.id);
                    }
                  }}
                >
                  Delete
                </button>
                <button className="mission-btn mission-btn--ghost" onClick={() => setDeleteConfirmId(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Link task panel ── */}
        {linkTaskFeatureId && (
          <div className="mission-confirm-panel mission-confirm-panel--link">
            <div className="mission-confirm-panel__content">
              <p>Link feature to task:</p>
              <input
                type="text"
                placeholder="Task ID (e.g., FN-001)"
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                autoFocus
              />
              {availableTasks.length > 0 && (
                <div className="mission-task-suggestions">
                  <small>Or select:</small>
                  <div className="mission-task-suggestions__list">
                    {availableTasks.slice(0, 5).map((task) => (
                      <button
                        key={task.id}
                        className="mission-task-suggestions__item"
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        {task.id}: {task.title || "Untitled"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="mission-confirm-panel__actions">
                <button className="mission-btn mission-btn--primary" onClick={handleLinkTask}>
                  Link
                </button>
                <button className="mission-btn mission-btn--ghost" onClick={() => { setLinkTaskFeatureId(null); setSelectedTaskId(""); }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
  );

  const interviewModal = (
    <MissionInterviewModal
      isOpen={showInterviewModal}
      onClose={() => setShowInterviewModal(false)}
      onMissionCreated={() => {
        loadMissions();
        addToast("Mission created from AI interview", "success");
      }}
      projectId={projectId}
      resumeSessionId={effectiveResumeSessionId}
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
      >
        {manager}
      </div>
      {interviewModal}
      {milestoneSliceInterviewModal}
    </>
  );
}
