/**
 * MissionStore - Data layer for the Missions hierarchy system.
 *
 * Manages CRUD operations for missions, milestones, slices, and features.
 * Provides status rollup logic and emits events for dashboard reactivity.
 *
 * Follows the same patterns as TaskStore for consistency:
 * - EventEmitter for change notifications
 * - SQLite for structured data storage
 * - JSON columns for nested arrays
 * - Transaction handling for atomic operations
 */

import { EventEmitter } from "node:events";
import type { Database } from "./db.js";
import { fromJson, toJson, toJsonNullable } from "./db.js";
import { normalizeMissionAssertionType } from "./mission-types.js";
import type { Goal, GoalStatus } from "./goal-types.js";
import type {
  Mission,
  MissionBranchStrategy,
  Milestone,
  Slice,
  MissionFeature,
  MissionValidatorRun,
  MissionAssertionFailureRecord,
  MissionFixFeatureLineage,
  MissionFeatureLoopSnapshot,
  MissionCreateInput,
  MilestoneCreateInput,
  SliceCreateInput,
  FeatureCreateInput,
  MissionWithHierarchy,
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  InterviewState,
  AutopilotState,
  MissionEvent,
  MissionEventType,
  MissionHealth,
  SlicePlanState,
  MissionContractAssertion,
  FeatureAssertionLink,
  MissionGoalLink,
  FixFeatureCreatedPayload,
  MilestoneValidationRollup,
  ContractAssertionCreateInput,
  ContractAssertionUpdateInput,
  MilestoneValidationState,
  ValidatorRunStatus,
  FeatureLoopState,
} from "./mission-types.js";
import {
  createMissionHierarchySnapshot,
  validateSnapshotEnvelope,
  type MissionHierarchySnapshot,
} from "./shared-mesh-state.js";
import { reconcileDeterministicDuplicate, runDeterministicDuplicateGuard } from "./duplicate-guard.js";
import { resolveEntryPointBranchAssignment } from "./branch-assignment.js";
// ── Constants ────────────────────────────────────────────────────────

/**
 * Default retry budget for implementation attempts.
 * When implementationAttemptCount reaches this limit, the feature enters
 * 'blocked' state instead of transitioning to 'implementing'.
 */
const DEFAULT_IMPLEMENTATION_RETRY_BUDGET = 3;

function missionBranchStrategyDefaults(strategy?: MissionBranchStrategy): {
  branch?: string;
  assignmentMode: "shared" | "per-task-derived";
} {
  if (!strategy) {
    return { assignmentMode: "shared" };
  }
  if (strategy.mode === "auto-per-task") {
    return { assignmentMode: "per-task-derived" };
  }
  if ((strategy.mode === "existing" || strategy.mode === "custom-new") && strategy.branchName?.trim()) {
    return { branch: strategy.branchName.trim(), assignmentMode: "shared" };
  }
  return { assignmentMode: "shared" };
}

export function deriveMilestoneAcceptanceCriteriaFromFeatures(features: MissionFeature[]): string | undefined {
  const lines = features
    .map((feature) => {
      const acceptance = feature.acceptanceCriteria?.trim();
      const description = feature.description?.trim();
      const text = acceptance && acceptance.length > 0
        ? acceptance
        : description && description.length > 0
          ? description
          : undefined;

      if (!text) {
        return undefined;
      }

      return `- ${feature.title}: ${text}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return undefined;
  }

  return lines.join("\n");
}

// ── Mission Summary Type ─────────────────────────────────────────────

/** Status summary for a mission, computed from its hierarchy. */
export interface MissionSummary {
  /** Total number of milestones in the mission */
  totalMilestones: number;
  /** Number of milestones with status "complete" */
  completedMilestones: number;
  /** Total number of features across all slices */
  totalFeatures: number;
  /** Number of features with status "done" */
  completedFeatures: number;
  /** Number of goals linked to the mission */
  linkedGoalCount: number;
  /** Unfiltered total number of persisted mission lifecycle events */
  eventCount: number;
  /** Computed progress percentage (0–100), based on features or milestones */
  progressPercent: number;
}

export type MissionAssertionTextSource = "acceptanceCriteria" | "description" | "fallback";

export interface MissionAssertionBackfillRepairRow {
  featureId: string;
  milestoneId: string;
  assertionId: string;
  textSource: MissionAssertionTextSource;
}

export interface MissionAssertionBackfillErrorRow {
  featureId: string;
  message: string;
}

export interface MissionAssertionBackfillReport {
  scanned: number;
  alreadyLinked: number;
  repaired: MissionAssertionBackfillRepairRow[];
  skippedErrors: MissionAssertionBackfillErrorRow[];
}

export interface MissionAssertionSeedInput {
  featureId: string;
  milestoneId: string;
  title: string;
  assertion: string;
}

export interface MissionAssertionSeedReport {
  scanned: number;
  created: number;
  linked: number;
  skippedExisting: number;
}

// ── Event Types ─────────────────────────────────────────────────────

export interface MissionStoreEvents {
  /** Emitted when a mission is created */
  "mission:created": [Mission];
  /** Emitted when a mission is updated */
  "mission:updated": [Mission];
  /** Emitted when a mission is deleted */
  "mission:deleted": [string];
  /** Emitted when a goal is linked to a mission */
  "mission:goal-linked": [MissionGoalLink];
  /** Emitted when a goal is unlinked from a mission */
  "mission:goal-unlinked": [MissionGoalLink];
  /** Emitted when a milestone is created */
  "milestone:created": [Milestone];
  /** Emitted when a milestone is updated */
  "milestone:updated": [Milestone];
  /** Emitted when a milestone is deleted */
  "milestone:deleted": [string];
  /** Emitted when a slice is created */
  "slice:created": [Slice];
  /** Emitted when a slice is updated */
  "slice:updated": [Slice];
  /** Emitted when a slice is deleted */
  "slice:deleted": [string];
  /** Emitted when a slice is activated for work */
  "slice:activated": [Slice];
  /** Emitted when a feature is created */
  "feature:created": [MissionFeature];
  /** Emitted when a feature is updated */
  "feature:updated": [MissionFeature];
  /** Emitted when a feature is deleted */
  "feature:deleted": [string];
  /** Emitted when a feature is linked to a task */
  "feature:linked": [{ feature: MissionFeature; taskId: string }];
  /** Emitted when a mission lifecycle event is persisted */
  "mission:event": [MissionEvent];
  /** Emitted when a contract assertion is created */
  "assertion:created": [MissionContractAssertion];
  /** Emitted when a contract assertion is updated */
  "assertion:updated": [MissionContractAssertion];
  /** Emitted when a contract assertion is deleted */
  "assertion:deleted": [string];
  /** Emitted when a feature is linked to an assertion */
  "assertion:linked": [{ featureId: string; assertionId: string }];
  /** Emitted when a feature is unlinked from an assertion */
  "assertion:unlinked": [{ featureId: string; assertionId: string }];
  /** Emitted when a milestone's validation state is recomputed */
  "milestone:validation:updated": [{ milestoneId: string; state: MilestoneValidationState; rollup: MilestoneValidationRollup }];
  /** Emitted when a validator run is started */
  "validator-run:started": [MissionValidatorRun];
  /** Emitted when a validator run is completed (run, final status, durationMs) */
  "validator-run:completed": [MissionValidatorRun, ValidatorRunStatus, number];
  /** Emitted when a generated fix feature is created after failed validation */
  "fix-feature:created": [FixFeatureCreatedPayload];
}

// ── Row Interfaces ──────────────────────────────────────────────────

/** Database row shape for the missions table. */
interface MissionRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  interviewState: string;
  baseBranch: string | null;
  branchStrategy: string | null;
  autoMerge: number | null;
  autoAdvance: number;
  autopilotEnabled: number;
  autopilotState: string;
  lastAutopilotActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the milestones table. */
interface MilestoneRow {
  id: string;
  missionId: string;
  title: string;
  description: string | null;
  status: string;
  orderIndex: number;
  interviewState: string;
  dependencies: string | null;
  planningNotes: string | null;
  verification: string | null;
  acceptanceCriteria: string | null;
  validationState: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the mission_contract_assertions table. */
interface MissionGoalRow {
  missionId: string;
  goalId: string;
  createdAt: string;
}

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the mission_contract_assertions table. */
interface AssertionRow {
  id: string;
  milestoneId: string;
  title: string;
  assertion: string;
  status: string;
  type: string | null;
  orderIndex: number;
  sourceFeatureId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the mission_feature_assertions table. */
interface FeatureAssertionLinkRow {
  featureId: string;
  assertionId: string;
  createdAt: string;
}

/** Database row shape for the slices table. */
interface SliceRow {
  id: string;
  milestoneId: string;
  title: string;
  description: string | null;
  status: string;
  orderIndex: number;
  activatedAt: string | null;
  planState: string | null;
  planningNotes: string | null;
  verification: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the mission_features table. */
interface FeatureRow {
  id: string;
  sliceId: string;
  taskId: string | null;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  loopState: string | null;
  implementationAttemptCount: number | null;
  validatorAttemptCount: number | null;
  lastValidatorRunId: string | null;
  lastValidatorStatus: string | null;
  generatedFromFeatureId: string | null;
  generatedFromRunId: string | null;
}

/** Database row shape for the mission_events table. */
interface MissionEventRow {
  id: string;
  missionId: string;
  eventType: string;
  description: string;
  metadata: string | null;
  timestamp: string;
  seq: number | null;
}

/** Database row shape for the mission_validator_runs table. */
interface ValidatorRunRow {
  id: string;
  featureId: string;
  milestoneId: string;
  sliceId: string;
  status: string;
  triggerType: string | null;
  implementationAttempt: number | null;
  validatorAttempt: number | null;
  taskId: string | null;
  summary: string | null;
  blockedReason: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the mission_validator_failures table. */
interface FailureRow {
  id: string;
  runId: string;
  featureId: string;
  assertionId: string;
  message: string | null;
  expected: string | null;
  actual: string | null;
  createdAt: string;
}

/** Database row shape for the mission_fix_feature_lineage table. */
interface LineageRow {
  id: string;
  sourceFeatureId: string;
  fixFeatureId: string;
  runId: string;
  failedAssertionIds: string | null;
  createdAt: string;
}

// ── MissionStore Class ──────────────────────────────────────────────

export class MissionStore extends EventEmitter<MissionStoreEvents> {
  /**
   * Creates a new MissionStore instance.
   *
   * @param fusionDir - Path to the .fusion directory (e.g., /path/to/project/.fusion)
   * @param db - Shared Database instance (same instance used by TaskStore)
   * @param taskStore - Optional TaskStore reference for triage operations that create tasks
   */
  constructor(
    private fusionDir: string,
    private db: Database,
    private taskStore?: import("./store.js").TaskStore,
  ) {
    super();
    this.setMaxListeners(100);
    // Initialize sequence counter from existing events to ensure uniqueness across restarts
    const lastEvent = this.db.prepare(`
      SELECT seq FROM mission_events ORDER BY seq DESC LIMIT 1
    `).get() as { seq?: number } | undefined;
    this._eventSeq = lastEvent?.seq ?? 0;
  }

  private _eventSeq = 0;
  private _milestonesMissingStructuredAssertions = new Set<string>();

  // ── Row-to-Object Converters ───────────────────────────────────────

  /**
   * Convert a database row to a Mission object.
   */
  private rowToMission(row: MissionRow): Mission {
    let branchStrategy: MissionBranchStrategy | undefined;
    if (row.branchStrategy) {
      try {
        branchStrategy = JSON.parse(row.branchStrategy) as MissionBranchStrategy;
      } catch {
        branchStrategy = undefined;
      }
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      status: row.status as MissionStatus,
      interviewState: row.interviewState as InterviewState,
      baseBranch: row.baseBranch || undefined,
      branchStrategy,
      autoMerge: row.autoMerge === null ? undefined : Boolean(row.autoMerge),
      autoAdvance: Boolean(row.autoAdvance),
      autopilotEnabled: Boolean(row.autopilotEnabled),
      autopilotState: (row.autopilotState as AutopilotState) || "inactive",
      lastAutopilotActivityAt: row.lastAutopilotActivityAt || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a Milestone object.
   */
  private rowToMilestone(row: MilestoneRow): Milestone {
    return {
      id: row.id,
      missionId: row.missionId,
      title: row.title,
      description: row.description || undefined,
      status: row.status as MilestoneStatus,
      orderIndex: row.orderIndex,
      interviewState: row.interviewState as InterviewState,
      dependencies: fromJson<string[]>(row.dependencies) || [],
      planningNotes: row.planningNotes || undefined,
      verification: row.verification || undefined,
      acceptanceCriteria: row.acceptanceCriteria || undefined,
      validationState: (row.validationState as MilestoneValidationState) || "not_started",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a MissionGoalLink object.
   */
  private rowToMissionGoalLink(row: MissionGoalRow): MissionGoalLink {
    return {
      missionId: row.missionId,
      goalId: row.goalId,
      createdAt: row.createdAt,
    };
  }

  private rowToGoal(row: GoalRow): Goal {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private listGoalsByIds(goalIds: string[]): Goal[] {
    return goalIds
      .map((goalId) => this.db
        .prepare("SELECT id, title, description, status, createdAt, updatedAt FROM goals WHERE id = ?")
        .get(goalId) as GoalRow | undefined)
      .filter((row): row is GoalRow => Boolean(row))
      .map((row) => this.rowToGoal(row));
  }

  /**
   * Convert a database row to a MissionContractAssertion object.
   */
  private rowToAssertion(row: AssertionRow): MissionContractAssertion {
    return {
      id: row.id,
      milestoneId: row.milestoneId,
      sourceFeatureId: row.sourceFeatureId || undefined,
      title: row.title,
      assertion: row.assertion,
      status: row.status as import("./mission-types.js").MissionAssertionStatus,
      type: normalizeMissionAssertionType(row.type),
      orderIndex: row.orderIndex,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a FeatureAssertionLink object.
   */
  private rowToFeatureAssertionLink(row: FeatureAssertionLinkRow): FeatureAssertionLink {
    return {
      featureId: row.featureId,
      assertionId: row.assertionId,
      createdAt: row.createdAt,
    };
  }

  /**
   * Convert a database row to a Slice object.
   */
  private rowToSlice(row: SliceRow): Slice {
    return {
      id: row.id,
      milestoneId: row.milestoneId,
      title: row.title,
      description: row.description || undefined,
      status: row.status as SliceStatus,
      orderIndex: row.orderIndex,
      activatedAt: row.activatedAt || undefined,
      planState: (row.planState as SlicePlanState) || "not_started",
      planningNotes: row.planningNotes || undefined,
      verification: row.verification || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a MissionFeature object.
   */
  private rowToFeature(row: FeatureRow): MissionFeature {
    return {
      id: row.id,
      sliceId: row.sliceId,
      taskId: row.taskId || undefined,
      title: row.title,
      description: row.description || undefined,
      acceptanceCriteria: row.acceptanceCriteria || undefined,
      status: row.status as FeatureStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      loopState: (row.loopState as import("./mission-types.js").FeatureLoopState) || "idle",
      implementationAttemptCount: row.implementationAttemptCount ?? 0,
      validatorAttemptCount: row.validatorAttemptCount ?? 0,
      lastValidatorRunId: row.lastValidatorRunId || undefined,
      lastValidatorStatus: row.lastValidatorStatus as import("./mission-types.js").ValidatorRunStatus || undefined,
      generatedFromFeatureId: row.generatedFromFeatureId || undefined,
      generatedFromRunId: row.generatedFromRunId || undefined,
    };
  }

  /**
   * Convert a database row to a MissionEvent object.
   */
  private rowToMissionEvent(row: MissionEventRow): MissionEvent {
    return {
      id: row.id,
      missionId: row.missionId,
      eventType: row.eventType as MissionEventType,
      description: row.description,
      metadata: fromJson<Record<string, unknown>>(row.metadata) ?? null,
      timestamp: row.timestamp,
      seq: row.seq ?? 0,
    };
  }

  /**
   * Convert a database row to a MissionValidatorRun object.
   */
  private rowToValidatorRun(row: ValidatorRunRow): MissionValidatorRun {
    return {
      id: row.id,
      featureId: row.featureId,
      milestoneId: row.milestoneId,
      sliceId: row.sliceId,
      status: row.status as ValidatorRunStatus,
      triggerType: row.triggerType || undefined,
      implementationAttempt: row.implementationAttempt ?? 0,
      validatorAttempt: row.validatorAttempt ?? 0,
      taskId: row.taskId || undefined,
      summary: row.summary || undefined,
      blockedReason: row.blockedReason || undefined,
      startedAt: row.startedAt,
      completedAt: row.completedAt || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Convert a database row to a MissionAssertionFailureRecord object.
   */
  private rowToFailure(row: FailureRow): MissionAssertionFailureRecord {
    return {
      id: row.id,
      runId: row.runId,
      featureId: row.featureId,
      assertionId: row.assertionId,
      message: row.message || undefined,
      expected: row.expected || undefined,
      actual: row.actual || undefined,
      createdAt: row.createdAt,
    };
  }

  /**
   * Convert a database row to a MissionFixFeatureLineage object.
   */
  private rowToLineage(row: LineageRow): MissionFixFeatureLineage {
    return {
      id: row.id,
      sourceFeatureId: row.sourceFeatureId,
      fixFeatureId: row.fixFeatureId,
      runId: row.runId,
      failedAssertionIds: fromJson<string[]>(row.failedAssertionIds) || [],
      createdAt: row.createdAt,
    };
  }

  // ── Mission CRUD Operations ────────────────────────────────────────

  /**
   * Create a new mission.
   * Missions are always created stopped (status `planning`, autopilot disabled).
   * Autopilot is only enabled via an explicit start/update after creation.
   *
   * @param input - Mission creation input
   * @returns The created mission
   */
  createMission(input: MissionCreateInput & { autopilotEnabled?: boolean }): Mission {
    const now = new Date().toISOString();
    const id = this.generateMissionId();

    const mission: Mission = {
      id,
      title: input.title,
      description: input.description,
      status: "planning",
      interviewState: "not_started",
      baseBranch: input.baseBranch,
      branchStrategy: input.branchStrategy,
      autoMerge: input.autoMerge,
      autoAdvance: false,
      autopilotEnabled: false,
      autopilotState: "inactive",
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO missions (id, title, description, status, interviewState, baseBranch, branchStrategy, autoMerge, autoAdvance, autopilotEnabled, autopilotState, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mission.id,
      mission.title,
      mission.description ?? null,
      mission.status,
      mission.interviewState,
      mission.baseBranch ?? null,
      mission.branchStrategy ? JSON.stringify(mission.branchStrategy) : null,
      mission.autoMerge === undefined ? null : (mission.autoMerge ? 1 : 0),
      mission.autoAdvance ? 1 : 0,
      mission.autopilotEnabled ? 1 : 0,
      mission.autopilotState ?? "inactive",
      mission.createdAt,
      mission.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("mission:created", mission);
    return mission;
  }

  /**
   * Get a mission by ID.
   *
   * @param id - Mission ID
   * @returns The mission, or undefined if not found
   */
  getMission(id: string): Mission | undefined {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as unknown as MissionRow | undefined;
    if (!row) return undefined;
    return this.rowToMission(row);
  }

  /**
   * Get a mission with its full hierarchy (milestones → slices → features).
   *
   * @param id - Mission ID
   * @returns The mission with hierarchy, or undefined if not found
   */
  getMissionWithHierarchy(id: string): MissionWithHierarchy | undefined {
    const mission = this.getMission(id);
    if (!mission) return undefined;

    const linkedGoals = this.listGoalsByIds(this.listGoalIdsForMission(id));

    const milestones = this.listMilestones(id);
    const milestonesWithSlices = milestones.map((milestone) => {
      const slices = this.listSlices(milestone.id);
      const slicesWithFeatures = slices.map((slice) => ({
        ...slice,
        features: this.listFeatures(slice.id),
      }));
      return {
        ...milestone,
        slices: slicesWithFeatures,
      };
    });

    const eventCountRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM mission_events WHERE missionId = ?")
      .get(id) as { count?: number | bigint } | undefined;
    const eventCount = Number(eventCountRow?.count ?? 0);

    return {
      ...mission,
      linkedGoals,
      eventCount,
      milestones: milestonesWithSlices,
    };
  }

  /**
   * List all missions, ordered by creation date (newest first).
   *
   * @returns Array of missions
   */
  listMissions(): Mission[] {
    const rows = this.db.prepare("SELECT * FROM missions ORDER BY createdAt DESC").all();
    return (rows as unknown as MissionRow[]).map((row) => this.rowToMission(row));
  }

  /**
   * Get a status summary for a mission, computing milestone and feature counts
   * and progress percentage from the hierarchy.
   *
   * Progress is calculated as:
   * - (completedFeatures / totalFeatures) * 100 if there are features
   * - (completedMilestones / totalMilestones) * 100 if there are milestones but no features
   * - 0 otherwise
   *
   * @param missionId - Mission ID
   * @returns MissionSummary with counts and progress
   */
  getMissionSummary(missionId: string): MissionSummary {
    const milestones = this.listMilestones(missionId);
    const totalMilestones = milestones.length;
    const completedMilestones = milestones.filter((m) => m.status === "complete").length;

    let totalFeatures = 0;
    let completedFeatures = 0;

    for (const milestone of milestones) {
      const slices = this.listSlices(milestone.id);
      for (const slice of slices) {
        const features = this.listFeatures(slice.id);
        totalFeatures += features.length;
        completedFeatures += features.filter((f) => f.status === "done").length;
      }
    }

    const linkedGoalRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM mission_goals WHERE missionId = ?")
      .get(missionId) as { count?: number | bigint } | undefined;
    const linkedGoalCount = Number(linkedGoalRow?.count ?? 0);

    const eventCountRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM mission_events WHERE missionId = ?")
      .get(missionId) as { count?: number | bigint } | undefined;
    const eventCount = Number(eventCountRow?.count ?? 0);

    let progressPercent = 0;
    if (totalFeatures > 0) {
      progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
    } else if (totalMilestones > 0) {
      progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
    }

    return {
      totalMilestones,
      completedMilestones,
      totalFeatures,
      completedFeatures,
      linkedGoalCount,
      eventCount,
      progressPercent,
    };
  }

  /**
   * List all missions with computed summaries in a single batch of queries.
   *
   * Instead of N×(1 + M×(1 + S×1)) queries (one per mission, then per-milestone,
   * per-slice, per-feature), this method fires 4 batch queries total and groups
   * the data in-memory for summary computation.
   *
   * @returns Array of missions with summary, sorted by createdAt DESC
   */
  listMissionsWithSummaries(): Array<Mission & { summary: MissionSummary }> {
    // 1. Fetch all missions
    const missions = this.listMissions();
    if (missions.length === 0) return [];

    // 2. Batch query all milestones
    const milestoneRows = this.db.prepare(
      "SELECT * FROM milestones ORDER BY orderIndex ASC"
    ).all() as unknown as MilestoneRow[];
    const allMilestones = milestoneRows.map((row) => this.rowToMilestone(row));

    // 3. Batch query all slices
    const sliceRows = this.db.prepare(
      "SELECT * FROM slices ORDER BY orderIndex ASC"
    ).all() as unknown as SliceRow[];
    const allSlices = sliceRows.map((row) => this.rowToSlice(row));

    // 4. Batch query all features
    const featureRows = this.db.prepare(
      "SELECT * FROM mission_features ORDER BY createdAt ASC"
    ).all() as unknown as FeatureRow[];
    const allFeatures = featureRows.map((row) => this.rowToFeature(row));

    // 5. Batch query linked goal counts
    const linkedGoalRows = this.db.prepare(
      "SELECT missionId, COUNT(*) AS count FROM mission_goals GROUP BY missionId"
    ).all() as Array<{ missionId: string; count?: number | bigint }>;
    const linkedGoalCountByMissionId = new Map(
      linkedGoalRows.map((row) => [row.missionId, Number(row.count ?? 0)]),
    );

    // 6. Batch query mission event counts
    const eventCountRows = this.db.prepare(
      "SELECT missionId, COUNT(*) AS count FROM mission_events GROUP BY missionId"
    ).all() as Array<{ missionId: string; count?: number | bigint }>;
    const eventCountByMissionId = new Map(
      eventCountRows.map((row) => [row.missionId, Number(row.count ?? 0)]),
    );

    // 7. Group in-memory: slices by milestoneId, features by sliceId
    const slicesByMilestoneId = new Map<string, Slice[]>();
    for (const slice of allSlices) {
      const list = slicesByMilestoneId.get(slice.milestoneId) || [];
      list.push(slice);
      slicesByMilestoneId.set(slice.milestoneId, list);
    }

    const featuresBySliceId = new Map<string, MissionFeature[]>();
    for (const feature of allFeatures) {
      const list = featuresBySliceId.get(feature.sliceId) || [];
      list.push(feature);
      featuresBySliceId.set(feature.sliceId, list);
    }

    // 8. Group milestones by missionId
    const milestonesByMissionId = new Map<string, Milestone[]>();
    for (const milestone of allMilestones) {
      const list = milestonesByMissionId.get(milestone.missionId) || [];
      list.push(milestone);
      milestonesByMissionId.set(milestone.missionId, list);
    }

    // 9. Compute summary for each mission using grouped data
    return missions.map((mission) => {
      const milestones = milestonesByMissionId.get(mission.id) || [];
      const totalMilestones = milestones.length;
      const completedMilestones = milestones.filter((m) => m.status === "complete").length;

      let totalFeatures = 0;
      let completedFeatures = 0;

      for (const milestone of milestones) {
        const slices = slicesByMilestoneId.get(milestone.id) || [];
        for (const slice of slices) {
          const features = featuresBySliceId.get(slice.id) || [];
          totalFeatures += features.length;
          completedFeatures += features.filter((f) => f.status === "done").length;
        }
      }

      const linkedGoalCount = linkedGoalCountByMissionId.get(mission.id) ?? 0;
      const eventCount = eventCountByMissionId.get(mission.id) ?? 0;

      let progressPercent = 0;
      if (totalFeatures > 0) {
        progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
      } else if (totalMilestones > 0) {
        progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
      }

      return {
        ...mission,
        summary: {
          totalMilestones,
          completedMilestones,
          totalFeatures,
          completedFeatures,
          linkedGoalCount,
          eventCount,
          progressPercent,
        },
      };
    });
  }

  /**
   * Compute health for ALL missions in a single batch of queries.
   *
   * Instead of N × (1 + M + S + F + failedTasks + lastError) individual queries,
   * this method fires a fixed number of batch queries and groups in-memory.
   *
   * @returns Map of mission ID → MissionHealth
   */
  listMissionsHealth(): Map<string, MissionHealth> {
    const missions = this.listMissions();
    if (missions.length === 0) return new Map();

    // 1. Batch query all milestones
    const milestoneRows = this.db.prepare(
      "SELECT * FROM milestones ORDER BY orderIndex ASC"
    ).all() as unknown as MilestoneRow[];
    const allMilestones = milestoneRows.map((row) => this.rowToMilestone(row));

    // 2. Batch query all slices
    const sliceRows = this.db.prepare(
      "SELECT * FROM slices ORDER BY orderIndex ASC"
    ).all() as unknown as SliceRow[];
    const allSlices = sliceRows.map((row) => this.rowToSlice(row));

    // 3. Batch query all features
    const featureRows = this.db.prepare(
      "SELECT * FROM mission_features ORDER BY createdAt ASC"
    ).all() as unknown as FeatureRow[];
    const allFeatures = featureRows.map((row) => this.rowToFeature(row));

    // 4. Batch query all failed task IDs
    const failedTaskRows = this.db.prepare(
      "SELECT id FROM tasks WHERE status = 'failed' AND \"deletedAt\" IS NULL"
    ).all() as Array<{ id: string }>;
    const failedTaskIds = new Set(failedTaskRows.map((row) => row.id));

    // 5. Batch query last error event per mission
    const lastErrorRows = this.db.prepare(`
      SELECT missionId, timestamp, description
      FROM mission_events
      WHERE eventType = 'error'
      ORDER BY seq DESC, id DESC
    `).all() as Array<{ missionId: string; timestamp: string; description: string }>;
    // Only keep the first (latest) error per missionId
    const lastErrorByMission = new Map<string, { timestamp: string; description: string }>();
    for (const row of lastErrorRows) {
      if (!lastErrorByMission.has(row.missionId)) {
        lastErrorByMission.set(row.missionId, { timestamp: row.timestamp, description: row.description });
      }
    }

    // 6. Group hierarchy in-memory
    const milestonesByMissionId = new Map<string, Milestone[]>();
    for (const milestone of allMilestones) {
      const list = milestonesByMissionId.get(milestone.missionId) || [];
      list.push(milestone);
      milestonesByMissionId.set(milestone.missionId, list);
    }

    const slicesByMilestoneId = new Map<string, Slice[]>();
    for (const slice of allSlices) {
      const list = slicesByMilestoneId.get(slice.milestoneId) || [];
      list.push(slice);
      slicesByMilestoneId.set(slice.milestoneId, list);
    }

    const featuresBySliceId = new Map<string, MissionFeature[]>();
    for (const feature of allFeatures) {
      const list = featuresBySliceId.get(feature.sliceId) || [];
      list.push(feature);
      featuresBySliceId.set(feature.sliceId, list);
    }

    // 7. Compute health for each mission
    const result = new Map<string, MissionHealth>();

    for (const mission of missions) {
      const milestones = milestonesByMissionId.get(mission.id) || [];

      let totalTasks = 0;
      let tasksCompleted = 0;
      let tasksInFlight = 0;
      let tasksFailed = 0;
      let currentSliceId: string | undefined;
      let currentMilestoneId: string | undefined;

      const totalMilestones = milestones.length;
      let completedMilestones = 0;
      let totalFeatures = 0;
      let completedFeatures = 0;

      for (const milestone of milestones) {
        if (milestone.status === "complete") {
          completedMilestones++;
        }
        if (!currentMilestoneId && milestone.status === "active") {
          currentMilestoneId = milestone.id;
        }

        const slices = slicesByMilestoneId.get(milestone.id) || [];
        for (const slice of slices) {
          if (!currentSliceId && slice.status === "active") {
            currentSliceId = slice.id;
            currentMilestoneId ??= milestone.id;
          }

          const features = featuresBySliceId.get(slice.id) || [];
          for (const feature of features) {
            totalFeatures++;
            totalTasks += 1;
            if (feature.status === "done") {
              tasksCompleted += 1;
              completedFeatures++;
            }
            if (feature.status === "triaged" || feature.status === "in-progress") {
              tasksInFlight += 1;
            }
            if (feature.taskId && failedTaskIds.has(feature.taskId)) {
              tasksFailed++;
            }
          }
        }
      }

      let progressPercent = 0;
      if (totalFeatures > 0) {
        progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
      } else if (totalMilestones > 0) {
        progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
      }

      const lastError = lastErrorByMission.get(mission.id);

      result.set(mission.id, {
        missionId: mission.id,
        status: mission.status,
        tasksCompleted,
        tasksFailed,
        tasksInFlight,
        totalTasks,
        currentSliceId,
        currentMilestoneId,
        estimatedCompletionPercent: progressPercent,
        lastErrorAt: lastError?.timestamp,
        lastErrorDescription: lastError?.description,
        autopilotState: mission.autopilotState ?? "inactive",
        autopilotEnabled: mission.autopilotEnabled ?? false,
        lastActivityAt: mission.lastAutopilotActivityAt,
      });
    }

    return result;
  }

  /**
   * Persist a mission lifecycle event for observability and auditing.
   */
  logMissionEvent(
    missionId: string,
    eventType: MissionEventType,
    description: string,
    metadata?: Record<string, unknown>,
  ): MissionEvent {
    const mission = this.getMission(missionId);
    if (!mission) {
      throw new Error(`Mission ${missionId} not found`);
    }

    const event: MissionEvent = {
      id: this.generateMissionEventId(),
      missionId,
      eventType,
      description,
      metadata: metadata ?? null,
      timestamp: new Date().toISOString(),
      seq: ++this._eventSeq,
    };

    this.db.prepare(`
      INSERT INTO mission_events (id, missionId, eventType, description, metadata, timestamp, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.missionId,
      event.eventType,
      event.description,
      toJsonNullable(event.metadata),
      event.timestamp,
      event.seq,
    );

    this.db.bumpLastModified();
    this.emit("mission:event", event);
    return event;
  }

  /**
   * List mission lifecycle events with pagination/filtering.
   */
  getMissionEvents(
    missionId: string,
    options?: { limit?: number; offset?: number; eventType?: string },
  ): { events: MissionEvent[]; total: number } {
    const limit = Math.max(0, options?.limit ?? 50);
    const offset = Math.max(0, options?.offset ?? 0);
    const eventType = options?.eventType;

    const whereClauses = ["missionId = ?"];
    const params: string[] = [missionId];

    if (eventType) {
      whereClauses.push("eventType = ?");
      params.push(eventType);
    }

    const whereSql = whereClauses.join(" AND ");
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM mission_events
      WHERE ${whereSql}
    `).get(...params) as { count: number };

    const rows = this.db.prepare(`
      SELECT *
      FROM mission_events
      WHERE ${whereSql}
      ORDER BY COALESCE(seq, 0) DESC, timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as MissionEventRow[];

    return {
      events: rows.map((row) => this.rowToMissionEvent(row)),
      total: totalRow?.count ?? 0,
    };
  }

  /**
   * Compute a mission health snapshot for observability endpoints.
   */
  getMissionHealth(missionId: string): MissionHealth | undefined {
    const mission = this.getMission(missionId);
    if (!mission) {
      return undefined;
    }

    const milestones = this.listMilestones(missionId);
    const summary = this.getMissionSummary(missionId);

    let totalTasks = 0;
    let tasksCompleted = 0;
    let tasksInFlight = 0;
    let currentSliceId: string | undefined;
    let currentMilestoneId: string | undefined;
    const featureTaskIds: string[] = [];

    for (const milestone of milestones) {
      if (!currentMilestoneId && milestone.status === "active") {
        currentMilestoneId = milestone.id;
      }

      const slices = this.listSlices(milestone.id);
      for (const slice of slices) {
        if (!currentSliceId && slice.status === "active") {
          currentSliceId = slice.id;
          currentMilestoneId ??= milestone.id;
        }

        const features = this.listFeatures(slice.id);
        for (const feature of features) {
          totalTasks += 1;
          if (feature.status === "done") {
            tasksCompleted += 1;
          }
          if (feature.status === "triaged" || feature.status === "in-progress") {
            tasksInFlight += 1;
          }
          if (feature.taskId) {
            featureTaskIds.push(feature.taskId);
          }
        }
      }
    }

    let tasksFailed = 0;
    if (featureTaskIds.length > 0) {
      const uniqueTaskIds = [...new Set(featureTaskIds)];
      const placeholders = uniqueTaskIds.map(() => "?").join(", ");
      const failedTaskRows = this.db.prepare(`
        SELECT id
        FROM tasks
        WHERE "deletedAt" IS NULL AND status = 'failed' AND id IN (${placeholders})
      `).all(...uniqueTaskIds) as Array<{ id: string }>;
      const failedTaskIds = new Set(failedTaskRows.map((row) => row.id));
      tasksFailed = featureTaskIds.filter((taskId) => failedTaskIds.has(taskId)).length;
    }

    const lastErrorRow = this.db.prepare(`
      SELECT timestamp, description
      FROM mission_events
      WHERE missionId = ? AND eventType = 'error'
      ORDER BY seq DESC, id DESC
      LIMIT 1
    `).get(missionId) as { timestamp: string; description: string } | undefined;

    return {
      missionId,
      status: mission.status,
      tasksCompleted,
      tasksFailed,
      tasksInFlight,
      totalTasks,
      currentSliceId,
      currentMilestoneId,
      estimatedCompletionPercent: summary.progressPercent,
      lastErrorAt: lastErrorRow?.timestamp,
      lastErrorDescription: lastErrorRow?.description,
      autopilotState: mission.autopilotState ?? "inactive",
      autopilotEnabled: mission.autopilotEnabled ?? false,
      lastActivityAt: mission.lastAutopilotActivityAt,
    };
  }

  /**
   * Update a mission.
   *
   * @param id - Mission ID
   * @param updates - Partial mission updates (cannot update id or createdAt)
   * @returns The updated mission
   * @throws Error if mission not found
   */
  updateMission(id: string, updates: Partial<Mission>): Mission {
    const mission = this.getMission(id);
    if (!mission) {
      throw new Error(`Mission ${id} not found`);
    }

    const updated: Mission = {
      ...mission,
      ...updates,
      id, // Prevent changing ID
      createdAt: mission.createdAt, // Prevent changing creation time
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE missions SET
        title = ?,
        description = ?,
        status = ?,
        interviewState = ?,
        baseBranch = ?,
        branchStrategy = ?,
        autoMerge = ?,
        autoAdvance = ?,
        autopilotEnabled = ?,
        autopilotState = ?,
        lastAutopilotActivityAt = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.status,
      updated.interviewState,
      updated.baseBranch ?? null,
      updated.branchStrategy ? JSON.stringify(updated.branchStrategy) : null,
      updated.autoMerge === undefined ? null : (updated.autoMerge ? 1 : 0),
      updated.autoAdvance ? 1 : 0,
      updated.autopilotEnabled ? 1 : 0,
      updated.autopilotState ?? "inactive",
      updated.lastAutopilotActivityAt ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("mission:updated", updated);
    return updated;
  }

  /**
   * Delete a mission.
   * Cascades to delete all milestones, slices, and features.
   *
   * @param id - Mission ID
   * @throws Error if mission not found
   */
  deleteMission(id: string): void {
    const mission = this.getMission(id);
    if (!mission) {
      throw new Error(`Mission ${id} not found`);
    }

    this.db.prepare("DELETE FROM missions WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("mission:deleted", id);
  }

  /**
   * Update the interview state for a mission.
   * Convenience method for the specification workflow.
   *
   * @param id - Mission ID
   * @param state - New interview state
   * @returns The updated mission
   */
  updateMissionInterviewState(id: string, state: InterviewState): Mission {
    return this.updateMission(id, { interviewState: state });
  }

  linkGoal(missionId: string, goalId: string): MissionGoalLink {
    const result = this.db.transactionImmediate(() => {
      const missionExists = this.db
        .prepare("SELECT id FROM missions WHERE id = ?")
        .get(missionId) as { id: string } | undefined;
      if (!missionExists) {
        throw new Error(`Mission ${missionId} not found`);
      }

      const goalExists = this.db
        .prepare("SELECT id FROM goals WHERE id = ?")
        .get(goalId) as { id: string } | undefined;
      if (!goalExists) {
        throw new Error(`Goal ${goalId} not found`);
      }

      const existing = this.db
        .prepare("SELECT missionId, goalId, createdAt FROM mission_goals WHERE missionId = ? AND goalId = ?")
        .get(missionId, goalId) as MissionGoalRow | undefined;
      if (existing) {
        return { link: this.rowToMissionGoalLink(existing), changed: false };
      }

      const createdAt = new Date().toISOString();
      this.db
        .prepare("INSERT OR IGNORE INTO mission_goals (missionId, goalId, createdAt) VALUES (?, ?, ?)")
        .run(missionId, goalId, createdAt);

      const row = this.db
        .prepare("SELECT missionId, goalId, createdAt FROM mission_goals WHERE missionId = ? AND goalId = ?")
        .get(missionId, goalId) as MissionGoalRow | undefined;
      if (!row) {
        throw new Error(`Failed to link mission ${missionId} to goal ${goalId}`);
      }

      return { link: this.rowToMissionGoalLink(row), changed: true };
    });

    if (result.changed) {
      this.db.bumpLastModified();
      this.emit("mission:goal-linked", result.link);
    }

    return result.link;
  }

  unlinkGoal(missionId: string, goalId: string): boolean {
    const deleted = this.db.transactionImmediate(() => {
      const row = this.db
        .prepare("SELECT missionId, goalId, createdAt FROM mission_goals WHERE missionId = ? AND goalId = ?")
        .get(missionId, goalId) as MissionGoalRow | undefined;
      if (!row) {
        return undefined;
      }

      const result = this.db
        .prepare("DELETE FROM mission_goals WHERE missionId = ? AND goalId = ?")
        .run(missionId, goalId);
      if (result.changes < 1) {
        return undefined;
      }

      return this.rowToMissionGoalLink(row);
    });

    if (!deleted) {
      return false;
    }

    this.db.bumpLastModified();
    this.emit("mission:goal-unlinked", deleted);
    return true;
  }

  listGoalIdsForMission(missionId: string): string[] {
    const rows = this.db
      .prepare("SELECT goalId FROM mission_goals WHERE missionId = ? ORDER BY createdAt ASC, goalId ASC")
      .all(missionId) as Array<{ goalId: string }>;
    return rows.map((row) => row.goalId);
  }

  listMissionIdsForGoal(goalId: string): string[] {
    const rows = this.db
      .prepare("SELECT missionId FROM mission_goals WHERE goalId = ? ORDER BY createdAt ASC, missionId ASC")
      .all(goalId) as Array<{ missionId: string }>;
    return rows.map((row) => row.missionId);
  }

  /**
   * Resolve task → goal provenance by deriving the owning mission from mission linkage.
   * Goal IDs are never duplicated onto the task row; provenance is always recovered from mission links.
   */
  listGoalIdsForTask(taskId: string): string[] {
    const feature = this.getFeatureByTaskId(taskId);
    const missionIdFromFeature = feature
      ? (() => {
          const slice = this.getSlice(feature.sliceId);
          if (!slice) {
            return undefined;
          }
          const milestone = this.getMilestone(slice.milestoneId);
          return milestone?.missionId;
        })()
      : undefined;

    const missionId = missionIdFromFeature ?? (() => {
      const row = this.db
        .prepare('SELECT missionId FROM tasks WHERE id = ? AND "deletedAt" IS NULL')
        .get(taskId) as { missionId?: string | null } | undefined;
      return row?.missionId ?? undefined;
    })();

    if (!missionId) {
      return [];
    }

    return this.listGoalIdsForMission(missionId);
  }

  /**
   * Resolve task → goal provenance to full Goal records derived from the owning mission.
   * Goal rows are read on demand so archived goals remain visible without storing duplicate task-level goal data.
   */
  listGoalsForTask(taskId: string): Goal[] {
    return this.listGoalsByIds(this.listGoalIdsForTask(taskId));
  }

  // ── Milestone Operations ───────────────────────────────────────────

  /**
   * Add a milestone to a mission.
   * Automatically computes the orderIndex (max + 1).
   *
   * @param missionId - Parent mission ID
   * @param input - Milestone creation input
   * @returns The created milestone
   * @throws Error if mission not found
   */
  addMilestone(missionId: string, input: MilestoneCreateInput): Milestone {
    const mission = this.getMission(missionId);
    if (!mission) {
      throw new Error(`Mission ${missionId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateMilestoneId();

    // Compute next orderIndex
    const existingMilestones = this.listMilestones(missionId);
    const orderIndex = existingMilestones.length > 0
      ? Math.max(...existingMilestones.map((m) => m.orderIndex)) + 1
      : 0;

    const milestone: Milestone = {
      id,
      missionId,
      title: input.title,
      description: input.description,
      status: "planning",
      orderIndex,
      interviewState: "not_started",
      dependencies: input.dependencies || [],
      planningNotes: input.planningNotes,
      verification: input.verification,
      acceptanceCriteria: input.acceptanceCriteria,
      validationState: "not_started",
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO milestones (id, missionId, title, description, status, orderIndex, interviewState, dependencies, planningNotes, verification, acceptanceCriteria, validationState, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      milestone.id,
      milestone.missionId,
      milestone.title,
      milestone.description ?? null,
      milestone.status,
      milestone.orderIndex,
      milestone.interviewState,
      toJson(milestone.dependencies),
      milestone.planningNotes ?? null,
      milestone.verification ?? null,
      milestone.acceptanceCriteria ?? null,
      milestone.validationState as string,
      milestone.createdAt,
      milestone.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("milestone:created", milestone);
    return milestone;
  }

  /**
   * Get a milestone by ID.
   *
   * @param id - Milestone ID
   * @returns The milestone, or undefined if not found
   */
  getMilestone(id: string): Milestone | undefined {
    const row = this.db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as unknown as MilestoneRow | undefined;
    if (!row) return undefined;
    return this.rowToMilestone(row);
  }

  /**
   * List milestones for a mission, ordered by orderIndex.
   *
   * @param missionId - Mission ID
   * @returns Array of milestones
   */
  listMilestones(missionId: string): Milestone[] {
    const rows = this.db.prepare(
      "SELECT * FROM milestones WHERE missionId = ? ORDER BY orderIndex ASC"
    ).all(missionId);
    return (rows as unknown as MilestoneRow[]).map((row) => this.rowToMilestone(row));
  }

  /**
   * Update a milestone.
   *
   * @param id - Milestone ID
   * @param updates - Partial milestone updates
   * @returns The updated milestone
   * @throws Error if milestone not found
   */
  updateMilestone(id: string, updates: Partial<Milestone>): Milestone {
    const milestone = this.getMilestone(id);
    if (!milestone) {
      throw new Error(`Milestone ${id} not found`);
    }

    const updated: Milestone = {
      ...milestone,
      ...updates,
      id,
      missionId: milestone.missionId, // Prevent moving to different mission
      createdAt: milestone.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE milestones SET
        title = ?,
        description = ?,
        status = ?,
        orderIndex = ?,
        interviewState = ?,
        dependencies = ?,
        planningNotes = ?,
        verification = ?,
        acceptanceCriteria = ?,
        validationState = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.status,
      updated.orderIndex,
      updated.interviewState,
      toJson(updated.dependencies),
      updated.planningNotes ?? null,
      updated.verification ?? null,
      updated.acceptanceCriteria ?? null,
      updated.validationState || "not_started",
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("milestone:updated", updated);

    // Recompute mission status after milestone update
    this.recomputeMissionStatus(updated.missionId);

    return updated;
  }

  /**
   * Delete a milestone.
   * Cascades to delete all slices and features.
   *
   * @param id - Milestone ID
   * @param force - Override linked live-task guard for child features
   * @throws Error if milestone not found
   */
  deleteMilestone(id: string, force = false): void {
    const milestone = this.getMilestone(id);
    if (!milestone) {
      throw new Error(`Milestone ${id} not found`);
    }

    const missionId = milestone.missionId;
    const features = this.listSlices(id).flatMap((slice) => this.listFeatures(slice.id));
    const blockingLinks = this.getLiveTaskLinkedFeatures(features);

    if (blockingLinks.length > 0 && !force) {
      throw new Error(
        `Milestone ${id} has features linked to live tasks: ${blockingLinks.map((link) => `${link.featureId}->${link.taskId}`).join(", ")}; pass force to delete anyway`,
      );
    }

    this.db.transaction(() => {
      if (force) {
        for (const link of blockingLinks) {
          this.db.prepare("UPDATE mission_features SET taskId = NULL, updatedAt = ? WHERE id = ?").run(new Date().toISOString(), link.featureId);
          this.db.prepare("UPDATE tasks SET missionId = NULL, sliceId = NULL WHERE id = ? AND \"deletedAt\" IS NULL").run(link.taskId);
        }
      }

      this.db.prepare("DELETE FROM milestones WHERE id = ?").run(id);
    });
    this.db.bumpLastModified();

    this.emit("milestone:deleted", id);

    // Recompute mission status after deletion
    this.recomputeMissionStatus(missionId);
  }

  /**
   * Reorder milestones within a mission.
   * Updates the orderIndex for each milestone in the provided order.
   *
   * @param missionId - Mission ID
   * @param orderedIds - Milestone IDs in the desired order
   * @throws Error if any milestone is not found or belongs to a different mission
   */
  reorderMilestones(missionId: string, orderedIds: string[]): void {
    this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        const milestone = this.getMilestone(id);

        if (!milestone) {
          throw new Error(`Milestone ${id} not found`);
        }
        if (milestone.missionId !== missionId) {
          throw new Error(`Milestone ${id} does not belong to mission ${missionId}`);
        }

        this.db.prepare(
          "UPDATE milestones SET orderIndex = ?, updatedAt = ? WHERE id = ?"
        ).run(i, new Date().toISOString(), id);
      }
    });

    this.db.bumpLastModified();
  }

  /**
   * Update the interview state for a milestone.
   *
   * @param id - Milestone ID
   * @param state - New interview state
   * @returns The updated milestone
   */
  updateMilestoneInterviewState(id: string, state: InterviewState): Milestone {
    return this.updateMilestone(id, { interviewState: state });
  }

  applyDerivedMilestoneAcceptanceCriteria(milestoneId: string): Milestone {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    if (milestone.acceptanceCriteria?.trim()) {
      return milestone;
    }

    const features = this.listSlices(milestoneId).flatMap((slice) => this.listFeatures(slice.id));
    const derivedAcceptanceCriteria = deriveMilestoneAcceptanceCriteriaFromFeatures(features);

    if (!derivedAcceptanceCriteria) {
      return milestone;
    }

    return this.updateMilestone(milestoneId, { acceptanceCriteria: derivedAcceptanceCriteria });
  }

  // ── Slice Operations ───────────────────────────────────────────────

  /**
   * Add a slice to a milestone.
   * Automatically computes the orderIndex (max + 1).
   * Initial status is "pending".
   *
   * @param milestoneId - Parent milestone ID
   * @param input - Slice creation input
   * @returns The created slice
   * @throws Error if milestone not found
   */
  addSlice(milestoneId: string, input: SliceCreateInput): Slice {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateSliceId();

    // Compute next orderIndex
    const existingSlices = this.listSlices(milestoneId);
    const orderIndex = existingSlices.length > 0
      ? Math.max(...existingSlices.map((s) => s.orderIndex)) + 1
      : 0;

    const slice: Slice = {
      id,
      milestoneId,
      title: input.title,
      description: input.description,
      status: "pending",
      planState: "not_started",
      orderIndex,
      planningNotes: input.planningNotes,
      verification: input.verification,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO slices (id, milestoneId, title, description, status, orderIndex, planState, planningNotes, verification, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slice.id,
      slice.milestoneId,
      slice.title,
      slice.description ?? null,
      slice.status,
      slice.orderIndex,
      slice.planState,
      slice.planningNotes ?? null,
      slice.verification ?? null,
      slice.createdAt,
      slice.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("slice:created", slice);
    return slice;
  }

  /**
   * Get a slice by ID.
   *
   * @param id - Slice ID
   * @returns The slice, or undefined if not found
   */
  getSlice(id: string): Slice | undefined {
    const row = this.db.prepare("SELECT * FROM slices WHERE id = ?").get(id) as unknown as SliceRow | undefined;
    if (!row) return undefined;
    return this.rowToSlice(row);
  }

  /**
   * List slices for a milestone, ordered by orderIndex.
   *
   * @param milestoneId - Milestone ID
   * @returns Array of slices
   */
  listSlices(milestoneId: string): Slice[] {
    const rows = this.db.prepare(
      "SELECT * FROM slices WHERE milestoneId = ? ORDER BY orderIndex ASC"
    ).all(milestoneId);
    return (rows as unknown as SliceRow[]).map((row) => this.rowToSlice(row));
  }

  /**
   * Update a slice.
   *
   * @param id - Slice ID
   * @param updates - Partial slice updates
   * @returns The updated slice
   * @throws Error if slice not found
   */
  updateSlice(id: string, updates: Partial<Slice>): Slice {
    const slice = this.getSlice(id);
    if (!slice) {
      throw new Error(`Slice ${id} not found`);
    }

    const updated: Slice = {
      ...slice,
      ...updates,
      id,
      milestoneId: slice.milestoneId,
      createdAt: slice.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE slices SET
        title = ?,
        description = ?,
        status = ?,
        orderIndex = ?,
        activatedAt = ?,
        planState = ?,
        planningNotes = ?,
        verification = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.status,
      updated.orderIndex,
      updated.activatedAt ?? null,
      updated.planState,
      updated.planningNotes ?? null,
      updated.verification ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("slice:updated", updated);

    // Recompute milestone status after slice update
    this.recomputeMilestoneStatus(updated.milestoneId);

    return updated;
  }

  /**
   * Delete a slice.
   * Cascades to delete all features.
   *
   * @param id - Slice ID
   * @param force - Override linked live-task guard for child features
   * @throws Error if slice not found
   */
  deleteSlice(id: string, force = false): void {
    const slice = this.getSlice(id);
    if (!slice) {
      throw new Error(`Slice ${id} not found`);
    }

    const milestoneId = slice.milestoneId;
    const features = this.listFeatures(id);
    const blockingLinks = this.getLiveTaskLinkedFeatures(features);

    if (blockingLinks.length > 0 && !force) {
      throw new Error(
        `Slice ${id} has features linked to live tasks: ${blockingLinks.map((link) => `${link.featureId}->${link.taskId}`).join(", ")}; pass force to delete anyway`,
      );
    }

    this.db.transaction(() => {
      if (force) {
        for (const link of blockingLinks) {
          this.db.prepare("UPDATE mission_features SET taskId = NULL, updatedAt = ? WHERE id = ?").run(new Date().toISOString(), link.featureId);
          this.db.prepare("UPDATE tasks SET missionId = NULL, sliceId = NULL WHERE id = ? AND \"deletedAt\" IS NULL").run(link.taskId);
        }
      }

      this.db.prepare("DELETE FROM slices WHERE id = ?").run(id);
    });
    this.db.bumpLastModified();

    this.emit("slice:deleted", id);

    // Recompute milestone status after deletion
    this.recomputeMilestoneStatus(milestoneId);
  }

  /**
   * Reorder slices within a milestone.
   *
   * @param milestoneId - Milestone ID
   * @param orderedIds - Slice IDs in the desired order
   * @throws Error if any slice is not found or belongs to a different milestone
   */
  reorderSlices(milestoneId: string, orderedIds: string[]): void {
    this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        const slice = this.getSlice(id);

        if (!slice) {
          throw new Error(`Slice ${id} not found`);
        }
        if (slice.milestoneId !== milestoneId) {
          throw new Error(`Slice ${id} does not belong to milestone ${milestoneId}`);
        }

        this.db.prepare(
          "UPDATE slices SET orderIndex = ?, updatedAt = ? WHERE id = ?"
        ).run(i, new Date().toISOString(), id);
      }
    });

    this.db.bumpLastModified();
  }

  /**
   * Activate a slice for implementation.
   * Sets status to "active" and records activation time.
   * When the parent mission has `autoAdvance: true`, all "defined" features
   * in the slice are automatically triaged (converted to tasks and linked).
   *
   * @param id - Slice ID
   * @returns The activated slice
   * @throws Error if slice not found
   */
  async activateSlice(id: string): Promise<Slice> {
    const slice = this.getSlice(id);
    if (!slice) {
      throw new Error(`Slice ${id} not found`);
    }

    const milestone = this.getMilestone(slice.milestoneId);
    const mission = milestone ? this.getMission(milestone.missionId) : undefined;

    // Use autopilotEnabled as canonical, fall back to autoAdvance for backward compat
    const shouldAutoTriage =
      mission?.autopilotEnabled === true || mission?.autoAdvance === true;

    const now = new Date().toISOString();
    const updated = this.updateSlice(id, {
      status: "active",
      activatedAt: now,
    });

    // Auto-triage features if autopilot is enabled (or legacy autoAdvance)
    if (shouldAutoTriage) {
      try {
        await this.triageSlice(id);
      } catch (err) {
        // Log but don't fail — triage failures shouldn't block slice activation
        console.error(`[MissionStore] Auto-triage failed for slice ${id}:`, err);
      }
    }

    this.emit("slice:activated", updated);
    return updated;
  }

  /**
   * Find the next pending slice in a mission.
   * Iterates milestones by orderIndex, then slices by orderIndex,
   * and returns the first slice with status "pending".
   *
   * @param missionId - Mission ID
   * @returns The next pending slice, or undefined if none found
   */
  findNextPendingSlice(missionId: string): Slice | undefined {
    const milestones = this.listMilestones(missionId);

    for (const milestone of milestones) {
      const slices = this.listSlices(milestone.id);
      for (const slice of slices) {
        if (slice.status === "pending") {
          return slice;
        }
      }
    }

    return undefined;
  }

  // ── Feature Operations ─────────────────────────────────────────────

  /**
   * Add a feature to a slice.
   * Initial status is "defined".
   *
   * @param sliceId - Parent slice ID
   * @param input - Feature creation input
   * @returns The created feature
   * @throws Error if slice not found
   */
  addFeature(sliceId: string, input: FeatureCreateInput): MissionFeature {
    const slice = this.getSlice(sliceId);
    if (!slice) {
      throw new Error(`Slice ${sliceId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateFeatureId();

    const feature: MissionFeature = {
      id,
      sliceId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      status: "defined",
      createdAt: now,
      updatedAt: now,
      loopState: "idle",
      implementationAttemptCount: 0,
      validatorAttemptCount: 0,
    };

    this.db.prepare(`
      INSERT INTO mission_features (id, sliceId, title, description, acceptanceCriteria, status, loopState, implementationAttemptCount, validatorAttemptCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feature.id,
      feature.sliceId,
      feature.title,
      feature.description ?? null,
      feature.acceptanceCriteria ?? null,
      feature.status,
      feature.loopState ?? "idle",
      feature.implementationAttemptCount ?? 0,
      feature.validatorAttemptCount ?? 0,
      feature.createdAt,
      feature.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("feature:created", feature);

    // Cascade status recompute upward: a newly added feature with status "defined"
    // may downgrade the slice from "complete" → "pending", which in turn should
    // update the parent milestone and mission statuses. Calling recomputeSliceStatus
    // here ensures the full chain is updated atomically when a feature is added.
    this.recomputeSliceStatus(sliceId);
    this.applyDerivedMilestoneAcceptanceCriteria(slice.milestoneId);
    this.ensureFeatureAssertion(feature);

    return this.getFeature(feature.id) ?? feature;
  }

  /**
   * Get a feature by ID.
   *
   * @param id - Feature ID
   * @returns The feature, or undefined if not found
   */
  getFeature(id: string): MissionFeature | undefined {
    const row = this.db.prepare("SELECT * FROM mission_features WHERE id = ?").get(id) as unknown as FeatureRow | undefined;
    if (!row) return undefined;
    return this.rowToFeature(row);
  }

  /**
   * List features for a slice, ordered by creation date.
   *
   * @param sliceId - Slice ID
   * @returns Array of features
   */
  listFeatures(sliceId: string): MissionFeature[] {
    const rows = this.db.prepare(
      "SELECT * FROM mission_features WHERE sliceId = ? ORDER BY createdAt ASC"
    ).all(sliceId);
    return (rows as unknown as FeatureRow[]).map((row) => this.rowToFeature(row));
  }

  /**
   * Update a feature.
   *
   * @param id - Feature ID
   * @param updates - Partial feature updates
   * @returns The updated feature
   * @throws Error if feature not found
   */
  updateFeature(id: string, updates: Partial<MissionFeature>): MissionFeature {
    const feature = this.getFeature(id);
    if (!feature) {
      throw new Error(`Feature ${id} not found`);
    }

    const updated: MissionFeature = {
      ...feature,
      ...updates,
      id,
      sliceId: feature.sliceId,
      createdAt: feature.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE mission_features SET
        title = ?,
        description = ?,
        acceptanceCriteria = ?,
        status = ?,
        taskId = ?,
        loopState = ?,
        implementationAttemptCount = ?,
        validatorAttemptCount = ?,
        lastValidatorRunId = ?,
        lastValidatorStatus = ?,
        generatedFromFeatureId = ?,
        generatedFromRunId = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.description ?? null,
      updated.acceptanceCriteria ?? null,
      updated.status,
      updated.taskId ?? null,
      updated.loopState ?? "idle",
      updated.implementationAttemptCount ?? 0,
      updated.validatorAttemptCount ?? 0,
      updated.lastValidatorRunId ?? null,
      updated.lastValidatorStatus ?? null,
      updated.generatedFromFeatureId ?? null,
      updated.generatedFromRunId ?? null,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("feature:updated", updated);

    // Recompute slice status if task linkage or status changed
    const taskIdChanged = updates.taskId !== undefined && updates.taskId !== feature.taskId;
    const statusChanged = updates.status !== undefined && updates.status !== feature.status;
    if (taskIdChanged || statusChanged) {
      this.recomputeSliceStatus(updated.sliceId);
    }

    const shouldSyncAssertion = updates.title !== undefined
      || updates.description !== undefined
      || updates.acceptanceCriteria !== undefined;
    if (shouldSyncAssertion) {
      this.ensureFeatureAssertion(updated);
      return this.getFeature(updated.id) ?? updated;
    }

    return updated;
  }

  /**
   * Delete a feature.
   *
   * @param id - Feature ID
   * @param force - Override linked live-task guard
   * @throws Error if feature not found
   */
  deleteFeature(id: string, force = false): void {
    const feature = this.getFeature(id);
    if (!feature) {
      throw new Error(`Feature ${id} not found`);
    }

    if (feature.taskId) {
      const linkedTask = this.db.prepare(
        `SELECT id, "column" FROM tasks WHERE id = ? AND "deletedAt" IS NULL`
      ).get(feature.taskId) as { id: string; column: string } | undefined;
      const linkedToLiveTask = linkedTask && linkedTask.column !== "archived";

      if (linkedToLiveTask && !force) {
        throw new Error(`Feature ${id} is linked to task ${feature.taskId}; pass force to delete anyway`);
      }
    }

    const sliceId = feature.sliceId;
    const slice = this.getSlice(sliceId);
    const milestoneId = slice?.milestoneId;

    this.db.transaction(() => {
      if (force && feature.taskId) {
        this.db.prepare("UPDATE mission_features SET taskId = NULL, updatedAt = ? WHERE id = ?").run(new Date().toISOString(), id);
        this.db.prepare("UPDATE tasks SET missionId = NULL, sliceId = NULL WHERE id = ? AND \"deletedAt\" IS NULL").run(feature.taskId);
      }

      if (milestoneId) {
        const managedAssertion = this.listContractAssertions(milestoneId)
          .find((assertion) => assertion.sourceFeatureId === feature.id);
        if (managedAssertion) {
          this.deleteContractAssertion(managedAssertion.id);
        }
      }

      this.db.prepare("DELETE FROM mission_features WHERE id = ?").run(id);
    });
    this.db.bumpLastModified();

    this.emit("feature:deleted", id);

    // Recompute slice status after deletion
    this.recomputeSliceStatus(sliceId);
  }

  private getLiveTaskLinkedFeatures(features: MissionFeature[]): Array<{ featureId: string; taskId: string }> {
    const links = features
      .filter((feature): feature is MissionFeature & { taskId: string } => Boolean(feature.taskId))
      .map((feature) => ({ featureId: feature.id, taskId: feature.taskId }));

    if (links.length === 0) {
      return [];
    }

    const placeholders = links.map(() => "?").join(", ");
    const liveRows = this.db.prepare(
      `SELECT id FROM tasks WHERE id IN (${placeholders}) AND "deletedAt" IS NULL AND "column" != 'archived'`
    ).all(...links.map((link) => link.taskId)) as Array<{ id: string }>;
    const liveTaskIds = new Set(liveRows.map((row) => row.id));

    return links.filter((link) => liveTaskIds.has(link.taskId));
  }

  private deriveFeatureAssertion(feature: MissionFeature): { assertionText: string; textSource: MissionAssertionTextSource } {
    const acceptanceCriteria = feature.acceptanceCriteria?.trim();
    if (acceptanceCriteria) {
      return { assertionText: acceptanceCriteria, textSource: "acceptanceCriteria" };
    }

    const description = feature.description?.trim();
    if (description) {
      return { assertionText: description, textSource: "description" };
    }

    return {
      assertionText: `Verify implementation of: ${feature.title}`,
      textSource: "fallback",
    };
  }

  private ensureFeatureAssertion(feature: MissionFeature): void {
    const slice = this.getSlice(feature.sliceId);
    if (!slice) {
      throw new Error(`Slice ${feature.sliceId} not found`);
    }

    const milestoneId = slice.milestoneId;
    const { assertionText } = this.deriveFeatureAssertion(feature);

    const existing = this.listContractAssertions(milestoneId)
      .find((assertion) => assertion.sourceFeatureId === feature.id);

    if (!existing) {
      const created = this.addContractAssertion(milestoneId, {
        title: feature.title,
        assertion: assertionText,
        status: "pending",
        sourceFeatureId: feature.id,
      });
      this.linkFeatureToAssertion(feature.id, created.id);
      return;
    }

    if (existing.title !== feature.title || existing.assertion !== assertionText) {
      this.updateContractAssertion(existing.id, {
        title: feature.title,
        assertion: assertionText,
      });
    }
  }

  ensureFeatureAssertionLinked(featureId: string): MissionContractAssertion[] {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    this.ensureFeatureAssertion(feature);
    return this.listAssertionsForFeature(featureId);
  }

  /**
   * Idempotently seed authored contract assertions for specific features.
   *
   * Re-running this method is safe: existing equivalent feature-linked assertions are skipped.
   */
  seedContractAssertionsForFeatures(inputs: MissionAssertionSeedInput[]): MissionAssertionSeedReport {
    let created = 0;
    let linked = 0;
    let skippedExisting = 0;

    for (const input of inputs) {
      const existingLinked = this.listAssertionsForFeature(input.featureId).find((assertion) =>
        assertion.milestoneId === input.milestoneId
        && assertion.title.trim() === input.title.trim()
        && assertion.assertion.trim() === input.assertion.trim(),
      );

      if (existingLinked) {
        skippedExisting += 1;
        continue;
      }

      const createdAssertion = this.addContractAssertion(input.milestoneId, {
        title: input.title,
        assertion: input.assertion,
        status: "pending",
        sourceFeatureId: input.featureId,
      });
      created += 1;

      this.linkFeatureToAssertion(input.featureId, createdAssertion.id);
      linked += 1;
    }

    return {
      scanned: inputs.length,
      created,
      linked,
      skippedExisting,
    };
  }

  /**
   * Backfill assertion links for legacy features that predate the FN-5695 creation-path fix.
   * Reuses deriveFeatureAssertion()/ensureFeatureAssertion text-source rules so create/update
   * and repair flows stay aligned on canonical assertion content.
   */
  backfillFeatureAssertions(options?: { missionId?: string; dryRun?: boolean }): MissionAssertionBackfillReport {
    const dryRun = options?.dryRun ?? true;
    const missionFilter = options?.missionId;

    const features = missionFilter
      ? this.listMilestones(missionFilter)
        .flatMap((milestone) => this.listSlices(milestone.id))
        .flatMap((slice) => this.listFeatures(slice.id))
      : this.listMissions()
        .flatMap((mission) => this.listMilestones(mission.id))
        .flatMap((milestone) => this.listSlices(milestone.id))
        .flatMap((slice) => this.listFeatures(slice.id));

    const report: MissionAssertionBackfillReport = {
      scanned: features.length,
      alreadyLinked: 0,
      repaired: [],
      skippedErrors: [],
    };

    for (const feature of features) {
      try {
        const linkedAssertions = this.listAssertionsForFeature(feature.id);
        if (linkedAssertions.length > 0) {
          report.alreadyLinked += 1;
          continue;
        }

        const slice = this.getSlice(feature.sliceId);
        if (!slice) {
          throw new Error(`Slice ${feature.sliceId} not found`);
        }

        const milestoneId = slice.milestoneId;
        const { assertionText, textSource } = this.deriveFeatureAssertion(feature);

        if (dryRun) {
          report.repaired.push({
            featureId: feature.id,
            milestoneId,
            assertionId: "(dry-run)",
            textSource,
          });
          continue;
        }

        const created = this.addContractAssertion(milestoneId, {
          title: feature.title,
          assertion: assertionText,
          status: "pending",
          sourceFeatureId: feature.id,
        });
        this.linkFeatureToAssertion(feature.id, created.id);

        report.repaired.push({
          featureId: feature.id,
          milestoneId,
          assertionId: created.id,
          textSource,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.skippedErrors.push({ featureId: feature.id, message });
      }
    }

    return report;
  }

  /**
   * Resolve the mission hierarchy for a slice.
   *
   * @param sliceId - Slice ID
   * @returns The slice, milestone, and mission IDs for the hierarchy
   * @throws Error if the hierarchy is incomplete
   */
  private resolveTaskLinkage(sliceId: string): { sliceId: string; missionId: string } {
    const slice = this.getSlice(sliceId);
    if (!slice) {
      throw new Error(`Slice ${sliceId} not found`);
    }

    const milestone = this.getMilestone(slice.milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${slice.milestoneId} not found for slice ${sliceId}`);
    }

    const mission = this.getMission(milestone.missionId);
    if (!mission) {
      throw new Error(`Mission ${milestone.missionId} not found for slice ${sliceId}`);
    }

    return {
      sliceId: slice.id,
      missionId: mission.id,
    };
  }

  /**
   * Link a feature to a task.
   * Updates the feature's taskId and emits feature:linked event.
   *
   * @param featureId - Feature ID
   * @param taskId - Task ID to link to
   * @returns The updated feature
   * @throws Error if feature not found
   */
  linkFeatureToTask(featureId: string, taskId: string): MissionFeature {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const liveTask = this.db
      .prepare(`SELECT id FROM tasks WHERE id = ? AND "deletedAt" IS NULL`)
      .get(taskId) as { id: string } | undefined;
    if (!liveTask) {
      throw new Error(
        `Cannot link feature ${featureId} to task ${taskId}: task is not on the active board (it may be archived, deleted, or never existed). Only active tasks can be linked to features.`,
      );
    }

    const linkage = this.resolveTaskLinkage(feature.sliceId);

    // When first linking (loopState is idle or falsy), transition to implementing
    const shouldTransitionLoop = !feature.loopState || feature.loopState === "idle";
    const loopStateUpdates: Partial<MissionFeature> = shouldTransitionLoop
      ? { loopState: "implementing", implementationAttemptCount: 1 }
      : {};

    const updated = this.db.transaction(() => {
      const featureUpdate = this.updateFeature(featureId, {
        taskId,
        status: "triaged",
        ...loopStateUpdates,
      });

      // Also update the task's mission/slice linkage for bidirectional linking.
      this.db.prepare(`
        UPDATE tasks SET missionId = ?, sliceId = ? WHERE id = ? AND "deletedAt" IS NULL
      `).run(linkage.missionId, linkage.sliceId, taskId);
      this.db.bumpLastModified();

      return featureUpdate;
    });

    this.emit("feature:linked", { feature: updated, taskId });

    // Recompute slice status
    this.recomputeSliceStatus(updated.sliceId);

    return updated;
  }

  /**
   * Unlink a feature from its task.
   * Clears the feature's taskId.
   *
   * @param featureId - Feature ID
   * @returns The updated feature
   * @throws Error if feature not found
   */
  unlinkFeatureFromTask(featureId: string): MissionFeature {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    // Get the taskId before clearing it
    const { taskId } = feature;

    const updated = this.db.transaction(() => {
      const featureUpdate = this.updateFeature(featureId, {
        taskId: undefined,
        status: "defined",
      });

      // Clear the task's mission/slice linkage together.
      if (taskId) {
        this.db.prepare(`
          UPDATE tasks SET missionId = NULL, sliceId = NULL WHERE id = ? AND "deletedAt" IS NULL
        `).run(taskId);
        this.db.bumpLastModified();
      }

      return featureUpdate;
    });

    // Recompute slice status
    this.recomputeSliceStatus(updated.sliceId);

    return updated;
  }

  /**
   * Update a feature's status.
   * Recomputes slice status after update.
   *
   * @param featureId - Feature ID
   * @param status - New status
   * @returns The updated feature
   * @throws Error if feature not found
   */
  updateFeatureStatus(featureId: string, status: FeatureStatus): MissionFeature {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const updated = this.updateFeature(featureId, { status });

    // Recompute slice status
    this.recomputeSliceStatus(updated.sliceId);

    return updated;
  }

  /**
   * Find a feature by its linked task ID.
   *
   * @param taskId - Task ID
   * @returns The feature, or undefined if no feature is linked to this task
   */
  getFeatureByTaskId(taskId: string): MissionFeature | undefined {
    const row = this.db.prepare("SELECT * FROM mission_features WHERE taskId = ?").get(taskId) as unknown as FeatureRow | undefined;
    if (!row) return undefined;
    return this.rowToFeature(row);
  }

  // ── Validator Run Operations ────────────────────────────────────────

  /**
   * Start a new validator run for a feature.
   * Creates a run with status='running', sets startedAt, increments the feature's
   * validatorAttemptCount, updates lastValidatorRunId, and emits validator-run:started event.
   *
   * @param featureId - Feature ID to start validation for
   * @param triggerType - What triggered this run (e.g., 'task_completion', 'manual', 'scheduled')
   * @param taskId - Optional board task ID for this validation run (enables board visibility)
   * @returns The created validator run
   * @throws Error if feature not found
   */
  startValidatorRun(featureId: string, triggerType?: string, taskId?: string): MissionValidatorRun {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    // Resolve the hierarchy to get milestoneId and sliceId
    const slice = this.getSlice(feature.sliceId);
    if (!slice) {
      throw new Error(`Slice ${feature.sliceId} not found`);
    }

    const milestone = this.getMilestone(slice.milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${slice.milestoneId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateValidatorRunId();

    // Increment validatorAttemptCount on the feature
    const newValidatorAttemptCount = (feature.validatorAttemptCount ?? 0) + 1;

    const run: MissionValidatorRun = {
      id,
      featureId,
      milestoneId: milestone.id,
      sliceId: slice.id,
      status: "running",
      triggerType,
      implementationAttempt: feature.implementationAttemptCount ?? 0,
      validatorAttempt: newValidatorAttemptCount,
      taskId,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      // Insert the validator run
      this.db.prepare(`
        INSERT INTO mission_validator_runs (id, featureId, milestoneId, sliceId, status, triggerType, implementationAttempt, validatorAttempt, taskId, startedAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.featureId,
        run.milestoneId,
        run.sliceId,
        run.status,
        run.triggerType ?? "auto",
        run.implementationAttempt,
        run.validatorAttempt,
        run.taskId ?? null,
        run.startedAt,
        run.createdAt,
        run.updatedAt,
      );

      // Update the feature: increment validatorAttemptCount and set lastValidatorRunId
      this.updateFeature(featureId, {
        validatorAttemptCount: newValidatorAttemptCount,
        lastValidatorRunId: run.id,
        loopState: "validating",
      });
    });

    this.db.bumpLastModified();
    this.emit("validator-run:started", run);

    return run;
  }

  /**
   * Complete a validator run with the given result.
   * Sets run status, completedAt, durationMs and updates feature loop state based on result.
   *
   * Result transitions:
   * - 'passed': run status='passed', feature loopState='passed', lastValidatorStatus='passed'
   * - 'failed': run status='failed', feature loopState='needs_fix', lastValidatorStatus='failed'
   * - 'blocked': run status='blocked', feature loopState='blocked', lastValidatorStatus='blocked'
   * - 'error': run status='error', feature loopState stays 'validating', lastValidatorStatus='error'
   *
   * @param runId - Validator run ID to complete
   * @param result - The completion result status
   * @param summary - Optional summary of the validation run
   * @param blockedReason - Optional reason if result is 'blocked'
   * @returns The completed validator run
   * @throws Error if run not found
   */
  completeValidatorRun(
    runId: string,
    result: "passed" | "failed" | "blocked" | "error",
    summary?: string,
    blockedReason?: string,
  ): MissionValidatorRun {
    const run = this.getValidatorRun(runId);
    if (!run) {
      throw new Error(`Validator run ${runId} not found`);
    }

    if (run.status !== "running") {
      throw new Error(`Validator run ${runId} is not in 'running' status`);
    }

    const now = new Date().toISOString();
    const completedAt = now;

    // Compute durationMs as non-negative integer
    const startedAtMs = new Date(run.startedAt).getTime();
    const completedAtMs = new Date(completedAt).getTime();
    const durationMs = Math.max(0, completedAtMs - startedAtMs);

    // Determine feature loop state and lastValidatorStatus based on result
    let featureLoopState: FeatureLoopState;
    let featureLastValidatorStatus: ValidatorRunStatus;

    switch (result) {
      case "passed":
        featureLoopState = "passed";
        featureLastValidatorStatus = "passed";
        break;
      case "failed":
        featureLoopState = "needs_fix";
        featureLastValidatorStatus = "failed";
        break;
      case "blocked":
        featureLoopState = "blocked";
        featureLastValidatorStatus = "blocked";
        break;
      case "error":
        featureLoopState = "validating"; // stays validating on error
        featureLastValidatorStatus = "error";
        break;
    }

    this.db.transaction(() => {
      // Update the validator run
      this.db.prepare(`
        UPDATE mission_validator_runs SET
          status = ?,
          summary = ?,
          blockedReason = ?,
          completedAt = ?,
          updatedAt = ?
        WHERE id = ?
      `).run(
        result,
        summary ?? null,
        blockedReason ?? null,
        completedAt,
        now,
        runId,
      );

      // Update the feature's loop state and lastValidatorStatus
      this.updateFeature(run.featureId, {
        loopState: featureLoopState,
        lastValidatorStatus: featureLastValidatorStatus,
      });
    });

    this.db.bumpLastModified();

    // Re-read the run to get the updated state
    const updatedRun = this.getValidatorRun(runId)!;
    this.emit("validator-run:completed", updatedRun, result, durationMs);

    if (result === "passed") {
      const passedFeature = this.getFeature(run.featureId);
      if (passedFeature) {
        this.reconcileSupersededGeneratedFixFeatures(passedFeature.sliceId);
      }
    }

    return updatedRun;
  }

  /**
   * Get a validator run by ID.
   *
   * @param id - Validator run ID
   * @returns The validator run, or undefined if not found
   */
  getValidatorRun(id: string): MissionValidatorRun | undefined {
    const row = this.db.prepare("SELECT * FROM mission_validator_runs WHERE id = ?").get(id) as ValidatorRunRow | undefined;
    if (!row) return undefined;
    return this.rowToValidatorRun(row);
  }

  // ── Validator Failure & Fix Feature Operations ─────────────────────────

  /**
   * Record assertion failures for a validator run.
   * Inserts one row per failure with a generated ID and createdAt timestamp.
   *
   * @param runId - The validator run ID these failures belong to
   * @param failures - Array of failure records to insert
   * @returns The created failure records
   */
  recordValidatorFailures(
    runId: string,
    failures: Array<{
      featureId: string;
      assertionId: string;
      message?: string;
      expected?: string;
      actual?: string;
    }>,
  ): MissionAssertionFailureRecord[] {
    const run = this.getValidatorRun(runId);
    if (!run) {
      throw new Error(`Validator run ${runId} not found`);
    }

    const createdRecords: MissionAssertionFailureRecord[] = [];

    this.db.transaction(() => {
      for (const failure of failures) {
        const now = new Date().toISOString();
        const id = this.generateFailureId();

        const record: MissionAssertionFailureRecord = {
          id,
          runId,
          featureId: failure.featureId,
          assertionId: failure.assertionId,
          message: failure.message,
          expected: failure.expected,
          actual: failure.actual,
          createdAt: now,
        };

        this.db.prepare(`
          INSERT INTO mission_validator_failures (id, runId, featureId, assertionId, message, expected, actual, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.id,
          record.runId,
          record.featureId,
          record.assertionId,
          record.message ?? null,
          record.expected ?? null,
          record.actual ?? null,
          record.createdAt,
        );

        createdRecords.push(record);
      }
    });

    this.db.bumpLastModified();

    return createdRecords;
  }

  /**
   * Get all failures for a validator run, ordered by createdAt ASC.
   *
   * @param runId - Validator run ID
   * @returns Array of failure records
   */
  getFailuresForRun(runId: string): MissionAssertionFailureRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM mission_validator_failures WHERE runId = ? ORDER BY createdAt ASC"
    ).all(runId);
    return (rows as unknown as FailureRow[]).map((row) => this.rowToFailure(row));
  }

  /**
   * Get all validator runs for a feature, ordered by startedAt DESC.
   *
   * @param featureId - Feature ID
   * @returns Array of validator runs
   */
  getValidatorRunsByFeature(featureId: string): MissionValidatorRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM mission_validator_runs WHERE featureId = ? ORDER BY startedAt DESC"
    ).all(featureId);
    return (rows as unknown as ValidatorRunRow[]).map((row) => this.rowToValidatorRun(row));
  }

  /**
   * List validator runs that are still marked running even though their startedAt is older
   * than the supplied age threshold.
   */
  listStaleRunningValidatorRuns(maxAgeMs: number, now = Date.now()): MissionValidatorRun[] {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const rows = this.db.prepare(
      "SELECT * FROM mission_validator_runs WHERE status = 'running' AND startedAt < ? ORDER BY startedAt ASC"
    ).all(cutoff);
    return (rows as unknown as ValidatorRunRow[]).map((row) => this.rowToValidatorRun(row));
  }

  /**
   * Reap a stale validator run whose owning execution no longer exists.
   *
   * Intentionally does not delegate to completeValidatorRun(): the generic error path keeps
   * the feature in loopState='validating', but a stale-owner recovery must move live features
   * back to loopState='needs_fix' so the mission loop can retry validation later.
   *
   * The feature's lastValidatorRunId is intentionally left pointing at this now-terminal run so
   * readers can resolve it and observe the authoritative terminal status instead of a dangling gap.
   */
  reapValidatorRun(runId: string, reason: string): MissionValidatorRun {
    const run = this.getValidatorRun(runId);
    if (!run) {
      throw new Error(`Validator run ${runId} not found`);
    }

    if (run.status !== "running") {
      return run;
    }

    const feature = this.getFeature(run.featureId);
    if (!feature) {
      throw new Error(`Feature ${run.featureId} not found`);
    }

    const slice = this.getSlice(feature.sliceId);
    if (!slice) {
      throw new Error(`Slice ${feature.sliceId} not found`);
    }

    const milestone = this.getMilestone(slice.milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${slice.milestoneId} not found`);
    }

    const mission = this.getMission(milestone.missionId);
    if (!mission) {
      throw new Error(`Mission ${milestone.missionId} not found`);
    }

    const now = new Date().toISOString();
    const completedAt = now;
    const startedAtMs = new Date(run.startedAt).getTime();
    const completedAtMs = new Date(completedAt).getTime();
    const durationMs = Math.max(0, completedAtMs - startedAtMs);
    const shouldUpdateFeature = mission.status !== "archived" && mission.status !== "complete" && feature.status !== "done";

    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE mission_validator_runs SET
          status = ?,
          summary = ?,
          completedAt = ?,
          updatedAt = ?
        WHERE id = ?
      `).run(
        "error",
        reason,
        completedAt,
        now,
        runId,
      );

      if (shouldUpdateFeature) {
        this.updateFeature(run.featureId, {
          loopState: "needs_fix",
          lastValidatorStatus: "error",
        });
      }
    });

    this.db.bumpLastModified();

    const updatedRun = this.getValidatorRun(runId)!;
    this.emit("validator-run:completed", updatedRun, "error", durationMs);

    return updatedRun;
  }

  /**
   * Create a generated fix feature for a failed validation.
   *
   * Creates a new MissionFeature in the same slice as the source feature,
   * sets the lineage tracking fields (generatedFromFeatureId, generatedFromRunId),
   * creates a lineage entry, and increments the original feature's implementationAttemptCount.
   *
   * If the source feature has exhausted its retry budget (implementationAttemptCount >= max),
   * the source feature is transitioned to 'blocked' state instead of having its count incremented.
   *
   * @param sourceFeatureId - The feature that failed validation
   * @param runId - The validator run that failed
   * @param failedAssertionIds - IDs of assertions that failed
   * @param failureReason - Optional observed-vs-expected detail (R6) appended to
   *   the Fix Feature description so the remediation agent sees what behavior was
   *   wrong rather than only which assertion ids failed.
   * @param title - Optional title for the fix feature (defaults to "Fix: {sourceTitle}")
   * @returns The created fix feature, or throws if retry budget is exhausted
   * @throws Error if source feature not found
   */
  createGeneratedFixFeature(
    sourceFeatureId: string,
    runId: string,
    failedAssertionIds: string[],
    failureReason?: string,
    title?: string,
  ): MissionFeature {
    const sourceFeature = this.getFeature(sourceFeatureId);
    if (!sourceFeature) {
      throw new Error(`Feature ${sourceFeatureId} not found`);
    }

    const run = this.getValidatorRun(runId);
    if (!run) {
      throw new Error(`Validator run ${runId} not found`);
    }
    if (run.featureId !== sourceFeatureId) {
      throw new Error(
        `Validator run ${runId} belongs to feature ${run.featureId}, expected ${sourceFeatureId}`,
      );
    }

    // R22 — idempotency across re-drives.
    //
    // Recovery sweeps and the validator reaper re-drive validation for the same
    // feature/run. Without dedup, each re-drive mints a fresh Fix Feature and
    // increments the source's implementationAttemptCount, eventually exhausting
    // the retry budget and force-blocking a feature whose code may be correct.
    //
    // Two guards, in order:
    //   1. Exact dedup on (sourceFeatureId, generatedFromRunId): a re-drive of the
    //      *same* failing run reuses the Fix Feature it already produced.
    //   2. Open-fix dedup: if any non-terminal Fix Feature already exists for this
    //      source (still being worked, i.e. not done/blocked), reuse it rather
    //      than stacking another remediation feature.
    // In both cases we return the existing feature WITHOUT incrementing the
    // attempt count — the budget is consumed once per genuine failing run.
    const existingForRun = this.findGeneratedFixFeature(sourceFeatureId, runId);
    if (existingForRun) {
      return existingForRun;
    }
    const openFix = this.findOpenGeneratedFixFeature(sourceFeatureId);
    if (openFix) {
      return openFix;
    }

    const now = new Date().toISOString();
    const fixFeatureId = this.generateFeatureId();

    // Check if source feature has exhausted its retry budget
    const retryBudget = DEFAULT_IMPLEMENTATION_RETRY_BUDGET;
    const attemptsRemaining = retryBudget - (sourceFeature.implementationAttemptCount ?? 0);

    if (attemptsRemaining <= 0) {
      // Exhausted retry budget - transition source to blocked
      this.updateFeature(sourceFeatureId, {
        loopState: "blocked",
      });
      this.db.bumpLastModified();
      throw new Error(
        `Feature ${sourceFeatureId} has exhausted its retry budget (${retryBudget} attempts). ` +
        "Transitioning to 'blocked' state."
      );
    }

    // R6 — surface the observed-vs-expected reason to the remediation agent.
    const reasonText = failureReason?.trim();
    const fixDescription = reasonText
      ? `${sourceFeature.description ? `${sourceFeature.description}\n\n` : ""}## Verification failure detail\n${reasonText}`
      : sourceFeature.description;

    const fixFeature: MissionFeature = {
      id: fixFeatureId,
      sliceId: sourceFeature.sliceId,
      title: title ?? `Fix: ${sourceFeature.title}`,
      description: fixDescription,
      acceptanceCriteria: sourceFeature.acceptanceCriteria,
      status: "defined",
      createdAt: now,
      updatedAt: now,
      loopState: "idle",
      implementationAttemptCount: 0,
      validatorAttemptCount: 0,
      generatedFromFeatureId: sourceFeatureId,
      generatedFromRunId: runId,
    };

    // Lineage ID
    const lineageId = this.generateLineageId();

    this.db.transaction(() => {
      // Create the fix feature
      this.db.prepare(`
        INSERT INTO mission_features (
          id, sliceId, title, description, acceptanceCriteria, status,
          loopState, implementationAttemptCount, validatorAttemptCount,
          generatedFromFeatureId, generatedFromRunId, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fixFeature.id,
        fixFeature.sliceId,
        fixFeature.title,
        fixFeature.description ?? null,
        fixFeature.acceptanceCriteria ?? null,
        fixFeature.status,
        fixFeature.loopState ?? "idle",
        fixFeature.implementationAttemptCount ?? 0,
        fixFeature.validatorAttemptCount ?? 0,
        fixFeature.generatedFromFeatureId ?? null,
        fixFeature.generatedFromRunId ?? null,
        fixFeature.createdAt,
        fixFeature.updatedAt,
      );

      // Create lineage entry
      this.db.prepare(`
        INSERT INTO mission_fix_feature_lineage (id, sourceFeatureId, fixFeatureId, runId, failedAssertionIds, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        lineageId,
        sourceFeatureId,
        fixFeatureId,
        runId,
        toJson(failedAssertionIds),
        now,
      );

      // Increment the source feature's implementationAttemptCount
      const newAttemptCount = (sourceFeature.implementationAttemptCount ?? 0) + 1;
      this.updateFeature(sourceFeatureId, {
        implementationAttemptCount: newAttemptCount,
        loopState: "implementing",
      });
    });

    this.db.bumpLastModified();
    this.emit("feature:created", fixFeature);
    this.emit("fix-feature:created", {
      feature: fixFeature,
      sourceFeatureId,
      runId,
      failedAssertionIds,
    });

    return fixFeature;
  }

  /**
   * Find the Fix Feature already generated for a given (source feature, run)
   * pair, if any. Used to make {@link createGeneratedFixFeature} idempotent
   * across re-drives of the same failing validator run (R22).
   *
   * @param sourceFeatureId - The feature that failed validation
   * @param runId - The originating validator run
   * @returns The existing Fix Feature, or undefined if none exists
   */
  findGeneratedFixFeature(sourceFeatureId: string, runId: string): MissionFeature | undefined {
    const row = this.db.prepare(
      "SELECT fixFeatureId FROM mission_fix_feature_lineage WHERE sourceFeatureId = ? AND runId = ? ORDER BY createdAt ASC LIMIT 1",
    ).get(sourceFeatureId, runId) as { fixFeatureId?: string } | undefined;
    if (!row?.fixFeatureId) {
      return undefined;
    }
    return this.getFeature(row.fixFeatureId);
  }

  /**
   * Find an open (non-terminal) Fix Feature already generated for a source
   * feature, if any. "Open" means a generated Fix Feature whose status is not a
   * terminal one (`done` / `blocked`) — i.e. remediation is still in flight.
   *
   * Used by {@link createGeneratedFixFeature} so a recovery/reaper re-drive does
   * not stack a second Fix Feature (and burn the retry budget) while the prior
   * one is still being worked (R22).
   *
   * @param sourceFeatureId - The feature that failed validation
   * @returns The earliest open Fix Feature, or undefined if none is open
   */
  findOpenGeneratedFixFeature(sourceFeatureId: string): MissionFeature | undefined {
    const rows = this.db.prepare(
      "SELECT fixFeatureId FROM mission_fix_feature_lineage WHERE sourceFeatureId = ? ORDER BY createdAt ASC",
    ).all(sourceFeatureId) as Array<{ fixFeatureId?: string }>;
    for (const row of rows) {
      if (!row.fixFeatureId) continue;
      const fix = this.getFeature(row.fixFeatureId);
      if (fix && fix.status !== "done" && fix.status !== "blocked") {
        return fix;
      }
    }
    return undefined;
  }

  /**
   * Mark generated Fix Features obsolete once an ancestor feature, or the fix's
   * own validation evidence, has already passed.
   *
   * Validator failures can create a chain of generated features. If the original
   * feature is later validated successfully, older descendants are no longer
   * actionable remediation work. Leaving them blocked/defined keeps the slice
   * pending forever even though the authoritative source feature has passed.
   *
   * FNXC:Missions 2026-07-05-22:09:
   * Superseded generated Fix Features must become terminal and lose live board-task ownership.
   * Otherwise mission recovery can keep resuming stale remediation tasks after the source feature is already validated.
   *
   * FNXC:Missions 2026-07-11-12:35:
   * A generated fix can also supersede itself once its own validator/loop evidence has passed.
   * Reconciliation treats that as terminal evidence so a completed fix does not stay active only because its ancestor previously failed.
   */
  reconcileSupersededGeneratedFixFeatures(sliceId: string): { supersededCount: number; featureIds: string[] } {
    const features = this.listFeatures(sliceId);
    const featureById = new Map(features.map((feature) => [feature.id, feature]));
    const ancestorPassedMemo = new Map<string, boolean>();

    const featureHasPassed = (feature: MissionFeature | undefined): boolean => {
      if (!feature) return false;
      return feature.lastValidatorStatus === "passed" || feature.loopState === "passed";
    };

    const hasPassedAncestor = (feature: MissionFeature, seen = new Set<string>()): boolean => {
      const sourceFeatureId = feature.generatedFromFeatureId;
      if (!sourceFeatureId || seen.has(sourceFeatureId)) {
        return false;
      }
      const cached = ancestorPassedMemo.get(feature.id);
      if (cached !== undefined) {
        return cached;
      }

      seen.add(sourceFeatureId);
      const sourceFeature = featureById.get(sourceFeatureId) ?? this.getFeature(sourceFeatureId);
      const passed = featureHasPassed(sourceFeature) || (sourceFeature ? hasPassedAncestor(sourceFeature, seen) : false);
      ancestorPassedMemo.set(feature.id, passed);
      return passed;
    };

    const supersededFeatureIds = features
      .filter((feature) => feature.generatedFromFeatureId && (featureHasPassed(feature) || hasPassedAncestor(feature)))
      .filter((feature) => feature.status !== "done" || feature.loopState !== "passed" || feature.lastValidatorStatus !== "passed" || feature.taskId)
      .map((feature) => feature.id);

    if (supersededFeatureIds.length > 0) {
      this.db.transaction(() => {
        for (const featureId of supersededFeatureIds) {
          const feature = this.getFeature(featureId);
          if (!feature) continue;
          this.updateFeature(featureId, {
            status: "done",
            taskId: undefined,
            loopState: "passed",
            lastValidatorStatus: "passed",
          });
          if (feature.taskId) {
            this.db.prepare("UPDATE tasks SET missionId = NULL, sliceId = NULL WHERE id = ? AND \"deletedAt\" IS NULL").run(feature.taskId);
          }
        }
      });
    }

    return {
      supersededCount: supersededFeatureIds.length,
      featureIds: supersededFeatureIds,
    };
  }

  /**
   * Get a complete loop state snapshot for a feature.
   *
   * Returns the feature's current loop state fields, all validator runs,
   * all assertion failures, all lineage entries (as source or fix), and
   * the computed retryBudgetRemaining.
   *
   * @param featureId - Feature ID
   * @returns The feature loop snapshot
   * @throws Error if feature not found
   */
  getFeatureLoopSnapshot(featureId: string): MissionFeatureLoopSnapshot {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const validatorRuns = this.getValidatorRunsByFeature(featureId);

    // Collect all failures across all runs
    const failures: MissionAssertionFailureRecord[] = [];
    for (const run of validatorRuns) {
      const runFailures = this.getFailuresForRun(run.id);
      failures.push(...runFailures);
    }

    // Get lineage entries where this feature is the source or the fix
    const sourceLineageRows = this.db.prepare(
      "SELECT * FROM mission_fix_feature_lineage WHERE sourceFeatureId = ?"
    ).all(featureId) as unknown as LineageRow[];
    const fixLineageRows = this.db.prepare(
      "SELECT * FROM mission_fix_feature_lineage WHERE fixFeatureId = ?"
    ).all(featureId) as unknown as LineageRow[];

    const lineage = [
      ...sourceLineageRows.map((row) => this.rowToLineage(row)),
      ...fixLineageRows.map((row) => this.rowToLineage(row)),
    ];

    // Compute retry budget remaining
    const retryBudget = DEFAULT_IMPLEMENTATION_RETRY_BUDGET;
    const retryBudgetRemaining = Math.max(0, retryBudget - (feature.implementationAttemptCount ?? 0));

    return {
      featureId: feature.id,
      feature,
      loopState: feature.loopState ?? "idle",
      implementationAttemptCount: feature.implementationAttemptCount ?? 0,
      validatorAttemptCount: feature.validatorAttemptCount ?? 0,
      lastValidatorRunId: feature.lastValidatorRunId,
      lastValidatorStatus: feature.lastValidatorStatus,
      generatedFromFeatureId: feature.generatedFromFeatureId,
      generatedFromRunId: feature.generatedFromRunId,
      validatorRuns,
      failures,
      lineage,
      retryBudgetRemaining,
    };
  }

  /**
   * Transition a feature's loop state.
   *
   * Valid transitions:
   * - idle → implementing
   * - implementing → validating
   * - validating → needs_fix
   * - validating → passed
   * - validating → blocked
   * - needs_fix → implementing
   *
   * If the transition would exceed the retry budget (attempting to go to 'implementing'
   * when implementationAttemptCount >= max), the feature is transitioned to 'blocked'
   * instead and an error is thrown.
   *
   * @param featureId - Feature ID
   * @param newState - The target loop state
   * @throws Error if feature not found or transition is invalid
   */
  transitionLoopState(featureId: string, newState: FeatureLoopState): MissionFeature {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const currentState = feature.loopState ?? "idle";

    // Validate the transition
    const validTransitions: Record<FeatureLoopState, FeatureLoopState[]> = {
      idle: ["implementing"],
      implementing: ["validating"],
      validating: ["needs_fix", "passed", "blocked"],
      needs_fix: ["implementing"],
      passed: [],
      blocked: [],
    };

    const allowedNextStates = validTransitions[currentState] || [];
    if (!allowedNextStates.includes(newState)) {
      throw new Error(
        `Invalid loop state transition from '${currentState}' to '${newState}'. ` +
        `Allowed transitions from '${currentState}': ${allowedNextStates.join(", ") || "none"}`
      );
    }

    // Check retry budget when transitioning to 'implementing'
    if (newState === "implementing") {
      const retryBudget = DEFAULT_IMPLEMENTATION_RETRY_BUDGET;
      const retryBudgetRemaining = retryBudget - (feature.implementationAttemptCount ?? 0);

      if (retryBudgetRemaining <= 0) {
        // Exhausted retry budget - transition to blocked instead
        this.updateFeature(featureId, {
          loopState: "blocked",
        });
        this.db.bumpLastModified();
        throw new Error(
          `Feature ${featureId} has exhausted its retry budget (${retryBudget} attempts). ` +
          "Transitioning to 'blocked' state."
        );
      }
    }

    const updated = this.updateFeature(featureId, {
      loopState: newState,
    });

    this.db.bumpLastModified();

    return updated;
  }

  // ── Contract Assertion Operations ─────────────────────────────────

  /**
   * Add a contract assertion to a milestone.
   * Automatically computes the orderIndex (max + 1).
   *
   * ## Assertion Lifecycle
   *
   * Assertions transition through these statuses:
   * - `pending` — Initial state, assertion has not been validated
   * - `passed` — Assertion has been validated and passed
   * - `failed` — Assertion has been validated and failed
   * - `blocked` — Assertion cannot be validated due to external blockers
   *
   * Status transitions are managed by calling `updateContractAssertion()` with
   * the appropriate status value.
   *
   * @param milestoneId - Parent milestone ID
   * @param input - Assertion creation input
   * @returns The created assertion
   * @throws Error if milestone not found
   */
  addContractAssertion(milestoneId: string, input: ContractAssertionCreateInput): MissionContractAssertion {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const now = new Date().toISOString();
    const id = this.generateAssertionId();

    // Compute next orderIndex
    const existingAssertions = this.listContractAssertions(milestoneId);
    const orderIndex = existingAssertions.length > 0
      ? Math.max(...existingAssertions.map((a) => a.orderIndex)) + 1
      : 0;

    const assertion: MissionContractAssertion = {
      id,
      milestoneId,
      sourceFeatureId: input.sourceFeatureId,
      title: input.title,
      assertion: input.assertion,
      status: input.status || "pending",
      type: normalizeMissionAssertionType(input.type),
      orderIndex,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO mission_contract_assertions (id, milestoneId, title, assertion, status, type, orderIndex, sourceFeatureId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assertion.id,
      assertion.milestoneId,
      assertion.title,
      assertion.assertion,
      assertion.status,
      assertion.type,
      assertion.orderIndex,
      assertion.sourceFeatureId ?? null,
      assertion.createdAt,
      assertion.updatedAt,
    );

    this.db.bumpLastModified();
    this.emit("assertion:created", assertion);

    // Recompute milestone validation state
    this.recomputeMilestoneValidation(milestoneId);

    return assertion;
  }

  /**
   * Get a contract assertion by ID.
   *
   * @param id - Assertion ID
   * @returns The assertion, or undefined if not found
   */
  getContractAssertion(id: string): MissionContractAssertion | undefined {
    const row = this.db.prepare("SELECT * FROM mission_contract_assertions WHERE id = ?").get(id) as unknown as AssertionRow | undefined;
    if (!row) return undefined;
    return this.rowToAssertion(row);
  }

  /**
   * List contract assertions for a milestone, ordered by orderIndex ASC, createdAt ASC, id ASC.
   *
   * This ordering is deterministic even when multiple assertions share the same
   * orderIndex or createdAt timestamp.
   *
   * @param milestoneId - Milestone ID
   * @returns Array of assertions
   */
  listContractAssertions(milestoneId: string): MissionContractAssertion[] {
    const rows = this.db.prepare(
      "SELECT * FROM mission_contract_assertions WHERE milestoneId = ? ORDER BY orderIndex ASC, createdAt ASC, id ASC"
    ).all(milestoneId);
    return (rows as unknown as AssertionRow[]).map((row) => this.rowToAssertion(row));
  }

  /**
   * Update a contract assertion.
   *
   * @param id - Assertion ID
   * @param updates - Partial assertion updates
   * @returns The updated assertion
   * @throws Error if assertion not found
   */
  updateContractAssertion(id: string, updates: ContractAssertionUpdateInput): MissionContractAssertion {
    const assertion = this.getContractAssertion(id);
    if (!assertion) {
      throw new Error(`Assertion ${id} not found`);
    }

    const now = new Date().toISOString();
    const updated: MissionContractAssertion = {
      ...assertion,
      title: updates.title ?? assertion.title,
      assertion: updates.assertion ?? assertion.assertion,
      status: updates.status ?? assertion.status,
      updatedAt: now,
    };

    this.db.prepare(`
      UPDATE mission_contract_assertions SET
        title = ?,
        assertion = ?,
        status = ?,
        updatedAt = ?
      WHERE id = ?
    `).run(
      updated.title,
      updated.assertion,
      updated.status,
      updated.updatedAt,
      updated.id,
    );

    this.db.bumpLastModified();
    this.emit("assertion:updated", updated);

    // Recompute milestone validation state
    this.recomputeMilestoneValidation(updated.milestoneId);

    return updated;
  }

  /**
   * Delete a contract assertion.
   *
   * @param id - Assertion ID
   * @throws Error if assertion not found
   */
  deleteContractAssertion(id: string): void {
    const assertion = this.getContractAssertion(id);
    if (!assertion) {
      throw new Error(`Assertion ${id} not found`);
    }

    const milestoneId = assertion.milestoneId;

    this.db.prepare("DELETE FROM mission_contract_assertions WHERE id = ?").run(id);
    this.db.bumpLastModified();

    this.emit("assertion:deleted", id);

    // Recompute milestone validation state
    this.recomputeMilestoneValidation(milestoneId);
  }

  /**
   * Reorder contract assertions within a milestone.
   *
   * @param milestoneId - Milestone ID
   * @param orderedIds - Assertion IDs in the desired order
   * @throws Error if any assertion is not found or belongs to a different milestone
   */
  reorderContractAssertions(milestoneId: string, orderedIds: string[]): void {
    this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        const assertion = this.getContractAssertion(id);

        if (!assertion) {
          throw new Error(`Assertion ${id} not found`);
        }
        if (assertion.milestoneId !== milestoneId) {
          throw new Error(`Assertion ${id} does not belong to milestone ${milestoneId}`);
        }

        this.db.prepare(
          "UPDATE mission_contract_assertions SET orderIndex = ?, updatedAt = ? WHERE id = ?"
        ).run(i, new Date().toISOString(), id);
      }
    });

    this.db.bumpLastModified();
  }

  // ── Feature-Assertion Link Operations ──────────────────────────────

  /**
   * Link a feature to a contract assertion.
   *
   * ## Linkage Cardinality
   *
   * The feature-assertion relationship is many-to-many:
   * - One feature can satisfy multiple assertions (e.g., a login feature covers
   *   "validates input", "shows errors", and "authenticates users")
   * - One assertion can be covered by multiple features (e.g., "security check"
   *   requires both the auth module and the session module)
   *
   * Links are stored in the `mission_feature_assertions` table with a composite
   * primary key of (featureId, assertionId) to prevent duplicate links.
   *
   * @param featureId - Feature ID
   * @param assertionId - Assertion ID
   * @throws Error if feature or assertion not found, or if link already exists
   */
  linkFeatureToAssertion(featureId: string, assertionId: string): void {
    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const assertion = this.getContractAssertion(assertionId);
    if (!assertion) {
      throw new Error(`Assertion ${assertionId} not found`);
    }

    // Check if link already exists
    const existing = this.db.prepare(
      "SELECT 1 FROM mission_feature_assertions WHERE featureId = ? AND assertionId = ?"
    ).get(featureId, assertionId);

    if (existing) {
      throw new Error(`Feature ${featureId} is already linked to assertion ${assertionId}`);
    }

    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO mission_feature_assertions (featureId, assertionId, createdAt) VALUES (?, ?, ?)"
    ).run(featureId, assertionId, now);

    this.db.bumpLastModified();
    this.emit("assertion:linked", { featureId, assertionId });

    // Recompute milestone validation state
    this.recomputeMilestoneValidation(assertion.milestoneId);
  }

  /**
   * Unlink a feature from a contract assertion.
   *
   * @param featureId - Feature ID
   * @param assertionId - Assertion ID
   * @throws Error if link not found
   */
  unlinkFeatureFromAssertion(featureId: string, assertionId: string): void {
    const existing = this.db.prepare(
      "SELECT 1 FROM mission_feature_assertions WHERE featureId = ? AND assertionId = ?"
    ).get(featureId, assertionId);

    if (!existing) {
      throw new Error(`Feature ${featureId} is not linked to assertion ${assertionId}`);
    }

    this.db.prepare(
      "DELETE FROM mission_feature_assertions WHERE featureId = ? AND assertionId = ?"
    ).run(featureId, assertionId);

    this.db.bumpLastModified();
    this.emit("assertion:unlinked", { featureId, assertionId });

    // Recompute milestone validation state for the assertion's milestone
    const assertion = this.getContractAssertion(assertionId);
    if (assertion) {
      this.recomputeMilestoneValidation(assertion.milestoneId);
    }
  }

  /**
   * List all assertions linked to a feature.
   *
   * @param featureId - Feature ID
   * @returns Array of linked assertions
   */
  listAssertionsForFeature(featureId: string): MissionContractAssertion[] {
    const rows = this.db.prepare(`
      SELECT ca.* FROM mission_contract_assertions ca
      INNER JOIN mission_feature_assertions fa ON ca.id = fa.assertionId
      WHERE fa.featureId = ?
      ORDER BY ca.orderIndex ASC, ca.createdAt ASC, ca.id ASC
    `).all(featureId);
    return (rows as unknown as AssertionRow[]).map((row) => this.rowToAssertion(row));
  }

  /**
   * List all features linked to an assertion.
   *
   * @param assertionId - Assertion ID
   * @returns Array of linked features
   */
  listFeaturesForAssertion(assertionId: string): MissionFeature[] {
    const rows = this.db.prepare(`
      SELECT mf.* FROM mission_features mf
      INNER JOIN mission_feature_assertions fa ON mf.id = fa.featureId
      WHERE fa.assertionId = ?
      ORDER BY mf.createdAt ASC
    `).all(assertionId);
    return (rows as unknown as FeatureRow[]).map((row) => this.rowToFeature(row));
  }

  // ── Validation Rollup Operations ───────────────────────────────────

  /**
   * Get the validation rollup for a milestone.
   * This is a denormalized snapshot that includes counts and computed state.
   *
   * ## Rollup Precedence
   *
   * The validation state is computed with the following precedence order:
   *
   * 1. `not_started` — Milestone has no assertions
   * 2. `failed` — Any assertion has `failed` status
   * 3. `blocked` — Any assertion has `blocked` status (only checked if no failures)
   * 4. `needs_coverage` — Assertions exist but some are not linked to features
   * 5. `passed` — All assertions have `passed` status
   * 6. `ready` — Assertions exist and are linked, but not all have passed
   *
   * This precedence ensures that:
   * - A milestone with no assertions shows `not_started`
   * - Failed assertions immediately mark the milestone as `failed`
   * - Blocked assertions take precedence over `needs_coverage` but not `failed`
   * - Unlinked assertions require attention before validation can complete
   * - A milestone only shows `passed` when all assertions pass
   *
   * The rollup state is automatically persisted to the milestone when assertions
   * or links change, via `recomputeMilestoneValidation()`.
   *
   * @param milestoneId - Milestone ID
   * @returns The validation rollup
   * @throws Error if milestone not found
   */
  getMilestoneValidationRollup(milestoneId: string): MilestoneValidationRollup {
    const milestone = this.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const assertions = this.listContractAssertions(milestoneId);
    const totalAssertions = assertions.length;
    const proseOnMilestone = (milestone.acceptanceCriteria ?? "").trim().length > 0;
    const proseOnFeatures = this.listSlices(milestoneId)
      .flatMap((slice) => this.listFeatures(slice.id))
      .some((feature) => (feature.acceptanceCriteria ?? "").trim().length > 0);
    const hasProseButNoAssertions = totalAssertions === 0 && (proseOnMilestone || proseOnFeatures);

    // Count by status
    let passedAssertions = 0;
    let failedAssertions = 0;
    let blockedAssertions = 0;
    let pendingAssertions = 0;
    let unlinkedAssertions = 0;

    for (const assertion of assertions) {
      switch (assertion.status) {
        case "passed":
          passedAssertions++;
          break;
        case "failed":
          failedAssertions++;
          break;
        case "blocked":
          blockedAssertions++;
          break;
        case "pending":
          pendingAssertions++;
          break;
      }

      // Check if assertion is linked to any feature
      const linkedFeatures = this.listFeaturesForAssertion(assertion.id);
      if (linkedFeatures.length === 0) {
        unlinkedAssertions++;
      }
    }

    // Compute validation state with exact precedence:
    // 1. totalAssertions === 0 → not_started
    // 2. failedAssertions > 0 → failed
    // 3. blockedAssertions > 0 → blocked
    // 4. unlinkedAssertions > 0 → needs_coverage
    // 5. passedAssertions === totalAssertions → passed
    // 6. otherwise → ready
    let state: MilestoneValidationState;

    if (totalAssertions === 0) {
      state = "not_started";
    } else if (failedAssertions > 0) {
      state = "failed";
    } else if (blockedAssertions > 0) {
      state = "blocked";
    } else if (unlinkedAssertions > 0) {
      state = "needs_coverage";
    } else if (passedAssertions === totalAssertions) {
      state = "passed";
    } else {
      state = "ready";
    }

    this.reconcileMissingStructuredAssertionsSignal(milestone, hasProseButNoAssertions);

    return {
      milestoneId,
      totalAssertions,
      passedAssertions,
      failedAssertions,
      blockedAssertions,
      pendingAssertions,
      unlinkedAssertions,
      hasProseButNoAssertions,
      state,
    };
  }

  milestoneHasProseButNoAssertions(milestoneId: string): boolean {
    return this.getMilestoneValidationRollup(milestoneId).hasProseButNoAssertions;
  }

  private reconcileMissingStructuredAssertionsSignal(milestone: Milestone, hasProseButNoAssertions: boolean): void {
    if (hasProseButNoAssertions) {
      // Debounce per process: emit on first transition into this condition so
      // operators can detect regressions without flooding every recompute cycle.
      if (!this._milestonesMissingStructuredAssertions.has(milestone.id)) {
        const mission = this.getMission(milestone.missionId);
        if (mission) {
          this.logMissionEvent(mission.id, "warning", `Milestone ${milestone.id} has prose acceptance criteria but no structured assertions.`, {
            code: "milestone_missing_structured_assertions",
            milestoneId: milestone.id,
          });
        }
      }
      this._milestonesMissingStructuredAssertions.add(milestone.id);
      return;
    }

    this._milestonesMissingStructuredAssertions.delete(milestone.id);
  }

  /**
   * Recompute and persist the milestone's validation state.
   * This is called automatically after assertion or link changes.
   */
  private recomputeMilestoneValidation(milestoneId: string): void {
    const rollup = this.getMilestoneValidationRollup(milestoneId);
    const now = new Date().toISOString();

    this.db.prepare(
      "UPDATE milestones SET validationState = ?, updatedAt = ? WHERE id = ?"
    ).run(rollup.state, now, milestoneId);

    this.db.bumpLastModified();
    this.emit("milestone:validation:updated", {
      milestoneId,
      state: rollup.state,
      rollup,
    });
  }

  // ── Triage Operations ────────────────────────────────────────────────

  /**
   * Build an enriched task description that includes the full mission hierarchy context.
   *
   * When a feature is triaged to a task, this method constructs a structured markdown
   * description that includes context from all levels of the hierarchy:
   * - Mission: title and description
   * - Milestone: title, description, verification criteria, planning notes
   * - Slice: title, description, verification criteria, planning notes
   * - Feature: description and acceptance criteria
   *
   * When contract assertions are linked to the feature, they are also included
   * in the output to provide explicit validation criteria for implementation.
   *
   * Only non-empty fields are included in the output. This provides AI agents
   * with full context for making informed decisions during task implementation.
   *
   * @param featureId - Feature ID to build enriched description for
   * @returns The enriched description string, or undefined if feature not found
   */
  buildEnrichedDescription(featureId: string): string | undefined {
    const feature = this.getFeature(featureId);
    if (!feature) {
      return undefined;
    }

    const slice = this.getSlice(feature.sliceId);
    if (!slice) {
      return undefined;
    }

    const milestone = this.getMilestone(slice.milestoneId);
    if (!milestone) {
      return undefined;
    }

    const mission = this.getMission(milestone.missionId);
    if (!mission) {
      return undefined;
    }

    const sections: string[] = [];

    // Mission context (always included)
    sections.push(`## Mission: ${mission.title}`);
    if (mission.description) {
      sections.push(mission.description);
    }

    // Milestone context
    const milestoneSections: string[] = [`## Milestone: ${milestone.title}`];
    if (milestone.description) {
      milestoneSections.push(`**Description:** ${milestone.description}`);
    }
    if (milestone.verification) {
      milestoneSections.push(`**Verification:** ${milestone.verification}`);
    }
    if (milestone.planningNotes) {
      milestoneSections.push(`**Planning Notes:** ${milestone.planningNotes}`);
    }
    sections.push(milestoneSections.join("\n"));

    // Slice context
    const sliceSections: string[] = [`## Slice: ${slice.title}`];
    if (slice.description) {
      sliceSections.push(`**Description:** ${slice.description}`);
    }
    if (slice.verification) {
      sliceSections.push(`**Verification:** ${slice.verification}`);
    }
    if (slice.planningNotes) {
      sliceSections.push(`**Planning Notes:** ${slice.planningNotes}`);
    }
    sections.push(sliceSections.join("\n"));

    // Feature context
    const featureSections: string[] = [`## Feature: ${feature.title}`];
    if (feature.description) {
      featureSections.push(feature.description);
    }
    if (feature.acceptanceCriteria) {
      featureSections.push(`**Acceptance Criteria:**\n${feature.acceptanceCriteria}`);
    }
    sections.push(featureSections.join("\n"));

    // Contract assertions context (only if linked to this feature)
    const linkedAssertions = this.listAssertionsForFeature(featureId);
    if (linkedAssertions.length > 0) {
      const assertionSections: string[] = [`## Contract Assertions`];
      for (const assertion of linkedAssertions) {
        const statusIcon = assertion.status === "passed" ? "✅" :
          assertion.status === "failed" ? "❌" :
          assertion.status === "blocked" ? "🚫" : "⏳";
        assertionSections.push(`### ${statusIcon} ${assertion.title}`);
        assertionSections.push(assertion.assertion);
      }
      sections.push(assertionSections.join("\n\n"));
    }

    return sections.join("\n\n");
  }

  /**
   * Triage a feature by creating a new task and linking it.
   *
   * Creates a fn task from the feature's title and description, then links
   * the feature to the newly created task using `linkFeatureToTask()`.
   * The feature status transitions from "defined" to "triaged".
   *
   * When no custom description is provided, the task description is enriched
   * with the full mission hierarchy context (mission → milestone → slice → feature).
   *
   * Requires MissionStore to have been constructed with a TaskStore reference.
   *
   * @param featureId - Feature ID to triage
   * @param taskTitle - Optional title override (defaults to feature title)
   * @param taskDescription - Optional description override (skips enrichment if provided)
   * @returns The updated feature with taskId set
   * @throws Error if feature not found, already triaged, or TaskStore not available
   */
  async triageFeature(
    featureId: string,
    taskTitle?: string,
    taskDescription?: string,
    branchOptions?: {
      branch?: string;
      baseBranch?: string;
      assignmentMode?: "shared" | "per-task-derived";
      workflowId?: string | null;
    },
  ): Promise<MissionFeature> {
    if (!this.taskStore) {
      throw new Error("TaskStore reference is required for triage operations");
    }

    const feature = this.getFeature(featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    if (feature.status !== "defined") {
      throw new Error(`Feature ${featureId} is already ${feature.status} (status must be "defined" to triage)`);
    }

    // Build description: use custom description if provided, otherwise use enriched description
    let description: string;
    if (taskDescription) {
      // Custom description provided - skip enrichment
      description = taskDescription;
    } else {
      // Use enriched description with full hierarchy context
      const enriched = this.buildEnrichedDescription(featureId);
      description = enriched || feature.title;
    }

    const slice = this.getSlice(feature.sliceId);
    const milestone = slice ? this.getMilestone(slice.milestoneId) : undefined;
    const missionId = milestone?.missionId;
    const mission = missionId ? this.getMission(missionId) : undefined;
    const strategyDefaults = missionBranchStrategyDefaults(mission?.branchStrategy);
    const resolvedBaseBranch = branchOptions?.baseBranch ?? mission?.baseBranch;
    const resolvedBranch = branchOptions?.branch ?? strategyDefaults.branch;
    const resolvedAssignmentMode = branchOptions?.assignmentMode ?? strategyDefaults.assignmentMode;

    const lockScope = missionId ? `mission:${missionId}` : `mission-store:${this.taskStore.getRootDir()}`;
    const guard = await runDeterministicDuplicateGuard(this.taskStore, {
      title: taskTitle || feature.title,
      description,
    }, { lockScope });

    let linkedTaskId: string;
    try {
      if (guard.action === "duplicate" && guard.existing) {
        linkedTaskId = guard.existing.id;
      } else {
        let sharedBranchBaseForMission: string | undefined;
        // Stamp the real BranchGroup id (BG-…) so listTasksByBranchGroup(group.id)
        // resolves members. The group is only ensured (and the id set) in shared
        // mode below. Non-shared members get NO groupId — stamping a synthetic
        // `mission:<id>` here would let the legacy membership fallback sweep them
        // into a shared group later created for the same mission.
        let missionGroupId: string | undefined;
        if (missionId && resolvedAssignmentMode === "shared") {
          const settings = await this.taskStore.getSettings();
          const settingsDefaultBranch =
            typeof settings.defaultBranch === "string" && settings.defaultBranch.trim().length > 0
              ? settings.defaultBranch
              : "main";
          const settingsAutoMerge = typeof settings.autoMerge === "boolean" ? settings.autoMerge : false;
          sharedBranchBaseForMission = resolvedBranch ?? resolvedBaseBranch ?? settingsDefaultBranch;
          const group = this.taskStore.ensureBranchGroupForSource("mission", missionId, {
            branchName: sharedBranchBaseForMission,
            autoMerge: mission?.autoMerge ?? settingsAutoMerge,
          });
          missionGroupId = group.id;
        }

        const taskSegment = feature.id;
        const branchAssignment = resolveEntryPointBranchAssignment({
          assignmentMode: resolvedAssignmentMode,
          resolvedBranch: resolvedAssignmentMode === "shared" ? sharedBranchBaseForMission ?? resolvedBranch : resolvedBranch,
          taskSegment,
        });

        const createdTask = await this.taskStore.createTask({
          title: taskTitle || feature.title,
          description,
          branch: branchAssignment.workingBranch,
          baseBranch: resolvedBaseBranch,
          ...(missionId
            ? {
                branchContext: {
                  ...(missionGroupId ? { groupId: missionGroupId } : {}),
                  source: "mission" as const,
                  assignmentMode: resolvedAssignmentMode,
                  inheritedBaseBranch: resolvedBaseBranch,
                },
              }
            : {}),
          /*
          FNXC:MissionWorkflows 2026-06-25-00:00:
          Apply the selected Missions header workflow atomically during TaskStore.createTask so newly triaged features land in the intended workflow lane. Duplicate-guard reuses skip this create path, preserving existing duplicate tasks without workflow mutation.
          */
          ...(branchOptions?.workflowId !== undefined ? { workflowId: branchOptions.workflowId } : {}),
        });

        if (guard.fingerprint) {
          await this.taskStore.updateTask(createdTask.id, {
            sourceMetadataPatch: { contentFingerprint: guard.fingerprint },
          });
        }

        const reconcile = await reconcileDeterministicDuplicate(this.taskStore, {
          createdTask,
          fingerprint: guard.fingerprint,
        });
        linkedTaskId = reconcile.canonical.id;
      }
    } finally {
      guard.releaseLock();
    }

    // Link the feature to the task (this also updates feature status to "triaged")
    const updated = this.linkFeatureToTask(featureId, linkedTaskId);

    return updated;
  }

  /**
   * Triage all "defined" features in a slice.
   *
   * Convenience method that iterates over all features in a slice with
   * status "defined" and triages each one, creating a task and linking it.
   * Features that are already triaged or in-progress are skipped.
   *
   * @param sliceId - Slice ID whose features should be triaged
   * @returns Array of updated features that were triaged
   * @throws Error if slice not found or TaskStore not available
   */
  async triageSlice(
    sliceId: string,
    branchOptions?: {
      branch?: string;
      baseBranch?: string;
      assignmentMode?: "shared" | "per-task-derived";
      workflowId?: string | null;
    },
  ): Promise<MissionFeature[]> {
    if (!this.taskStore) {
      throw new Error("TaskStore reference is required for triage operations");
    }

    const slice = this.getSlice(sliceId);
    if (!slice) {
      throw new Error(`Slice ${sliceId} not found`);
    }

    const features = this.listFeatures(sliceId);
    const definedFeatures = features.filter((f) => f.status === "defined");
    const milestone = this.getMilestone(slice.milestoneId);
    const mission = milestone ? this.getMission(milestone.missionId) : undefined;
    const strategyDefaults = missionBranchStrategyDefaults(mission?.branchStrategy);
    const resolvedBaseBranch = branchOptions?.baseBranch ?? mission?.baseBranch;
    const resolvedAssignmentMode = branchOptions?.assignmentMode ?? strategyDefaults.assignmentMode;
    const resolvedBranch = branchOptions?.branch ?? strategyDefaults.branch;

    const triaged: MissionFeature[] = [];
    for (const feature of definedFeatures) {
      const strategyBranch = resolvedBranch;
      const updated = await this.triageFeature(feature.id, undefined, undefined, {
        branch: strategyBranch,
        baseBranch: resolvedBaseBranch,
        assignmentMode: resolvedAssignmentMode,
        ...(branchOptions?.workflowId !== undefined ? { workflowId: branchOptions.workflowId } : {}),
      });
      triaged.push(updated);
    }

    return triaged;
  }

  // ── Status Rollup Logic ───────────────────────────────────────────

  /**
   * Compute the status of a slice based on its features.
   * - If no features: "pending"
   * - If all features linked to done tasks: "complete"
   * - If any feature linked to in-progress task: "active"
   * - If any feature linked to triaged (ready) task: "active"
   * - Otherwise: "pending"
   *
   * @param sliceId - Slice ID
   * @returns The computed slice status
   */
  computeSliceStatus(sliceId: string): SliceStatus {
    const features = this.listFeatures(sliceId);

    if (features.length === 0) {
      return "pending";
    }

    // Check if all features are done. For features linked to contract assertions,
    // a passed validator run is required before they count toward slice completion.
    const allDone = features.every((feature) => {
      if (feature.status !== "done") {
        return false;
      }
      const hasLinkedAssertions = this.listAssertionsForFeature(feature.id).length > 0;
      if (!hasLinkedAssertions) {
        return true;
      }
      if (feature.lastValidatorStatus === "passed") {
        return true;
      }
      // Gate completion for assertion-linked features that are in the execution loop.
      // Legacy/manual rows that remain idle retain prior completion behavior.
      return feature.loopState === "idle" || feature.loopState === undefined;
    });
    if (allDone) {
      return "complete";
    }

    // Check if any feature is in-progress or triaged (has a task link)
    const anyActive = features.some((f) =>
      f.status === "in-progress" || f.status === "triaged" || f.taskId !== undefined
    );
    if (anyActive) {
      return "active";
    }

    return "pending";
  }

  /**
   * Compute the status of a milestone based on its slices.
   * - If any slice "active": "active"
   * - If all slices "complete": "complete"
   * - If any slice "active" or "complete" but not all complete: "active"
   * - Otherwise: "planning"
   * Note: "blocked" is manually set, not auto-computed.
   *
   * @param milestoneId - Milestone ID
   * @returns The computed milestone status
   */
  computeMilestoneStatus(milestoneId: string): MilestoneStatus {
    const slices = this.listSlices(milestoneId);

    if (slices.length === 0) {
      return "planning";
    }

    const hasActive = slices.some((s) => s.status === "active");
    const allComplete = slices.every((s) => s.status === "complete");

    if (allComplete) {
      return "complete";
    }

    if (hasActive) {
      return "active";
    }

    const hasProgress = slices.some((s) => s.status === "active" || s.status === "complete");
    if (hasProgress) {
      return "active";
    }

    return "planning";
  }

  /**
   * Compute the status of a mission based on its milestones.
   * - If any milestone "active": "active"
   * - If all milestones "complete": "complete"
   * - If any milestone "active" or "complete" but not all complete: "active"
   * - Otherwise: "planning"
   * Note: "blocked" and "archived" are manually set.
   *
   * @param missionId - Mission ID
   * @returns The computed mission status
   */
  computeMissionStatus(missionId: string): MissionStatus {
    const milestones = this.listMilestones(missionId);

    if (milestones.length === 0) {
      return "planning";
    }

    const hasActive = milestones.some((m) => m.status === "active");
    const allComplete = milestones.every((m) => m.status === "complete");

    if (allComplete) {
      return "complete";
    }

    if (hasActive) {
      return "active";
    }

    const hasProgress = milestones.some((m) => m.status === "active" || m.status === "complete");
    if (hasProgress) {
      return "active";
    }

    return "planning";
  }

  /**
   * Recompute and update the slice status.
   * Called automatically after feature changes.
   */
  private recomputeSliceStatus(sliceId: string): void {
    const newStatus = this.computeSliceStatus(sliceId);
    const slice = this.getSlice(sliceId);

    if (slice && slice.status !== newStatus) {
      this.updateSlice(sliceId, { status: newStatus });
      // Don't emit here - updateSlice already emits and triggers milestone recompute
    }
  }

  /**
   * Recompute and update the milestone status.
   * Called automatically after slice changes.
   */
  private recomputeMilestoneStatus(milestoneId: string): void {
    const newStatus = this.computeMilestoneStatus(milestoneId);
    const milestone = this.getMilestone(milestoneId);

    if (milestone && milestone.status !== newStatus) {
      this.updateMilestone(milestoneId, { status: newStatus });
      // Don't emit here - updateMilestone already emits and triggers mission recompute
    }
  }

  /**
   * Recompute and update the mission status.
   * Called automatically after milestone changes.
   */
  private recomputeMissionStatus(missionId: string): void {
    const newStatus = this.computeMissionStatus(missionId);
    const mission = this.getMission(missionId);

    if (mission && mission.status !== newStatus) {
      this.updateMission(missionId, { status: newStatus });
      // Don't emit here - updateMission already emits
    }
  }

  // ── ID Generators ───────────────────────────────────────────────────

  private idSequence = 0;

  getMissionHierarchySnapshot(): MissionHierarchySnapshot {
    const missions = this.listMissions();
    const milestones = missions.flatMap((mission) => this.listMilestones(mission.id));
    const slices = milestones.flatMap((milestone) => this.listSlices(milestone.id));
    const features = slices.flatMap((slice) => this.listFeatures(slice.id));
    const missionEvents = missions.flatMap((mission) => this.getMissionEvents(mission.id, { limit: 10_000 }).events);
    const assertions = milestones.flatMap((milestone) => this.listContractAssertions(milestone.id));
    const featureAssertionLinks = this.db.prepare("SELECT featureId, assertionId, createdAt FROM mission_feature_assertions ORDER BY createdAt ASC").all() as Array<{ featureId: string; assertionId: string; createdAt: string }>;

    return createMissionHierarchySnapshot({
      missions,
      milestones,
      slices,
      features,
      missionEvents,
      assertions,
      featureAssertionLinks,
    });
  }

  applyMissionHierarchySnapshot(snapshot: MissionHierarchySnapshot): { applied: number } {
    validateSnapshotEnvelope(snapshot);
    let applied = 0;

    for (const mission of snapshot.payload.missions) {
      this.db.prepare(`INSERT INTO missions (id, title, description, status, interviewState, baseBranch, branchStrategy, autoMerge, autoAdvance, autopilotEnabled, autopilotState, lastAutopilotActivityAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title, description=excluded.description, status=excluded.status, interviewState=excluded.interviewState,
          baseBranch=excluded.baseBranch, branchStrategy=excluded.branchStrategy, autoMerge=excluded.autoMerge, autoAdvance=excluded.autoAdvance, autopilotEnabled=excluded.autopilotEnabled, autopilotState=excluded.autopilotState,
          lastAutopilotActivityAt=excluded.lastAutopilotActivityAt, updatedAt=excluded.updatedAt`).run(
        mission.id, mission.title, mission.description ?? null, mission.status, mission.interviewState,
        mission.baseBranch ?? null, mission.branchStrategy ? JSON.stringify(mission.branchStrategy) : null,
        mission.autoMerge === undefined ? null : (mission.autoMerge ? 1 : 0), mission.autoAdvance ? 1 : 0,
        mission.autopilotEnabled ? 1 : 0, mission.autopilotState, mission.lastAutopilotActivityAt ?? null, mission.createdAt, mission.updatedAt,
      );
      applied++;
    }

    for (const milestone of snapshot.payload.milestones) {
      this.db.prepare(`INSERT INTO milestones (id, missionId, title, description, status, orderIndex, interviewState, dependencies, planningNotes, verification, acceptanceCriteria, validationState, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, status=excluded.status, orderIndex=excluded.orderIndex,
          interviewState=excluded.interviewState, dependencies=excluded.dependencies, planningNotes=excluded.planningNotes, verification=excluded.verification,
          acceptanceCriteria=excluded.acceptanceCriteria, validationState=excluded.validationState, updatedAt=excluded.updatedAt`).run(
        milestone.id, milestone.missionId, milestone.title, milestone.description ?? null, milestone.status, milestone.orderIndex,
        milestone.interviewState, toJsonNullable(milestone.dependencies), milestone.planningNotes ?? null, milestone.verification ?? null,
        milestone.acceptanceCriteria ?? null, milestone.validationState ?? null, milestone.createdAt, milestone.updatedAt,
      );
      applied++;
    }

    for (const slice of snapshot.payload.slices) {
      this.db.prepare(`INSERT INTO slices (id, milestoneId, title, description, status, orderIndex, activatedAt, planState, planningNotes, verification, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, status=excluded.status, orderIndex=excluded.orderIndex,
          activatedAt=excluded.activatedAt, planState=excluded.planState, planningNotes=excluded.planningNotes, verification=excluded.verification, updatedAt=excluded.updatedAt`).run(
        slice.id, slice.milestoneId, slice.title, slice.description ?? null, slice.status, slice.orderIndex, slice.activatedAt ?? null,
        slice.planState ?? null, slice.planningNotes ?? null, slice.verification ?? null, slice.createdAt, slice.updatedAt,
      );
      applied++;
    }

    for (const feature of snapshot.payload.features) {
      this.db.prepare(`INSERT INTO mission_features (id, sliceId, taskId, title, description, acceptanceCriteria, status, createdAt, updatedAt, loopState, implementationAttemptCount, validatorAttemptCount, lastValidatorRunId, lastValidatorStatus, generatedFromFeatureId, generatedFromRunId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, title=excluded.title, description=excluded.description, acceptanceCriteria=excluded.acceptanceCriteria,
          status=excluded.status, updatedAt=excluded.updatedAt, loopState=excluded.loopState, implementationAttemptCount=excluded.implementationAttemptCount,
          validatorAttemptCount=excluded.validatorAttemptCount, lastValidatorRunId=excluded.lastValidatorRunId, lastValidatorStatus=excluded.lastValidatorStatus,
          generatedFromFeatureId=excluded.generatedFromFeatureId, generatedFromRunId=excluded.generatedFromRunId`).run(
        feature.id, feature.sliceId, feature.taskId ?? null, feature.title, feature.description ?? null, feature.acceptanceCriteria ?? null,
        feature.status, feature.createdAt, feature.updatedAt, feature.loopState ?? null, feature.implementationAttemptCount ?? null,
        feature.validatorAttemptCount ?? null, feature.lastValidatorRunId ?? null, feature.lastValidatorStatus ?? null,
        feature.generatedFromFeatureId ?? null, feature.generatedFromRunId ?? null,
      );
      applied++;
    }

    for (const event of snapshot.payload.missionEvents) {
      if (!event.id || !event.missionId) continue;
      this.db.prepare(`INSERT OR IGNORE INTO mission_events (id, missionId, eventType, description, metadata, timestamp, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(event.id, event.missionId, event.eventType, event.description, toJsonNullable(event.metadata), event.timestamp, event.seq ?? null);
    }

    for (const assertion of snapshot.payload.assertions) {
      if (!assertion.id || !assertion.milestoneId) continue;
      this.db.prepare(`INSERT INTO mission_contract_assertions (id, milestoneId, title, assertion, status, type, orderIndex, sourceFeatureId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, assertion=excluded.assertion, status=excluded.status, type=excluded.type, orderIndex=excluded.orderIndex, sourceFeatureId=excluded.sourceFeatureId, updatedAt=excluded.updatedAt`)
        .run(assertion.id, assertion.milestoneId, assertion.title, assertion.assertion, assertion.status, normalizeMissionAssertionType((assertion as { type?: unknown }).type), assertion.orderIndex, assertion.sourceFeatureId ?? null, assertion.createdAt, assertion.updatedAt);
    }

    for (const link of snapshot.payload.featureAssertionLinks) {
      if (!link.featureId || !link.assertionId) continue;
      this.db.prepare(`INSERT OR IGNORE INTO mission_feature_assertions (featureId, assertionId, createdAt) VALUES (?, ?, ?)`)
        .run(link.featureId, link.assertionId, link.createdAt);
    }

    return { applied };
  }

  private generateId(prefix: string): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    this.idSequence += 1;
    const sequence = this.idSequence.toString(36).toUpperCase().padStart(4, "0");
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${sequence}-${random}`;
  }

  private generateMissionId(): string {
    return this.generateId("M");
  }

  private generateMilestoneId(): string {
    return this.generateId("MS");
  }

  private generateSliceId(): string {
    return this.generateId("SL");
  }

  private generateFeatureId(): string {
    return this.generateId("F");
  }

  private generateMissionEventId(): string {
    return this.generateId("ME");
  }

  private generateAssertionId(): string {
    return this.generateId("CA");
  }

  private generateValidatorRunId(): string {
    return this.generateId("VR");
  }

  private generateFailureId(): string {
    return this.generateId("VF");
  }

  private generateLineageId(): string {
    return this.generateId("FL");
  }
}
