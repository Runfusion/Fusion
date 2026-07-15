/**
 * Async Drizzle MissionStore helpers (U6 satellite-mission-store).
 *
 * FNXC:MissionStore 2026-06-24-09:00:
 * Async equivalents of the sync SQLite MissionStore call sites in
 * mission-store.ts (~4382 lines, 84 prepare() calls). These helpers target
 * the PostgreSQL `project` schema tables (missions, milestones, slices,
 * mission_features, mission_events, mission_goals, mission_contract_assertions,
 * mission_feature_assertions, mission_validator_runs, mission_validator_failures,
 * mission_fix_feature_lineage) via Drizzle.
 *
 * SQLite → PostgreSQL notes (see library/satellite-store-migration-pattern.md):
 *   - jsonb columns (milestones.dependencies, mission_events.metadata,
 *     mission_fix_feature_lineage.failed_assertion_ids) return already-parsed
 *     JS values, so fromJson() is replaced by direct field access. On write,
 *     pass the JS value directly (Drizzle serializes it).
 *   - text columns (milestones.acceptanceCriteria, mission_features.acceptanceCriteria,
 *     slices.planningNotes/verification, milestones.planningNotes/verification)
 *     stay as plain strings — the U3 snapshot incorrectly mapped acceptanceCriteria
 *     as jsonb but it is plain text (derived criteria bullet list). Fixed in this
 *     feature's schema updates.
 *   - boolean 0/1 integer columns (missions.autoAdvance/autoMerge/autopilotEnabled)
 *     are kept as integer in PostgreSQL, so `row.autoAdvance === 1` checks work.
 *   - DELETE results: postgres.js does not expose rowCount on delete. Use
 *     .returning({ id }) and check .length (see async-todo-store.ts precedent).
 *   - ON CONFLICT: insert().onConflictDoUpdate() for upserts (snapshot apply),
 *     insert().onConflictDoNothing() for INSERT OR IGNORE semantics (mission_goals,
 *     mission_events snapshot, mission_feature_assertions snapshot).
 *   - Transactions: layer.transactionImmediate(async (tx) => ...) for multi-statement
 *     mutations (linkGoal existence checks + insert, startValidatorRun insert + update,
 *     deleteMilestone force-clear + delete, reorder operations).
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated flip.
 *   The sync MissionStore keeps its sync path (the gate depends on it). These
 *   helpers are the async target the PostgreSQL integration tests consume and
 *   that the MissionStore facade will delegate to after the getDatabase() flip.
 *   They program against the stable `AsyncDataLayer` interface (U4), not the
 *   underlying driver.
 */
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import { normalizeMissionAssertionType } from "./mission-types.js";
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
  MissionHealth,
  MissionEvent,
  MissionEventType,
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  InterviewState,
  AutopilotState,
  MissionContractAssertion,
  FeatureAssertionLink,
  MissionGoalLink,
  MilestoneValidationState,
  MilestoneValidationRollup,
  ContractAssertionCreateInput,
  ContractAssertionUpdateInput,
  SlicePlanState,
  ValidatorRunStatus,
  FeatureLoopState,
} from "./mission-types.js";
import type { Goal, GoalStatus } from "./goal-types.js";
import {
  deriveMilestoneAcceptanceCriteriaFromFeatures,
} from "./mission-store.js";
import type {
  MissionSummary,
  MissionAssertionBackfillReport,
  MissionAssertionTextSource,
  MissionStoreEvents,
} from "./mission-store.js";
import { reconcileDeterministicDuplicate, runDeterministicDuplicateGuard } from "./duplicate-guard.js";
import { resolveEntryPointBranchAssignment } from "./branch-assignment.js";

/**
 * FNXC:MissionStore 2026-06-27-15:00:
 * Default retry budget for implementation attempts (mirrors mission-store.ts).
 * When implementationAttemptCount reaches this limit, the feature loop blocks
 * instead of re-implementing.
 */
const DEFAULT_IMPLEMENTATION_RETRY_BUDGET = 3;

/**
 * FNXC:MissionStore 2026-06-27-15:00:
 * Local replica of the (non-exported) sync `missionBranchStrategyDefaults`.
 * Resolves a mission's branch strategy into a concrete {branch, assignmentMode}
 * used by triage.
 */
function missionBranchStrategyDefaults(strategy?: MissionBranchStrategy): {
  branch?: string;
  assignmentMode: "shared" | "per-task-derived";
} {
  if (!strategy) return { assignmentMode: "shared" };
  if (strategy.mode === "auto-per-task") return { assignmentMode: "per-task-derived" };
  if ((strategy.mode === "existing" || strategy.mode === "custom-new") && strategy.branchName?.trim()) {
    return { branch: strategy.branchName.trim(), assignmentMode: "shared" };
  }
  return { assignmentMode: "shared" };
}

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

// ── Row shapes (camelCase column aliases via Drizzle) ───────────────

interface MissionRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  interviewState: string;
  baseBranch: string | null;
  branchStrategy: string | null;
  autoMerge: number | null;
  autoAdvance: number | null;
  autopilotEnabled: number | null;
  autopilotState: string | null;
  lastAutopilotActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MilestoneRow {
  id: string;
  missionId: string;
  title: string;
  description: string | null;
  status: string;
  orderIndex: number;
  interviewState: string;
  dependencies: string[] | null;
  planningNotes: string | null;
  verification: string | null;
  acceptanceCriteria: string | null;
  validationState: string | null;
  createdAt: string;
  updatedAt: string;
}

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

interface MissionEventRow {
  id: string;
  missionId: string;
  eventType: string;
  description: string;
  metadata: unknown;
  timestamp: string;
  seq: number | null;
}

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

interface FeatureAssertionLinkRow {
  featureId: string;
  assertionId: string;
  createdAt: string;
}

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

interface LineageRow {
  id: string;
  sourceFeatureId: string;
  fixFeatureId: string;
  runId: string;
  failedAssertionIds: string[] | null;
  createdAt: string;
}

// ── Column projections (select only what we need) ────────────────────

const missionColumns = {
  id: schema.project.missions.id,
  title: schema.project.missions.title,
  description: schema.project.missions.description,
  status: schema.project.missions.status,
  interviewState: schema.project.missions.interviewState,
  baseBranch: schema.project.missions.baseBranch,
  branchStrategy: schema.project.missions.branchStrategy,
  autoMerge: schema.project.missions.autoMerge,
  autoAdvance: schema.project.missions.autoAdvance,
  autopilotEnabled: schema.project.missions.autopilotEnabled,
  autopilotState: schema.project.missions.autopilotState,
  lastAutopilotActivityAt: schema.project.missions.lastAutopilotActivityAt,
  createdAt: schema.project.missions.createdAt,
  updatedAt: schema.project.missions.updatedAt,
};

const milestoneColumns = {
  id: schema.project.milestones.id,
  missionId: schema.project.milestones.missionId,
  title: schema.project.milestones.title,
  description: schema.project.milestones.description,
  status: schema.project.milestones.status,
  orderIndex: schema.project.milestones.orderIndex,
  interviewState: schema.project.milestones.interviewState,
  dependencies: schema.project.milestones.dependencies,
  planningNotes: schema.project.milestones.planningNotes,
  verification: schema.project.milestones.verification,
  acceptanceCriteria: schema.project.milestones.acceptanceCriteria,
  validationState: schema.project.milestones.validationState,
  createdAt: schema.project.milestones.createdAt,
  updatedAt: schema.project.milestones.updatedAt,
};

const sliceColumns = {
  id: schema.project.slices.id,
  milestoneId: schema.project.slices.milestoneId,
  title: schema.project.slices.title,
  description: schema.project.slices.description,
  status: schema.project.slices.status,
  orderIndex: schema.project.slices.orderIndex,
  activatedAt: schema.project.slices.activatedAt,
  planState: schema.project.slices.planState,
  planningNotes: schema.project.slices.planningNotes,
  verification: schema.project.slices.verification,
  createdAt: schema.project.slices.createdAt,
  updatedAt: schema.project.slices.updatedAt,
};

const featureColumns = {
  id: schema.project.missionFeatures.id,
  sliceId: schema.project.missionFeatures.sliceId,
  taskId: schema.project.missionFeatures.taskId,
  title: schema.project.missionFeatures.title,
  description: schema.project.missionFeatures.description,
  acceptanceCriteria: schema.project.missionFeatures.acceptanceCriteria,
  status: schema.project.missionFeatures.status,
  createdAt: schema.project.missionFeatures.createdAt,
  updatedAt: schema.project.missionFeatures.updatedAt,
  loopState: schema.project.missionFeatures.loopState,
  implementationAttemptCount: schema.project.missionFeatures.implementationAttemptCount,
  validatorAttemptCount: schema.project.missionFeatures.validatorAttemptCount,
  lastValidatorRunId: schema.project.missionFeatures.lastValidatorRunId,
  lastValidatorStatus: schema.project.missionFeatures.lastValidatorStatus,
  generatedFromFeatureId: schema.project.missionFeatures.generatedFromFeatureId,
  generatedFromRunId: schema.project.missionFeatures.generatedFromRunId,
};

const eventColumns = {
  id: schema.project.missionEvents.id,
  missionId: schema.project.missionEvents.missionId,
  eventType: schema.project.missionEvents.eventType,
  description: schema.project.missionEvents.description,
  metadata: schema.project.missionEvents.metadata,
  timestamp: schema.project.missionEvents.timestamp,
  seq: schema.project.missionEvents.seq,
};

const missionGoalColumns = {
  missionId: schema.project.missionGoals.missionId,
  goalId: schema.project.missionGoals.goalId,
  createdAt: schema.project.missionGoals.createdAt,
};

const assertionColumns = {
  id: schema.project.missionContractAssertions.id,
  milestoneId: schema.project.missionContractAssertions.milestoneId,
  title: schema.project.missionContractAssertions.title,
  assertion: schema.project.missionContractAssertions.assertion,
  status: schema.project.missionContractAssertions.status,
  type: schema.project.missionContractAssertions.type,
  orderIndex: schema.project.missionContractAssertions.orderIndex,
  sourceFeatureId: schema.project.missionContractAssertions.sourceFeatureId,
  createdAt: schema.project.missionContractAssertions.createdAt,
  updatedAt: schema.project.missionContractAssertions.updatedAt,
};

const validatorRunColumns = {
  id: schema.project.missionValidatorRuns.id,
  featureId: schema.project.missionValidatorRuns.featureId,
  milestoneId: schema.project.missionValidatorRuns.milestoneId,
  sliceId: schema.project.missionValidatorRuns.sliceId,
  status: schema.project.missionValidatorRuns.status,
  triggerType: schema.project.missionValidatorRuns.triggerType,
  implementationAttempt: schema.project.missionValidatorRuns.implementationAttempt,
  validatorAttempt: schema.project.missionValidatorRuns.validatorAttempt,
  taskId: schema.project.missionValidatorRuns.taskId,
  summary: schema.project.missionValidatorRuns.summary,
  blockedReason: schema.project.missionValidatorRuns.blockedReason,
  startedAt: schema.project.missionValidatorRuns.startedAt,
  completedAt: schema.project.missionValidatorRuns.completedAt,
  createdAt: schema.project.missionValidatorRuns.createdAt,
  updatedAt: schema.project.missionValidatorRuns.updatedAt,
};

const failureColumns = {
  id: schema.project.missionValidatorFailures.id,
  runId: schema.project.missionValidatorFailures.runId,
  featureId: schema.project.missionValidatorFailures.featureId,
  assertionId: schema.project.missionValidatorFailures.assertionId,
  message: schema.project.missionValidatorFailures.message,
  expected: schema.project.missionValidatorFailures.expected,
  actual: schema.project.missionValidatorFailures.actual,
  createdAt: schema.project.missionValidatorFailures.createdAt,
};

const lineageColumns = {
  id: schema.project.missionFixFeatureLineage.id,
  sourceFeatureId: schema.project.missionFixFeatureLineage.sourceFeatureId,
  fixFeatureId: schema.project.missionFixFeatureLineage.fixFeatureId,
  runId: schema.project.missionFixFeatureLineage.runId,
  failedAssertionIds: schema.project.missionFixFeatureLineage.failedAssertionIds,
  createdAt: schema.project.missionFixFeatureLineage.createdAt,
};

// ── Row-to-object converters ────────────────────────────────────────

function rowToMission(row: MissionRow): Mission {
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
    description: row.description ?? undefined,
    status: row.status as MissionStatus,
    interviewState: row.interviewState as InterviewState,
    baseBranch: row.baseBranch ?? undefined,
    branchStrategy,
    autoMerge: row.autoMerge === null ? undefined : Boolean(row.autoMerge),
    autoAdvance: Boolean(row.autoAdvance ?? 0),
    autopilotEnabled: Boolean(row.autopilotEnabled ?? 0),
    autopilotState: (row.autopilotState as AutopilotState) || "inactive",
    lastAutopilotActivityAt: row.lastAutopilotActivityAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    missionId: row.missionId,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as MilestoneStatus,
    orderIndex: row.orderIndex,
    interviewState: row.interviewState as InterviewState,
    // FNXC:MissionStore 2026-06-24-09:10:
    // dependencies is jsonb in PostgreSQL (was TEXT DEFAULT '[]' in SQLite).
    // Drizzle returns it as a parsed JS array. Guard against null for rows
    // that pre-date the jsonb default.
    dependencies: Array.isArray(row.dependencies) ? row.dependencies : [],
    planningNotes: row.planningNotes ?? undefined,
    verification: row.verification ?? undefined,
    acceptanceCriteria: row.acceptanceCriteria ?? undefined,
    validationState: (row.validationState as MilestoneValidationState) || "not_started",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToSlice(row: SliceRow): Slice {
  return {
    id: row.id,
    milestoneId: row.milestoneId,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as SliceStatus,
    orderIndex: row.orderIndex,
    activatedAt: row.activatedAt ?? undefined,
    planState: (row.planState as SlicePlanState) || "not_started",
    planningNotes: row.planningNotes ?? undefined,
    verification: row.verification ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToFeature(row: FeatureRow): MissionFeature {
  return {
    id: row.id,
    sliceId: row.sliceId,
    taskId: row.taskId ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    acceptanceCriteria: row.acceptanceCriteria ?? undefined,
    status: row.status as FeatureStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    loopState: (row.loopState as FeatureLoopState) || "idle",
    implementationAttemptCount: row.implementationAttemptCount ?? 0,
    validatorAttemptCount: row.validatorAttemptCount ?? 0,
    lastValidatorRunId: row.lastValidatorRunId ?? undefined,
    lastValidatorStatus: (row.lastValidatorStatus as ValidatorRunStatus) ?? undefined,
    generatedFromFeatureId: row.generatedFromFeatureId ?? undefined,
    generatedFromRunId: row.generatedFromRunId ?? undefined,
  };
}

function rowToMissionEvent(row: MissionEventRow): MissionEvent {
  return {
    id: row.id,
    missionId: row.missionId,
    eventType: row.eventType as MissionEvent["eventType"],
    description: row.description,
    // FNXC:MissionStore 2026-06-24-09:15:
    // metadata is jsonb in PostgreSQL (was TEXT in SQLite). Drizzle returns
    // it already-parsed. Null stays null.
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    timestamp: row.timestamp,
    seq: row.seq ?? 0,
  };
}

function rowToMissionGoalLink(row: MissionGoalRow): MissionGoalLink {
  return { missionId: row.missionId, goalId: row.goalId, createdAt: row.createdAt };
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToAssertion(row: AssertionRow): MissionContractAssertion {
  return {
    id: row.id,
    milestoneId: row.milestoneId,
    sourceFeatureId: row.sourceFeatureId ?? undefined,
    title: row.title,
    assertion: row.assertion,
    status: row.status as MissionContractAssertion["status"],
    type: normalizeMissionAssertionType(row.type),
    orderIndex: row.orderIndex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToFeatureAssertionLink(row: FeatureAssertionLinkRow): FeatureAssertionLink {
  return { featureId: row.featureId, assertionId: row.assertionId, createdAt: row.createdAt };
}

function rowToValidatorRun(row: ValidatorRunRow): MissionValidatorRun {
  return {
    id: row.id,
    featureId: row.featureId,
    milestoneId: row.milestoneId,
    sliceId: row.sliceId,
    status: row.status as ValidatorRunStatus,
    triggerType: row.triggerType ?? undefined,
    implementationAttempt: row.implementationAttempt ?? 0,
    validatorAttempt: row.validatorAttempt ?? 0,
    taskId: row.taskId ?? undefined,
    summary: row.summary ?? undefined,
    blockedReason: row.blockedReason ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToFailure(row: FailureRow): MissionAssertionFailureRecord {
  return {
    id: row.id,
    runId: row.runId,
    featureId: row.featureId,
    assertionId: row.assertionId,
    message: row.message ?? undefined,
    expected: row.expected ?? undefined,
    actual: row.actual ?? undefined,
    createdAt: row.createdAt,
  };
}

function rowToLineage(row: LineageRow): MissionFixFeatureLineage {
  return {
    id: row.id,
    sourceFeatureId: row.sourceFeatureId,
    fixFeatureId: row.fixFeatureId,
    runId: row.runId,
    // failedAssertionIds is jsonb in PostgreSQL (was TEXT in SQLite).
    failedAssertionIds: Array.isArray(row.failedAssertionIds) ? row.failedAssertionIds : [],
    createdAt: row.createdAt,
  };
}

// ── Helpers for write serialization ─────────────────────────────────

/**
 * FNXC:MissionStore 2026-06-24-09:20:
 * Serialize a MissionBranchStrategy for the text branchStrategy column.
 * The column stores the strategy as a JSON string (parsed on read by rowToMission).
 */
function serializeBranchStrategy(strategy: MissionBranchStrategy | undefined): string | null {
  return strategy ? JSON.stringify(strategy) : null;
}

// ════════════════════════════════════════════════════════════════════
// MISSION CRUD
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-09:25:
 * Create a mission (non-destructive INSERT, VAL-DATA-009). Missions are always
 * created with status "planning" and autopilot disabled.
 */
export async function createMission(
  handle: QueryHandle,
  input: { id: string } & MissionCreateInput & { createdAt: string; updatedAt: string; status: string; interviewState: string; autoAdvance: boolean; autopilotEnabled: boolean; autopilotState: string },
): Promise<Mission> {
  await handle.insert(schema.project.missions).values({
    id: input.id,
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    interviewState: input.interviewState,
    baseBranch: input.baseBranch ?? null,
    branchStrategy: serializeBranchStrategy(input.branchStrategy),
    autoMerge: input.autoMerge === undefined ? null : input.autoMerge ? 1 : 0,
    autoAdvance: input.autoAdvance ? 1 : 0,
    autopilotEnabled: input.autopilotEnabled ? 1 : 0,
    autopilotState: input.autopilotState ?? "inactive",
    lastAutopilotActivityAt: null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  return (await getMission(handle, input.id))!;
}

/** Get a single mission by id. */
export async function getMission(handle: QueryHandle, id: string): Promise<Mission | undefined> {
  const rows = await handle
    .select(missionColumns)
    .from(schema.project.missions)
    .where(eq(schema.project.missions.id, id));
  return rows[0] ? rowToMission(rows[0] as MissionRow) : undefined;
}

/** List all missions, ordered by createdAt DESC (newest first). */
export async function listMissions(handle: QueryHandle): Promise<Mission[]> {
  const rows = await handle
    .select(missionColumns)
    .from(schema.project.missions)
    .orderBy(desc(schema.project.missions.createdAt));
  return rows.map((row) => rowToMission(row as MissionRow));
}

/**
 * FNXC:MissionStore 2026-06-24-09:30:
 * Update a mission's mutable columns. branchStrategy is serialized as JSON text.
 */
export async function updateMission(
  handle: QueryHandle,
  mission: Mission,
): Promise<void> {
  await handle
    .update(schema.project.missions)
    .set({
      title: mission.title,
      description: mission.description ?? null,
      status: mission.status,
      interviewState: mission.interviewState,
      baseBranch: mission.baseBranch ?? null,
      branchStrategy: serializeBranchStrategy(mission.branchStrategy),
      autoMerge: mission.autoMerge === undefined ? null : mission.autoMerge ? 1 : 0,
      autoAdvance: mission.autoAdvance ? 1 : 0,
      autopilotEnabled: mission.autopilotEnabled ? 1 : 0,
      autopilotState: mission.autopilotState ?? "inactive",
      lastAutopilotActivityAt: mission.lastAutopilotActivityAt ?? null,
      updatedAt: mission.updatedAt,
    })
    .where(eq(schema.project.missions.id, mission.id));
}

/** Delete a mission by id (cascades to milestones/slices/features/events). Returns true if a row was deleted. */
export async function deleteMission(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missions)
    .where(eq(schema.project.missions.id, id))
    .returning({ id: schema.project.missions.id });
  return result.length > 0;
}

/** Check whether a mission with the given id exists. */
export async function missionExists(handle: QueryHandle, id: string): Promise<boolean> {
  const rows = await handle
    .select({ id: schema.project.missions.id })
    .from(schema.project.missions)
    .where(eq(schema.project.missions.id, id));
  return rows.length > 0;
}

// ════════════════════════════════════════════════════════════════════
// MILESTONE CRUD
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-09:35:
 * Create a milestone (non-destructive INSERT). dependencies is a jsonb array.
 */
export async function createMilestone(
  handle: QueryHandle,
  milestone: Milestone,
): Promise<Milestone> {
  await handle.insert(schema.project.milestones).values({
    id: milestone.id,
    missionId: milestone.missionId,
    title: milestone.title,
    description: milestone.description ?? null,
    status: milestone.status,
    orderIndex: milestone.orderIndex,
    interviewState: milestone.interviewState,
    dependencies: milestone.dependencies,
    planningNotes: milestone.planningNotes ?? null,
    verification: milestone.verification ?? null,
    acceptanceCriteria: milestone.acceptanceCriteria ?? null,
    validationState: milestone.validationState ?? "not_started",
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
  });
  return (await getMilestone(handle, milestone.id))!;
}

/** Get a single milestone by id. */
export async function getMilestone(handle: QueryHandle, id: string): Promise<Milestone | undefined> {
  const rows = await handle
    .select(milestoneColumns)
    .from(schema.project.milestones)
    .where(eq(schema.project.milestones.id, id));
  return rows[0] ? rowToMilestone(rows[0] as MilestoneRow) : undefined;
}

/** List milestones for a mission, ordered by orderIndex ASC. */
export async function listMilestones(handle: QueryHandle, missionId: string): Promise<Milestone[]> {
  const rows = await handle
    .select(milestoneColumns)
    .from(schema.project.milestones)
    .where(eq(schema.project.milestones.missionId, missionId))
    .orderBy(asc(schema.project.milestones.orderIndex));
  return rows.map((row) => rowToMilestone(row as MilestoneRow));
}

/** List ALL milestones across all missions, ordered by orderIndex ASC. */
export async function listAllMilestones(handle: QueryHandle): Promise<Milestone[]> {
  const rows = await handle
    .select(milestoneColumns)
    .from(schema.project.milestones)
    .orderBy(asc(schema.project.milestones.orderIndex));
  return rows.map((row) => rowToMilestone(row as MilestoneRow));
}

/** Update a milestone's mutable columns. */
export async function updateMilestone(handle: QueryHandle, milestone: Milestone): Promise<void> {
  await handle
    .update(schema.project.milestones)
    .set({
      title: milestone.title,
      description: milestone.description ?? null,
      status: milestone.status,
      orderIndex: milestone.orderIndex,
      interviewState: milestone.interviewState,
      dependencies: milestone.dependencies,
      planningNotes: milestone.planningNotes ?? null,
      verification: milestone.verification ?? null,
      acceptanceCriteria: milestone.acceptanceCriteria ?? null,
      validationState: milestone.validationState || "not_started",
      updatedAt: milestone.updatedAt,
    })
    .where(eq(schema.project.milestones.id, milestone.id));
}

/** Delete a milestone by id (cascades to slices/features). Returns true if deleted. */
export async function deleteMilestone(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.milestones)
    .where(eq(schema.project.milestones.id, id))
    .returning({ id: schema.project.milestones.id });
  return result.length > 0;
}

/**
 * FNXC:MissionStore 2026-06-24-09:40:
 * Reorder milestones transactionally. Each milestone's orderIndex is set to its
 * array position. The entire reorder runs in one transaction so partial reorders
 * never persist.
 */
export async function reorderMilestones(
  layer: AsyncDataLayer,
  orderedIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await layer.transactionImmediate(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(schema.project.milestones)
        .set({ orderIndex: i, updatedAt: now })
        .where(eq(schema.project.milestones.id, orderedIds[i]!));
    }
  });
}

// ════════════════════════════════════════════════════════════════════
// SLICE CRUD
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-09:45:
 * Create a slice (non-destructive INSERT).
 */
export async function createSlice(handle: QueryHandle, slice: Slice): Promise<Slice> {
  await handle.insert(schema.project.slices).values({
    id: slice.id,
    milestoneId: slice.milestoneId,
    title: slice.title,
    description: slice.description ?? null,
    status: slice.status,
    orderIndex: slice.orderIndex,
    activatedAt: slice.activatedAt ?? null,
    planState: slice.planState ?? "not_started",
    planningNotes: slice.planningNotes ?? null,
    verification: slice.verification ?? null,
    createdAt: slice.createdAt,
    updatedAt: slice.updatedAt,
  });
  return (await getSlice(handle, slice.id))!;
}

/** Get a single slice by id. */
export async function getSlice(handle: QueryHandle, id: string): Promise<Slice | undefined> {
  const rows = await handle
    .select(sliceColumns)
    .from(schema.project.slices)
    .where(eq(schema.project.slices.id, id));
  return rows[0] ? rowToSlice(rows[0] as SliceRow) : undefined;
}

/** List slices for a milestone, ordered by orderIndex ASC. */
export async function listSlices(handle: QueryHandle, milestoneId: string): Promise<Slice[]> {
  const rows = await handle
    .select(sliceColumns)
    .from(schema.project.slices)
    .where(eq(schema.project.slices.milestoneId, milestoneId))
    .orderBy(asc(schema.project.slices.orderIndex));
  return rows.map((row) => rowToSlice(row as SliceRow));
}

/** List ALL slices across all milestones, ordered by orderIndex ASC. */
export async function listAllSlices(handle: QueryHandle): Promise<Slice[]> {
  const rows = await handle
    .select(sliceColumns)
    .from(schema.project.slices)
    .orderBy(asc(schema.project.slices.orderIndex));
  return rows.map((row) => rowToSlice(row as SliceRow));
}

/** Update a slice's mutable columns. */
export async function updateSlice(handle: QueryHandle, slice: Slice): Promise<void> {
  await handle
    .update(schema.project.slices)
    .set({
      title: slice.title,
      description: slice.description ?? null,
      status: slice.status,
      orderIndex: slice.orderIndex,
      activatedAt: slice.activatedAt ?? null,
      planState: slice.planState ?? "not_started",
      planningNotes: slice.planningNotes ?? null,
      verification: slice.verification ?? null,
      updatedAt: slice.updatedAt,
    })
    .where(eq(schema.project.slices.id, slice.id));
}

/** Delete a slice by id (cascades to features). Returns true if deleted. */
export async function deleteSlice(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.slices)
    .where(eq(schema.project.slices.id, id))
    .returning({ id: schema.project.slices.id });
  return result.length > 0;
}

/** Reorder slices transactionally within a milestone. */
export async function reorderSlices(
  layer: AsyncDataLayer,
  orderedIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await layer.transactionImmediate(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(schema.project.slices)
        .set({ orderIndex: i, updatedAt: now })
        .where(eq(schema.project.slices.id, orderedIds[i]!));
    }
  });
}

// ════════════════════════════════════════════════════════════════════
// FEATURE CRUD
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-09:50:
 * Create a feature (non-destructive INSERT).
 */
export async function createFeature(handle: QueryHandle, feature: MissionFeature): Promise<MissionFeature> {
  await handle.insert(schema.project.missionFeatures).values({
    id: feature.id,
    sliceId: feature.sliceId,
    taskId: feature.taskId ?? null,
    title: feature.title,
    description: feature.description ?? null,
    acceptanceCriteria: feature.acceptanceCriteria ?? null,
    status: feature.status,
    createdAt: feature.createdAt,
    updatedAt: feature.updatedAt,
    loopState: feature.loopState ?? "idle",
    implementationAttemptCount: feature.implementationAttemptCount ?? 0,
    validatorAttemptCount: feature.validatorAttemptCount ?? 0,
    lastValidatorRunId: feature.lastValidatorRunId ?? null,
    lastValidatorStatus: feature.lastValidatorStatus ?? null,
    generatedFromFeatureId: feature.generatedFromFeatureId ?? null,
    generatedFromRunId: feature.generatedFromRunId ?? null,
  });
  return (await getFeature(handle, feature.id))!;
}

/** Get a single feature by id. */
export async function getFeature(handle: QueryHandle, id: string): Promise<MissionFeature | undefined> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(eq(schema.project.missionFeatures.id, id));
  return rows[0] ? rowToFeature(rows[0] as FeatureRow) : undefined;
}

/** List features for a slice, ordered by createdAt ASC. */
export async function listFeatures(handle: QueryHandle, sliceId: string): Promise<MissionFeature[]> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(eq(schema.project.missionFeatures.sliceId, sliceId))
    .orderBy(asc(schema.project.missionFeatures.createdAt));
  return rows.map((row) => rowToFeature(row as FeatureRow));
}

/** List ALL features across all slices, ordered by createdAt ASC. */
export async function listAllFeatures(handle: QueryHandle): Promise<MissionFeature[]> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .orderBy(asc(schema.project.missionFeatures.createdAt));
  return rows.map((row) => rowToFeature(row as FeatureRow));
}

/**
 * FNXC:MissionStore 2026-06-24-09:55:
 * Update a feature's mutable columns. This is the core mutation surface for the
 * implement→validate→fix loop (loopState, attempt counts, last validator linkage).
 */
export async function updateFeature(handle: QueryHandle, feature: MissionFeature): Promise<void> {
  await handle
    .update(schema.project.missionFeatures)
    .set({
      taskId: feature.taskId ?? null,
      title: feature.title,
      description: feature.description ?? null,
      acceptanceCriteria: feature.acceptanceCriteria ?? null,
      status: feature.status,
      updatedAt: feature.updatedAt,
      loopState: feature.loopState ?? "idle",
      implementationAttemptCount: feature.implementationAttemptCount ?? 0,
      validatorAttemptCount: feature.validatorAttemptCount ?? 0,
      lastValidatorRunId: feature.lastValidatorRunId ?? null,
      lastValidatorStatus: feature.lastValidatorStatus ?? null,
      generatedFromFeatureId: feature.generatedFromFeatureId ?? null,
      generatedFromRunId: feature.generatedFromRunId ?? null,
    })
    .where(eq(schema.project.missionFeatures.id, feature.id));
}

/** Delete a feature by id. Returns true if deleted. */
export async function deleteFeature(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missionFeatures)
    .where(eq(schema.project.missionFeatures.id, id))
    .returning({ id: schema.project.missionFeatures.id });
  return result.length > 0;
}

/** Get a feature by its linked taskId (null if no feature is linked). */
export async function getFeatureByTaskId(handle: QueryHandle, taskId: string): Promise<MissionFeature | undefined> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(eq(schema.project.missionFeatures.taskId, taskId));
  return rows[0] ? rowToFeature(rows[0] as FeatureRow) : undefined;
}

/**
 * FNXC:MissionStore 2026-06-24-10:00:
 * Unlink a feature from its task (set taskId = NULL). Used when force-deleting
 * a slice/milestone or unlinking a feature from a task.
 */
export async function unlinkFeatureFromTaskId(handle: QueryHandle, featureId: string): Promise<void> {
  const now = new Date().toISOString();
  await handle
    .update(schema.project.missionFeatures)
    .set({ taskId: null, updatedAt: now })
    .where(eq(schema.project.missionFeatures.id, featureId));
}

// ════════════════════════════════════════════════════════════════════
// MISSION EVENTS
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-10:05:
 * Get the maximum event seq for the mission_events table (used to initialize
 * the event sequence counter on store open so new events have unique seqs).
 */
export async function getMaxEventSeq(handle: QueryHandle): Promise<number> {
  const rows = await handle
    .select({ maxSeq: sql<number | null>`max(${schema.project.missionEvents.seq})` })
    .from(schema.project.missionEvents);
  return rows[0]?.maxSeq ?? 0;
}

/**
 * FNXC:MissionStore 2026-06-24-10:10:
 * Insert a mission event (non-destructive). metadata is a jsonb column.
 */
export async function insertMissionEvent(handle: QueryHandle, event: MissionEvent): Promise<void> {
  await handle.insert(schema.project.missionEvents).values({
    id: event.id,
    missionId: event.missionId,
    eventType: event.eventType,
    description: event.description,
    metadata: event.metadata,
    timestamp: event.timestamp,
    seq: event.seq,
  });
}

/**
 * FNXC:MissionStore 2026-06-24-10:15:
 * Insert a mission event with INSERT OR IGNORE semantics (snapshot apply).
 */
export async function insertMissionEventIfAbsent(handle: QueryHandle, event: MissionEvent): Promise<void> {
  await handle
    .insert(schema.project.missionEvents)
    .values({
      id: event.id,
      missionId: event.missionId,
      eventType: event.eventType,
      description: event.description,
      metadata: event.metadata,
      timestamp: event.timestamp,
      seq: event.seq,
    })
    .onConflictDoNothing();
}

/** Count events for a mission. */
export async function countMissionEvents(handle: QueryHandle, missionId: string): Promise<number> {
  const rows = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.missionEvents)
    .where(eq(schema.project.missionEvents.missionId, missionId));
  return rows[0]?.count ?? 0;
}

/** Get events for a mission, ordered by seq DESC (or timestamp DESC, id DESC), with optional limit. */
export async function listMissionEvents(
  handle: QueryHandle,
  missionId: string,
  limit?: number,
): Promise<MissionEvent[]> {
  let query = handle
    .select(eventColumns)
    .from(schema.project.missionEvents)
    .where(eq(schema.project.missionEvents.missionId, missionId))
    .orderBy(desc(schema.project.missionEvents.seq), desc(schema.project.missionEvents.id));
  if (limit !== undefined) {
    query = query.limit(limit) as typeof query;
  }
  const rows = await query;
  return rows.map((row) => rowToMissionEvent(row as MissionEventRow));
}

/** Count events grouped by missionId (batch query for summaries). */
export async function countEventsByMission(handle: QueryHandle): Promise<Map<string, number>> {
  const rows = await handle
    .select({
      missionId: schema.project.missionEvents.missionId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.project.missionEvents)
    .groupBy(schema.project.missionEvents.missionId);
  return new Map(rows.map((row) => [row.missionId, row.count]));
}

/**
 * FNXC:MissionStore 2026-06-24-10:20:
 * Get the latest error event per mission (batch query for health rollup).
 * Ordered by seq DESC, id DESC so the first row per missionId is the latest.
 */
export async function listErrorEventsForHealth(handle: QueryHandle): Promise<Array<{ missionId: string; timestamp: string; description: string }>> {
  return handle
    .select({
      missionId: schema.project.missionEvents.missionId,
      timestamp: schema.project.missionEvents.timestamp,
      description: schema.project.missionEvents.description,
    })
    .from(schema.project.missionEvents)
    .where(eq(schema.project.missionEvents.eventType, "error"))
    .orderBy(desc(schema.project.missionEvents.seq), desc(schema.project.missionEvents.id));
}

// ════════════════════════════════════════════════════════════════════
// MISSION-GOAL LINKS
// ════════════════════════════════════════════════════════════════════

/** Get a mission-goal link row if it exists. */
export async function getMissionGoalLink(
  handle: QueryHandle,
  missionId: string,
  goalId: string,
): Promise<MissionGoalLink | undefined> {
  const rows = await handle
    .select(missionGoalColumns)
    .from(schema.project.missionGoals)
    .where(
      and(
        eq(schema.project.missionGoals.missionId, missionId),
        eq(schema.project.missionGoals.goalId, goalId),
      ),
    );
  return rows[0] ? rowToMissionGoalLink(rows[0] as MissionGoalRow) : undefined;
}

/**
 * FNXC:MissionStore 2026-06-24-10:25:
 * Insert a mission-goal link with INSERT OR IGNORE semantics (idempotent link).
 */
export async function insertMissionGoalLink(
  handle: QueryHandle,
  missionId: string,
  goalId: string,
  createdAt: string,
): Promise<void> {
  await handle
    .insert(schema.project.missionGoals)
    .values({ missionId, goalId, createdAt })
    .onConflictDoNothing();
}

/** Delete a mission-goal link. Returns true if a row was deleted. */
export async function deleteMissionGoalLink(
  handle: QueryHandle,
  missionId: string,
  goalId: string,
): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missionGoals)
    .where(
      and(
        eq(schema.project.missionGoals.missionId, missionId),
        eq(schema.project.missionGoals.goalId, goalId),
      ),
    )
    .returning({ missionId: schema.project.missionGoals.missionId });
  return result.length > 0;
}

/** List goal IDs linked to a mission, ordered by createdAt ASC, goalId ASC. */
export async function listGoalIdsForMission(handle: QueryHandle, missionId: string): Promise<string[]> {
  const rows = await handle
    .select({ goalId: schema.project.missionGoals.goalId })
    .from(schema.project.missionGoals)
    .where(eq(schema.project.missionGoals.missionId, missionId))
    .orderBy(asc(schema.project.missionGoals.createdAt), asc(schema.project.missionGoals.goalId));
  return rows.map((row) => row.goalId);
}

/** List mission IDs linked to a goal, ordered by createdAt ASC, missionId ASC. */
export async function listMissionIdsForGoal(handle: QueryHandle, goalId: string): Promise<string[]> {
  const rows = await handle
    .select({ missionId: schema.project.missionGoals.missionId })
    .from(schema.project.missionGoals)
    .where(eq(schema.project.missionGoals.goalId, goalId))
    .orderBy(asc(schema.project.missionGoals.createdAt), asc(schema.project.missionGoals.missionId));
  return rows.map((row) => row.missionId);
}

/** Count goals linked per mission (batch query for summaries). */
export async function countGoalsByMission(handle: QueryHandle): Promise<Map<string, number>> {
  const rows = await handle
    .select({
      missionId: schema.project.missionGoals.missionId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.project.missionGoals)
    .groupBy(schema.project.missionGoals.missionId);
  return new Map(rows.map((row) => [row.missionId, row.count]));
}

/** Check whether a goal exists (for link validation). */
export async function goalExists(handle: QueryHandle, goalId: string): Promise<boolean> {
  const rows = await handle
    .select({ id: schema.project.goals.id })
    .from(schema.project.goals)
    .where(eq(schema.project.goals.id, goalId));
  return rows.length > 0;
}

/** Get a goal by id. */
export async function getGoal(handle: QueryHandle, goalId: string): Promise<Goal | undefined> {
  const rows = await handle
    .select({
      id: schema.project.goals.id,
      title: schema.project.goals.title,
      description: schema.project.goals.description,
      status: schema.project.goals.status,
      createdAt: schema.project.goals.createdAt,
      updatedAt: schema.project.goals.updatedAt,
    })
    .from(schema.project.goals)
    .where(eq(schema.project.goals.id, goalId));
  return rows[0] ? rowToGoal(rows[0] as GoalRow) : undefined;
}

/** Get goals by IDs (batch fetch). */
export async function listGoalsByIds(handle: QueryHandle, goalIds: string[]): Promise<Goal[]> {
  if (goalIds.length === 0) return [];
  const rows = await handle
    .select({
      id: schema.project.goals.id,
      title: schema.project.goals.title,
      description: schema.project.goals.description,
      status: schema.project.goals.status,
      createdAt: schema.project.goals.createdAt,
      updatedAt: schema.project.goals.updatedAt,
    })
    .from(schema.project.goals)
    .where(inArray(schema.project.goals.id, goalIds));
  return rows.map((row) => rowToGoal(row as GoalRow));
}

// ════════════════════════════════════════════════════════════════════
// CONTRACT ASSERTIONS
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-10:30:
 * Create a contract assertion (non-destructive INSERT).
 */
export async function createContractAssertion(
  handle: QueryHandle,
  assertion: MissionContractAssertion,
): Promise<MissionContractAssertion> {
  await handle.insert(schema.project.missionContractAssertions).values({
    id: assertion.id,
    milestoneId: assertion.milestoneId,
    title: assertion.title,
    assertion: assertion.assertion,
    status: assertion.status,
    type: normalizeMissionAssertionType(assertion.type),
    orderIndex: assertion.orderIndex,
    sourceFeatureId: assertion.sourceFeatureId ?? null,
    createdAt: assertion.createdAt,
    updatedAt: assertion.updatedAt,
  });
  return (await getContractAssertion(handle, assertion.id))!;
}

/** Get a contract assertion by id. */
export async function getContractAssertion(handle: QueryHandle, id: string): Promise<MissionContractAssertion | undefined> {
  const rows = await handle
    .select(assertionColumns)
    .from(schema.project.missionContractAssertions)
    .where(eq(schema.project.missionContractAssertions.id, id));
  return rows[0] ? rowToAssertion(rows[0] as AssertionRow) : undefined;
}

/** List contract assertions for a milestone, ordered by orderIndex, createdAt, id. */
export async function listContractAssertions(handle: QueryHandle, milestoneId: string): Promise<MissionContractAssertion[]> {
  const rows = await handle
    .select(assertionColumns)
    .from(schema.project.missionContractAssertions)
    .where(eq(schema.project.missionContractAssertions.milestoneId, milestoneId))
    .orderBy(
      asc(schema.project.missionContractAssertions.orderIndex),
      asc(schema.project.missionContractAssertions.createdAt),
      asc(schema.project.missionContractAssertions.id),
    );
  return rows.map((row) => rowToAssertion(row as AssertionRow));
}

/** Update a contract assertion's mutable columns. */
export async function updateContractAssertion(handle: QueryHandle, assertion: MissionContractAssertion): Promise<void> {
  await handle
    .update(schema.project.missionContractAssertions)
    .set({
      title: assertion.title,
      assertion: assertion.assertion,
      status: assertion.status,
      type: normalizeMissionAssertionType(assertion.type),
      orderIndex: assertion.orderIndex,
      sourceFeatureId: assertion.sourceFeatureId ?? null,
      updatedAt: assertion.updatedAt,
    })
    .where(eq(schema.project.missionContractAssertions.id, assertion.id));
}

/** Delete a contract assertion by id. Returns true if deleted. */
export async function deleteContractAssertion(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missionContractAssertions)
    .where(eq(schema.project.missionContractAssertions.id, id))
    .returning({ id: schema.project.missionContractAssertions.id });
  return result.length > 0;
}

/** Reorder contract assertions transactionally. */
export async function reorderContractAssertions(
  layer: AsyncDataLayer,
  orderedIds: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await layer.transactionImmediate(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(schema.project.missionContractAssertions)
        .set({ orderIndex: i, updatedAt: now })
        .where(eq(schema.project.missionContractAssertions.id, orderedIds[i]!));
    }
  });
}

// ════════════════════════════════════════════════════════════════════
// FEATURE-ASSERTION LINKS
// ════════════════════════════════════════════════════════════════════

/** Check whether a feature-assertion link exists. */
export async function featureAssertionLinkExists(
  handle: QueryHandle,
  featureId: string,
  assertionId: string,
): Promise<boolean> {
  const rows = await handle
    .select({ featureId: schema.project.missionFeatureAssertions.featureId })
    .from(schema.project.missionFeatureAssertions)
    .where(
      and(
        eq(schema.project.missionFeatureAssertions.featureId, featureId),
        eq(schema.project.missionFeatureAssertions.assertionId, assertionId),
      ),
    );
  return rows.length > 0;
}

/** Insert a feature-assertion link with INSERT OR IGNORE semantics. */
export async function linkFeatureToAssertion(
  handle: QueryHandle,
  featureId: string,
  assertionId: string,
  createdAt: string,
): Promise<void> {
  await handle
    .insert(schema.project.missionFeatureAssertions)
    .values({ featureId, assertionId, createdAt })
    .onConflictDoNothing();
}

/** Delete a feature-assertion link. Returns true if deleted. */
export async function unlinkFeatureFromAssertion(
  handle: QueryHandle,
  featureId: string,
  assertionId: string,
): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missionFeatureAssertions)
    .where(
      and(
        eq(schema.project.missionFeatureAssertions.featureId, featureId),
        eq(schema.project.missionFeatureAssertions.assertionId, assertionId),
      ),
    )
    .returning({ featureId: schema.project.missionFeatureAssertions.featureId });
  return result.length > 0;
}

/** List all feature-assertion links, ordered by createdAt ASC. */
export async function listAllFeatureAssertionLinks(handle: QueryHandle): Promise<FeatureAssertionLink[]> {
  const rows = await handle
    .select({
      featureId: schema.project.missionFeatureAssertions.featureId,
      assertionId: schema.project.missionFeatureAssertions.assertionId,
      createdAt: schema.project.missionFeatureAssertions.createdAt,
    })
    .from(schema.project.missionFeatureAssertions)
    .orderBy(asc(schema.project.missionFeatureAssertions.createdAt));
  return rows.map((row) => rowToFeatureAssertionLink(row as FeatureAssertionLinkRow));
}

// ════════════════════════════════════════════════════════════════════
// VALIDATOR RUNS
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-10:35:
 * Create a validator run (non-destructive INSERT).
 */
export async function createValidatorRun(handle: QueryHandle, run: MissionValidatorRun): Promise<MissionValidatorRun> {
  await handle.insert(schema.project.missionValidatorRuns).values({
    id: run.id,
    featureId: run.featureId,
    milestoneId: run.milestoneId,
    sliceId: run.sliceId,
    status: run.status,
    triggerType: run.triggerType ?? "auto",
    implementationAttempt: run.implementationAttempt,
    validatorAttempt: run.validatorAttempt,
    taskId: run.taskId ?? null,
    summary: run.summary ?? null,
    blockedReason: run.blockedReason ?? null,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });
  return (await getValidatorRun(handle, run.id))!;
}

/** Get a validator run by id. */
export async function getValidatorRun(handle: QueryHandle, id: string): Promise<MissionValidatorRun | undefined> {
  const rows = await handle
    .select(validatorRunColumns)
    .from(schema.project.missionValidatorRuns)
    .where(eq(schema.project.missionValidatorRuns.id, id));
  return rows[0] ? rowToValidatorRun(rows[0] as ValidatorRunRow) : undefined;
}

/** List validator runs for a feature, ordered by startedAt DESC. */
export async function listValidatorRunsByFeature(handle: QueryHandle, featureId: string): Promise<MissionValidatorRun[]> {
  const rows = await handle
    .select(validatorRunColumns)
    .from(schema.project.missionValidatorRuns)
    .where(eq(schema.project.missionValidatorRuns.featureId, featureId))
    .orderBy(desc(schema.project.missionValidatorRuns.startedAt));
  return rows.map((row) => rowToValidatorRun(row as ValidatorRunRow));
}

/** List stale running validator runs older than the cutoff, ordered by startedAt ASC. */
export async function listStaleRunningValidatorRuns(handle: QueryHandle, cutoffIso: string): Promise<MissionValidatorRun[]> {
  const rows = await handle
    .select(validatorRunColumns)
    .from(schema.project.missionValidatorRuns)
    .where(
      and(
        eq(schema.project.missionValidatorRuns.status, "running"),
        sql`${schema.project.missionValidatorRuns.startedAt} < ${cutoffIso}`,
      ),
    )
    .orderBy(asc(schema.project.missionValidatorRuns.startedAt));
  return rows.map((row) => rowToValidatorRun(row as ValidatorRunRow));
}

/** Update a validator run's mutable columns (status, summary, blockedReason, completedAt). */
export async function updateValidatorRun(handle: QueryHandle, run: MissionValidatorRun): Promise<void> {
  await handle
    .update(schema.project.missionValidatorRuns)
    .set({
      status: run.status,
      summary: run.summary ?? null,
      blockedReason: run.blockedReason ?? null,
      completedAt: run.completedAt ?? null,
      updatedAt: run.updatedAt,
    })
    .where(eq(schema.project.missionValidatorRuns.id, run.id));
}

// ════════════════════════════════════════════════════════════════════
// VALIDATOR FAILURES
// ════════════════════════════════════════════════════════════════════

/** Insert a validator failure record (non-destructive INSERT). */
export async function insertValidatorFailure(handle: QueryHandle, failure: MissionAssertionFailureRecord): Promise<void> {
  await handle.insert(schema.project.missionValidatorFailures).values({
    id: failure.id,
    runId: failure.runId,
    featureId: failure.featureId,
    assertionId: failure.assertionId,
    message: failure.message ?? null,
    expected: failure.expected ?? null,
    actual: failure.actual ?? null,
    createdAt: failure.createdAt,
  });
}

/** List failures for a run, ordered by createdAt ASC. */
export async function listFailuresForRun(handle: QueryHandle, runId: string): Promise<MissionAssertionFailureRecord[]> {
  const rows = await handle
    .select(failureColumns)
    .from(schema.project.missionValidatorFailures)
    .where(eq(schema.project.missionValidatorFailures.runId, runId))
    .orderBy(asc(schema.project.missionValidatorFailures.createdAt));
  return rows.map((row) => rowToFailure(row as FailureRow));
}

// ════════════════════════════════════════════════════════════════════
// FIX-FEATURE LINEAGE
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-10:40:
 * Insert a fix-feature lineage row. failedAssertionIds is a jsonb array.
 */
export async function insertFixFeatureLineage(handle: QueryHandle, lineage: MissionFixFeatureLineage): Promise<void> {
  await handle.insert(schema.project.missionFixFeatureLineage).values({
    id: lineage.id,
    sourceFeatureId: lineage.sourceFeatureId,
    fixFeatureId: lineage.fixFeatureId,
    runId: lineage.runId,
    failedAssertionIds: lineage.failedAssertionIds,
    createdAt: lineage.createdAt,
  });
}

/** Find the fix-feature ID for a source feature + run (first match, ordered by createdAt). */
export async function findFixFeatureId(handle: QueryHandle, sourceFeatureId: string, runId: string): Promise<string | undefined> {
  const rows = await handle
    .select({ fixFeatureId: schema.project.missionFixFeatureLineage.fixFeatureId })
    .from(schema.project.missionFixFeatureLineage)
    .where(
      and(
        eq(schema.project.missionFixFeatureLineage.sourceFeatureId, sourceFeatureId),
        eq(schema.project.missionFixFeatureLineage.runId, runId),
      ),
    )
    .orderBy(asc(schema.project.missionFixFeatureLineage.createdAt))
    .limit(1);
  return rows[0]?.fixFeatureId;
}

/** Find all fix-feature IDs for a source feature, ordered by createdAt ASC. */
export async function findFixFeatureIdsForSource(handle: QueryHandle, sourceFeatureId: string): Promise<string[]> {
  const rows = await handle
    .select({ fixFeatureId: schema.project.missionFixFeatureLineage.fixFeatureId })
    .from(schema.project.missionFixFeatureLineage)
    .where(eq(schema.project.missionFixFeatureLineage.sourceFeatureId, sourceFeatureId))
    .orderBy(asc(schema.project.missionFixFeatureLineage.createdAt));
  return rows.map((row) => row.fixFeatureId);
}

/** Get lineage rows for a source feature. */
export async function listLineageForSourceFeature(handle: QueryHandle, sourceFeatureId: string): Promise<MissionFixFeatureLineage[]> {
  const rows = await handle
    .select(lineageColumns)
    .from(schema.project.missionFixFeatureLineage)
    .where(eq(schema.project.missionFixFeatureLineage.sourceFeatureId, sourceFeatureId));
  return rows.map((row) => rowToLineage(row as LineageRow));
}

/** Get lineage rows where the feature is a fix (fixFeatureId match). */
export async function listLineageForFixFeature(handle: QueryHandle, fixFeatureId: string): Promise<MissionFixFeatureLineage[]> {
  const rows = await handle
    .select(lineageColumns)
    .from(schema.project.missionFixFeatureLineage)
    .where(eq(schema.project.missionFixFeatureLineage.fixFeatureId, fixFeatureId));
  return rows.map((row) => rowToLineage(row as LineageRow));
}

// ════════════════════════════════════════════════════════════════════
// SNAPSHOT APPLY (upserts)
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-24-10:45:
 * Upsert a mission (snapshot apply / mesh replication). On conflict, update all
 * mutable columns. This is the ON CONFLICT(id) DO UPDATE SET ... pattern from
 * the sync applyMissionHierarchySnapshot.
 */
export async function upsertMission(handle: QueryHandle, mission: Mission): Promise<void> {
  await handle
    .insert(schema.project.missions)
    .values({
      id: mission.id,
      title: mission.title,
      description: mission.description ?? null,
      status: mission.status,
      interviewState: mission.interviewState,
      baseBranch: mission.baseBranch ?? null,
      branchStrategy: serializeBranchStrategy(mission.branchStrategy),
      autoMerge: mission.autoMerge === undefined ? null : mission.autoMerge ? 1 : 0,
      autoAdvance: mission.autoAdvance ? 1 : 0,
      autopilotEnabled: mission.autopilotEnabled ? 1 : 0,
      autopilotState: mission.autopilotState,
      lastAutopilotActivityAt: mission.lastAutopilotActivityAt ?? null,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    })
    .onConflictDoUpdate({
      target: [schema.project.missions.projectId, schema.project.missions.id],
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        status: sql`excluded.status`,
        interviewState: sql`excluded.interview_state`,
        baseBranch: sql`excluded.base_branch`,
        branchStrategy: sql`excluded.branch_strategy`,
        autoMerge: sql`excluded.auto_merge`,
        autoAdvance: sql`excluded.auto_advance`,
        autopilotEnabled: sql`excluded.autopilot_enabled`,
        autopilotState: sql`excluded.autopilot_state`,
        lastAutopilotActivityAt: sql`excluded.last_autopilot_activity_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Upsert a milestone (snapshot apply). */
export async function upsertMilestone(handle: QueryHandle, milestone: Milestone): Promise<void> {
  await handle
    .insert(schema.project.milestones)
    .values({
      id: milestone.id,
      missionId: milestone.missionId,
      title: milestone.title,
      description: milestone.description ?? null,
      status: milestone.status,
      orderIndex: milestone.orderIndex,
      interviewState: milestone.interviewState,
      dependencies: milestone.dependencies,
      planningNotes: milestone.planningNotes ?? null,
      verification: milestone.verification ?? null,
      acceptanceCriteria: milestone.acceptanceCriteria ?? null,
      validationState: milestone.validationState ?? "not_started",
      createdAt: milestone.createdAt,
      updatedAt: milestone.updatedAt,
    })
    .onConflictDoUpdate({
      target: [schema.project.milestones.projectId, schema.project.milestones.id],
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        status: sql`excluded.status`,
        orderIndex: sql`excluded.order_index`,
        interviewState: sql`excluded.interview_state`,
        dependencies: sql`excluded.dependencies`,
        planningNotes: sql`excluded.planning_notes`,
        verification: sql`excluded.verification`,
        acceptanceCriteria: sql`excluded.acceptance_criteria`,
        validationState: sql`excluded.validation_state`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Upsert a slice (snapshot apply). */
export async function upsertSlice(handle: QueryHandle, slice: Slice): Promise<void> {
  await handle
    .insert(schema.project.slices)
    .values({
      id: slice.id,
      milestoneId: slice.milestoneId,
      title: slice.title,
      description: slice.description ?? null,
      status: slice.status,
      orderIndex: slice.orderIndex,
      activatedAt: slice.activatedAt ?? null,
      planState: slice.planState ?? "not_started",
      planningNotes: slice.planningNotes ?? null,
      verification: slice.verification ?? null,
      createdAt: slice.createdAt,
      updatedAt: slice.updatedAt,
    })
    .onConflictDoUpdate({
      target: [schema.project.slices.projectId, schema.project.slices.id],
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        status: sql`excluded.status`,
        orderIndex: sql`excluded.order_index`,
        activatedAt: sql`excluded.activated_at`,
        planState: sql`excluded.plan_state`,
        planningNotes: sql`excluded.planning_notes`,
        verification: sql`excluded.verification`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Upsert a feature (snapshot apply). */
export async function upsertFeature(handle: QueryHandle, feature: MissionFeature): Promise<void> {
  await handle
    .insert(schema.project.missionFeatures)
    .values({
      id: feature.id,
      sliceId: feature.sliceId,
      taskId: feature.taskId ?? null,
      title: feature.title,
      description: feature.description ?? null,
      acceptanceCriteria: feature.acceptanceCriteria ?? null,
      status: feature.status,
      createdAt: feature.createdAt,
      updatedAt: feature.updatedAt,
      loopState: feature.loopState ?? "idle",
      implementationAttemptCount: feature.implementationAttemptCount ?? 0,
      validatorAttemptCount: feature.validatorAttemptCount ?? 0,
      lastValidatorRunId: feature.lastValidatorRunId ?? null,
      lastValidatorStatus: feature.lastValidatorStatus ?? null,
      generatedFromFeatureId: feature.generatedFromFeatureId ?? null,
      generatedFromRunId: feature.generatedFromRunId ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.project.missionFeatures.projectId, schema.project.missionFeatures.id],
      set: {
        taskId: sql`excluded.task_id`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        acceptanceCriteria: sql`excluded.acceptance_criteria`,
        status: sql`excluded.status`,
        updatedAt: sql`excluded.updated_at`,
        loopState: sql`excluded.loop_state`,
        implementationAttemptCount: sql`excluded.implementation_attempt_count`,
        validatorAttemptCount: sql`excluded.validator_attempt_count`,
        lastValidatorRunId: sql`excluded.last_validator_run_id`,
        lastValidatorStatus: sql`excluded.last_validator_status`,
        generatedFromFeatureId: sql`excluded.generated_from_feature_id`,
        generatedFromRunId: sql`excluded.generated_from_run_id`,
      },
    });
}

/** Upsert a contract assertion (snapshot apply). */
export async function upsertContractAssertion(handle: QueryHandle, assertion: MissionContractAssertion): Promise<void> {
  await handle
    .insert(schema.project.missionContractAssertions)
    .values({
      id: assertion.id,
      milestoneId: assertion.milestoneId,
      title: assertion.title,
      assertion: assertion.assertion,
      status: assertion.status,
      type: normalizeMissionAssertionType(assertion.type),
      orderIndex: assertion.orderIndex,
      sourceFeatureId: assertion.sourceFeatureId ?? null,
      createdAt: assertion.createdAt,
      updatedAt: assertion.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.project.missionContractAssertions.projectId,
        schema.project.missionContractAssertions.id,
      ],
      set: {
        title: sql`excluded.title`,
        assertion: sql`excluded.assertion`,
        status: sql`excluded.status`,
        type: sql`excluded.type`,
        orderIndex: sql`excluded.order_index`,
        sourceFeatureId: sql`excluded.source_feature_id`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

// ════════════════════════════════════════════════════════════════════
// U5 ADDED HELPERS — JOIN lists, event paging, task-linkage guards
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:MissionStore 2026-06-27-15:05:
 * Paginated mission events with total count and optional eventType filter.
 * Mirrors sync `MissionStore.getMissionEvents` ordering:
 * COALESCE(seq,0) DESC, timestamp DESC, id DESC.
 */
export async function getMissionEventsPage(
  handle: QueryHandle,
  missionId: string,
  options?: { limit?: number; offset?: number; eventType?: string },
): Promise<{ events: MissionEvent[]; total: number }> {
  const limit = Math.max(0, options?.limit ?? 50);
  const offset = Math.max(0, options?.offset ?? 0);
  const conditions = [eq(schema.project.missionEvents.missionId, missionId)];
  if (options?.eventType) conditions.push(eq(schema.project.missionEvents.eventType, options.eventType));
  const totalRows = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.missionEvents)
    .where(and(...conditions));
  const total = totalRows[0]?.count ?? 0;
  const rows = await handle
    .select(eventColumns)
    .from(schema.project.missionEvents)
    .where(and(...conditions))
    .orderBy(
      desc(sql`coalesce(${schema.project.missionEvents.seq}, 0)`),
      desc(schema.project.missionEvents.timestamp),
      desc(schema.project.missionEvents.id),
    )
    .limit(limit)
    .offset(offset);
  return { events: rows.map((row) => rowToMissionEvent(row as MissionEventRow)), total };
}

/**
 * FNXC:MissionStore 2026-06-27-15:05:
 * List assertions linked to a feature (JOIN mission_feature_assertions),
 * ordered orderIndex ASC, createdAt ASC, id ASC — mirrors sync `listAssertionsForFeature`.
 */
export async function listAssertionsForFeature(handle: QueryHandle, featureId: string): Promise<MissionContractAssertion[]> {
  const rows = await handle
    .select(assertionColumns)
    .from(schema.project.missionContractAssertions)
    .innerJoin(
      schema.project.missionFeatureAssertions,
      eq(schema.project.missionContractAssertions.id, schema.project.missionFeatureAssertions.assertionId),
    )
    .where(eq(schema.project.missionFeatureAssertions.featureId, featureId))
    .orderBy(
      asc(schema.project.missionContractAssertions.orderIndex),
      asc(schema.project.missionContractAssertions.createdAt),
      asc(schema.project.missionContractAssertions.id),
    );
  return rows.map((row) => rowToAssertion(row as AssertionRow));
}

/**
 * FNXC:MissionStore 2026-06-27-15:05:
 * List features linked to an assertion (JOIN), ordered createdAt ASC.
 */
export async function listFeaturesForAssertion(handle: QueryHandle, assertionId: string): Promise<MissionFeature[]> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .innerJoin(
      schema.project.missionFeatureAssertions,
      eq(schema.project.missionFeatures.id, schema.project.missionFeatureAssertions.featureId),
    )
    .where(eq(schema.project.missionFeatureAssertions.assertionId, assertionId))
    .orderBy(asc(schema.project.missionFeatures.createdAt));
  return rows.map((row) => rowToFeature(row as FeatureRow));
}

/** Filter the given task ids to those that are live (not deleted, not archived). */
export async function listLiveLinkedTaskIds(handle: QueryHandle, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await handle
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(
      and(
        inArray(schema.project.tasks.id, taskIds),
        sql`${schema.project.tasks.deletedAt} is null`,
        sql`${schema.project.tasks.column} <> 'archived'`,
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** Get a live (non-deleted) task's id + column, or undefined. */
export async function getLiveTaskById(handle: QueryHandle, taskId: string): Promise<{ id: string; column: string } | undefined> {
  const rows = await handle
    .select({ id: schema.project.tasks.id, column: schema.project.tasks.column })
    .from(schema.project.tasks)
    .where(and(eq(schema.project.tasks.id, taskId), sql`${schema.project.tasks.deletedAt} is null`));
  const row = rows[0];
  return row ? { id: row.id, column: row.column as string } : undefined;
}

/** Set a live task's mission/slice linkage (bidirectional link). */
export async function setTaskMissionLinkage(handle: QueryHandle, taskId: string, missionId: string, sliceId: string): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ missionId, sliceId })
    .where(and(eq(schema.project.tasks.id, taskId), sql`${schema.project.tasks.deletedAt} is null`));
}

/** Clear a live task's mission/slice linkage. */
export async function clearTaskMissionLinkage(handle: QueryHandle, taskId: string): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ missionId: null, sliceId: null })
    .where(and(eq(schema.project.tasks.id, taskId), sql`${schema.project.tasks.deletedAt} is null`));
}

/** Set of all failed (non-deleted) task ids — for health rollup. */
export async function listFailedTaskIds(handle: QueryHandle): Promise<Set<string>> {
  const rows = await handle
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(and(eq(schema.project.tasks.status, "failed"), sql`${schema.project.tasks.deletedAt} is null`));
  return new Set(rows.map((row) => row.id));
}

// ════════════════════════════════════════════════════════════════════
// FNXC:MissionStore 2026-06-27-15:10:
// PostgreSQL-backed MissionStore — the AsyncDataLayer counterpart of the sync
// SQLite `MissionStore` (mission-store.ts). Exposes the SAME public method names
// the dashboard mission routes + goal→mission routes + CLI mission tools call,
// so callers `await` either implementation. `getMissionStoreImpl` returns this in
// backend mode instead of throwing "MissionStore is not available in PG backend
// mode". Id/timestamp generation mirrors the sync store (M-/MS-/SL-/F-/ME-/CA-/VR-
// prefixes via generateId), as do the status-rollup recompute cascades
// (feature→slice→milestone→mission) and the milestone validation-state recompute.
//
// Known gap vs the sync store: the sync MissionStore is an EventEmitter
// (mission:created/feature:linked/validator-run:completed/…) consumed by the
// engine MissionAutopilot + dashboard SSE. This wrapper performs CRUD + rollups +
// triage only; mission AUTOPILOT and live SSE mission events stay degraded in PG
// mode (the engine guards init with `instanceof MissionStore`). The engine-only
// loop helpers (completeValidatorRun/recordValidatorFailures/reapValidatorRun/
// createGeneratedFixFeature/transitionLoopState/getMissionHierarchySnapshot/
// applyMissionHierarchySnapshot/listGoalIdsForTask) are NOT ported here — their
// sync consumers are instanceof-guarded.
// ════════════════════════════════════════════════════════════════════
/**
 * FNXC:MissionStore 2026-06-28-13:00:
 * SSE live-push parity — AsyncMissionStore extends EventEmitter<MissionStoreEvents>
 * and emits the SAME events at the SAME mutation points as the sync MissionStore
 * (mission-store.ts) so the dashboard SSE handler live-refreshes mission/milestone/
 * slice/feature/assertion changes in PG backend mode (previously only manual reload
 * updated them). Emit sites are mirrored method-by-method from the sync store's
 * `this.emit(` call sites; each emit fires AFTER the persistence await succeeds with
 * the same payload (the persisted entity) the sync store emits. The status-cascade
 * recompute helpers (recomputeSliceStatus/MilestoneStatus/MissionStatus/MilestoneValidation)
 * route through the emitting update* methods, so cascade-driven updates emit exactly as
 * in the sync store. The instance is cached on the TaskStore, so SSE subscribes to the
 * same object the mission routes mutate.
 *
 * Known gap vs the sync store: completeValidatorRun / reapValidatorRun /
 * createGeneratedFixFeature (validator-run:completed, fix-feature:created) are not ported
 * into the async wrapper, so those two events never fire in PG mode (validator-run loop
 * execution stays a sync-mode capability).
 */
export class AsyncMissionStore extends EventEmitter<MissionStoreEvents> {
  private idSequence = 0;
  private readonly milestonesMissingStructuredAssertions = new Set<string>();

  constructor(
    private readonly layer: AsyncDataLayer,
    private readonly taskStore?: import("./store.js").TaskStore,
  ) {
    super();
  }

  private get db(): AsyncDataLayer["db"] {
    return this.layer.db;
  }

  // ── ID generation (mirrors sync generateId format) ──────────────────
  private generateId(prefix: string): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    this.idSequence += 1;
    const sequence = this.idSequence.toString(36).toUpperCase().padStart(4, "0");
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${sequence}-${random}`;
  }

  // ════════════════ MISSION CRUD ════════════════
  async createMission(input: MissionCreateInput & { autopilotEnabled?: boolean }): Promise<Mission> {
    const now = new Date().toISOString();
    const mission = await createMission(this.db, {
      id: this.generateId("M"),
      title: input.title,
      description: input.description,
      baseBranch: input.baseBranch,
      branchStrategy: input.branchStrategy,
      autoMerge: input.autoMerge,
      status: "planning",
      interviewState: "not_started",
      autoAdvance: false,
      autopilotEnabled: false,
      autopilotState: "inactive",
      createdAt: now,
      updatedAt: now,
    });
    this.emit("mission:created", mission);
    return mission;
  }

  async getMission(id: string): Promise<Mission | undefined> {
    return getMission(this.db, id);
  }

  async listMissions(): Promise<Mission[]> {
    return listMissions(this.db);
  }

  async getMissionWithHierarchy(id: string): Promise<MissionWithHierarchy | undefined> {
    const mission = await getMission(this.db, id);
    if (!mission) return undefined;
    const goalIds = await listGoalIdsForMission(this.db, id);
    const goals = await listGoalsByIds(this.db, goalIds);
    const goalById = new Map(goals.map((g) => [g.id, g]));
    const linkedGoals = goalIds.map((gid) => goalById.get(gid)).filter((g): g is Goal => Boolean(g));

    const milestones = await listMilestones(this.db, id);
    const milestonesWithSlices = [];
    for (const milestone of milestones) {
      const slices = await listSlices(this.db, milestone.id);
      const slicesWithFeatures = [];
      for (const slice of slices) {
        slicesWithFeatures.push({ ...slice, features: await listFeatures(this.db, slice.id) });
      }
      milestonesWithSlices.push({ ...milestone, slices: slicesWithFeatures });
    }
    const eventCount = await countMissionEvents(this.db, id);
    return { ...mission, linkedGoals, eventCount, milestones: milestonesWithSlices } as MissionWithHierarchy;
  }

  async getMissionSummary(missionId: string): Promise<MissionSummary> {
    const milestones = await listMilestones(this.db, missionId);
    const totalMilestones = milestones.length;
    const completedMilestones = milestones.filter((m) => m.status === "complete").length;
    let totalFeatures = 0;
    let completedFeatures = 0;
    for (const milestone of milestones) {
      const slices = await listSlices(this.db, milestone.id);
      for (const slice of slices) {
        const features = await listFeatures(this.db, slice.id);
        totalFeatures += features.length;
        completedFeatures += features.filter((f) => f.status === "done").length;
      }
    }
    const linkedGoalCount = (await listGoalIdsForMission(this.db, missionId)).length;
    const eventCount = await countMissionEvents(this.db, missionId);
    let progressPercent = 0;
    if (totalFeatures > 0) progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
    else if (totalMilestones > 0) progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
    return { totalMilestones, completedMilestones, totalFeatures, completedFeatures, linkedGoalCount, eventCount, progressPercent };
  }

  async listMissionsWithSummaries(): Promise<Array<Mission & { summary: MissionSummary }>> {
    const missions = await listMissions(this.db);
    if (missions.length === 0) return [];
    const allMilestones = await listAllMilestones(this.db);
    const allSlices = await listAllSlices(this.db);
    const allFeatures = await listAllFeatures(this.db);
    const goalCountByMission = await countGoalsByMission(this.db);
    const eventCountByMission = await countEventsByMission(this.db);

    const slicesByMilestone = new Map<string, Slice[]>();
    for (const slice of allSlices) {
      const list = slicesByMilestone.get(slice.milestoneId) ?? [];
      list.push(slice);
      slicesByMilestone.set(slice.milestoneId, list);
    }
    const featuresBySlice = new Map<string, MissionFeature[]>();
    for (const feature of allFeatures) {
      const list = featuresBySlice.get(feature.sliceId) ?? [];
      list.push(feature);
      featuresBySlice.set(feature.sliceId, list);
    }
    const milestonesByMission = new Map<string, Milestone[]>();
    for (const milestone of allMilestones) {
      const list = milestonesByMission.get(milestone.missionId) ?? [];
      list.push(milestone);
      milestonesByMission.set(milestone.missionId, list);
    }

    return missions.map((mission) => {
      const milestones = milestonesByMission.get(mission.id) ?? [];
      const totalMilestones = milestones.length;
      const completedMilestones = milestones.filter((m) => m.status === "complete").length;
      let totalFeatures = 0;
      let completedFeatures = 0;
      for (const milestone of milestones) {
        for (const slice of slicesByMilestone.get(milestone.id) ?? []) {
          const features = featuresBySlice.get(slice.id) ?? [];
          totalFeatures += features.length;
          completedFeatures += features.filter((f) => f.status === "done").length;
        }
      }
      const linkedGoalCount = goalCountByMission.get(mission.id) ?? 0;
      const eventCount = eventCountByMission.get(mission.id) ?? 0;
      let progressPercent = 0;
      if (totalFeatures > 0) progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
      else if (totalMilestones > 0) progressPercent = Math.round((completedMilestones / totalMilestones) * 100);
      return {
        ...mission,
        summary: { totalMilestones, completedMilestones, totalFeatures, completedFeatures, linkedGoalCount, eventCount, progressPercent },
      };
    });
  }

  async listMissionsHealth(): Promise<Map<string, MissionHealth>> {
    const missions = await listMissions(this.db);
    if (missions.length === 0) return new Map();
    const allMilestones = await listAllMilestones(this.db);
    const allSlices = await listAllSlices(this.db);
    const allFeatures = await listAllFeatures(this.db);
    const failedTaskIds = await listFailedTaskIds(this.db);
    const errorEvents = await listErrorEventsForHealth(this.db);
    const lastErrorByMission = new Map<string, { timestamp: string; description: string }>();
    for (const row of errorEvents) {
      if (!lastErrorByMission.has(row.missionId)) {
        lastErrorByMission.set(row.missionId, { timestamp: row.timestamp, description: row.description });
      }
    }

    const milestonesByMission = new Map<string, Milestone[]>();
    for (const m of allMilestones) {
      const list = milestonesByMission.get(m.missionId) ?? [];
      list.push(m);
      milestonesByMission.set(m.missionId, list);
    }
    const slicesByMilestone = new Map<string, Slice[]>();
    for (const s of allSlices) {
      const list = slicesByMilestone.get(s.milestoneId) ?? [];
      list.push(s);
      slicesByMilestone.set(s.milestoneId, list);
    }
    const featuresBySlice = new Map<string, MissionFeature[]>();
    for (const f of allFeatures) {
      const list = featuresBySlice.get(f.sliceId) ?? [];
      list.push(f);
      featuresBySlice.set(f.sliceId, list);
    }

    const result = new Map<string, MissionHealth>();
    for (const mission of missions) {
      const milestones = milestonesByMission.get(mission.id) ?? [];
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
        if (milestone.status === "complete") completedMilestones++;
        if (!currentMilestoneId && milestone.status === "active") currentMilestoneId = milestone.id;
        for (const slice of slicesByMilestone.get(milestone.id) ?? []) {
          if (!currentSliceId && slice.status === "active") {
            currentSliceId = slice.id;
            currentMilestoneId ??= milestone.id;
          }
          for (const feature of featuresBySlice.get(slice.id) ?? []) {
            totalFeatures++;
            totalTasks += 1;
            if (feature.status === "done") {
              tasksCompleted += 1;
              completedFeatures++;
            }
            if (feature.status === "triaged" || feature.status === "in-progress") tasksInFlight += 1;
            if (feature.taskId && failedTaskIds.has(feature.taskId)) tasksFailed++;
          }
        }
      }

      let progressPercent = 0;
      if (totalFeatures > 0) progressPercent = Math.round((completedFeatures / totalFeatures) * 100);
      else if (totalMilestones > 0) progressPercent = Math.round((completedMilestones / totalMilestones) * 100);

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

  async getMissionHealth(missionId: string): Promise<MissionHealth | undefined> {
    const mission = await getMission(this.db, missionId);
    if (!mission) return undefined;
    const milestones = await listMilestones(this.db, missionId);
    const summary = await this.getMissionSummary(missionId);
    let totalTasks = 0;
    let tasksCompleted = 0;
    let tasksInFlight = 0;
    let currentSliceId: string | undefined;
    let currentMilestoneId: string | undefined;
    const featureTaskIds: string[] = [];
    for (const milestone of milestones) {
      if (!currentMilestoneId && milestone.status === "active") currentMilestoneId = milestone.id;
      for (const slice of await listSlices(this.db, milestone.id)) {
        if (!currentSliceId && slice.status === "active") {
          currentSliceId = slice.id;
          currentMilestoneId ??= milestone.id;
        }
        for (const feature of await listFeatures(this.db, slice.id)) {
          totalTasks += 1;
          if (feature.status === "done") tasksCompleted += 1;
          if (feature.status === "triaged" || feature.status === "in-progress") tasksInFlight += 1;
          if (feature.taskId) featureTaskIds.push(feature.taskId);
        }
      }
    }
    let tasksFailed = 0;
    if (featureTaskIds.length > 0) {
      const failed = await listFailedTaskIds(this.db);
      tasksFailed = featureTaskIds.filter((taskId) => failed.has(taskId)).length;
    }
    const errorEvents = await listErrorEventsForHealth(this.db);
    const lastError = errorEvents.find((row) => row.missionId === missionId);
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
      lastErrorAt: lastError?.timestamp,
      lastErrorDescription: lastError?.description,
      autopilotState: mission.autopilotState ?? "inactive",
      autopilotEnabled: mission.autopilotEnabled ?? false,
      lastActivityAt: mission.lastAutopilotActivityAt,
    };
  }

  async logMissionEvent(
    missionId: string,
    eventType: MissionEventType,
    description: string,
    metadata?: Record<string, unknown>,
  ): Promise<MissionEvent> {
    const mission = await getMission(this.db, missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    const event = await this.layer.transactionImmediate(async (tx) => {
      const maxSeq = await getMaxEventSeq(tx);
      const created: MissionEvent = {
        id: this.generateId("ME"),
        missionId,
        eventType,
        description,
        metadata: metadata ?? null,
        timestamp: new Date().toISOString(),
        seq: maxSeq + 1,
      };
      await insertMissionEvent(tx, created);
      return created;
    });
    this.emit("mission:event", event);
    return event;
  }

  async getMissionEvents(
    missionId: string,
    options?: { limit?: number; offset?: number; eventType?: string },
  ): Promise<{ events: MissionEvent[]; total: number }> {
    return getMissionEventsPage(this.db, missionId, options);
  }

  async updateMission(id: string, updates: Partial<Mission>): Promise<Mission> {
    const mission = await getMission(this.db, id);
    if (!mission) throw new Error(`Mission ${id} not found`);
    const updated: Mission = {
      ...mission,
      ...updates,
      id,
      createdAt: mission.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await updateMission(this.db, updated);
    this.emit("mission:updated", updated);
    return updated;
  }

  async deleteMission(id: string): Promise<void> {
    const mission = await getMission(this.db, id);
    if (!mission) throw new Error(`Mission ${id} not found`);
    await deleteMission(this.db, id);
    this.emit("mission:deleted", id);
  }

  async updateMissionInterviewState(id: string, state: InterviewState): Promise<Mission> {
    return this.updateMission(id, { interviewState: state });
  }

  // ════════════════ MISSION-GOAL LINKS ════════════════
  async linkGoal(missionId: string, goalId: string): Promise<MissionGoalLink> {
    const { link, changed } = await this.layer.transactionImmediate(async (tx) => {
      if (!(await missionExists(tx, missionId))) throw new Error(`Mission ${missionId} not found`);
      if (!(await goalExists(tx, goalId))) throw new Error(`Goal ${goalId} not found`);
      const existing = await getMissionGoalLink(tx, missionId, goalId);
      if (existing) return { link: existing, changed: false };
      const createdAt = new Date().toISOString();
      await insertMissionGoalLink(tx, missionId, goalId, createdAt);
      const row = await getMissionGoalLink(tx, missionId, goalId);
      if (!row) throw new Error(`Failed to link mission ${missionId} to goal ${goalId}`);
      return { link: row, changed: true };
    });
    // Mirror sync: emit mission:goal-linked only when a new link was created.
    if (changed) this.emit("mission:goal-linked", link);
    return link;
  }

  async unlinkGoal(missionId: string, goalId: string): Promise<boolean> {
    // Capture the link row before deletion so the emit payload matches the sync
    // store's mission:goal-unlinked [MissionGoalLink] shape.
    const link = await getMissionGoalLink(this.db, missionId, goalId);
    const deleted = await deleteMissionGoalLink(this.db, missionId, goalId);
    if (deleted && link) this.emit("mission:goal-unlinked", link);
    return deleted;
  }

  async listGoalIdsForMission(missionId: string): Promise<string[]> {
    return listGoalIdsForMission(this.db, missionId);
  }

  async listMissionIdsForGoal(goalId: string): Promise<string[]> {
    return listMissionIdsForGoal(this.db, goalId);
  }

  // ════════════════ MILESTONE OPS ════════════════
  async addMilestone(missionId: string, input: MilestoneCreateInput): Promise<Milestone> {
    const mission = await getMission(this.db, missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    const now = new Date().toISOString();
    const existing = await listMilestones(this.db, missionId);
    const orderIndex = existing.length > 0 ? Math.max(...existing.map((m) => m.orderIndex)) + 1 : 0;
    const milestone: Milestone = {
      id: this.generateId("MS"),
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
    const created = await createMilestone(this.db, milestone);
    this.emit("milestone:created", created);
    return created;
  }

  async getMilestone(id: string): Promise<Milestone | undefined> {
    return getMilestone(this.db, id);
  }

  async listMilestones(missionId: string): Promise<Milestone[]> {
    return listMilestones(this.db, missionId);
  }

  async updateMilestone(id: string, updates: Partial<Milestone>): Promise<Milestone> {
    const milestone = await getMilestone(this.db, id);
    if (!milestone) throw new Error(`Milestone ${id} not found`);
    const updated: Milestone = {
      ...milestone,
      ...updates,
      id,
      missionId: milestone.missionId,
      createdAt: milestone.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await updateMilestone(this.db, updated);
    this.emit("milestone:updated", updated);
    await this.recomputeMissionStatus(updated.missionId);
    return updated;
  }

  async deleteMilestone(id: string, force = false): Promise<void> {
    const milestone = await getMilestone(this.db, id);
    if (!milestone) throw new Error(`Milestone ${id} not found`);
    const missionId = milestone.missionId;
    const slices = await listSlices(this.db, id);
    const features: MissionFeature[] = [];
    for (const slice of slices) features.push(...(await listFeatures(this.db, slice.id)));
    const blockingLinks = await this.getLiveTaskLinkedFeatures(features);
    if (blockingLinks.length > 0 && !force) {
      throw new Error(
        `Milestone ${id} has features linked to live tasks: ${blockingLinks.map((link) => `${link.featureId}->${link.taskId}`).join(", ")}; pass force to delete anyway`,
      );
    }
    if (force) {
      for (const link of blockingLinks) {
        await unlinkFeatureFromTaskId(this.db, link.featureId);
        await clearTaskMissionLinkage(this.db, link.taskId);
      }
    }
    await deleteMilestone(this.db, id);
    this.emit("milestone:deleted", id);
    await this.recomputeMissionStatus(missionId);
  }

  async reorderMilestones(missionId: string, orderedIds: string[]): Promise<void> {
    for (const id of orderedIds) {
      const milestone = await getMilestone(this.db, id);
      if (!milestone) throw new Error(`Milestone ${id} not found`);
      if (milestone.missionId !== missionId) throw new Error(`Milestone ${id} does not belong to mission ${missionId}`);
    }
    await reorderMilestones(this.layer, orderedIds);
  }

  async updateMilestoneInterviewState(id: string, state: InterviewState): Promise<Milestone> {
    return this.updateMilestone(id, { interviewState: state });
  }

  async applyDerivedMilestoneAcceptanceCriteria(milestoneId: string): Promise<Milestone> {
    const milestone = await getMilestone(this.db, milestoneId);
    if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);
    if (milestone.acceptanceCriteria?.trim()) return milestone;
    const features: MissionFeature[] = [];
    for (const slice of await listSlices(this.db, milestoneId)) features.push(...(await listFeatures(this.db, slice.id)));
    const derived = deriveMilestoneAcceptanceCriteriaFromFeatures(features);
    if (!derived) return milestone;
    return this.updateMilestone(milestoneId, { acceptanceCriteria: derived });
  }

  // ════════════════ SLICE OPS ════════════════
  async addSlice(milestoneId: string, input: SliceCreateInput): Promise<Slice> {
    const milestone = await getMilestone(this.db, milestoneId);
    if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);
    const now = new Date().toISOString();
    const existing = await listSlices(this.db, milestoneId);
    const orderIndex = existing.length > 0 ? Math.max(...existing.map((s) => s.orderIndex)) + 1 : 0;
    const slice: Slice = {
      id: this.generateId("SL"),
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
    const created = await createSlice(this.db, slice);
    this.emit("slice:created", created);
    return created;
  }

  async getSlice(id: string): Promise<Slice | undefined> {
    return getSlice(this.db, id);
  }

  async listSlices(milestoneId: string): Promise<Slice[]> {
    return listSlices(this.db, milestoneId);
  }

  async updateSlice(id: string, updates: Partial<Slice>): Promise<Slice> {
    const slice = await getSlice(this.db, id);
    if (!slice) throw new Error(`Slice ${id} not found`);
    const updated: Slice = {
      ...slice,
      ...updates,
      id,
      milestoneId: slice.milestoneId,
      createdAt: slice.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await updateSlice(this.db, updated);
    this.emit("slice:updated", updated);
    await this.recomputeMilestoneStatus(updated.milestoneId);
    return updated;
  }

  async deleteSlice(id: string, force = false): Promise<void> {
    const slice = await getSlice(this.db, id);
    if (!slice) throw new Error(`Slice ${id} not found`);
    const milestoneId = slice.milestoneId;
    const features = await listFeatures(this.db, id);
    const blockingLinks = await this.getLiveTaskLinkedFeatures(features);
    if (blockingLinks.length > 0 && !force) {
      throw new Error(
        `Slice ${id} has features linked to live tasks: ${blockingLinks.map((link) => `${link.featureId}->${link.taskId}`).join(", ")}; pass force to delete anyway`,
      );
    }
    if (force) {
      for (const link of blockingLinks) {
        await unlinkFeatureFromTaskId(this.db, link.featureId);
        await clearTaskMissionLinkage(this.db, link.taskId);
      }
    }
    await deleteSlice(this.db, id);
    this.emit("slice:deleted", id);
    await this.recomputeMilestoneStatus(milestoneId);
  }

  async reorderSlices(milestoneId: string, orderedIds: string[]): Promise<void> {
    for (const id of orderedIds) {
      const slice = await getSlice(this.db, id);
      if (!slice) throw new Error(`Slice ${id} not found`);
      if (slice.milestoneId !== milestoneId) throw new Error(`Slice ${id} does not belong to milestone ${milestoneId}`);
    }
    await reorderSlices(this.layer, orderedIds);
  }

  async activateSlice(id: string): Promise<Slice> {
    const slice = await getSlice(this.db, id);
    if (!slice) throw new Error(`Slice ${id} not found`);
    const milestone = await getMilestone(this.db, slice.milestoneId);
    const mission = milestone ? await getMission(this.db, milestone.missionId) : undefined;
    const shouldAutoTriage = mission?.autopilotEnabled === true || mission?.autoAdvance === true;
    const now = new Date().toISOString();
    const updated = await this.updateSlice(id, { status: "active", activatedAt: now });
    if (shouldAutoTriage) {
      try {
        await this.triageSlice(id);
      } catch (err) {
        console.error(`[AsyncMissionStore] Auto-triage failed for slice ${id}:`, err);
      }
    }
    this.emit("slice:activated", updated);
    return updated;
  }

  async findNextPendingSlice(missionId: string): Promise<Slice | undefined> {
    for (const milestone of await listMilestones(this.db, missionId)) {
      for (const slice of await listSlices(this.db, milestone.id)) {
        if (slice.status === "pending") return slice;
      }
    }
    return undefined;
  }

  // ════════════════ FEATURE OPS ════════════════
  async addFeature(sliceId: string, input: FeatureCreateInput): Promise<MissionFeature> {
    const slice = await getSlice(this.db, sliceId);
    if (!slice) throw new Error(`Slice ${sliceId} not found`);
    const now = new Date().toISOString();
    const feature: MissionFeature = {
      id: this.generateId("F"),
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
    const created = await createFeature(this.db, feature);
    this.emit("feature:created", created);
    await this.recomputeSliceStatus(sliceId);
    await this.applyDerivedMilestoneAcceptanceCriteria(slice.milestoneId);
    await this.ensureFeatureAssertion(feature);
    return (await getFeature(this.db, feature.id)) ?? feature;
  }

  async getFeature(id: string): Promise<MissionFeature | undefined> {
    return getFeature(this.db, id);
  }

  async listFeatures(sliceId: string): Promise<MissionFeature[]> {
    return listFeatures(this.db, sliceId);
  }

  async getFeatureByTaskId(taskId: string): Promise<MissionFeature | undefined> {
    return getFeatureByTaskId(this.db, taskId);
  }

  async updateFeature(id: string, updates: Partial<MissionFeature>): Promise<MissionFeature> {
    const feature = await getFeature(this.db, id);
    if (!feature) throw new Error(`Feature ${id} not found`);
    const updated: MissionFeature = {
      ...feature,
      ...updates,
      id,
      sliceId: feature.sliceId,
      createdAt: feature.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await updateFeature(this.db, updated);
    this.emit("feature:updated", updated);
    const taskIdChanged = updates.taskId !== undefined && updates.taskId !== feature.taskId;
    const statusChanged = updates.status !== undefined && updates.status !== feature.status;
    if (taskIdChanged || statusChanged) await this.recomputeSliceStatus(updated.sliceId);
    const shouldSyncAssertion =
      updates.title !== undefined || updates.description !== undefined || updates.acceptanceCriteria !== undefined;
    if (shouldSyncAssertion) {
      await this.ensureFeatureAssertion(updated);
      return (await getFeature(this.db, updated.id)) ?? updated;
    }
    return updated;
  }

  async deleteFeature(id: string, force = false): Promise<void> {
    const feature = await getFeature(this.db, id);
    if (!feature) throw new Error(`Feature ${id} not found`);
    if (feature.taskId) {
      const linkedTask = await getLiveTaskById(this.db, feature.taskId);
      const linkedToLiveTask = linkedTask && linkedTask.column !== "archived";
      if (linkedToLiveTask && !force) {
        throw new Error(`Feature ${id} is linked to task ${feature.taskId}; pass force to delete anyway`);
      }
    }
    const sliceId = feature.sliceId;
    const slice = await getSlice(this.db, sliceId);
    const milestoneId = slice?.milestoneId;
    if (force && feature.taskId) {
      await unlinkFeatureFromTaskId(this.db, id);
      await clearTaskMissionLinkage(this.db, feature.taskId);
    }
    if (milestoneId) {
      const managed = (await listContractAssertions(this.db, milestoneId)).find((a) => a.sourceFeatureId === feature.id);
      if (managed) await this.deleteContractAssertion(managed.id);
    }
    await deleteFeature(this.db, id);
    this.emit("feature:deleted", id);
    await this.recomputeSliceStatus(sliceId);
  }

  async updateFeatureStatus(featureId: string, status: FeatureStatus): Promise<MissionFeature> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const updated = await this.updateFeature(featureId, { status });
    await this.recomputeSliceStatus(updated.sliceId);
    return updated;
  }

  async linkFeatureToTask(featureId: string, taskId: string): Promise<MissionFeature> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const liveTask = await getLiveTaskById(this.db, taskId);
    if (!liveTask) {
      throw new Error(
        `Cannot link feature ${featureId} to task ${taskId}: task is not on the active board (it may be archived, deleted, or never existed). Only active tasks can be linked to features.`,
      );
    }
    const linkage = await this.resolveTaskLinkage(feature.sliceId);
    const shouldTransitionLoop = !feature.loopState || feature.loopState === "idle";
    const loopStateUpdates: Partial<MissionFeature> = shouldTransitionLoop
      ? { loopState: "implementing", implementationAttemptCount: 1 }
      : {};
    const updated = await this.updateFeature(featureId, { taskId, status: "triaged", ...loopStateUpdates });
    await setTaskMissionLinkage(this.db, taskId, linkage.missionId, linkage.sliceId);
    await this.recomputeSliceStatus(updated.sliceId);
    this.emit("feature:linked", { feature: updated, taskId });
    return updated;
  }

  async unlinkFeatureFromTask(featureId: string): Promise<MissionFeature> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const { taskId } = feature;
    const updated = await this.updateFeature(featureId, { taskId: undefined, status: "defined" });
    if (taskId) await clearTaskMissionLinkage(this.db, taskId);
    await this.recomputeSliceStatus(updated.sliceId);
    return updated;
  }

  // ════════════════ VALIDATOR RUNS ════════════════
  async startValidatorRun(featureId: string, triggerType?: string, taskId?: string): Promise<MissionValidatorRun> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const slice = await getSlice(this.db, feature.sliceId);
    if (!slice) throw new Error(`Slice ${feature.sliceId} not found`);
    const milestone = await getMilestone(this.db, slice.milestoneId);
    if (!milestone) throw new Error(`Milestone ${slice.milestoneId} not found`);
    const now = new Date().toISOString();
    const newValidatorAttemptCount = (feature.validatorAttemptCount ?? 0) + 1;
    const run: MissionValidatorRun = {
      id: this.generateId("VR"),
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
    await createValidatorRun(this.db, run);
    this.emit("validator-run:started", run);
    await this.updateFeature(featureId, {
      validatorAttemptCount: newValidatorAttemptCount,
      lastValidatorRunId: run.id,
      loopState: "validating",
    });
    return run;
  }

  async getValidatorRun(id: string): Promise<MissionValidatorRun | undefined> {
    return getValidatorRun(this.db, id);
  }

  async getValidatorRunsByFeature(featureId: string): Promise<MissionValidatorRun[]> {
    return listValidatorRunsByFeature(this.db, featureId);
  }

  async getFailuresForRun(runId: string): Promise<MissionAssertionFailureRecord[]> {
    return listFailuresForRun(this.db, runId);
  }

  async getFeatureLoopSnapshot(featureId: string): Promise<MissionFeatureLoopSnapshot> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const validatorRuns = await listValidatorRunsByFeature(this.db, featureId);
    const failures: MissionAssertionFailureRecord[] = [];
    for (const run of validatorRuns) failures.push(...(await listFailuresForRun(this.db, run.id)));
    const lineage = [
      ...(await listLineageForSourceFeature(this.db, featureId)),
      ...(await listLineageForFixFeature(this.db, featureId)),
    ];
    const retryBudgetRemaining = Math.max(0, DEFAULT_IMPLEMENTATION_RETRY_BUDGET - (feature.implementationAttemptCount ?? 0));
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

  // ════════════════ CONTRACT ASSERTIONS ════════════════
  async addContractAssertion(milestoneId: string, input: ContractAssertionCreateInput): Promise<MissionContractAssertion> {
    const milestone = await getMilestone(this.db, milestoneId);
    if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);
    const now = new Date().toISOString();
    const existing = await listContractAssertions(this.db, milestoneId);
    const orderIndex = existing.length > 0 ? Math.max(...existing.map((a) => a.orderIndex)) + 1 : 0;
    const assertion: MissionContractAssertion = {
      id: this.generateId("CA"),
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
    const created = await createContractAssertion(this.db, assertion);
    this.emit("assertion:created", created);
    await this.recomputeMilestoneValidation(milestoneId);
    return created;
  }

  async getContractAssertion(id: string): Promise<MissionContractAssertion | undefined> {
    return getContractAssertion(this.db, id);
  }

  async listContractAssertions(milestoneId: string): Promise<MissionContractAssertion[]> {
    return listContractAssertions(this.db, milestoneId);
  }

  async updateContractAssertion(id: string, updates: ContractAssertionUpdateInput): Promise<MissionContractAssertion> {
    const assertion = await getContractAssertion(this.db, id);
    if (!assertion) throw new Error(`Assertion ${id} not found`);
    const updated: MissionContractAssertion = {
      ...assertion,
      title: updates.title ?? assertion.title,
      assertion: updates.assertion ?? assertion.assertion,
      status: updates.status ?? assertion.status,
      updatedAt: new Date().toISOString(),
    };
    await updateContractAssertion(this.db, updated);
    this.emit("assertion:updated", updated);
    await this.recomputeMilestoneValidation(updated.milestoneId);
    return updated;
  }

  async deleteContractAssertion(id: string): Promise<void> {
    const assertion = await getContractAssertion(this.db, id);
    if (!assertion) throw new Error(`Assertion ${id} not found`);
    const milestoneId = assertion.milestoneId;
    await deleteContractAssertion(this.db, id);
    this.emit("assertion:deleted", id);
    await this.recomputeMilestoneValidation(milestoneId);
  }

  async reorderContractAssertions(milestoneId: string, orderedIds: string[]): Promise<void> {
    for (const id of orderedIds) {
      const assertion = await getContractAssertion(this.db, id);
      if (!assertion) throw new Error(`Assertion ${id} not found`);
      if (assertion.milestoneId !== milestoneId) throw new Error(`Assertion ${id} does not belong to milestone ${milestoneId}`);
    }
    await reorderContractAssertions(this.layer, orderedIds);
  }

  // ════════════════ FEATURE-ASSERTION LINKS ════════════════
  async linkFeatureToAssertion(featureId: string, assertionId: string): Promise<void> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const assertion = await getContractAssertion(this.db, assertionId);
    if (!assertion) throw new Error(`Assertion ${assertionId} not found`);
    if (await featureAssertionLinkExists(this.db, featureId, assertionId)) {
      throw new Error(`Feature ${featureId} is already linked to assertion ${assertionId}`);
    }
    await linkFeatureToAssertion(this.db, featureId, assertionId, new Date().toISOString());
    this.emit("assertion:linked", { featureId, assertionId });
    await this.recomputeMilestoneValidation(assertion.milestoneId);
  }

  async unlinkFeatureFromAssertion(featureId: string, assertionId: string): Promise<void> {
    if (!(await featureAssertionLinkExists(this.db, featureId, assertionId))) {
      throw new Error(`Feature ${featureId} is not linked to assertion ${assertionId}`);
    }
    await unlinkFeatureFromAssertion(this.db, featureId, assertionId);
    this.emit("assertion:unlinked", { featureId, assertionId });
    const assertion = await getContractAssertion(this.db, assertionId);
    if (assertion) await this.recomputeMilestoneValidation(assertion.milestoneId);
  }

  async listAssertionsForFeature(featureId: string): Promise<MissionContractAssertion[]> {
    return listAssertionsForFeature(this.db, featureId);
  }

  async listFeaturesForAssertion(assertionId: string): Promise<MissionFeature[]> {
    return listFeaturesForAssertion(this.db, assertionId);
  }

  // ════════════════ VALIDATION ROLLUP ════════════════
  async getMilestoneValidationRollup(milestoneId: string): Promise<MilestoneValidationRollup> {
    const milestone = await getMilestone(this.db, milestoneId);
    if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);
    const assertions = await listContractAssertions(this.db, milestoneId);
    const totalAssertions = assertions.length;
    const proseOnMilestone = (milestone.acceptanceCriteria ?? "").trim().length > 0;
    let proseOnFeatures = false;
    for (const slice of await listSlices(this.db, milestoneId)) {
      for (const feature of await listFeatures(this.db, slice.id)) {
        if ((feature.acceptanceCriteria ?? "").trim().length > 0) {
          proseOnFeatures = true;
          break;
        }
      }
      if (proseOnFeatures) break;
    }
    const hasProseButNoAssertions = totalAssertions === 0 && (proseOnMilestone || proseOnFeatures);

    let passedAssertions = 0;
    let failedAssertions = 0;
    let blockedAssertions = 0;
    let pendingAssertions = 0;
    let unlinkedAssertions = 0;
    for (const assertion of assertions) {
      switch (assertion.status) {
        case "passed": passedAssertions++; break;
        case "failed": failedAssertions++; break;
        case "blocked": blockedAssertions++; break;
        case "pending": pendingAssertions++; break;
      }
      const linkedFeatures = await listFeaturesForAssertion(this.db, assertion.id);
      if (linkedFeatures.length === 0) unlinkedAssertions++;
    }

    let state: MilestoneValidationState;
    if (totalAssertions === 0) state = "not_started";
    else if (failedAssertions > 0) state = "failed";
    else if (blockedAssertions > 0) state = "blocked";
    else if (unlinkedAssertions > 0) state = "needs_coverage";
    else if (passedAssertions === totalAssertions) state = "passed";
    else state = "ready";

    await this.reconcileMissingStructuredAssertionsSignal(milestone, hasProseButNoAssertions);

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

  async backfillFeatureAssertions(options?: { missionId?: string; dryRun?: boolean }): Promise<MissionAssertionBackfillReport> {
    const dryRun = options?.dryRun ?? true;
    const missionFilter = options?.missionId;
    const missions = missionFilter ? [missionFilter] : (await listMissions(this.db)).map((m) => m.id);
    const features: MissionFeature[] = [];
    for (const missionId of missions) {
      for (const milestone of await listMilestones(this.db, missionId)) {
        for (const slice of await listSlices(this.db, milestone.id)) {
          features.push(...(await listFeatures(this.db, slice.id)));
        }
      }
    }
    const report: MissionAssertionBackfillReport = { scanned: features.length, alreadyLinked: 0, repaired: [], skippedErrors: [] };
    for (const feature of features) {
      try {
        const linked = await listAssertionsForFeature(this.db, feature.id);
        if (linked.length > 0) {
          report.alreadyLinked += 1;
          continue;
        }
        const slice = await getSlice(this.db, feature.sliceId);
        if (!slice) throw new Error(`Slice ${feature.sliceId} not found`);
        const milestoneId = slice.milestoneId;
        const { assertionText, textSource } = this.deriveFeatureAssertion(feature);
        if (dryRun) {
          report.repaired.push({ featureId: feature.id, milestoneId, assertionId: "(dry-run)", textSource });
          continue;
        }
        const created = await this.addContractAssertion(milestoneId, {
          title: feature.title,
          assertion: assertionText,
          status: "pending",
          sourceFeatureId: feature.id,
        });
        await this.linkFeatureToAssertion(feature.id, created.id);
        report.repaired.push({ featureId: feature.id, milestoneId, assertionId: created.id, textSource });
      } catch (error) {
        report.skippedErrors.push({ featureId: feature.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }

  // ════════════════ TRIAGE ════════════════
  async buildEnrichedDescription(featureId: string): Promise<string | undefined> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) return undefined;
    const slice = await getSlice(this.db, feature.sliceId);
    if (!slice) return undefined;
    const milestone = await getMilestone(this.db, slice.milestoneId);
    if (!milestone) return undefined;
    const mission = await getMission(this.db, milestone.missionId);
    if (!mission) return undefined;

    const sections: string[] = [];
    sections.push(`## Mission: ${mission.title}`);
    if (mission.description) sections.push(mission.description);

    const milestoneSections: string[] = [`## Milestone: ${milestone.title}`];
    if (milestone.description) milestoneSections.push(`**Description:** ${milestone.description}`);
    if (milestone.verification) milestoneSections.push(`**Verification:** ${milestone.verification}`);
    if (milestone.planningNotes) milestoneSections.push(`**Planning Notes:** ${milestone.planningNotes}`);
    sections.push(milestoneSections.join("\n"));

    const sliceSections: string[] = [`## Slice: ${slice.title}`];
    if (slice.description) sliceSections.push(`**Description:** ${slice.description}`);
    if (slice.verification) sliceSections.push(`**Verification:** ${slice.verification}`);
    if (slice.planningNotes) sliceSections.push(`**Planning Notes:** ${slice.planningNotes}`);
    sections.push(sliceSections.join("\n"));

    const featureSections: string[] = [`## Feature: ${feature.title}`];
    if (feature.description) featureSections.push(feature.description);
    if (feature.acceptanceCriteria) featureSections.push(`**Acceptance Criteria:**\n${feature.acceptanceCriteria}`);
    sections.push(featureSections.join("\n"));

    const linkedAssertions = await listAssertionsForFeature(this.db, featureId);
    if (linkedAssertions.length > 0) {
      const assertionSections: string[] = [`## Contract Assertions`];
      for (const assertion of linkedAssertions) {
        const statusIcon = assertion.status === "passed" ? "✅" : assertion.status === "failed" ? "❌" : assertion.status === "blocked" ? "🚫" : "⏳";
        assertionSections.push(`### ${statusIcon} ${assertion.title}`);
        assertionSections.push(assertion.assertion);
      }
      sections.push(assertionSections.join("\n\n"));
    }
    return sections.join("\n\n");
  }

  async triageFeature(
    featureId: string,
    taskTitle?: string,
    taskDescription?: string,
    branchOptions?: { branch?: string; baseBranch?: string; assignmentMode?: "shared" | "per-task-derived"; workflowId?: string | null },
  ): Promise<MissionFeature> {
    if (!this.taskStore) throw new Error("TaskStore reference is required for triage operations");
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    if (feature.status !== "defined") {
      throw new Error(`Feature ${featureId} is already ${feature.status} (status must be "defined" to triage)`);
    }
    let description: string;
    if (taskDescription) description = taskDescription;
    else description = (await this.buildEnrichedDescription(featureId)) || feature.title;

    const slice = await getSlice(this.db, feature.sliceId);
    const milestone = slice ? await getMilestone(this.db, slice.milestoneId) : undefined;
    const missionId = milestone?.missionId;
    const mission = missionId ? await getMission(this.db, missionId) : undefined;
    const strategyDefaults = missionBranchStrategyDefaults(mission?.branchStrategy);
    const resolvedBaseBranch = branchOptions?.baseBranch ?? mission?.baseBranch;
    const resolvedBranch = branchOptions?.branch ?? strategyDefaults.branch;
    const resolvedAssignmentMode = branchOptions?.assignmentMode ?? strategyDefaults.assignmentMode;

    const lockScope = missionId ? `mission:${missionId}` : `mission-store:${this.taskStore.getRootDir()}`;
    const guard = await runDeterministicDuplicateGuard(this.taskStore, { title: taskTitle || feature.title, description }, { lockScope });

    let linkedTaskId: string;
    try {
      if (guard.action === "duplicate" && guard.existing) {
        linkedTaskId = guard.existing.id;
      } else {
        let sharedBranchBaseForMission: string | undefined;
        let missionGroupId: string | undefined;
        if (missionId && resolvedAssignmentMode === "shared") {
          const settings = await this.taskStore.getSettings();
          const settingsDefaultBranch =
            typeof settings.defaultBranch === "string" && settings.defaultBranch.trim().length > 0 ? settings.defaultBranch : "main";
          const settingsAutoMerge = typeof settings.autoMerge === "boolean" ? settings.autoMerge : false;
          sharedBranchBaseForMission = resolvedBranch ?? resolvedBaseBranch ?? settingsDefaultBranch;
          const group = await this.taskStore.ensureBranchGroupForSource("mission", missionId, {
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
          ...(branchOptions?.workflowId !== undefined ? { workflowId: branchOptions.workflowId } : {}),
        });
        if (guard.fingerprint) {
          await this.taskStore.updateTask(createdTask.id, { sourceMetadataPatch: { contentFingerprint: guard.fingerprint } });
        }
        const reconcile = await reconcileDeterministicDuplicate(this.taskStore, { createdTask, fingerprint: guard.fingerprint });
        linkedTaskId = reconcile.canonical.id;
      }
    } finally {
      guard.releaseLock();
    }
    return this.linkFeatureToTask(featureId, linkedTaskId);
  }

  async triageSlice(
    sliceId: string,
    branchOptions?: { branch?: string; baseBranch?: string; assignmentMode?: "shared" | "per-task-derived"; workflowId?: string | null },
  ): Promise<MissionFeature[]> {
    if (!this.taskStore) throw new Error("TaskStore reference is required for triage operations");
    const slice = await getSlice(this.db, sliceId);
    if (!slice) throw new Error(`Slice ${sliceId} not found`);
    const features = await listFeatures(this.db, sliceId);
    const definedFeatures = features.filter((f) => f.status === "defined");
    const milestone = await getMilestone(this.db, slice.milestoneId);
    const mission = milestone ? await getMission(this.db, milestone.missionId) : undefined;
    const strategyDefaults = missionBranchStrategyDefaults(mission?.branchStrategy);
    const resolvedBaseBranch = branchOptions?.baseBranch ?? mission?.baseBranch;
    const resolvedAssignmentMode = branchOptions?.assignmentMode ?? strategyDefaults.assignmentMode;
    const resolvedBranch = branchOptions?.branch ?? strategyDefaults.branch;
    const triaged: MissionFeature[] = [];
    for (const feature of definedFeatures) {
      const updated = await this.triageFeature(feature.id, undefined, undefined, {
        branch: resolvedBranch,
        baseBranch: resolvedBaseBranch,
        assignmentMode: resolvedAssignmentMode,
        ...(branchOptions?.workflowId !== undefined ? { workflowId: branchOptions.workflowId } : {}),
      });
      triaged.push(updated);
    }
    return triaged;
  }

  // ════════════════ STATUS ROLLUP ════════════════
  async computeSliceStatus(sliceId: string): Promise<SliceStatus> {
    const features = await listFeatures(this.db, sliceId);
    if (features.length === 0) return "pending";
    let allDone = true;
    for (const feature of features) {
      if (feature.status !== "done") { allDone = false; break; }
      const hasLinkedAssertions = (await listAssertionsForFeature(this.db, feature.id)).length > 0;
      if (!hasLinkedAssertions) continue;
      if (feature.lastValidatorStatus === "passed") continue;
      if (feature.loopState === "idle" || feature.loopState === undefined) continue;
      allDone = false;
      break;
    }
    if (allDone) return "complete";
    const anyActive = features.some((f) => f.status === "in-progress" || f.status === "triaged" || f.taskId !== undefined);
    return anyActive ? "active" : "pending";
  }

  async computeMilestoneStatus(milestoneId: string): Promise<MilestoneStatus> {
    const slices = await listSlices(this.db, milestoneId);
    if (slices.length === 0) return "planning";
    const allComplete = slices.every((s) => s.status === "complete");
    if (allComplete) return "complete";
    const hasActive = slices.some((s) => s.status === "active");
    if (hasActive) return "active";
    const hasProgress = slices.some((s) => s.status === "active" || s.status === "complete");
    return hasProgress ? "active" : "planning";
  }

  async computeMissionStatus(missionId: string): Promise<MissionStatus> {
    const milestones = await listMilestones(this.db, missionId);
    if (milestones.length === 0) return "planning";
    const allComplete = milestones.every((m) => m.status === "complete");
    if (allComplete) return "complete";
    const hasActive = milestones.some((m) => m.status === "active");
    if (hasActive) return "active";
    const hasProgress = milestones.some((m) => m.status === "active" || m.status === "complete");
    return hasProgress ? "active" : "planning";
  }

  // ── Private cascade + assertion helpers ──────────────────────────────
  private async recomputeSliceStatus(sliceId: string): Promise<void> {
    const newStatus = await this.computeSliceStatus(sliceId);
    const slice = await getSlice(this.db, sliceId);
    if (slice && slice.status !== newStatus) await this.updateSlice(sliceId, { status: newStatus });
  }

  private async recomputeMilestoneStatus(milestoneId: string): Promise<void> {
    const newStatus = await this.computeMilestoneStatus(milestoneId);
    const milestone = await getMilestone(this.db, milestoneId);
    if (milestone && milestone.status !== newStatus) await this.updateMilestone(milestoneId, { status: newStatus });
  }

  private async recomputeMissionStatus(missionId: string): Promise<void> {
    const newStatus = await this.computeMissionStatus(missionId);
    const mission = await getMission(this.db, missionId);
    if (mission && mission.status !== newStatus) await this.updateMission(missionId, { status: newStatus });
  }

  private async recomputeMilestoneValidation(milestoneId: string): Promise<void> {
    const rollup = await this.getMilestoneValidationRollup(milestoneId);
    await updateMilestoneValidationState(this.db, milestoneId, rollup.state);
    this.emit("milestone:validation:updated", { milestoneId, state: rollup.state, rollup });
  }

  private deriveFeatureAssertion(feature: MissionFeature): { assertionText: string; textSource: MissionAssertionTextSource } {
    const acceptanceCriteria = feature.acceptanceCriteria?.trim();
    if (acceptanceCriteria) return { assertionText: acceptanceCriteria, textSource: "acceptanceCriteria" };
    const description = feature.description?.trim();
    if (description) return { assertionText: description, textSource: "description" };
    return { assertionText: `Verify implementation of: ${feature.title}`, textSource: "fallback" };
  }

  private async ensureFeatureAssertion(feature: MissionFeature): Promise<void> {
    const slice = await getSlice(this.db, feature.sliceId);
    if (!slice) throw new Error(`Slice ${feature.sliceId} not found`);
    const milestoneId = slice.milestoneId;
    const { assertionText } = this.deriveFeatureAssertion(feature);
    const existing = (await listContractAssertions(this.db, milestoneId)).find((a) => a.sourceFeatureId === feature.id);
    if (!existing) {
      const created = await this.addContractAssertion(milestoneId, {
        title: feature.title,
        assertion: assertionText,
        status: "pending",
        sourceFeatureId: feature.id,
      });
      await this.linkFeatureToAssertion(feature.id, created.id);
      return;
    }
    if (existing.title !== feature.title || existing.assertion !== assertionText) {
      await this.updateContractAssertion(existing.id, { title: feature.title, assertion: assertionText });
    }
  }

  private async resolveTaskLinkage(sliceId: string): Promise<{ sliceId: string; missionId: string }> {
    const slice = await getSlice(this.db, sliceId);
    if (!slice) throw new Error(`Slice ${sliceId} not found`);
    const milestone = await getMilestone(this.db, slice.milestoneId);
    if (!milestone) throw new Error(`Milestone ${slice.milestoneId} not found for slice ${sliceId}`);
    const mission = await getMission(this.db, milestone.missionId);
    if (!mission) throw new Error(`Mission ${milestone.missionId} not found for slice ${sliceId}`);
    return { sliceId: slice.id, missionId: mission.id };
  }

  private async getLiveTaskLinkedFeatures(features: MissionFeature[]): Promise<Array<{ featureId: string; taskId: string }>> {
    const links = features
      .filter((feature): feature is MissionFeature & { taskId: string } => Boolean(feature.taskId))
      .map((feature) => ({ featureId: feature.id, taskId: feature.taskId }));
    if (links.length === 0) return [];
    const live = await listLiveLinkedTaskIds(this.db, links.map((link) => link.taskId));
    return links.filter((link) => live.has(link.taskId));
  }

  private async reconcileMissingStructuredAssertionsSignal(milestone: Milestone, hasProseButNoAssertions: boolean): Promise<void> {
    if (hasProseButNoAssertions) {
      if (!this.milestonesMissingStructuredAssertions.has(milestone.id)) {
        const mission = await getMission(this.db, milestone.missionId);
        if (mission) {
          await this.logMissionEvent(mission.id, "warning", `Milestone ${milestone.id} has prose acceptance criteria but no structured assertions.`, {
            code: "milestone_missing_structured_assertions",
            milestoneId: milestone.id,
          });
        }
      }
      this.milestonesMissingStructuredAssertions.add(milestone.id);
      return;
    }
    this.milestonesMissingStructuredAssertions.delete(milestone.id);
  }
}

/**
 * FNXC:MissionStore 2026-06-27-15:05:
 * Persist a milestone's recomputed validationState (mirrors the sync
 * recomputeMilestoneValidation UPDATE).
 */
export async function updateMilestoneValidationState(
  handle: QueryHandle,
  milestoneId: string,
  state: MilestoneValidationState,
): Promise<void> {
  await handle
    .update(schema.project.milestones)
    .set({ validationState: state, updatedAt: new Date().toISOString() })
    .where(eq(schema.project.milestones.id, milestoneId));
}
