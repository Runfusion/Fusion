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
} from "lucide-react";
import type { ToastType } from "../hooks/useToast";
import { MissionInterviewModal } from "./MissionInterviewModal";
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
  resumeMission,
  stopMission,
  startMission,
  updateMissionAutopilot,
  fetchMissionHealth,
  fetchMissionsHealth,
  fetchMissionEvents,
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

export function MissionManager({ isOpen, isInline = false, onClose, addToast, projectId, onSelectTask, availableTasks = [], resumeSessionId, targetMissionId }: MissionManagerProps) {
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

  // Auto-open interview modal when resuming a session
  useEffect(() => {
    if (isActive && resumeSessionId) {
      setShowInterviewModal(true);
    }
  }, [isActive, resumeSessionId]);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<{ type: string; id: string } | null>(null);

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
        setExpandedMilestones(new Set([data.milestones[0].id]));
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

    return () => {
      eventSource.removeEventListener("mission:updated", handleMissionUpdated);
      eventSource.removeEventListener("slice:updated", handleSliceUpdated);
      eventSource.removeEventListener("feature:updated", handleFeatureUpdated);
      eventSource.removeEventListener("mission:event", handleMissionEvent);
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
      if (next.has(milestoneId)) {
        next.delete(milestoneId);
      } else {
        next.add(milestoneId);
      }
      return next;
    });
  }, []);

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
        <div className="mission-manager__header">
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
          <button
            className="modal-close"
            onClick={onClose}
            title="Close"
            aria-label="Close Mission Manager"
            data-testid="mission-close-btn"
          >
            <X size={18} />
          </button>
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
                                                onClick={() => handleTriageFeature(feature.id)}
                                                title="Triage — create task"
                                                disabled={saving}
                                              >
                                                {saving ? <Loader2 size={14} className="spinner" /> : <Zap size={14} />}
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
      resumeSessionId={resumeSessionId}
    />
  );

  if (isInline) {
    return (
      <>
        {manager}
        {interviewModal}
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
    </>
  );
}
