/**
 * Event-emitting PostgreSQL MissionStore facade.
 *
 * FNXC:MissionStoreMaintainability 2026-07-14-19:24:
 * The facade owns domain orchestration, concurrency guards, rollups, and live
 * events; reusable SQL and row mapping live in async-mission-store-queries.ts.
 */
import { EventEmitter } from "node:events";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { FEATURE_LOOP_TRANSITIONS, normalizeMissionAssertionType, renderValidationCause } from "../missions/mission-types.js";
import type {
  Mission,
  Milestone,
  Slice,
  MissionFeature,
  MissionValidatorRun,
  MissionAssertionFailureRecord,
  MissionFeatureLoopSnapshot,
  MissionCreateInput,
  MilestoneCreateInput,
  SliceCreateInput,
  FeatureCreateInput,
  ResearchFeatureCreateInput,
  MissionWithHierarchy,
  MissionHealth,
  MissionEvent,
  MissionEventType,
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  InterviewState,
  MissionContractAssertion,
  MissionGoalLink,
  MilestoneValidationState,
  MilestoneValidationRollup,
  ContractAssertionCreateInput,
  ContractAssertionUpdateInput,
  FeatureLoopState,
  ValidationDiagnostics,
  MissionTransitionActor,
  MissionUpdateOptions,
} from "../missions/mission-types.js";
import type { Goal } from "../goals/goal-types.js";
import {
  deriveMilestoneAcceptanceCriteriaFromFeatures,
} from "../missions/mission-store.js";
import type {
  MissionSummary,
  MissionAssertionBackfillReport,
  MissionAssertionTextSource,
  MissionAssertionSeedInput,
  MissionAssertionSeedReport,
  MissionStoreEvents,
} from "../missions/mission-store.js";
import { reconcileDeterministicDuplicate, runDeterministicDuplicateGuard } from "../duplicates/duplicate-guard.js";
import { resolveEntryPointBranchAssignment } from "../branch/branch-assignment.js";


/*
FNXC:MissionStoreMaintainability 2026-07-14-19:24:
The event-emitting facade delegates standalone PostgreSQL queries to a focused module while preserving every existing top-level helper export.
*/
export * from "./async-mission-store-queries.js";
import {
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  missionBranchStrategyDefaults,
  missionProjectId,
  QueryHandle,
  AssertionRow,
  assertionColumns,
  rowToAssertion,
  createMission,
  getMission,
  listMissions,
  updateMission,
  deleteMission,
  missionExists,
  createMilestone,
  getMilestone,
  listMilestones,
  listAllMilestones,
  updateMilestone,
  deleteMilestone,
  reorderMilestones,
  createSlice,
  getSlice,
  listSlices,
  listAllSlices,
  updateSlice,
  deleteSlice,
  reorderSlices,
  createFeature,
  getFeature,
  getFeatureByResearchProvenance,
  listFeaturesByIds,
  listFeatures,
  listFeaturesForMilestone,
  listAllFeatures,
  updateFeature,
  deleteFeature,
  getFeatureByTaskId,
  getConflictingFeatureByTaskId,
  unlinkFeatureFromTaskId,
  getTerminalTaskEvidence,
  getMaxEventSeq,
  insertMissionEvent,
  countMissionEvents,
  countEventsByMission,
  listErrorEventsForHealth,
  getMissionGoalLink,
  insertMissionGoalLink,
  deleteMissionGoalLink,
  listGoalIdsForMission,
  listMissionIdsForGoal,
  countGoalsByMission,
  goalExists,
  listGoalsByIds,
  createContractAssertion,
  getContractAssertion,
  listContractAssertions,
  listLinkedAssertionsForFeatures,
  listLinkedAssertionIds,
  updateContractAssertion,
  deleteContractAssertion,
  reorderContractAssertions,
  featureAssertionLinkExists,
  linkFeatureToAssertion,
  unlinkFeatureFromAssertion,
  createValidatorRun,
  getValidatorRun,
  listValidatorRunsByFeature,
  listStaleRunningValidatorRuns,
  transitionRunningValidatorRun,
  insertValidatorFailures,
  listFailuresForRun,
  listFailuresForRuns,
  listFeatureIdsWithAssertions,
  insertFixFeatureLineage,
  findFixFeatureId,
  findFixFeatureIdsForSource,
  listLineageForSourceFeature,
  listLineageForFixFeature,
  getMissionEventsPage,
  listAssertionsForFeature,
  listFeaturesForAssertion,
  listLiveLinkedTaskIds,
  getLiveTaskById,
  setTaskMissionLinkage,
  clearTaskMissionLinkage,
  listFailedTaskIds,
  recordGeneratedFixOperatorStop,
} from "./async-mission-store-queries.js";

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
// FNXC:PostgresMissionRuntime 2026-07-14-17:15:
// This EventEmitter-backed store provides CRUD, rollups, triage, validator
// execution, generated-fix recovery, goal provenance, and live mutation events;
// engine callers await the backend union instead of gating PostgreSQL behavior.
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
 * Validator-run and generated-fix events are emitted after their PostgreSQL
 * transactions commit, matching the synchronous store's observable contract.
 */
export type TerminalTaskReconciliationErrorCode =
  | "FEATURE_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_TERMINAL"
  | "TASK_ARCHIVE_INVALID"
  | "FEATURE_TASK_CONFLICT"
  | "TASK_FEATURE_CONFLICT";

export class TerminalTaskReconciliationError extends Error {
  constructor(
    public readonly code: TerminalTaskReconciliationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TerminalTaskReconciliationError";
  }
}

/** Typed no-mint result used by the execution loop instead of parsing errors. */
export class MissionRemediationStoppedError extends Error {
  constructor(public readonly reason: "budget-exhausted" | "operator-intervention" | "legacy-unknown-stop") {
    super(`MISSION_REMEDIATION_STOPPED: ${reason}`);
    this.name = "MissionRemediationStoppedError";
  }
}

/** Stable mission-wide conflict payload for the sole explicit lineage-stop resume seam. */
export class MissionResumeConflictError extends Error {
  constructor(public readonly blockers: Array<{ id: string; reason: string }>) {
    super("Mission resume is blocked by non-resumable lineage stops");
    this.name = "MissionResumeConflictError";
  }
}

export class AsyncMissionStore extends EventEmitter<MissionStoreEvents> {
  private idSequence = 0;
  private readonly milestonesMissingStructuredAssertions = new Set<string>();

  constructor(
    private readonly layer: AsyncDataLayer,
    private readonly taskStore?: import("../store.js").TaskStore,
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
  /* FNXC:Ideation 2026-07-30-15:30: Accept a caller transaction so ideation convergence and canonical Mission creation commit or roll back together. */
  async createMission(input: MissionCreateInput & { autopilotEnabled?: boolean }, handle: QueryHandle = this.db): Promise<Mission> {
    const now = new Date().toISOString();
    const mission = await createMission(handle, {
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

  /**
   * FNXC:MissionAutonomyAudit 2026-07-23-14:20:
   * A status or `autopilotEnabled` change can arm autonomous remediation.
   * Persist its before/after audit event in the same PostgreSQL transaction as
   * the mutation; callers that predate attribution receive a conservative
   * system identity instead of silently creating an unaudited transition.
   */
  async updateMission(id: string, updates: Partial<Mission>, options: MissionUpdateOptions = {}): Promise<Mission> {
    const actor: MissionTransitionActor = options.actor ?? {
      type: "system",
      id: "mission-store",
      displayName: "Mission store",
      source: "mission-store",
    };
    const { updated, events } = await this.layer.transactionImmediate(async (tx) => {
      const mission = await getMission(tx, id);
      if (!mission) throw new Error(`Mission ${id} not found`);
      const updated: Mission = {
        ...mission,
        ...updates,
        id,
        createdAt: mission.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const transitions: Array<{ eventType: MissionEventType; description: string; metadata: Record<string, unknown> }> = [];
      if (mission.status !== updated.status) {
        transitions.push({
          eventType: "mission_status_changed",
          description: `Mission status changed from ${mission.status} to ${updated.status}`,
          metadata: { source: actor.source, actor, field: "status", from: mission.status, to: updated.status },
        });
      }
      // FNXC:MissionAutonomyAudit 2026-07-23-14:20: Legacy rows may omit this
      // flag; undefined and false are the same disabled autonomy state and must
      // not fabricate a transition event when a caller normalizes storage.
      const wasAutopilotEnabled = mission.autopilotEnabled === true;
      const isAutopilotEnabled = updated.autopilotEnabled === true;
      if (wasAutopilotEnabled !== isAutopilotEnabled) {
        transitions.push({
          eventType: isAutopilotEnabled ? "autopilot_enabled" : "autopilot_disabled",
          description: `Autopilot ${isAutopilotEnabled ? "enabled" : "disabled"}`,
          metadata: { source: actor.source, actor, field: "autopilotEnabled", from: wasAutopilotEnabled, to: isAutopilotEnabled },
        });
      }
      await updateMission(tx, updated);
      if (transitions.length === 0) return { updated, events: [] as MissionEvent[] };
      let seq = await getMaxEventSeq(tx);
      const events = await Promise.all(transitions.map(async (transition) => {
        const event: MissionEvent = {
          id: this.generateId("ME"), missionId: id, eventType: transition.eventType,
          description: transition.description, metadata: transition.metadata,
          timestamp: new Date().toISOString(), seq: ++seq,
        };
        await insertMissionEvent(tx, event);
        return event;
      }));
      return { updated, events };
    });
    this.emit("mission:updated", updated);
    for (const event of events) this.emit("mission:event", event);
    return updated;
  }

  async deleteMission(id: string): Promise<void> {
    const mission = await getMission(this.db, id);
    if (!mission) throw new Error(`Mission ${id} not found`);
    const features: MissionFeature[] = [];
    for (const milestone of await listMilestones(this.db, id)) {
      for (const slice of await listSlices(this.db, milestone.id)) features.push(...await listFeatures(this.db, slice.id));
    }
    await this.layer.transactionImmediate(async (tx) => {
      /* FNXC:MissionLineageBudget 2026-07-22-14:55: Mission-level cascades retain generated-fix stops even though every hierarchy row is about to disappear. */
      for (const feature of features) {
        if (feature.generatedFromFeatureId) await recordGeneratedFixOperatorStop(tx, feature, "feature-delete");
      }
      await deleteMission(tx, id);
    });
    this.emit("mission:deleted", id);
  }

  /**
   * FNXC:MissionLineageBudget 2026-07-22-12:00:
   * Resume is the only seam that clears operator intervention. Classify every
   * stopped root before mutating so a budget or unknown legacy root cannot
   * partially reactivate a mission.
   */
  async resumeMission(id: string): Promise<Mission> {
    const result = await this.layer.transactionImmediate(async (tx) => {
      const mission = await getMission(tx, id);
      if (!mission) throw new Error(`Mission ${id} not found`);
      const allFeatures = await listAllFeatures(tx);
      const featureMission = new Map<string, string>();
      for (const feature of allFeatures) {
        const slice = await getSlice(tx, feature.sliceId);
        const milestone = slice ? await getMilestone(tx, slice.milestoneId) : undefined;
        if (milestone) featureMission.set(feature.id, milestone.missionId);
      }
      const stops = await tx.select().from(schema.project.missionLineageStops)
        .where(and(eq(schema.project.missionLineageStops.projectId, missionProjectId()), eq(schema.project.missionLineageStops.missionId, id))).for("update");
      const roots = allFeatures.filter((feature) => featureMission.get(feature.id) === id && !feature.generatedFromFeatureId && feature.loopState === "blocked");
      const stopIds = new Set(stops.map((stop) => stop.rootFeatureId));
      const blockers = roots.filter((root) => root.implementationStopReason !== "operator-intervention")
        .map((root) => ({ id: root.id, reason: root.implementationStopReason ?? "legacy-unknown-stop" }));
      for (const stop of stops) if (stop.reason !== "operator-intervention") blockers.push({ id: stop.rootFeatureId, reason: stop.reason });
      if (blockers.length > 0) {
        const stable = blockers.sort((a, b) => a.id.localeCompare(b.id));
        throw new MissionResumeConflictError(stable);
      }
      for (const root of roots) {
        if (root.implementationStopReason === "operator-intervention" || stopIds.has(root.id)) {
          await updateFeature(tx, { ...root, loopState: "needs_fix", implementationStopReason: undefined, implementationStoppedAt: undefined, implementationStopOrigin: undefined, updatedAt: new Date().toISOString() });
        }
      }
      if (stops.length > 0) await tx.delete(schema.project.missionLineageStops).where(and(eq(schema.project.missionLineageStops.projectId, missionProjectId()), eq(schema.project.missionLineageStops.missionId, id)));
      const updated = { ...mission, status: "active" as MissionStatus, updatedAt: new Date().toISOString() };
      await updateMission(tx, updated);
      return updated;
    });
    this.emit("mission:updated", result);
    return result;
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

  async listGoalIdsForTask(taskId: string): Promise<string[]> {
    const feature = await getFeatureByTaskId(this.db, taskId);
    let missionId: string | undefined;
    if (feature) {
      const slice = await getSlice(this.db, feature.sliceId);
      const milestone = slice ? await getMilestone(this.db, slice.milestoneId) : undefined;
      missionId = milestone?.missionId;
    }
    if (!missionId) {
      const rows = await this.db
        .select({ missionId: schema.project.tasks.missionId })
        .from(schema.project.tasks)
        .where(and(eq(schema.project.tasks.id, taskId), sql`${schema.project.tasks.deletedAt} IS NULL`))
        .limit(1);
      missionId = rows[0]?.missionId ?? undefined;
    }
    return missionId ? this.listGoalIdsForMission(missionId) : [];
  }

  async listGoalsForTask(taskId: string): Promise<Goal[]> {
    return listGoalsByIds(this.db, await this.listGoalIdsForTask(taskId));
  }

  // ════════════════ MILESTONE OPS ════════════════
  async addMilestone(missionId: string, input: MilestoneCreateInput, handle: QueryHandle = this.db): Promise<Milestone> {
    const mission = await getMission(handle, missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);
    const now = new Date().toISOString();
    const existing = await listMilestones(handle, missionId);
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
    const created = await createMilestone(handle, milestone);
    this.emit("milestone:created", created);
    await this.synchronizeMilestoneAcceptanceAssertion(created);
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
    if (updates.acceptanceCriteria !== undefined) {
      await this.synchronizeMilestoneAcceptanceAssertion(updated);
    }
    await this.recomputeMissionStatus(updated.missionId);
    return updated;
  }

  /*
  FNXC:MissionValidation 2026-07-23-14:30:
  Acceptance prose has exactly one store-managed milestone assertion selected by
  durable origin. Authored/imported rows are never selected by text or title and
  survive criteria edits/removal unchanged.
  */
  private async synchronizeMilestoneAcceptanceAssertion(milestone: Milestone): Promise<void> {
    const existing = (await listContractAssertions(this.db, milestone.id))
      .find((assertion) => assertion.origin === "derived_milestone_acceptance");
    const criteria = milestone.acceptanceCriteria?.trim();
    if (!criteria) {
      if (existing) await this.deleteContractAssertion(existing.id);
      return;
    }
    if (!existing) {
      await this.addContractAssertion(milestone.id, {
        title: "Milestone acceptance criteria",
        assertion: criteria,
        scope: "milestone",
        origin: "derived_milestone_acceptance",
      });
      return;
    }
    if (existing.assertion !== criteria) {
      await this.updateContractAssertion(existing.id, {
        title: "Milestone acceptance criteria",
        assertion: criteria,
        status: "pending",
      });
    }
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
    await this.layer.transactionImmediate(async (tx) => {
      /* FNXC:MissionLineageBudget 2026-07-22-14:50: Cascade deletion records every generated descendant's root stop before FK cascades erase lineage. */
      for (const feature of features) {
        if (feature.generatedFromFeatureId) await recordGeneratedFixOperatorStop(tx, feature, "feature-delete");
      }
      if (force) {
        for (const link of blockingLinks) {
          await unlinkFeatureFromTaskId(tx, link.featureId);
          await clearTaskMissionLinkage(tx, link.taskId);
        }
      }
      await deleteMilestone(tx, id);
    });
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
  async addSlice(milestoneId: string, input: SliceCreateInput, handle: QueryHandle = this.db): Promise<Slice> {
    const milestone = await getMilestone(handle, milestoneId);
    if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);
    const now = new Date().toISOString();
    const existing = await listSlices(handle, milestoneId);
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
    const created = await createSlice(handle, slice);
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
    await this.layer.transactionImmediate(async (tx) => {
      /* FNXC:MissionLineageBudget 2026-07-22-14:50: Cascade deletion records every generated descendant's root stop before FK cascades erase lineage. */
      for (const feature of features) {
        if (feature.generatedFromFeatureId) await recordGeneratedFixOperatorStop(tx, feature, "feature-delete");
      }
      if (force) {
        for (const link of blockingLinks) {
          await unlinkFeatureFromTaskId(tx, link.featureId);
          await clearTaskMissionLinkage(tx, link.taskId);
        }
      }
      await deleteSlice(tx, id);
    });
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
  async addFeature(sliceId: string, input: FeatureCreateInput, handle: QueryHandle = this.db): Promise<MissionFeature> {
    const slice = await getSlice(handle, sliceId);
    if (!slice) throw new Error(`Slice ${sliceId} not found`);
    const now = new Date().toISOString();
    const feature: MissionFeature = {
      id: this.generateId("F"),
      sliceId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      researchProvenance: (input as Partial<ResearchFeatureCreateInput>).researchProvenance,
      status: "defined",
      createdAt: now,
      updatedAt: now,
      loopState: "idle",
      implementationAttemptCount: 0,
      validatorAttemptCount: 0,
    };
    const created = await createFeature(handle, feature);
    this.emit("feature:created", created);
    await this.recomputeSliceStatus(sliceId);
    await this.applyDerivedMilestoneAcceptanceCriteria(slice.milestoneId);
    await this.ensureFeatureAssertion(feature);
    return (await getFeature(this.db, feature.id)) ?? feature;
  }

  /**
   * FNXC:ResearchMissionBridge 2026-07-18-12:00:
   * Research promotion creates canonical features through this facade and
   * reuses a project/slice/run/finding match before writing. The composite
   * database index is the concurrent retry backstop for this invariant.
   */
  async addResearchFeature(sliceId: string, input: ResearchFeatureCreateInput): Promise<{ feature: MissionFeature; reused: boolean }> {
    const existing = await getFeatureByResearchProvenance(this.db, sliceId, input.researchProvenance.researchRunId, input.researchProvenance.findingId);
    if (existing) return { feature: existing, reused: true };
    const feature = await this.addFeature(sliceId, input);
    return { feature, reused: false };
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
    await this.layer.transactionImmediate(async (tx) => {
      /*
      FNXC:MissionLineageBudget 2026-07-22-14:45:
      Feature removal and its durable intervention record share one transaction.
      Force-unlinking and assertion cleanup therefore cannot leave a deletion
      committed after the generated-fix ancestry has been discarded.
      */
      if (feature.generatedFromFeatureId) await recordGeneratedFixOperatorStop(tx, feature, "feature-delete");
      if (force && feature.taskId) {
        await unlinkFeatureFromTaskId(tx, id);
        await clearTaskMissionLinkage(tx, feature.taskId);
      }
      if (milestoneId) {
        const managed = (await listContractAssertions(tx, milestoneId)).find((a) => a.sourceFeatureId === feature.id);
        if (managed) await deleteContractAssertion(tx, managed.id);
      }
      await deleteFeature(tx, id);
    });
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

  /**
   * FNXC:MissionReconciliation 2026-07-20-08:34:
   * Shipped-delivery repair is a dedicated transaction, not ordinary feature linking. It accepts only a live done row or the supported retained archived tombstone+cold snapshot, preserves conflict guards, leaves loop attempts and mission run controls untouched, and updates only the live task backlink because archived evidence must never be resurrected.
   */
  async reconcileFeatureDoneWithTerminalTask(featureId: string, taskId: string): Promise<MissionFeature> {
    const outcome = await this.layer.transactionImmediate(async (tx) => {
      const feature = await getFeature(tx, featureId);
      if (!feature) {
        throw new TerminalTaskReconciliationError("FEATURE_NOT_FOUND", `Feature ${featureId} not found`);
      }
      if (feature.taskId && feature.taskId !== taskId) {
        throw new TerminalTaskReconciliationError(
          "FEATURE_TASK_CONFLICT",
          `Feature ${featureId} is already linked to ${feature.taskId}; cannot reconcile against ${taskId}`,
        );
      }

      const evidence = await getTerminalTaskEvidence(tx, taskId);
      if (evidence.kind === "missing") {
        throw new TerminalTaskReconciliationError("TASK_NOT_FOUND", `Delivery task ${taskId} not found`);
      }
      if (evidence.kind === "nonterminal") {
        throw new TerminalTaskReconciliationError(
          "TASK_NOT_TERMINAL",
          `Delivery task ${taskId} must be in done or supported archived state, not ${evidence.column}`,
        );
      }
      if (evidence.kind === "invalid-deleted") {
        throw new TerminalTaskReconciliationError(
          "TASK_ARCHIVE_INVALID",
          `Delivery task ${taskId} is deleted or archived without a valid retained tombstone and archive snapshot`,
        );
      }

      const taskFeature = await getConflictingFeatureByTaskId(tx, taskId, featureId);
      if (taskFeature) {
        throw new TerminalTaskReconciliationError(
          "TASK_FEATURE_CONFLICT",
          `Delivery task ${taskId} is already linked to feature ${taskFeature.id}`,
        );
      }

      const slice = await getSlice(tx, feature.sliceId);
      if (!slice) throw new TerminalTaskReconciliationError("FEATURE_NOT_FOUND", `Slice ${feature.sliceId} not found`);
      const milestone = await getMilestone(tx, slice.milestoneId);
      if (!milestone) throw new TerminalTaskReconciliationError("FEATURE_NOT_FOUND", `Milestone ${slice.milestoneId} not found`);
      const mission = await getMission(tx, milestone.missionId);
      if (!mission) throw new TerminalTaskReconciliationError("FEATURE_NOT_FOUND", `Mission ${milestone.missionId} not found`);

      const now = new Date().toISOString();
      const featureChanged = feature.taskId !== taskId || feature.status !== "done";
      const reconciledFeature: MissionFeature = featureChanged
        ? { ...feature, taskId, status: "done", updatedAt: now }
        : feature;
      if (featureChanged) await updateFeature(tx, reconciledFeature);

      if (evidence.kind === "done") {
        await setTaskMissionLinkage(tx, taskId, mission.id, slice.id);
      }

      const sliceStatus = await this.computeSliceStatusWithHandle(tx, slice.id);
      const reconciledSlice = slice.status === sliceStatus ? slice : { ...slice, status: sliceStatus, updatedAt: now };
      if (reconciledSlice !== slice) await updateSlice(tx, reconciledSlice);

      const milestoneStatus = await this.computeMilestoneStatusWithHandle(tx, milestone.id);
      const reconciledMilestone = milestone.status === milestoneStatus
        ? milestone
        : { ...milestone, status: milestoneStatus, updatedAt: now };
      if (reconciledMilestone !== milestone) await updateMilestone(tx, reconciledMilestone);

      return {
        feature: reconciledFeature,
        featureChanged,
        linked: feature.taskId !== taskId,
        slice: reconciledSlice !== slice ? reconciledSlice : undefined,
        milestone: reconciledMilestone !== milestone ? reconciledMilestone : undefined,
      };
    });

    if (outcome.featureChanged) this.emit("feature:updated", outcome.feature);
    if (outcome.linked) this.emit("feature:linked", { feature: outcome.feature, taskId });
    if (outcome.slice) this.emit("slice:updated", outcome.slice);
    if (outcome.milestone) this.emit("milestone:updated", outcome.milestone);
    return outcome.feature;
  }

  /**
   * Atomically claim a hand-authored defined feature for a task already inserted
   * in the caller's transaction. This is intentionally narrower than
   * linkFeatureToTask(): existing manual links may establish task lineage,
   * whereas a duplicate bootstrap canonical must already prove this lineage.
   */
  async claimDefinedFeatureTaskInTransaction(
    tx: import("../postgres/data-layer.js").DbTransaction,
    input: { featureId: string; taskId: string; missionId: string; sliceId: string; requireExistingFeatureLink?: boolean },
  ): Promise<MissionFeature> {
    /*
    FNXC:MissionAdmission 2026-07-23-15:30:
    Defined is creation-admissible only at the first-task claim boundary. Check
    the project-scoped task's existing lineage before updating either record so
    a deterministic duplicate from another mission can never be repurposed.
    */
    /*
    FNXC:MissionAdmission 2026-08-10-00:00:
    Concurrent bootstrap requests must serialize on the defined Feature before
    either inserts its task. READ COMMITTED alone permits both readers to claim
    it; this row lock makes the second request re-read the committed taskId and
    reject, preserving one exclusive first-task claim.
    */
    const lockedFeatures = await tx
      .select({ id: schema.project.missionFeatures.id })
      .from(schema.project.missionFeatures)
      .where(eq(schema.project.missionFeatures.id, input.featureId))
      .for("update");
    if (lockedFeatures.length === 0) throw new Error(`Feature ${input.featureId} not found`);
    const feature = await getFeature(tx, input.featureId);
    if (!feature) throw new Error(`Feature ${input.featureId} not found`);
    if (feature.sliceId !== input.sliceId) throw new Error(`Feature ${input.featureId} does not belong to slice ${input.sliceId}`);
    if (feature.taskId && feature.taskId !== input.taskId) {
      throw new Error(`Feature ${input.featureId} is already linked to task ${feature.taskId}`);
    }
    if (feature.status !== "defined" && feature.taskId !== input.taskId) {
      throw new Error(`Feature ${input.featureId} is not available for first-task bootstrap`);
    }
    /*
    FNXC:MissionAdmission 2026-07-23-17:20:
    A duplicate canonical was not inserted in this transaction. It may be
    reused only after this feature already owns it; allowing an arbitrary
    unlinked task from the same slice would silently assign another feature's
    work to this bootstrap request.
    */
    if (input.requireExistingFeatureLink === true && feature.taskId !== input.taskId) {
      throw new Error(`Cannot bootstrap feature ${input.featureId}: pre-existing task ${input.taskId} is not linked to this feature`);
    }

    const projectId = this.layer.projectId;
    if (!projectId) throw new Error("Defined-feature bootstrap requires a project-scoped data layer");
    const taskRows = await tx
      .select({ id: schema.project.tasks.id, missionId: schema.project.tasks.missionId, sliceId: schema.project.tasks.sliceId, column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectId),
        eq(schema.project.tasks.id, input.taskId),
        sql`${schema.project.tasks.deletedAt} is null`,
      ));
    const task = taskRows[0];
    if (!task || task.column === "archived") {
      throw new Error(`Cannot bootstrap feature ${input.featureId}: task ${input.taskId} is not active in this project`);
    }
    if (task.missionId !== input.missionId || task.sliceId !== input.sliceId) {
      throw new Error(`Cannot bootstrap feature ${input.featureId}: task ${input.taskId} has unrelated mission lineage`);
    }
    const conflict = await getConflictingFeatureByTaskId(tx, input.taskId, input.featureId);
    if (conflict) throw new Error(`Task ${input.taskId} is already linked to feature ${conflict.id}`);

    const now = new Date().toISOString();
    const shouldTransitionLoop = !feature.loopState || feature.loopState === "idle";
    const updated: MissionFeature = {
      ...feature,
      taskId: input.taskId,
      status: "triaged",
      ...(shouldTransitionLoop ? { loopState: "implementing", implementationAttemptCount: 1 } : {}),
      updatedAt: now,
    };
    await updateFeature(tx, updated);
    // The inserted task already carries this verified linkage; retain this write
    // for retry parity when the same canonical is claimed again.
    await setTaskMissionLinkage(tx, input.taskId, input.missionId, input.sliceId);
    return updated;
  }

  async claimDefinedFeatureTask(input: { featureId: string; taskId: string; missionId: string; sliceId: string }): Promise<MissionFeature> {
    const feature = await this.layer.transactionImmediate((tx) => this.claimDefinedFeatureTaskInTransaction(tx, { ...input, requireExistingFeatureLink: true }));
    this.emit("feature:updated", feature);
    this.emit("feature:linked", { feature, taskId: input.taskId });
    await this.recomputeSliceStatus(feature.sliceId);
    return feature;
  }

  /**
   * Keep the task that atomically claimed a defined Feature as the sole live
   * deterministic-duplicate canonical. This compensates for a duplicate that
   * became visible only after the create preflight, without ever allowing the
   * generic intake path to archive feature.taskId.
   */
  async archiveDefinedFeatureBootstrapDuplicate(input: { featureId: string; taskId: string; duplicateTaskId: string }): Promise<void> {
    /*
    FNXC:MissionAdmission 2026-07-23-21:10:
    Project-agnostic legacy stores remain scoped to their reserved RLS
    partition, so reconciliation never falls back to an unscoped task ID.
    */
    const projectId = this.layer.projectId || "__legacy_unscoped__";
    await this.layer.transactionImmediate(async (tx) => {
      /*
      FNXC:MissionAdmission 2026-07-23-20:00:
      A late deterministic duplicate must not reverse the first-task claim and
      archive feature.taskId. Verify that the feature still owns the claimed,
      project-scoped live task, then archive only the competing live task in
      this transaction. `defined` remains scheduler-ineligible throughout.
      */
      const feature = await getFeature(tx, input.featureId);
      if (!feature || feature.taskId !== input.taskId || feature.status !== "triaged") {
        throw new Error(`Cannot reconcile defined-feature bootstrap duplicate for ${input.featureId}`);
      }
      const claimed = await tx.select({ id: schema.project.tasks.id })
        .from(schema.project.tasks)
        .where(and(
          eq(schema.project.tasks.projectId, projectId),
          eq(schema.project.tasks.id, input.taskId),
          sql`${schema.project.tasks.deletedAt} is null`,
          sql`${schema.project.tasks.column} <> 'archived'`,
        ));
      if (!claimed[0]) throw new Error(`Cannot reconcile defined-feature bootstrap duplicate: claimed task ${input.taskId} is not live`);
      /*
      FNXC:MissionAdmission 2026-07-23-21:10:
      Fingerprint equality does not make work interchangeable across Features.
      A late sibling already claimed by another Feature remains live; archiving
      it here would corrupt that Feature's canonical task. Keep both tasks and
      let each feature retain its own transactional bootstrap claim.
      */
      const duplicateFeature = await getConflictingFeatureByTaskId(tx, input.duplicateTaskId, input.featureId);
      if (duplicateFeature) return;
      await tx.update(schema.project.tasks)
        .set({ column: "archived", updatedAt: new Date().toISOString() })
        .where(and(
          eq(schema.project.tasks.projectId, projectId),
          eq(schema.project.tasks.id, input.duplicateTaskId),
          sql`${schema.project.tasks.deletedAt} is null`,
          sql`${schema.project.tasks.column} <> 'archived'`,
        ));
    });
  }

  async linkFeatureToTask(featureId: string, taskId: string): Promise<MissionFeature> {
    /*
    FNXC:MissionAdmission 2026-07-23-12:00:
    First-task bootstrap must claim the feature, promote it, and backlink the
    exact project-scoped task as one transaction. Never overwrite a feature's
    existing taskId: retries may reuse only that same canonical task.
    */
    const outcome = await this.layer.transactionImmediate(async (tx) => {
      const feature = await getFeature(tx, featureId);
      if (!feature) throw new Error(`Feature ${featureId} not found`);
      if (feature.taskId && feature.taskId !== taskId) {
        throw new Error(`Feature ${featureId} is already linked to task ${feature.taskId}`);
      }
      const liveTask = await getLiveTaskById(tx, taskId);
      if (!liveTask) {
        throw new Error(
          `Cannot link feature ${featureId} to task ${taskId}: task is not on the active board (it may be archived, deleted, or never existed). Only active tasks can be linked to features.`,
        );
      }
      const conflictingFeature = await getConflictingFeatureByTaskId(tx, taskId, featureId);
      if (conflictingFeature) {
        throw new Error(`Task ${taskId} is already linked to feature ${conflictingFeature.id}`);
      }
      const slice = await getSlice(tx, feature.sliceId);
      const milestone = slice ? await getMilestone(tx, slice.milestoneId) : undefined;
      if (!slice || !milestone) throw new Error(`Feature ${featureId} has incomplete mission hierarchy`);
      const shouldTransitionLoop = !feature.loopState || feature.loopState === "idle";
      const now = new Date().toISOString();
      const updated: MissionFeature = {
        ...feature,
        taskId,
        status: "triaged",
        ...(shouldTransitionLoop ? { loopState: "implementing", implementationAttemptCount: 1 } : {}),
        updatedAt: now,
      };
      await updateFeature(tx, updated);
      await setTaskMissionLinkage(tx, taskId, milestone.missionId, slice.id);
      return updated;
    });
    this.emit("feature:updated", outcome);
    this.emit("feature:linked", { feature: outcome, taskId });
    await this.recomputeSliceStatus(outcome.sliceId);
    return outcome;
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

  async completeValidatorRun(
    runId: string,
    result: "passed" | "failed" | "blocked" | "error",
    summary?: string,
    blockedReason?: string,
  ): Promise<MissionValidatorRun> {
    const run = await getValidatorRun(this.db, runId);
    if (!run) throw new Error(`Validator run ${runId} not found`);
    if (run.status !== "running") throw new Error(`Validator run ${runId} is not in 'running' status`);
    const feature = await getFeature(this.db, run.featureId);
    if (!feature) throw new Error(`Feature ${run.featureId} not found`);
    const now = new Date().toISOString();
    const loopState: FeatureLoopState = result === "passed" ? "passed" : result === "failed" ? "needs_fix" : result === "blocked" ? "blocked" : "validating";
    const updatedRun: MissionValidatorRun = { ...run, status: result, summary, blockedReason, completedAt: now, updatedAt: now };
    const won = await this.layer.transactionImmediate(async (tx) => {
      const winner = await transitionRunningValidatorRun(tx, updatedRun);
      if (!winner) return false;
      await updateFeature(tx, { ...feature, loopState, lastValidatorStatus: result, updatedAt: now });
      return true;
    });
    if (!won) return (await getValidatorRun(this.db, runId)) ?? updatedRun;
    const updatedFeature = await getFeature(this.db, feature.id);
    if (updatedFeature) this.emit("feature:updated", updatedFeature);
    await this.recomputeSliceStatus(feature.sliceId);
    const durationMs = Math.max(0, Date.parse(now) - Date.parse(run.startedAt));
    this.emit("validator-run:completed", updatedRun, result, durationMs);
    if (result === "passed") await this.reconcileSupersededGeneratedFixFeatures(feature.sliceId);
    return updatedRun;
  }

  async recordValidatorFailures(
    runId: string,
    failures: Array<{ featureId: string; assertionId: string; message?: string; expected?: string; actual?: string }>,
  ): Promise<MissionAssertionFailureRecord[]> {
    if (!(await getValidatorRun(this.db, runId))) throw new Error(`Validator run ${runId} not found`);
    const records = failures.map((failure) => ({
      ...failure,
      id: this.generateId("VF"),
      runId,
      createdAt: new Date().toISOString(),
    }));
    await this.layer.transactionImmediate(async (tx) => {
      /*
      FNXC:PostgresMissionValidatorFailures 2026-07-14-17:55:
      One validator result is one durable observation batch. Persist every assertion failure with one INSERT statement so run cost does not scale by one database round trip per failed assertion.
      */
      await insertValidatorFailures(tx, records);
    });
    return records;
  }

  async listStaleRunningValidatorRuns(maxAgeMs: number, now = Date.now()): Promise<MissionValidatorRun[]> {
    return listStaleRunningValidatorRuns(this.db, new Date(now - maxAgeMs).toISOString());
  }

  async reapValidatorRun(runId: string, reason: string): Promise<MissionValidatorRun> {
    const run = await getValidatorRun(this.db, runId);
    if (!run) throw new Error(`Validator run ${runId} not found`);
    if (run.status !== "running") return run;
    const feature = await getFeature(this.db, run.featureId);
    if (!feature) throw new Error(`Feature ${run.featureId} not found`);
    const slice = await getSlice(this.db, feature.sliceId);
    const milestone = slice ? await getMilestone(this.db, slice.milestoneId) : undefined;
    const mission = milestone ? await getMission(this.db, milestone.missionId) : undefined;
    if (!slice) throw new Error(`Slice ${feature.sliceId} not found`);
    if (!milestone) throw new Error(`Milestone ${slice.milestoneId} not found`);
    if (!mission) throw new Error(`Mission ${milestone.missionId} not found`);
    const now = new Date().toISOString();
    const updatedRun: MissionValidatorRun = { ...run, status: "error", summary: reason, completedAt: now, updatedAt: now };
    const shouldUpdateFeature = mission.status !== "archived" && mission.status !== "complete" && feature.status !== "done";
    const won = await this.layer.transactionImmediate(async (tx) => {
      const winner = await transitionRunningValidatorRun(tx, updatedRun);
      if (!winner) return false;
      if (shouldUpdateFeature) await updateFeature(tx, { ...feature, loopState: "needs_fix", lastValidatorStatus: "error", updatedAt: now });
      return true;
    });
    if (!won) return (await getValidatorRun(this.db, runId)) ?? updatedRun;
    if (shouldUpdateFeature) {
      const updatedFeature = await getFeature(this.db, feature.id);
      if (updatedFeature) this.emit("feature:updated", updatedFeature);
      await this.recomputeSliceStatus(feature.sliceId);
    }
    this.emit("validator-run:completed", updatedRun, "error", Math.max(0, Date.parse(now) - Date.parse(run.startedAt)));
    return updatedRun;
  }

  async findGeneratedFixFeature(sourceFeatureId: string, runId: string): Promise<MissionFeature | undefined> {
    const id = await findFixFeatureId(this.db, sourceFeatureId, runId);
    return id ? getFeature(this.db, id) : undefined;
  }

  async findOpenGeneratedFixFeature(sourceFeatureId: string): Promise<MissionFeature | undefined> {
    const ids = await findFixFeatureIdsForSource(this.db, sourceFeatureId);
    const featuresById = new Map((await listFeaturesByIds(this.db, ids)).map((feature) => [feature.id, feature]));
    return ids.map((id) => featuresById.get(id)).find((feature) => feature && feature.status !== "done" && feature.status !== "blocked");
  }

  /**
   * FNXC:MissionLineageBudget 2026-07-22-12:00:
   * A generated fix is never a new budget owner. Resolve its parent chain while
   * the caller transaction is open; missing or cyclic evidence fails closed.
   */
  private async resolveFixRoot(handle: QueryHandle, feature: MissionFeature): Promise<MissionFeature> {
    const seen = new Set<string>();
    let current = feature;
    while (current.generatedFromFeatureId) {
      if (seen.has(current.id)) throw new Error("MISSION_LINEAGE_UNRESOLVED: cyclic generated-fix lineage");
      seen.add(current.id);
      const parent = await getFeature(handle, current.generatedFromFeatureId);
      if (!parent) throw new Error("MISSION_LINEAGE_UNRESOLVED: missing generated-fix ancestor");
      current = parent;
    }
    if (seen.has(current.id)) throw new Error("MISSION_LINEAGE_UNRESOLVED: cyclic generated-fix lineage");
    return current;
  }

  private async getRootStop(handle: QueryHandle, rootFeatureId: string) {
    const rows = await handle.select().from(schema.project.missionLineageStops)
      .where(and(eq(schema.project.missionLineageStops.projectId, missionProjectId()), eq(schema.project.missionLineageStops.rootFeatureId, rootFeatureId)));
    return rows[0];
  }

  async createGeneratedFixFeature(
    sourceFeatureId: string,
    runId: string,
    failedAssertionIds: string[],
    failureReason?: string,
    title?: string,
    diagnostics?: ValidationDiagnostics,
  ): Promise<MissionFeature> {
    const run = await getValidatorRun(this.db, runId);
    if (!run) throw new Error(`Validator run ${runId} not found`);
    if (run.featureId !== sourceFeatureId) throw new Error(`Validator run ${runId} belongs to feature ${run.featureId}, expected ${sourceFeatureId}`);
    const now = new Date().toISOString();
    const reasonText = failureReason?.trim();
    // FNXC:MissionValidationDiagnostics 2026-07-23-12:00: PostgreSQL remediation uses the identical shared cause renderer as SQLite to prevent backend-specific operator diagnostics.
    const causeText = diagnostics ? renderValidationCause(diagnostics) : undefined;
    /*
    FNXC:MissionFixIdempotency 2026-07-14-18:45:
    Generated remediation is one source/run operation. Lock the source feature, re-check lineage/open fixes under that lock, and increment the retry counter in the same transaction so concurrent validator workers cannot create duplicates or consume two attempts.
    */
    const outcome = await this.layer.transactionImmediate(async (tx): Promise<
      | { kind: "existing"; feature: MissionFeature }
      | { kind: "created"; feature: MissionFeature }
      | { kind: "exhausted" }
      | { kind: "stopped"; reason: string }
    > => {
      const locked = await tx
        .select({ id: schema.project.missionFeatures.id })
        .from(schema.project.missionFeatures)
        .where(and(
          eq(schema.project.missionFeatures.projectId, missionProjectId()),
          eq(schema.project.missionFeatures.id, sourceFeatureId),
        ))
        .for("update");
      if (locked.length === 0) throw new Error(`Feature ${sourceFeatureId} not found`);
      const source = await getFeature(tx, sourceFeatureId);
      if (!source) throw new Error(`Feature ${sourceFeatureId} not found`);
      const root = await this.resolveFixRoot(tx, source);
      // Lock the canonical owner, not the generated child that happened to fail.
      const rootLocked = await tx.select({ id: schema.project.missionFeatures.id }).from(schema.project.missionFeatures)
        .where(and(
          eq(schema.project.missionFeatures.projectId, missionProjectId()),
          eq(schema.project.missionFeatures.id, root.id),
        )).for("update");
      if (rootLocked.length !== 1) throw new Error("MISSION_LINEAGE_UNRESOLVED: canonical root disappeared");
      const lockedRoot = await getFeature(tx, root.id);
      if (!lockedRoot) throw new Error("MISSION_LINEAGE_UNRESOLVED: canonical root disappeared");
      const durableStop = await this.getRootStop(tx, root.id);
      if (durableStop) return { kind: "stopped", reason: durableStop.reason };
      if (lockedRoot.loopState === "blocked") {
        return { kind: "stopped", reason: lockedRoot.implementationStopReason ?? "legacy-unknown-stop" };
      }

      const exactId = await findFixFeatureId(tx, sourceFeatureId, runId);
      if (exactId) {
        const exact = await getFeature(tx, exactId);
        if (exact) return { kind: "existing", feature: exact };
      }
      const openIds = await findFixFeatureIdsForSource(tx, sourceFeatureId);
      const openFeatures = await listFeaturesByIds(tx, openIds);
      const open = openFeatures.find((candidate) => candidate.status !== "done" && candidate.status !== "blocked");
      if (open) return { kind: "existing", feature: open };

      if ((lockedRoot.implementationAttemptCount ?? 0) >= DEFAULT_IMPLEMENTATION_RETRY_BUDGET) {
        await updateFeature(tx, {
          ...lockedRoot,
          loopState: "blocked",
          implementationStopReason: "budget-exhausted",
          implementationStoppedAt: now,
          implementationStopOrigin: "retry-budget",
          updatedAt: now,
        });
        return { kind: "exhausted" };
      }

      const feature: MissionFeature = {
        id: this.generateId("F"),
        sliceId: source.sliceId,
        title: title ?? `Fix: ${source.title}`,
        description: [source.description, causeText ?? (reasonText ? `## Verification failure detail\n${reasonText}` : undefined)].filter(Boolean).join("\n\n") || undefined,
        acceptanceCriteria: source.acceptanceCriteria,
        status: "defined",
        createdAt: now,
        updatedAt: now,
        loopState: "idle",
        implementationAttemptCount: 0,
        validatorAttemptCount: 0,
        generatedFromFeatureId: sourceFeatureId,
        generatedFromRunId: runId,
      };
      await createFeature(tx, feature);
      await insertFixFeatureLineage(tx, { id: this.generateId("FFL"), sourceFeatureId, fixFeatureId: feature.id, runId, failedAssertionIds, createdAt: now });
      const bumped = await tx
        .update(schema.project.missionFeatures)
        .set({
          implementationAttemptCount: sql`${schema.project.missionFeatures.implementationAttemptCount} + 1`,
          loopState: "implementing",
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.missionFeatures.projectId, missionProjectId()),
          eq(schema.project.missionFeatures.id, root.id),
          sql`${schema.project.missionFeatures.implementationAttemptCount} < ${DEFAULT_IMPLEMENTATION_RETRY_BUDGET}`,
        ))
        .returning({ id: schema.project.missionFeatures.id });
      if (bumped.length !== 1) throw new Error(`Feature ${root.id} retry budget changed while creating its generated fix`);
      return { kind: "created", feature };
    });
    if (outcome.kind === "existing") return outcome.feature;
    if (outcome.kind === "exhausted") {
      const updatedSource = await getFeature(this.db, sourceFeatureId);
      if (updatedSource) this.emit("feature:updated", updatedSource);
      throw new MissionRemediationStoppedError("budget-exhausted");
    }
    if (outcome.kind === "stopped") {
      throw new MissionRemediationStoppedError(
        outcome.reason === "budget-exhausted" || outcome.reason === "operator-intervention"
          ? outcome.reason
          : "legacy-unknown-stop",
      );
    }
    const feature = outcome.feature;
    this.emit("feature:created", feature);
    const updatedSource = await getFeature(this.db, sourceFeatureId);
    if (updatedSource) this.emit("feature:updated", updatedSource);
    this.emit("fix-feature:created", { feature, sourceFeatureId, runId, failedAssertionIds });
    return feature;
  }

  async reconcileSupersededGeneratedFixFeatures(sliceId: string): Promise<{ supersededCount: number; featureIds: string[] }> {
    const features = await listFeatures(this.db, sliceId);
    const byId = new Map(features.map((feature) => [feature.id, feature]));
    let missingSourceIds = [...new Set(features.map((feature) => feature.generatedFromFeatureId).filter((id): id is string => Boolean(id) && !byId.has(id!)))];
    while (missingSourceIds.length > 0) {
      const sources = await listFeaturesByIds(this.db, missingSourceIds);
      for (const source of sources) byId.set(source.id, source);
      missingSourceIds = [...new Set(sources.map((source) => source.generatedFromFeatureId).filter((id): id is string => Boolean(id) && !byId.has(id!)))];
    }
    const passed = (feature?: MissionFeature) => feature?.lastValidatorStatus === "passed" || feature?.loopState === "passed";
    const hasPassedAncestor = (feature: MissionFeature, seen = new Set<string>()): boolean => {
      const sourceId = feature.generatedFromFeatureId;
      if (!sourceId || seen.has(sourceId)) return false;
      seen.add(sourceId);
      const source = byId.get(sourceId);
      return passed(source) || (source ? hasPassedAncestor(source, seen) : false);
    };
    const ids: string[] = [];
    for (const feature of features) {
      if (!feature.generatedFromFeatureId || !(passed(feature) || hasPassedAncestor(feature))) continue;
      if (feature.status !== "done" || feature.loopState !== "passed" || feature.lastValidatorStatus !== "passed" || feature.taskId) ids.push(feature.id);
    }
    if (ids.length > 0) {
      const now = new Date().toISOString();
      /*
      FNXC:PostgresMissionStatusReconciliation 2026-07-14-17:55:
      Superseded generated fixes are one reconciliation set. Update their terminal status in one statement instead of routing every ID through updateFeature/getFeature/cascade reads; emit the same per-feature observable events after persistence.
      */
      await this.db.update(schema.project.missionFeatures).set({
        status: "done",
        taskId: null,
        loopState: "passed",
        lastValidatorStatus: "passed",
        updatedAt: now,
      }).where(inArray(schema.project.missionFeatures.id, ids));
      for (const id of ids) {
        const feature = byId.get(id)!;
        const updated = { ...feature, status: "done" as const, taskId: undefined, loopState: "passed" as const, lastValidatorStatus: "passed" as const, updatedAt: now };
        this.emit("feature:updated", updated);
        if (feature.taskId) await clearTaskMissionLinkage(this.db, feature.taskId);
      }
      await this.recomputeSliceStatus(sliceId);
    }
    return { supersededCount: ids.length, featureIds: ids };
  }

  async transitionLoopState(featureId: string, newState: FeatureLoopState): Promise<MissionFeature> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const current = feature.loopState ?? "idle";
    const allowedNextStates = FEATURE_LOOP_TRANSITIONS[current] || [];
    if (!allowedNextStates.includes(newState)) throw new Error(`Invalid loop state transition from '${current}' to '${newState}'. Allowed transitions from '${current}': ${allowedNextStates.join(", ") || "none"}`);
    if (newState === "implementing" && (feature.implementationAttemptCount ?? 0) >= DEFAULT_IMPLEMENTATION_RETRY_BUDGET) {
      await this.updateFeature(featureId, { loopState: "blocked" });
      throw new Error(`Feature ${featureId} has exhausted its retry budget (${DEFAULT_IMPLEMENTATION_RETRY_BUDGET} attempts). Transitioning to 'blocked' state.`);
    }

    /*
    FNXC:MissionRecovery 2026-07-21-21:30:
    Recovering validating to implementing must terminalize the interrupted validator run in the same transaction as the feature transition. A stale reaper or delayed validator completion must not overwrite the resumed feature with an outcome from the abandoned validation cycle.
    */
    if (current === "validating" && newState === "implementing" && feature.lastValidatorRunId) {
      const run = await getValidatorRun(this.db, feature.lastValidatorRunId);
      if (run?.status === "running") {
        const now = new Date().toISOString();
        const interruptedRun: MissionValidatorRun = {
          ...run,
          status: "error",
          summary: "Interrupted validation was superseded by loop-state recovery",
          completedAt: now,
          updatedAt: now,
        };
        const won = await this.layer.transactionImmediate(async (tx) => {
          const terminalRun = await transitionRunningValidatorRun(tx, interruptedRun);
          if (!terminalRun) return false;
          await updateFeature(tx, {
            ...feature,
            loopState: "implementing",
            lastValidatorStatus: "error",
            updatedAt: now,
          });
          return true;
        });
        if (won) {
          const updated = await getFeature(this.db, featureId);
          if (!updated) throw new Error(`Feature ${featureId} not found after recovery`);
          this.emit("feature:updated", updated);
          this.emit("validator-run:completed", interruptedRun, "error", Math.max(0, Date.parse(now) - Date.parse(run.startedAt)));
          return updated;
        }

        const freshFeature = await getFeature(this.db, featureId);
        const freshCurrent = freshFeature?.loopState ?? "idle";
        if (freshCurrent !== "validating") {
          throw new Error(`Invalid loop state transition from '${freshCurrent}' to '${newState}'. Allowed transitions from '${freshCurrent}': ${(FEATURE_LOOP_TRANSITIONS[freshCurrent] || []).join(", ") || "none"}`);
        }
      }
    }
    return this.updateFeature(featureId, { loopState: newState });
  }

  async getFeatureLoopSnapshot(featureId: string): Promise<MissionFeatureLoopSnapshot> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    const validatorRuns = await listValidatorRunsByFeature(this.db, featureId);
    /* FNXC:PostgresMissionBulkReads 2026-07-14-17:55: Snapshot history fetches every run's failures with one IN query rather than one query per run. */
    const failures = await listFailuresForRuns(this.db, validatorRuns.map((run) => run.id));
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
    const origin = input.origin ?? "authored";
    const existing = await listContractAssertions(this.db, milestoneId);
    if (origin === "derived_milestone_acceptance"
      && existing.some((assertion) => assertion.origin === "derived_milestone_acceptance")) {
      /*
      FNXC:MissionValidation 2026-07-23-17:20:
      Reject duplicate canonical provenance before insert; PostgreSQL also
      enforces this at rest, while authored/imported rows stay non-unique.
      */
      throw new Error(`Milestone ${milestoneId} already has a derived milestone acceptance assertion`);
    }
    const now = new Date().toISOString();
    const orderIndex = existing.length > 0 ? Math.max(...existing.map((a) => a.orderIndex)) + 1 : 0;
    const assertion: MissionContractAssertion = {
      id: this.generateId("CA"),
      milestoneId,
      sourceFeatureId: input.sourceFeatureId,
      scope: input.scope ?? "feature",
      origin,
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
    // FNXC:MissionValidation 2026-07-23-15:05: Rollup-owned assertions are never feature evidence.
    if (assertion.scope === "milestone") {
      throw new Error(`Milestone-scoped assertion ${assertionId} cannot be linked to feature ${featureId}`);
    }
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

  async ensureFeatureAssertionLinked(featureId: string): Promise<MissionContractAssertion[]> {
    const feature = await getFeature(this.db, featureId);
    if (!feature) throw new Error(`Feature ${featureId} not found`);
    await this.ensureFeatureAssertion(feature);
    return listAssertionsForFeature(this.db, featureId);
  }

  async seedContractAssertionsForFeatures(inputs: MissionAssertionSeedInput[]): Promise<MissionAssertionSeedReport> {
    const report: MissionAssertionSeedReport = { scanned: inputs.length, created: 0, linked: 0, skippedExisting: 0 };
    if (inputs.length === 0) return report;
    const featureIds = [...new Set(inputs.map((input) => input.featureId))];
    const milestoneIds = [...new Set(inputs.map((input) => input.milestoneId))];
    const [features, milestones, linked, milestoneAssertions] = await Promise.all([
      listFeaturesByIds(this.db, featureIds),
      this.db.select({ id: schema.project.milestones.id }).from(schema.project.milestones).where(inArray(schema.project.milestones.id, milestoneIds)),
      listLinkedAssertionsForFeatures(this.db, featureIds),
      this.db.select(assertionColumns).from(schema.project.missionContractAssertions).where(inArray(schema.project.missionContractAssertions.milestoneId, milestoneIds)),
    ]);
    const featureSet = new Set(features.map((feature) => feature.id));
    const milestoneSet = new Set(milestones.map((milestone) => milestone.id));
    const existingKeys = new Set(linked.map(({ featureId, assertion }) =>
      `${featureId}\u0000${assertion.milestoneId}\u0000${assertion.title.trim()}\u0000${assertion.assertion.trim()}`));
    const nextOrder = new Map<string, number>();
    for (const row of milestoneAssertions) {
      const assertion = rowToAssertion(row as AssertionRow);
      nextOrder.set(assertion.milestoneId, Math.max(nextOrder.get(assertion.milestoneId) ?? 0, assertion.orderIndex + 1));
    }
    const created: MissionContractAssertion[] = [];
    const links: Array<{ featureId: string; assertionId: string; createdAt: string }> = [];
    for (const input of inputs) {
      if (!milestoneSet.has(input.milestoneId)) throw new Error(`Milestone ${input.milestoneId} not found`);
      if (!featureSet.has(input.featureId)) throw new Error(`Feature ${input.featureId} not found`);
      const key = `${input.featureId}\u0000${input.milestoneId}\u0000${input.title.trim()}\u0000${input.assertion.trim()}`;
      if (existingKeys.has(key)) {
        report.skippedExisting += 1;
        continue;
      }
      existingKeys.add(key);
      const now = new Date().toISOString();
      const assertion: MissionContractAssertion = {
        id: this.generateId("CA"),
        milestoneId: input.milestoneId,
        title: input.title,
        assertion: input.assertion,
        status: "pending",
        type: "static",
        orderIndex: nextOrder.get(input.milestoneId) ?? 0,
        sourceFeatureId: input.featureId,
        createdAt: now,
        updatedAt: now,
      };
      nextOrder.set(input.milestoneId, assertion.orderIndex + 1);
      created.push(assertion);
      links.push({ featureId: input.featureId, assertionId: assertion.id, createdAt: now });
    }
    if (created.length === 0) return report;
    /*
    FNXC:PostgresMissionAssertionSeeding 2026-07-14-17:55:
    Authored assertion seeds are idempotent batches. Resolve existing links/features/milestones up front, insert all new assertions and links transactionally, and recompute each affected milestone once instead of performing a read/write/recompute cycle per seed row.
    */
    await this.layer.transactionImmediate(async (tx) => {
      await tx.insert(schema.project.missionContractAssertions).values(created.map((assertion) => ({
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
      })));
      await tx.insert(schema.project.missionFeatureAssertions).values(links).onConflictDoNothing();
    });
    report.created = created.length;
    report.linked = links.length;
    for (let index = 0; index < created.length; index += 1) {
      this.emit("assertion:created", created[index]!);
      this.emit("assertion:linked", { featureId: links[index]!.featureId, assertionId: created[index]!.id });
    }
    for (const milestoneId of new Set(created.map((assertion) => assertion.milestoneId))) {
      await this.recomputeMilestoneValidation(milestoneId);
    }
    return report;
  }

  // ════════════════ VALIDATION ROLLUP ════════════════
  async getMilestoneValidationRollup(milestoneId: string): Promise<MilestoneValidationRollup> {
    const milestone = await getMilestone(this.db, milestoneId);
    if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);
    const assertions = await listContractAssertions(this.db, milestoneId);
    const totalAssertions = assertions.length;
    const proseOnMilestone = (milestone.acceptanceCriteria ?? "").trim().length > 0;
    const [milestoneFeatures, linkedAssertionIds] = await Promise.all([
      listFeaturesForMilestone(this.db, milestoneId),
      listLinkedAssertionIds(this.db, assertions.map((assertion) => assertion.id)),
    ]);
    const proseOnFeatures = milestoneFeatures.some((feature) => (feature.acceptanceCriteria ?? "").trim().length > 0);
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
      // Rollup assertions are milestone-owned and intentionally have no
      // feature link; only feature-scoped assertions need coverage.
      if (assertion.scope !== "milestone" && !linkedAssertionIds.has(assertion.id)) unlinkedAssertions++;
    }

    /*
    FNXC:PostgresMissionValidationRollup 2026-07-14-17:55:
    Milestone validation computes prose coverage and linked assertion membership with two bulk queries. Assertion count no longer multiplies database round trips during every status reconciliation or seed batch.
    */

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

  async milestoneHasProseButNoAssertions(milestoneId: string): Promise<boolean> {
    return (await this.getMilestoneValidationRollup(milestoneId)).hasProseButNoAssertions;
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
          /*
          FNXC:MissionAutoMerge 2026-07-18-12:00:
          An autoMerge:false mission stamps each newly triaged task so its shared branch produces one PR instead of per-task auto-merges. Duplicate reuse intentionally bypasses this create-only override.
          */
          ...(mission?.autoMerge === false ? { autoMerge: false } : {}),
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
    return this.computeSliceStatusWithHandle(this.db, sliceId);
  }

  private async computeSliceStatusWithHandle(handle: QueryHandle, sliceId: string): Promise<SliceStatus> {
    const features = await listFeatures(handle, sliceId);
    if (features.length === 0) return "pending";
    /* FNXC:MissionStatusPerformance 2026-07-14-18:45: Slice reconciliation loads assertion membership for the whole feature set once; status rollups must not issue one assertion query per feature. */
    const featureIdsWithAssertions = await listFeatureIdsWithAssertions(handle, features.map((feature) => feature.id));
    let allDone = true;
    for (const feature of features) {
      if (feature.status !== "done") { allDone = false; break; }
      const hasLinkedAssertions = featureIdsWithAssertions.has(feature.id);
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
    return this.computeMilestoneStatusWithHandle(this.db, milestoneId);
  }

  private async computeMilestoneStatusWithHandle(handle: QueryHandle, milestoneId: string): Promise<MilestoneStatus> {
    const slices = await listSlices(handle, milestoneId);
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
