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

/** Loop state values for a feature's execution loop lifecycle */
export const FEATURE_LOOP_STATES = ["idle", "implementing", "validating", "needs_fix", "passed", "blocked"] as const;
export type FeatureLoopState = (typeof FEATURE_LOOP_STATES)[number];

/** Status values for a validator run */
export const VALIDATOR_RUN_STATUSES = ["running", "passed", "failed", "blocked", "error"] as const;
export type ValidatorRunStatus = (typeof VALIDATOR_RUN_STATUSES)[number];

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
  /**
   * @deprecated Superseded by `autopilotEnabled`. Kept for backward compatibility
   * with existing mission data. Autopilot now always auto-advances slices when
   * enabled and watching.
   */
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
  /** Computed validation state from contract assertions (optional, always populated by MissionStore) */
  validationState?: MilestoneValidationState;
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
  /** Current loop state for the execution loop (idle, implementing, validating, needs_fix, passed, blocked) */
  loopState?: FeatureLoopState;
  /** Number of implementation attempts made for this feature */
  implementationAttemptCount?: number;
  /** Number of validation attempts made for this feature */
  validatorAttemptCount?: number;
  /** ID of the last validator run for this feature */
  lastValidatorRunId?: string;
  /** Status of the last validator run (passed, failed, blocked, error) */
  lastValidatorStatus?: ValidatorRunStatus;
  /** Feature ID that generated this feature as a fix (for lineage tracking) */
  generatedFromFeatureId?: string;
  /** Validator run ID that generated this feature as a fix (for lineage tracking) */
  generatedFromRunId?: string;
}

// ── Validator Run & Loop Types ──────────────────────────────────────

/**
 * A validator run represents a single execution of the validation phase
 * for a feature within the mission execution loop.
 */
export interface MissionValidatorRun {
  /** Unique identifier (e.g., "VR-XXXXXXXX-XXXX") */
  id: string;
  /** Parent feature ID */
  featureId: string;
  /** Parent milestone ID */
  milestoneId: string;
  /** Parent slice ID */
  sliceId: string;
  /** Current status of the run */
  status: ValidatorRunStatus;
  /** What triggered this run (e.g., "task_completion", "manual", "scheduled") */
  triggerType?: string;
  /** Which implementation attempt this run corresponds to */
  implementationAttempt: number;
  /** Which validation attempt this run corresponds to */
  validatorAttempt: number;
  /** Summary of the validation run results */
  summary?: string;
  /** Reason for blocked status if applicable */
  blockedReason?: string;
  /** ISO-8601 timestamp when the run started */
  startedAt: string;
  /** ISO-8601 timestamp when the run completed (if completed) */
  completedAt?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/**
 * An assertion failure record represents a single assertion failure
 * within a validator run.
 */
export interface MissionAssertionFailureRecord {
  /** Unique identifier (e.g., "VAF-XXXXXXXX-XXXX") */
  id: string;
  /** Parent validator run ID */
  runId: string;
  /** Feature ID this failure belongs to */
  featureId: string;
  /** Assertion ID that failed */
  assertionId: string;
  /** Human-readable failure message */
  message?: string;
  /** Expected value or behavior */
  expected?: string;
  /** Actual value or behavior */
  actual?: string;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
}

/**
 * A fix feature lineage record tracks the relationship between a source
 * feature and a generated fix feature within the execution loop.
 */
export interface MissionFixFeatureLineage {
  /** Unique identifier (e.g., "FFL-XXXXXXXX-XXXX") */
  id: string;
  /** Source feature ID that failed validation */
  sourceFeatureId: string;
  /** Generated fix feature ID */
  fixFeatureId: string;
  /** Validator run ID that triggered the fix generation */
  runId: string;
  /** JSON array of assertion IDs that failed and triggered the fix */
  failedAssertionIds: string[];
  /** ISO-8601 timestamp of creation */
  createdAt: string;
}

/**
 * A complete loop state snapshot for a feature, including all validator
 * runs, failures, and lineage information.
 */
export interface MissionFeatureLoopSnapshot {
  /** Feature ID */
  featureId: string;
  /** The feature object */
  feature: MissionFeature;
  /** Current loop state */
  loopState: FeatureLoopState;
  /** Number of implementation attempts */
  implementationAttemptCount: number;
  /** Number of validation attempts */
  validatorAttemptCount: number;
  /** ID of the last validator run */
  lastValidatorRunId?: string;
  /** Status of the last validator run */
  lastValidatorStatus?: ValidatorRunStatus;
  /** Feature ID that generated this feature (if applicable) */
  generatedFromFeatureId?: string;
  /** Validator run ID that generated this feature (if applicable) */
  generatedFromRunId?: string;
  /** All validator runs for this feature, newest first */
  validatorRuns: MissionValidatorRun[];
  /** All assertion failures across all runs */
  failures: MissionAssertionFailureRecord[];
  /** All lineage entries for this feature (as source or fix) */
  lineage: MissionFixFeatureLineage[];
  /** Remaining retry budget (max attempts - current attempts) */
  retryBudgetRemaining: number;
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

/** Payload for fix-feature:created event */
export interface FixFeatureCreatedPayload {
  /** The generated fix feature */
  feature: MissionFeature;
  /** Source feature ID that failed validation */
  sourceFeatureId: string;
  /** Validator run ID that triggered the fix generation */
  runId: string;
  /** Assertion IDs that failed and triggered the fix */
  failedAssertionIds: string[];
}

// ── Contract Assertion Types ────────────────────────────────────────

/**
 * Status values for a contract assertion's validation state.
 *
 * Assertions represent explicit behavioral tests or requirements that can be
 * validated. They are linked to milestones and optionally to features,
 * enabling milestone validation rollup.
 */
export const MISSION_ASSERTION_STATUSES = ["pending", "passed", "failed", "blocked"] as const;
export type MissionAssertionStatus = (typeof MISSION_ASSERTION_STATUSES)[number];

/**
 * Validation states for a milestone's contract coverage.
 *
 * The validation state is computed from the milestone's assertions and is
 * persisted on the milestone for efficient querying without rollup recalculation.
 *
 * Precedence (evaluated in order):
 * 1. `not_started` — milestone has no assertions
 * 2. `failed` — any assertion has failed
 * 3. `blocked` — any assertion is blocked
 * 4. `needs_coverage` — assertions exist but some are not linked to features
 * 5. `passed` — all assertions have passed
 * 6. `ready` — assertions exist and are linked, but not all have passed
 */
export const MILESTONE_VALIDATION_STATES = [
  "not_started",
  "needs_coverage",
  "ready",
  "passed",
  "failed",
  "blocked",
] as const;
export type MilestoneValidationState = (typeof MILESTONE_VALIDATION_STATES)[number];

/**
 * A contract assertion represents an explicit behavioral test or requirement
 * associated with a milestone. Assertions can be linked to features to track
 * coverage and validation status.
 */
export interface MissionContractAssertion {
  /** Unique identifier (e.g., "CA-A3B7CD-E9F2") */
  id: string;
  /** Parent milestone ID */
  milestoneId: string;
  /** Human-readable title describing the assertion */
  title: string;
  /** The behavioral specification or acceptance test content */
  assertion: string;
  /** Current validation status */
  status: MissionAssertionStatus;
  /** Order index for sorting within the milestone (0-based) */
  orderIndex: number;
  /** ISO-8601 timestamp of creation */
  createdAt: string;
  /** ISO-8601 timestamp of last update */
  updatedAt: string;
}

/**
 * A feature-assertion link represents the association between a feature
 * and a contract assertion. This is a many-to-many relationship:
 * - One feature can satisfy multiple assertions
 * - One assertion can be covered by multiple features
 */
export interface FeatureAssertionLink {
  /** The linked feature ID */
  featureId: string;
  /** The linked assertion ID */
  assertionId: string;
  /** ISO-8601 timestamp when the link was created */
  createdAt: string;
}

/**
 * Computed validation rollup for a milestone's contract assertions.
 * This is a denormalized snapshot persisted on the milestone.
 */
export interface MilestoneValidationRollup {
  /** The milestone this rollup belongs to */
  milestoneId: string;
  /** Total number of assertions */
  totalAssertions: number;
  /** Number of assertions in passed status */
  passedAssertions: number;
  /** Number of assertions in failed status */
  failedAssertions: number;
  /** Number of assertions in blocked status */
  blockedAssertions: number;
  /** Number of assertions in pending status */
  pendingAssertions: number;
  /** Number of assertions not linked to any feature */
  unlinkedAssertions: number;
  /** The computed validation state */
  state: MilestoneValidationState;
}

/**
 * Input for creating a new contract assertion.
 */
export interface ContractAssertionCreateInput {
  /** Human-readable title (required) */
  title: string;
  /** The behavioral specification or acceptance test content (required) */
  assertion: string;
  /** Initial status, defaults to "pending" */
  status?: MissionAssertionStatus;
}

/**
 * Input for updating a contract assertion.
 */
export interface ContractAssertionUpdateInput {
  /** Human-readable title */
  title?: string;
  /** The behavioral specification */
  assertion?: string;
  /** Validation status */
  status?: MissionAssertionStatus;
}

/** Payload for assertion:created event */
export type AssertionCreatedPayload = MissionContractAssertion;

/** Payload for assertion:updated event */
export type AssertionUpdatedPayload = MissionContractAssertion;

/** Payload for assertion:deleted event */
export interface AssertionDeletedPayload {
  /** ID of the deleted assertion */
  assertionId: string;
  /** Parent milestone ID at time of deletion */
  milestoneId: string;
}

/** Payload for assertion:linked event */
export interface AssertionLinkedPayload {
  /** The feature ID */
  featureId: string;
  /** The assertion ID */
  assertionId: string;
}

/** Payload for assertion:unlinked event */
export interface AssertionUnlinkedPayload {
  /** The feature ID */
  featureId: string;
  /** The assertion ID */
  assertionId: string;
}

/** Payload for milestone:validation:updated event */
export interface MilestoneValidationUpdatedPayload {
  /** The milestone ID */
  milestoneId: string;
  /** The new validation state */
  state: MilestoneValidationState;
  /** The full validation rollup snapshot */
  rollup: MilestoneValidationRollup;
}
