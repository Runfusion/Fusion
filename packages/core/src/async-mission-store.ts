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
  MissionCreateInput,
  MissionEvent,
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
  SlicePlanState,
  ValidatorRunStatus,
  FeatureLoopState,
} from "./mission-types.js";
import type { Goal, GoalStatus } from "./goal-types.js";

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
      target: schema.project.missions.id,
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
      target: schema.project.milestones.id,
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
      target: schema.project.slices.id,
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
      target: schema.project.missionFeatures.id,
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
      target: schema.project.missionContractAssertions.id,
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
