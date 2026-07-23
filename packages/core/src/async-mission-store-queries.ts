/**
 * PostgreSQL mission row mappings and query helpers.
 *
 * FNXC:MissionStoreMaintainability 2026-07-14-19:24:
 * Keep persistence projections, row conversion, and standalone SQL operations
 * separate from the event-emitting AsyncMissionStore facade. This preserves the
 * public helper exports while making lifecycle and concurrency changes reviewable.
 */
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
 * FNXC:PostgresFinalCutover 2026-07-14-19:24:
 *   These helpers are the production MissionStore persistence path and program
 *   against AsyncDataLayer rather than a synchronous SQLite database.
 */
import { and, asc, desc, eq, inArray, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import { normalizeMissionAssertionOrigin, normalizeMissionAssertionScope, normalizeMissionAssertionType } from "./mission-types.js";
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

/**
 * FNXC:MissionStore 2026-06-27-15:00:
 * Default retry budget for implementation attempts (mirrors mission-store.ts).
 * When implementationAttemptCount reaches this limit, the feature loop blocks
 * instead of re-implementing.
 */
export const DEFAULT_IMPLEMENTATION_RETRY_BUDGET = 3;

/**
 * FNXC:MissionStore 2026-06-27-15:00:
 * Local replica of the (non-exported) sync `missionBranchStrategyDefaults`.
 * Resolves a mission's branch strategy into a concrete {branch, assignmentMode}
 * used by triage.
 */
export function missionBranchStrategyDefaults(strategy?: MissionBranchStrategy): {
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
export type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

/*
FNXC:MissionProjectIsolation 2026-07-14-21:35:
Mission data lives in the shared PostgreSQL project schema, so every mission-owned insert and predicate must use the session's authoritative project partition even when an administrative connection bypasses row-level security. An unbound maintenance session is confined to the explicit legacy quarantine rather than becoming a cross-project reader.
*/
function missionProjectId(): SQL<string> {
  return sql<string>`COALESCE(NULLIF(current_setting('fusion.project_id', true), ''), '__legacy_unscoped__')`;
}

function missionProjectScope(column: AnyColumn): SQL {
  return eq(column, missionProjectId());
}

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
  researchRunId: string | null;
  researchFindingId: string | null;
  researchSourceUrls: string[] | null;
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

export interface AssertionRow {
  id: string;
  milestoneId: string;
  title: string;
  assertion: string;
  status: string;
  type: string | null;
  orderIndex: number;
  sourceFeatureId: string | null;
  scope: string | null;
  origin: string | null;
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
  researchRunId: schema.project.missionFeatures.researchRunId,
  researchFindingId: schema.project.missionFeatures.researchFindingId,
  researchSourceUrls: schema.project.missionFeatures.researchSourceUrls,
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

export const assertionColumns = {
  id: schema.project.missionContractAssertions.id,
  milestoneId: schema.project.missionContractAssertions.milestoneId,
  title: schema.project.missionContractAssertions.title,
  assertion: schema.project.missionContractAssertions.assertion,
  status: schema.project.missionContractAssertions.status,
  type: schema.project.missionContractAssertions.type,
  orderIndex: schema.project.missionContractAssertions.orderIndex,
  sourceFeatureId: schema.project.missionContractAssertions.sourceFeatureId,
  scope: schema.project.missionContractAssertions.scope,
  origin: schema.project.missionContractAssertions.origin,
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
    researchProvenance: row.researchRunId && row.researchFindingId ? { researchRunId: row.researchRunId, findingId: row.researchFindingId, sourceUrls: row.researchSourceUrls ?? [] } : undefined,
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

export function rowToAssertion(row: AssertionRow): MissionContractAssertion {
  return {
    id: row.id,
    milestoneId: row.milestoneId,
    sourceFeatureId: row.sourceFeatureId ?? undefined,
    scope: normalizeMissionAssertionScope(row.scope),
    origin: normalizeMissionAssertionOrigin(row.origin),
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
    projectId: missionProjectId(),
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
    .where(and(missionProjectScope(schema.project.missions.projectId), eq(schema.project.missions.id, id)));
  return rows[0] ? rowToMission(rows[0] as MissionRow) : undefined;
}

/** List all missions, ordered by createdAt DESC (newest first). */
export async function listMissions(handle: QueryHandle): Promise<Mission[]> {
  const rows = await handle
    .select(missionColumns)
    .from(schema.project.missions)
    .where(missionProjectScope(schema.project.missions.projectId))
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
    .where(and(missionProjectScope(schema.project.missions.projectId), eq(schema.project.missions.id, mission.id)));
}

/** Delete a mission by id (cascades to milestones/slices/features/events). Returns true if a row was deleted. */
export async function deleteMission(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missions)
    .where(and(missionProjectScope(schema.project.missions.projectId), eq(schema.project.missions.id, id)))
    .returning({ id: schema.project.missions.id });
  return result.length > 0;
}

/** Check whether a mission with the given id exists. */
export async function missionExists(handle: QueryHandle, id: string): Promise<boolean> {
  const rows = await handle
    .select({ id: schema.project.missions.id })
    .from(schema.project.missions)
    .where(and(missionProjectScope(schema.project.missions.projectId), eq(schema.project.missions.id, id)));
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
    projectId: missionProjectId(),
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
    .where(and(missionProjectScope(schema.project.milestones.projectId), eq(schema.project.milestones.id, id)));
  return rows[0] ? rowToMilestone(rows[0] as MilestoneRow) : undefined;
}

/** List milestones for a mission, ordered by orderIndex ASC. */
export async function listMilestones(handle: QueryHandle, missionId: string): Promise<Milestone[]> {
  const rows = await handle
    .select(milestoneColumns)
    .from(schema.project.milestones)
    .where(and(missionProjectScope(schema.project.milestones.projectId), eq(schema.project.milestones.missionId, missionId)))
    .orderBy(asc(schema.project.milestones.orderIndex));
  return rows.map((row) => rowToMilestone(row as MilestoneRow));
}

/** List ALL milestones across all missions, ordered by orderIndex ASC. */
export async function listAllMilestones(handle: QueryHandle): Promise<Milestone[]> {
  const rows = await handle
    .select(milestoneColumns)
    .from(schema.project.milestones)
    .where(missionProjectScope(schema.project.milestones.projectId))
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
    .where(and(missionProjectScope(schema.project.milestones.projectId), eq(schema.project.milestones.id, milestone.id)));
}

/** Delete a milestone by id (cascades to slices/features). Returns true if deleted. */
export async function deleteMilestone(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.milestones)
    .where(and(missionProjectScope(schema.project.milestones.projectId), eq(schema.project.milestones.id, id)))
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
        .where(and(missionProjectScope(schema.project.milestones.projectId), eq(schema.project.milestones.id, orderedIds[i]!)));
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
    projectId: missionProjectId(),
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
    .where(and(missionProjectScope(schema.project.slices.projectId), eq(schema.project.slices.id, id)));
  return rows[0] ? rowToSlice(rows[0] as SliceRow) : undefined;
}

/** List slices for a milestone, ordered by orderIndex ASC. */
export async function listSlices(handle: QueryHandle, milestoneId: string): Promise<Slice[]> {
  const rows = await handle
    .select(sliceColumns)
    .from(schema.project.slices)
    .where(and(missionProjectScope(schema.project.slices.projectId), eq(schema.project.slices.milestoneId, milestoneId)))
    .orderBy(asc(schema.project.slices.orderIndex));
  return rows.map((row) => rowToSlice(row as SliceRow));
}

/** List ALL slices across all milestones, ordered by orderIndex ASC. */
export async function listAllSlices(handle: QueryHandle): Promise<Slice[]> {
  const rows = await handle
    .select(sliceColumns)
    .from(schema.project.slices)
    .where(missionProjectScope(schema.project.slices.projectId))
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
    .where(and(missionProjectScope(schema.project.slices.projectId), eq(schema.project.slices.id, slice.id)));
}

/** Delete a slice by id (cascades to features). Returns true if deleted. */
export async function deleteSlice(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.slices)
    .where(and(missionProjectScope(schema.project.slices.projectId), eq(schema.project.slices.id, id)))
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
        .where(and(missionProjectScope(schema.project.slices.projectId), eq(schema.project.slices.id, orderedIds[i]!)));
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
    projectId: missionProjectId(),
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
    researchRunId: feature.researchProvenance?.researchRunId ?? null,
    researchFindingId: feature.researchProvenance?.findingId ?? null,
    researchSourceUrls: feature.researchProvenance?.sourceUrls ?? null,
  });
  return (await getFeature(handle, feature.id))!;
}

/** Get a single feature by id. */
export async function getFeatureByResearchProvenance(handle: QueryHandle, sliceId: string, researchRunId: string, findingId: string): Promise<MissionFeature | undefined> {
  const rows = await handle.select(featureColumns).from(schema.project.missionFeatures).where(and(
    missionProjectScope(schema.project.missionFeatures.projectId),
    eq(schema.project.missionFeatures.sliceId, sliceId),
    eq(schema.project.missionFeatures.researchRunId, researchRunId),
    eq(schema.project.missionFeatures.researchFindingId, findingId),
  ));
  return rows[0] ? rowToFeature(rows[0] as FeatureRow) : undefined;
}

export async function getFeature(handle: QueryHandle, id: string): Promise<MissionFeature | undefined> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), eq(schema.project.missionFeatures.id, id)));
  return rows[0] ? rowToFeature(rows[0] as FeatureRow) : undefined;
}

/**
 * FNXC:PostgresMissionBulkReads 2026-07-14-17:55:
 * Mission reconciliation resolves feature sets in one query. Empty inputs short-circuit so callers never emit an invalid IN ().
 */
export async function listFeaturesByIds(handle: QueryHandle, ids: string[]): Promise<MissionFeature[]> {
  if (ids.length === 0) return [];
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), inArray(schema.project.missionFeatures.id, [...new Set(ids)])));
  return rows.map((row) => rowToFeature(row as FeatureRow));
}

/** List features for a slice, ordered by createdAt ASC. */
export async function listFeatures(handle: QueryHandle, sliceId: string): Promise<MissionFeature[]> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), eq(schema.project.missionFeatures.sliceId, sliceId)))
    .orderBy(asc(schema.project.missionFeatures.createdAt));
  return rows.map((row) => rowToFeature(row as FeatureRow));
}

/** Fetch every feature under one milestone without a slice-by-slice query loop. */
export async function listFeaturesForMilestone(handle: QueryHandle, milestoneId: string): Promise<MissionFeature[]> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .innerJoin(schema.project.slices, and(
      eq(schema.project.slices.projectId, schema.project.missionFeatures.projectId),
      eq(schema.project.slices.id, schema.project.missionFeatures.sliceId),
    ))
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), eq(schema.project.slices.milestoneId, milestoneId)))
    .orderBy(asc(schema.project.missionFeatures.createdAt));
  return rows.map((row) => rowToFeature(row as FeatureRow));
}

/** List ALL features across all slices, ordered by createdAt ASC. */
export async function listAllFeatures(handle: QueryHandle): Promise<MissionFeature[]> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(missionProjectScope(schema.project.missionFeatures.projectId))
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
      researchRunId: feature.researchProvenance?.researchRunId ?? null,
      researchFindingId: feature.researchProvenance?.findingId ?? null,
      researchSourceUrls: feature.researchProvenance?.sourceUrls ?? null,
    })
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), eq(schema.project.missionFeatures.id, feature.id)));
}

/** Delete a feature by id. Returns true if deleted. */
export async function deleteFeature(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missionFeatures)
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), eq(schema.project.missionFeatures.id, id)))
    .returning({ id: schema.project.missionFeatures.id });
  return result.length > 0;
}

/** Return a different feature already using the task, if one exists. */
export async function getConflictingFeatureByTaskId(
  handle: QueryHandle,
  taskId: string,
  featureId: string,
): Promise<MissionFeature | undefined> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(and(
      missionProjectScope(schema.project.missionFeatures.projectId),
      eq(schema.project.missionFeatures.taskId, taskId),
      ne(schema.project.missionFeatures.id, featureId),
    ))
    .limit(1);
  return rows[0] ? rowToFeature(rows[0] as FeatureRow) : undefined;
}

/** Get a feature by its linked taskId (null if no feature is linked). */
export async function getFeatureByTaskId(handle: QueryHandle, taskId: string): Promise<MissionFeature | undefined> {
  const rows = await handle
    .select(featureColumns)
    .from(schema.project.missionFeatures)
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), eq(schema.project.missionFeatures.taskId, taskId)));
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
    .where(and(missionProjectScope(schema.project.missionFeatures.projectId), eq(schema.project.missionFeatures.id, featureId)));
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
    .from(schema.project.missionEvents)
    .where(missionProjectScope(schema.project.missionEvents.projectId));
  return rows[0]?.maxSeq ?? 0;
}

/**
 * FNXC:MissionStore 2026-06-24-10:10:
 * Insert a mission event (non-destructive). metadata is a jsonb column.
 */
export async function insertMissionEvent(handle: QueryHandle, event: MissionEvent): Promise<void> {
  await handle.insert(schema.project.missionEvents).values({
    projectId: missionProjectId(),
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
      projectId: missionProjectId(),
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
    .where(and(missionProjectScope(schema.project.missionEvents.projectId), eq(schema.project.missionEvents.missionId, missionId)));
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
    .where(and(missionProjectScope(schema.project.missionEvents.projectId), eq(schema.project.missionEvents.missionId, missionId)))
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
    .where(missionProjectScope(schema.project.missionEvents.projectId))
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
    .where(and(missionProjectScope(schema.project.missionEvents.projectId), eq(schema.project.missionEvents.eventType, "error")))
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
        missionProjectScope(schema.project.missionGoals.projectId),
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
    .values({ projectId: missionProjectId(), missionId, goalId, createdAt })
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
        missionProjectScope(schema.project.missionGoals.projectId),
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
    .where(and(missionProjectScope(schema.project.missionGoals.projectId), eq(schema.project.missionGoals.missionId, missionId)))
    .orderBy(asc(schema.project.missionGoals.createdAt), asc(schema.project.missionGoals.goalId));
  return rows.map((row) => row.goalId);
}

/** List mission IDs linked to a goal, ordered by createdAt ASC, missionId ASC. */
export async function listMissionIdsForGoal(handle: QueryHandle, goalId: string): Promise<string[]> {
  const rows = await handle
    .select({ missionId: schema.project.missionGoals.missionId })
    .from(schema.project.missionGoals)
    .where(and(missionProjectScope(schema.project.missionGoals.projectId), eq(schema.project.missionGoals.goalId, goalId)))
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
    .where(missionProjectScope(schema.project.missionGoals.projectId))
    .groupBy(schema.project.missionGoals.missionId);
  return new Map(rows.map((row) => [row.missionId, row.count]));
}

/** Check whether a goal exists (for link validation). */
export async function goalExists(handle: QueryHandle, goalId: string): Promise<boolean> {
  const rows = await handle
    .select({ id: schema.project.goals.id })
    .from(schema.project.goals)
    .where(and(missionProjectScope(schema.project.goals.projectId), eq(schema.project.goals.id, goalId)));
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
    .where(and(missionProjectScope(schema.project.goals.projectId), eq(schema.project.goals.id, goalId)));
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
    .where(and(missionProjectScope(schema.project.goals.projectId), inArray(schema.project.goals.id, goalIds)));
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
    projectId: missionProjectId(),
    id: assertion.id,
    milestoneId: assertion.milestoneId,
    title: assertion.title,
    assertion: assertion.assertion,
    status: assertion.status,
    type: normalizeMissionAssertionType(assertion.type),
    orderIndex: assertion.orderIndex,
    sourceFeatureId: assertion.sourceFeatureId ?? null,
    scope: assertion.scope ?? "feature",
    origin: assertion.origin ?? "authored",
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
    .where(and(missionProjectScope(schema.project.missionContractAssertions.projectId), eq(schema.project.missionContractAssertions.id, id)));
  return rows[0] ? rowToAssertion(rows[0] as AssertionRow) : undefined;
}

/** List contract assertions for a milestone, ordered by orderIndex, createdAt, id. */
export async function listContractAssertions(handle: QueryHandle, milestoneId: string): Promise<MissionContractAssertion[]> {
  const rows = await handle
    .select(assertionColumns)
    .from(schema.project.missionContractAssertions)
    .where(and(missionProjectScope(schema.project.missionContractAssertions.projectId), eq(schema.project.missionContractAssertions.milestoneId, milestoneId)))
    .orderBy(
      asc(schema.project.missionContractAssertions.orderIndex),
      asc(schema.project.missionContractAssertions.createdAt),
      asc(schema.project.missionContractAssertions.id),
    );
  return rows.map((row) => rowToAssertion(row as AssertionRow));
}

/** Read linked assertions for a feature set in one join. */
export async function listLinkedAssertionsForFeatures(
  handle: QueryHandle,
  featureIds: string[],
): Promise<Array<{ featureId: string; assertion: MissionContractAssertion }>> {
  if (featureIds.length === 0) return [];
  const rows = await handle
    .select({ featureId: schema.project.missionFeatureAssertions.featureId, ...assertionColumns })
    .from(schema.project.missionFeatureAssertions)
    .innerJoin(
      schema.project.missionContractAssertions,
      and(
        eq(schema.project.missionContractAssertions.projectId, schema.project.missionFeatureAssertions.projectId),
        eq(schema.project.missionContractAssertions.id, schema.project.missionFeatureAssertions.assertionId),
      ),
    )
    .where(and(missionProjectScope(schema.project.missionFeatureAssertions.projectId), inArray(schema.project.missionFeatureAssertions.featureId, [...new Set(featureIds)])));
  return rows.map((row) => ({
    featureId: row.featureId,
    assertion: rowToAssertion(row as unknown as AssertionRow),
  }));
}

/** Return the linked subset of an assertion ID set in one query. */
export async function listLinkedAssertionIds(handle: QueryHandle, assertionIds: string[]): Promise<Set<string>> {
  if (assertionIds.length === 0) return new Set();
  const rows = await handle
    .select({ assertionId: schema.project.missionFeatureAssertions.assertionId })
    .from(schema.project.missionFeatureAssertions)
    .where(and(missionProjectScope(schema.project.missionFeatureAssertions.projectId), inArray(schema.project.missionFeatureAssertions.assertionId, [...new Set(assertionIds)])));
  return new Set(rows.map((row) => row.assertionId));
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
    .where(and(missionProjectScope(schema.project.missionContractAssertions.projectId), eq(schema.project.missionContractAssertions.id, assertion.id)));
}

/** Delete a contract assertion by id. Returns true if deleted. */
export async function deleteContractAssertion(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.missionContractAssertions)
    .where(and(missionProjectScope(schema.project.missionContractAssertions.projectId), eq(schema.project.missionContractAssertions.id, id)))
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
        .where(and(missionProjectScope(schema.project.missionContractAssertions.projectId), eq(schema.project.missionContractAssertions.id, orderedIds[i]!)));
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
        missionProjectScope(schema.project.missionFeatureAssertions.projectId),
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
    .values({ projectId: missionProjectId(), featureId, assertionId, createdAt })
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
        missionProjectScope(schema.project.missionFeatureAssertions.projectId),
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
    .where(missionProjectScope(schema.project.missionFeatureAssertions.projectId))
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
    projectId: missionProjectId(),
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
    .where(and(missionProjectScope(schema.project.missionValidatorRuns.projectId), eq(schema.project.missionValidatorRuns.id, id)));
  return rows[0] ? rowToValidatorRun(rows[0] as ValidatorRunRow) : undefined;
}

/** List validator runs for a feature, ordered by startedAt DESC. */
export async function listValidatorRunsByFeature(handle: QueryHandle, featureId: string): Promise<MissionValidatorRun[]> {
  const rows = await handle
    .select(validatorRunColumns)
    .from(schema.project.missionValidatorRuns)
    .where(and(missionProjectScope(schema.project.missionValidatorRuns.projectId), eq(schema.project.missionValidatorRuns.featureId, featureId)))
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
        missionProjectScope(schema.project.missionValidatorRuns.projectId),
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
    .where(and(missionProjectScope(schema.project.missionValidatorRuns.projectId), eq(schema.project.missionValidatorRuns.id, run.id)));
}

/**
 * FNXC:MissionValidatorConcurrency 2026-07-14-18:45:
 * Validator completion and stale-run reaping compete for the same terminal transition. PostgreSQL chooses exactly one winner by conditioning the write on status='running'; losers must not mutate the feature or emit a second terminal event.
 */
export async function transitionRunningValidatorRun(
  handle: QueryHandle,
  run: MissionValidatorRun,
): Promise<MissionValidatorRun | undefined> {
  const rows = await handle
    .update(schema.project.missionValidatorRuns)
    .set({
      status: run.status,
      summary: run.summary ?? null,
      blockedReason: run.blockedReason ?? null,
      completedAt: run.completedAt ?? null,
      updatedAt: run.updatedAt,
    })
    .where(and(
      missionProjectScope(schema.project.missionValidatorRuns.projectId),
      eq(schema.project.missionValidatorRuns.id, run.id),
      eq(schema.project.missionValidatorRuns.status, "running"),
    ))
    .returning(validatorRunColumns);
  return rows[0] ? rowToValidatorRun(rows[0] as ValidatorRunRow) : undefined;
}

// ════════════════════════════════════════════════════════════════════
// VALIDATOR FAILURES
// ════════════════════════════════════════════════════════════════════

/** Insert a validator failure record (non-destructive INSERT). */
export async function insertValidatorFailure(handle: QueryHandle, failure: MissionAssertionFailureRecord): Promise<void> {
  await handle.insert(schema.project.missionValidatorFailures).values({
    projectId: missionProjectId(),
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

/** Bulk insert all failures observed by one validator run. */
export async function insertValidatorFailures(handle: QueryHandle, failures: MissionAssertionFailureRecord[]): Promise<void> {
  if (failures.length === 0) return;
  await handle.insert(schema.project.missionValidatorFailures).values(failures.map((failure) => ({
    projectId: missionProjectId(),
    id: failure.id,
    runId: failure.runId,
    featureId: failure.featureId,
    assertionId: failure.assertionId,
    message: failure.message ?? null,
    expected: failure.expected ?? null,
    actual: failure.actual ?? null,
    createdAt: failure.createdAt,
  })));
}

/** List failures for a run, ordered by createdAt ASC. */
export async function listFailuresForRun(handle: QueryHandle, runId: string): Promise<MissionAssertionFailureRecord[]> {
  const rows = await handle
    .select(failureColumns)
    .from(schema.project.missionValidatorFailures)
    .where(and(missionProjectScope(schema.project.missionValidatorFailures.projectId), eq(schema.project.missionValidatorFailures.runId, runId)))
    .orderBy(asc(schema.project.missionValidatorFailures.createdAt));
  return rows.map((row) => rowToFailure(row as FailureRow));
}


/** Fetch failure history for a validator-run set in one ordered query. */
export async function listFailuresForRuns(handle: QueryHandle, runIds: string[]): Promise<MissionAssertionFailureRecord[]> {
  if (runIds.length === 0) return [];
  const rows = await handle
    .select(failureColumns)
    .from(schema.project.missionValidatorFailures)
    .where(and(missionProjectScope(schema.project.missionValidatorFailures.projectId), inArray(schema.project.missionValidatorFailures.runId, [...new Set(runIds)])))
    .orderBy(asc(schema.project.missionValidatorFailures.createdAt));
  return rows.map((row) => rowToFailure(row as FailureRow));
}

/** Return feature ids that have at least one linked assertion in one query. */
export async function listFeatureIdsWithAssertions(handle: QueryHandle, featureIds: string[]): Promise<Set<string>> {
  if (featureIds.length === 0) return new Set();
  const rows = await handle
    .selectDistinct({ featureId: schema.project.missionFeatureAssertions.featureId })
    .from(schema.project.missionFeatureAssertions)
    .where(and(missionProjectScope(schema.project.missionFeatureAssertions.projectId), inArray(schema.project.missionFeatureAssertions.featureId, [...new Set(featureIds)])));
  return new Set(rows.map((row) => row.featureId));
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
    projectId: missionProjectId(),
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
        missionProjectScope(schema.project.missionFixFeatureLineage.projectId),
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
    .where(and(missionProjectScope(schema.project.missionFixFeatureLineage.projectId), eq(schema.project.missionFixFeatureLineage.sourceFeatureId, sourceFeatureId)))
    .orderBy(asc(schema.project.missionFixFeatureLineage.createdAt));
  return rows.map((row) => row.fixFeatureId);
}

/** Get lineage rows for a source feature. */
export async function listLineageForSourceFeature(handle: QueryHandle, sourceFeatureId: string): Promise<MissionFixFeatureLineage[]> {
  const rows = await handle
    .select(lineageColumns)
    .from(schema.project.missionFixFeatureLineage)
    .where(and(missionProjectScope(schema.project.missionFixFeatureLineage.projectId), eq(schema.project.missionFixFeatureLineage.sourceFeatureId, sourceFeatureId)));
  return rows.map((row) => rowToLineage(row as LineageRow));
}

/** Get lineage rows where the feature is a fix (fixFeatureId match). */
export async function listLineageForFixFeature(handle: QueryHandle, fixFeatureId: string): Promise<MissionFixFeatureLineage[]> {
  const rows = await handle
    .select(lineageColumns)
    .from(schema.project.missionFixFeatureLineage)
    .where(and(missionProjectScope(schema.project.missionFixFeatureLineage.projectId), eq(schema.project.missionFixFeatureLineage.fixFeatureId, fixFeatureId)));
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
      projectId: missionProjectId(),
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
      projectId: missionProjectId(),
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
      projectId: missionProjectId(),
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
      projectId: missionProjectId(),
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
      researchRunId: feature.researchProvenance?.researchRunId ?? null,
      researchFindingId: feature.researchProvenance?.findingId ?? null,
      researchSourceUrls: feature.researchProvenance?.sourceUrls ?? null,
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
      projectId: missionProjectId(),
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
  const conditions = [
    missionProjectScope(schema.project.missionEvents.projectId),
    eq(schema.project.missionEvents.missionId, missionId),
  ];
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
      and(
        eq(schema.project.missionContractAssertions.projectId, schema.project.missionFeatureAssertions.projectId),
        eq(schema.project.missionContractAssertions.id, schema.project.missionFeatureAssertions.assertionId),
      ),
    )
    // FNXC:MissionValidation 2026-07-23-17:20: Ignore legacy milestone links so parent scope cannot re-enter feature grading.
    .where(and(
      missionProjectScope(schema.project.missionFeatureAssertions.projectId),
      eq(schema.project.missionFeatureAssertions.featureId, featureId),
      sql`${schema.project.missionContractAssertions.scope} <> 'milestone'`,
    ))
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
      and(
        eq(schema.project.missionFeatures.projectId, schema.project.missionFeatureAssertions.projectId),
        eq(schema.project.missionFeatures.id, schema.project.missionFeatureAssertions.featureId),
      ),
    )
    .where(and(missionProjectScope(schema.project.missionFeatureAssertions.projectId), eq(schema.project.missionFeatureAssertions.assertionId, assertionId)))
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
        missionProjectScope(schema.project.tasks.projectId),
        inArray(schema.project.tasks.id, taskIds),
        sql`${schema.project.tasks.deletedAt} is null`,
        sql`${schema.project.tasks.column} <> 'archived'`,
      ),
    );
  return new Set(rows.map((row) => row.id));
}

export type TerminalTaskEvidence =
  | { kind: "done"; id: string; column: "done" }
  | { kind: "archived"; id: string; column: "archived" }
  | { kind: "nonterminal"; id: string; column: string }
  | { kind: "invalid-deleted"; id: string; column?: string }
  | { kind: "missing" };

/**
 * FNXC:MissionReconciliation 2026-07-20-08:34:
 * Terminal evidence repair must distinguish a supported archive (the retained archived task tombstone plus its project-scoped cold snapshot) from an arbitrary soft/hard deletion. Read both representations on the caller's transaction handle so validation and feature linkage share one snapshot.
 */
export async function getTerminalTaskEvidence(handle: QueryHandle, taskId: string): Promise<TerminalTaskEvidence> {
  const taskRows = await handle
    .select({
      id: schema.project.tasks.id,
      column: schema.project.tasks.column,
      deletedAt: schema.project.tasks.deletedAt,
    })
    .from(schema.project.tasks)
    .where(and(missionProjectScope(schema.project.tasks.projectId), eq(schema.project.tasks.id, taskId)))
    .limit(1);
  const archiveRows = await handle
    .select({ id: schema.archive.archivedTasks.id })
    .from(schema.archive.archivedTasks)
    .where(and(missionProjectScope(schema.archive.archivedTasks.projectId), eq(schema.archive.archivedTasks.id, taskId)))
    .limit(1);
  const task = taskRows[0];
  const hasArchiveSnapshot = archiveRows.length > 0;

  if (!task) return hasArchiveSnapshot ? { kind: "invalid-deleted", id: taskId } : { kind: "missing" };
  if (task.deletedAt === null && task.column === "done") return { kind: "done", id: task.id, column: "done" };
  if (task.deletedAt !== null && task.column === "archived" && hasArchiveSnapshot) {
    return { kind: "archived", id: task.id, column: "archived" };
  }
  if (task.deletedAt !== null || task.column === "archived") {
    return { kind: "invalid-deleted", id: task.id, column: task.column };
  }
  return { kind: "nonterminal", id: task.id, column: task.column };
}

/** Get a live (non-deleted) task's id + column, or undefined. */
export async function getLiveTaskById(handle: QueryHandle, taskId: string): Promise<{ id: string; column: string } | undefined> {
  const rows = await handle
    .select({ id: schema.project.tasks.id, column: schema.project.tasks.column })
    .from(schema.project.tasks)
    .where(and(missionProjectScope(schema.project.tasks.projectId), eq(schema.project.tasks.id, taskId), sql`${schema.project.tasks.deletedAt} is null`));
  const row = rows[0];
  return row ? { id: row.id, column: row.column as string } : undefined;
}

/** Set a live task's mission/slice linkage (bidirectional link). */
export async function setTaskMissionLinkage(handle: QueryHandle, taskId: string, missionId: string, sliceId: string): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ missionId, sliceId })
    .where(and(missionProjectScope(schema.project.tasks.projectId), eq(schema.project.tasks.id, taskId), sql`${schema.project.tasks.deletedAt} is null`));
}

/** Clear a live task's mission/slice linkage. */
export async function clearTaskMissionLinkage(handle: QueryHandle, taskId: string): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ missionId: null, sliceId: null })
    .where(and(missionProjectScope(schema.project.tasks.projectId), eq(schema.project.tasks.id, taskId), sql`${schema.project.tasks.deletedAt} is null`));
}

/** Set of all failed (non-deleted) task ids — for health rollup. */
export async function listFailedTaskIds(handle: QueryHandle): Promise<Set<string>> {
  const rows = await handle
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(and(
      missionProjectScope(schema.project.tasks.projectId),
      eq(schema.project.tasks.status, "failed"),
      sql`${schema.project.tasks.deletedAt} is null`,
    ));
  return new Set(rows.map((row) => row.id));
}
