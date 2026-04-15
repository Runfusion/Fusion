// Mission types for MissionManager - local copy to avoid module resolution issues

import type {
  MissionEvent as CoreMissionEvent,
  MissionEventType as CoreMissionEventType,
  MissionHealth as CoreMissionHealth,
} from "@fusion/core";

export type MissionStatus = "planning" | "active" | "blocked" | "complete" | "archived";
export type MilestoneStatus = "planning" | "active" | "blocked" | "complete";
export type SliceStatus = "pending" | "active" | "complete";
export type SlicePlanState = "not_started" | "planned" | "needs_update";
export type FeatureStatus = "defined" | "triaged" | "in-progress" | "done";

/** Loop state values for a feature's execution loop lifecycle */
export type FeatureLoopState = "idle" | "implementing" | "validating" | "needs_fix" | "passed" | "blocked";

/** Status values for a contract assertion */
export type MissionAssertionStatus = "pending" | "passed" | "failed" | "blocked";

/** Status values for a validator run */
export type ValidatorRunStatus = "running" | "passed" | "failed" | "blocked" | "error";

/** Validation states for a milestone's contract coverage */
export type MilestoneValidationState = "not_started" | "needs_coverage" | "ready" | "passed" | "failed" | "blocked";

/** Autopilot state values for mission autonomous progression */
export type AutopilotState = "inactive" | "watching" | "activating" | "completing";

/** Autopilot status returned by API */
export interface AutopilotStatus {
  enabled: boolean;
  state: AutopilotState;
  watched: boolean;
  lastActivityAt?: string;
  nextScheduledCheck?: string;
}

export interface Mission {
  id: string;
  title: string;
  description?: string;
  status: MissionStatus;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  autoAdvance?: boolean;
  autopilotEnabled?: boolean;
  autopilotState?: AutopilotState;
  lastAutopilotActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MissionFeature {
  id: string;
  sliceId: string;
  taskId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  status: FeatureStatus;
  createdAt: string;
  updatedAt: string;
  /** Current loop state for the execution loop (idle, implementing, validating, needs_fix, passed, blocked) */
  loopState?: FeatureLoopState;
  /** Number of implementation attempts made for this feature */
  implementationAttemptCount?: number;
  /** Number of validation attempts made for this feature */
  validatorAttemptCount?: number;
  /** ID of the last validator run for this feature */
  lastValidatorRunId?: string;
  /** Status of the last validator run */
  lastValidatorStatus?: ValidatorRunStatus;
  /** Feature ID that generated this feature (if it was a fix feature) */
  generatedFromFeatureId?: string;
  /** Validator run ID that generated this feature (if applicable) */
  generatedFromRunId?: string;
}

/** A contract assertion represents an explicit behavioral test or requirement associated with a milestone */
export interface MissionContractAssertion {
  id: string;
  milestoneId: string;
  title: string;
  assertion: string;
  status: MissionAssertionStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a contract assertion */
export interface ContractAssertionCreateInput {
  title: string;
  assertion: string;
  status?: MissionAssertionStatus;
}

/** Input for updating a contract assertion */
export interface ContractAssertionUpdateInput {
  title?: string;
  assertion?: string;
  status?: MissionAssertionStatus;
}

/** A feature-assertion link represents the association between a feature and an assertion */
export interface FeatureAssertionLink {
  featureId: string;
  assertionId: string;
  createdAt: string;
}

/** Validation rollup for a milestone */
export interface MilestoneValidationRollup {
  milestoneId: string;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  blockedAssertions: number;
  pendingAssertions: number;
  state: MilestoneValidationState;
}

/** Validator run */
export interface MissionValidatorRun {
  id: string;
  featureId: string;
  milestoneId: string;
  sliceId: string;
  status: ValidatorRunStatus;
  triggerType: string;
  implementationAttempt: number;
  validatorAttempt: number;
  summary?: string;
  blockedReason?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Loop state snapshot for a feature */
export interface MissionFeatureLoopSnapshot {
  featureId: string;
  feature: MissionFeature;
  loopState: FeatureLoopState;
  implementationAttemptCount: number;
  validatorAttemptCount: number;
  lastValidatorRunId?: string;
  lastValidatorStatus?: ValidatorRunStatus;
  generatedFromFeatureId?: string;
  generatedFromRunId?: string;
  retryBudgetRemaining: number;
}

export interface Slice {
  id: string;
  milestoneId: string;
  title: string;
  description?: string;
  status: SliceStatus;
  orderIndex: number;
  activatedAt?: string;
  planState?: SlicePlanState;
  interviewState?: "not_started" | "in_progress" | "completed" | "needs_update";
  planningNotes?: string;
  verification?: string;
  createdAt: string;
  updatedAt: string;
  features: MissionFeature[];
}

export type SliceWithFeatures = Slice;

export interface Milestone {
  id: string;
  missionId: string;
  title: string;
  description?: string;
  status: MilestoneStatus;
  orderIndex: number;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  dependencies: string[];
  planningNotes?: string;
  verification?: string;
  createdAt: string;
  updatedAt: string;
  slices: Slice[];
}

export type MilestoneWithSlices = Milestone;

/** Status summary for a mission card, computed from hierarchy */
export interface MissionSummary {
  totalMilestones: number;
  completedMilestones: number;
  totalFeatures: number;
  completedFeatures: number;
  progressPercent: number;
}

/** Mission with optional status summary (returned by list endpoint) */
export type MissionWithSummary = Mission & { summary?: MissionSummary };

export interface MissionWithHierarchy extends Mission {
  milestones: Milestone[];
}

/** Mission event categories emitted by mission observability APIs. */
export type MissionEventType = CoreMissionEventType;

/** Mission lifecycle event persisted in the mission event log. */
export type MissionEvent = CoreMissionEvent;

/** Computed mission health snapshot returned by observability APIs. */
export type MissionHealth = CoreMissionHealth;

