/**
 * Mission hierarchy types for fn project planning.
 *
 * A Mission represents a high-level objective that can span multiple milestones.
 * Each Milestone represents a phase of work within a mission.
 * Each Slice represents a work unit within a milestone that can be activated for implementation.
 * Each Feature represents a deliverable within a slice that can be linked to a fn Task.
 *
 * The hierarchy: Mission → Milestone → Slice → Feature → (optional) Task
 */

// ── Status Enums ─────────────────────────────────────────────────────

/** Status values for a Mission's lifecycle */
export const MISSION_STATUSES = ["planning", "active", "blocked", "complete", "archived"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** Status values for a Milestone within a mission */
export const MILESTONE_STATUSES = ["planning", "active", "blocked", "complete"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** Status values for a Slice (work unit) */
export const SLICE_STATUSES = ["pending", "active", "complete"] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

/** Status values for a Slice's plan state (per-slice planning workflow) */
export const SLICE_PLAN_STATES = ["not_started", "planned", "needs_update"] as const;
export type SlicePlanState = (typeof SLICE_PLAN_STATES)[number];

/** Status values for a Feature within a slice */
export const FEATURE_STATUSES = ["defined", "triaged", "in-progress", "done", "blocked"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/** Interview state for AI-assisted specification */
export const INTERVIEW_STATES = ["not_started", "in_progress", "completed", "needs_update"] as const;
export type InterviewState = (typeof INTERVIEW_STATES)[number];

/** Autopilot state values for mission autonomous progression */
export const AUTOPILOT_STATES = ["inactive", "watching", "activating", "completing"] as const;
export type AutopilotState = (typeof AUTOPILOT_STATES)[number];

/** Persisted mission lifecycle event categories for observability/audit trails. */
export const MISSION_EVENT_TYPES = [
  "slice_activated",
  "feature_triaged",
  "feature_completed",
  "slice_completed",
  "milestone_completed",
  "mission_completed",
  "mission_started",
  "mission_paused",
  "mission_resumed",
  "autopilot_enabled",
  "autopilot_disabled",
  "autopilot_state_changed",
  "autopilot_retry",
  "autopilot_stale",
  "error",
  "warning",
] as const;
export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

/** Autopilot status for a mission */
export interface AutopilotStatus {
  enabled: boolean;
  state: AutopilotState;
  watched: boolean;
  lastActivityAt?: string;
  nextScheduledCheck?: string;
}

/** Persisted audit event describing a mission lifecycle transition or warning. */
export interface MissionEvent {
  id: string;
  missionId: string;
  eventType: MissionEventType;
  description: string;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  /** Monotonically increasing sequence number for ordering events with identical timestamps */
  seq: number;
}

/** Computed mission health snapshot used by observability APIs. */
export interface MissionHealth {
  missionId: string;
  status: MissionStatus;
  tasksCompleted: number;
  tasksFailed: number;
  tasksInFlight: number;
  totalTasks: number;
  currentSliceId?: string;
  currentMilestoneId?: string;
  estimatedCompletionPercent: number;
  lastErrorAt?: string;
  lastErrorDescription?: string;
  autopilotState: AutopilotState;
  autopilotEnabled: boolean;
  lastActivityAt?: string;
}

// ── Core Entity Types ───────────────────────────────────────────────

/**
 * A Mission represents a high-level objective or project.
 * Missions contain milestones that break down the work into phases.
 */
export interface Mission {
  /** Unique identifier (e.g., "M-LZ7DN0-A2B5") */
  id: string;
  /** Display name of the mission */
  title: string;
  /** Detailed description of the mission's objectives */
  description?: string;
  /** Current lifecycle status */
  status: MissionStatus;
  /** State of the AI specification interview process */
  interviewState: InterviewState;
  /** When true, automatically activate the next pending slice when current slice completes */
  autoAdvance?: boolean;
  /** When true, enable autopilot monitoring system for this mission */
  autopilotEnabled?: boolean;
  /** Current autopilot runtime state */
  autopilotState?: AutopilotState;
  /** ISO-8601 timestamp of last autopilot activity (only populated when active) */
  lastAutopilotActivityAt?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/**
 * A Milestone represents a phase of work within a mission.
 * Milestones contain slices that represent work units to be executed.
 */
export interface Milestone {
  /** Unique identifier (e.g., "MS-M3N8QR-C9F1") */
  id: string;
  /** Parent mission ID */
  missionId: string;
  /** Display name of the milestone */
  title: string;
  /** Detailed description of milestone objectives */
  description?: string;
  /** Current lifecycle status */
  status: MilestoneStatus;
  /** Order index for sorting within the mission (0-based) */
  orderIndex: number;
  /** State of the AI specification interview process */
  interviewState: InterviewState;
  /** IDs of milestones that must complete before this one can start */
  dependencies: string[];
  /** Planning notes from interview/planning output */
  planningNotes?: string;
  /** How to verify milestone completion */
  verification?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/**
 * A Slice represents a work unit within a milestone.
 * Slices can be activated for implementation, linking to fn tasks.
 */
export interface Slice {
  /** Unique identifier (e.g., "SL-P4T2WX-D5E8") */
  id: string;
  /** Parent milestone ID */
  milestoneId: string;
  /** Display name of the slice */
  title: string;
  /** Detailed description of work to be done */
  description?: string;
  /** Current lifecycle status */
  status: SliceStatus;
  /** Order index for sorting within the milestone (0-based) */
  orderIndex: number;
  /** ISO-8601 timestamp when the slice was activated (if applicable) */
  activatedAt?: string;
  /** State of the per-slice planning workflow */
  planState: SlicePlanState;
  /** Planning notes from interview/planning output */
  planningNotes?: string;
  /** How to verify slice completion */
  verification?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/**
 * A MissionFeature represents a deliverable within a slice.
 * Features can be linked to fn Tasks for implementation.
 */
export interface MissionFeature {
  /** Unique identifier (e.g., "F-J6K9AB-G7H3") */
  id: string;
  /** Parent slice ID */
  sliceId: string;
  /** Linked task ID (optional) - set when feature is triaged into a task */
  taskId?: string;
  /** Display name of the feature */
  title: string;
  /** Detailed description of the feature */
  description?: string;
  /** Acceptance criteria for completing the feature */
  acceptanceCriteria?: string;
  /** Current lifecycle status */
  status: FeatureStatus;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

// ── Input Types (for creation) ──────────────────────────────────────

/** Input for creating a new Mission */
export interface MissionCreateInput {
  /** Display name of the mission (required) */
  title: string;
  /** Detailed description of the mission's objectives */
  description?: string;
}

/** Input for creating a new Milestone */
export interface MilestoneCreateInput {
  /** Display name of the milestone (required) */
  title: string;
  /** Detailed description of milestone objectives */
  description?: string;
  /** IDs of milestones that must complete before this one can start */
  dependencies?: string[];
  /** Planning notes from interview/planning output */
  planningNotes?: string;
  /** How to verify milestone completion */
  verification?: string;
}

/** Input for creating a new Slice */
export interface SliceCreateInput {
  /** Display name of the slice (required) */
  title: string;
  /** Detailed description of work to be done */
  description?: string;
  /** Planning notes from interview/planning output */
  planningNotes?: string;
  /** How to verify slice completion */
  verification?: string;
}

/** Input for creating a new Feature */
export interface FeatureCreateInput {
  /** Display name of the feature (required) */
  title: string;
  /** Detailed description of the feature */
  description?: string;
  /** Acceptance criteria for completing the feature */
  acceptanceCriteria?: string;
}

// ─ Composite Types ─────────────────────────────────────────────────

/**
 * A Milestone with its nested slices loaded.
 * Used when fetching a single milestone with full hierarchy.
 */
export interface MilestoneWithSlices extends Milestone {
  /** Slices belonging to this milestone */
  slices: Slice[];
}

/**
 * A Slice with its nested features loaded.
 * Used when fetching a single slice with full details.
 */
export interface SliceWithFeatures extends Slice {
  /** Features belonging to this slice */
  features: MissionFeature[];
}

/**
 * A Mission with complete hierarchy loaded:
 * Mission → Milestones → Slices → Features
 */
export interface MissionWithHierarchy extends Mission {
  /** Milestones belonging to this mission, each with their slices */
  milestones: Array<MilestoneWithSlices & {
    /** Slices with their features loaded */
    slices: SliceWithFeatures[];
  }>;
}

// ── Event Payload Types ─────────────────────────────────────────────

/** Payload for mission:created and mission:updated events */
export type MissionEventPayload = Mission;

/** Payload for mission:deleted event */
export interface MissionDeletedPayload {
  /** ID of the deleted mission */
  missionId: string;
}

/** Payload for milestone:created and milestone:updated events */
export type MilestoneEventPayload = Milestone;

/** Payload for milestone:deleted event */
export interface MilestoneDeletedPayload {
  /** ID of the deleted milestone */
  milestoneId: string;
}

/** Payload for slice:created and slice:updated events */
export type SliceEventPayload = Slice;

/** Payload for slice:deleted event */
export interface SliceDeletedPayload {
  /** ID of the deleted slice */
  sliceId: string;
}

/** Payload for slice:activated event */
export type SliceActivatedPayload = Slice;

/** Payload for feature:created and feature:updated events */
export type FeatureEventPayload = MissionFeature;

/** Payload for feature:deleted event */
export interface FeatureDeletedPayload {
  /** ID of the deleted feature */
  featureId: string;
}

/** Payload for feature:linked event */
export interface FeatureLinkedPayload {
  /** The feature that was linked */
  feature: MissionFeature;
  /** ID of the task it was linked to */
  taskId: string;
}
