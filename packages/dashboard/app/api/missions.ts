/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Mission hierarchy, contract assertions, validation loop, and autopilot client API peeled from legacy.ts.
 * Mission interview SSE streams remain in legacy until createResilientEventSource is shared.
 */
import type { MissionEvent, MissionHealth, MissionEventType, CommitAssociationDiffBackfillReport } from "@fusion/core";
import type { MilestoneValidationTelemetry } from "../components/mission-types";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

// ── Mission API ───────────────────────────────────────────────────────────

/** Mission status values */
export type MissionStatus = "planning" | "active" | "blocked" | "complete" | "archived";

/** Milestone status values */
export type MilestoneStatus = "planning" | "active" | "blocked" | "complete";

/** Slice status values */
export type SliceStatus = "pending" | "active" | "complete";

/** Feature status values */
export type FeatureStatus = "defined" | "triaged" | "in-progress" | "done" | "blocked";

/** Autopilot state values for mission autonomous progression */
export type AutopilotState = "inactive" | "watching" | "activating" | "completing";

/** Autopilot status for a mission */
export interface AutopilotStatus {
  enabled: boolean;
  state: AutopilotState;
  watched: boolean;
  lastActivityAt?: string;
  nextScheduledCheck?: string;
}

/** Mission entity */
export interface Mission {
  id: string;
  title: string;
  description?: string;
  baseBranch?: string;
  branchStrategy?: {
    mode: "project-default" | "existing" | "custom-new" | "auto-per-task";
    branchName?: string;
  };
  status: MissionStatus;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  autoAdvance?: boolean;
  /**
   * FNXC:MissionAutoMerge 2026-07-19-12:30:
   * Mission-level auto-merge override (create/update payloads + list/detail responses).
   * `null` clears an explicit override back to project default on PATCH.
   */
  autoMerge?: boolean | null;
  /** When true, enable autopilot monitoring system for this mission */
  autopilotEnabled?: boolean;
  /** Current autopilot runtime state */
  autopilotState?: AutopilotState;
  /** ISO-8601 timestamp of last autopilot activity */
  lastAutopilotActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Status summary for a mission card, computed from hierarchy */
export interface MissionSummary {
  totalMilestones: number;
  completedMilestones: number;
  totalFeatures: number;
  completedFeatures: number;
  linkedGoalCount: number;
  eventCount: number;
  progressPercent: number;
}

/** Mission with optional status summary (returned by list endpoint) */
export type MissionWithSummary = Mission & { summary?: MissionSummary };

/** Milestone entity */
export interface Milestone {
  id: string;
  missionId: string;
  title: string;
  description?: string;
  status: MilestoneStatus;
  orderIndex: number;
  interviewState: "not_started" | "in_progress" | "completed" | "needs_update";
  dependencies: string[];
  acceptanceCriteria?: string;
  createdAt: string;
  updatedAt: string;
}

/** Slice entity */
export interface Slice {
  id: string;
  milestoneId: string;
  title: string;
  description?: string;
  status: SliceStatus;
  orderIndex: number;
  activatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Feature entity */
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
}

/** Milestone with slices (each slice has features) */
export interface MilestoneWithSlices extends Milestone {
  slices: SliceWithFeatures[];
}

/** Slice with features */
export interface SliceWithFeatures extends Slice {
  features: MissionFeature[];
}

/** Full mission hierarchy */
export interface MissionWithHierarchy extends Mission {
  /** Unfiltered total of all mission lifecycle events, matching MissionSummary.eventCount and getMissionEvents total with no eventType filter */
  eventCount?: number;
  milestones: MilestoneWithSlices[];
}

/** Fetch all missions with status summary */
export function fetchMissions(projectId?: string): Promise<MissionWithSummary[]> {
  return api<MissionWithSummary[]>(withProjectId("/missions", projectId));
}

/** Create a new mission */
export function createMission(input: { title: string; description?: string; autoAdvance?: boolean; autopilotEnabled?: boolean; autoMerge?: boolean; baseBranch?: string; branchStrategy?: Mission["branchStrategy"] }, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId("/missions", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Get mission with full hierarchy */
export function fetchMission(missionId: string, projectId?: string): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId));
}

/** Update mission */
export function updateMission(missionId: string, updates: Partial<Mission>, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete mission */
export function deleteMission(missionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/${encodeURIComponent(missionId)}`, projectId), {
    method: "DELETE",
  });
}

/** Get mission computed status */
export function fetchMissionStatus(missionId: string, projectId?: string): Promise<{ status: string }> {
  return api<{ status: string }>(withProjectId(`/missions/${encodeURIComponent(missionId)}/status`, projectId));
}

export interface MissionAssertionBackfillRepairRow {
  featureId: string;
  milestoneId: string;
  assertionId: string;
  textSource: "acceptanceCriteria" | "description" | "title" | "fallback";
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

/** Backfill store-managed mission assertions for unlinked features. Defaults to dry-run. */
export function backfillMissionAssertions(
  missionId: string,
  options?: { dryRun?: boolean },
  projectId?: string,
): Promise<MissionAssertionBackfillReport> {
  return api<MissionAssertionBackfillReport>(
    withProjectId(`/missions/${encodeURIComponent(missionId)}/backfill-assertions`, projectId),
    {
      method: "POST",
      body: JSON.stringify({ dryRun: options?.dryRun ?? true }),
    },
  );
}

/** Backfill historical Command Center LOC stats for commit associations. Defaults to dry-run. */
export function backfillCommitAssociationDiffStats(
  options?: { dryRun?: boolean },
  projectId?: string,
): Promise<CommitAssociationDiffBackfillReport> {
  return api<CommitAssociationDiffBackfillReport>(
    withProjectId("/command-center/productivity/backfill-loc", projectId),
    {
      method: "POST",
      body: JSON.stringify({ dryRun: options?.dryRun ?? true }),
    },
  );
}

/** Query options for paginated mission event logs. */
export interface MissionEventQueryOptions {
  limit?: number;
  offset?: number;
  eventType?: MissionEventType;
}

/** Paginated mission event log response. */
export interface MissionEventsResponse {
  events: MissionEvent[];
  total: number;
  limit: number;
  offset: number;
}

/** Fetch paginated mission observability events. */
export function fetchMissionEvents(
  missionId: string,
  options?: MissionEventQueryOptions,
  projectId?: string,
): Promise<MissionEventsResponse> {
  const query = new URLSearchParams();
  if (options?.limit !== undefined) query.set("limit", String(options.limit));
  if (options?.offset !== undefined) query.set("offset", String(options.offset));
  if (options?.eventType !== undefined) query.set("eventType", options.eventType);

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return api<MissionEventsResponse>(
    withProjectId(`/missions/${encodeURIComponent(missionId)}/events${suffix}`, projectId),
  );
}

/** Fetch computed mission health metrics. */
export function fetchMissionHealth(missionId: string, projectId?: string): Promise<MissionHealth> {
  return api<MissionHealth>(withProjectId(`/missions/${encodeURIComponent(missionId)}/health`, projectId));
}

/** Fetch health metrics for all missions in a single batched request. */
export function fetchMissionsHealth(projectId?: string): Promise<Record<string, MissionHealth>> {
  return api<Record<string, MissionHealth>>(withProjectId("/missions/health", projectId));
}

/** Add milestone to mission */
export function createMilestone(
  missionId: string,
  input: { title: string; description?: string; acceptanceCriteria?: string; dependencies?: string[] },
  projectId?: string
): Promise<Milestone> {
  return api<Milestone>(withProjectId(`/missions/${encodeURIComponent(missionId)}/milestones`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update milestone */
export function updateMilestone(milestoneId: string, updates: Partial<Milestone>, projectId?: string): Promise<Milestone> {
  return api<Milestone>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete milestone */
export function deleteMilestone(milestoneId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}`, projectId), {
    method: "DELETE",
  });
}

/** Reorder milestones */
export function reorderMilestones(missionId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/${encodeURIComponent(missionId)}/milestones/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Add slice to milestone */
export function createSlice(
  milestoneId: string,
  input: { title: string; description?: string },
  projectId?: string
): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/slices`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update slice */
export function updateSlice(sliceId: string, updates: Partial<Slice>, projectId?: string): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete slice */
export function deleteSlice(sliceId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}`, projectId), {
    method: "DELETE",
  });
}

/** Activate slice */
export function activateSlice(sliceId: string, projectId?: string): Promise<Slice> {
  return api<Slice>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/activate`, projectId), {
    method: "POST",
  });
}

/** Reorder slices */
export function reorderSlices(milestoneId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/slices/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Add feature to slice */
export function createFeature(
  sliceId: string,
  input: { title: string; description?: string; acceptanceCriteria?: string },
  projectId?: string
): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/features`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update feature */
export function updateFeature(featureId: string, updates: Partial<MissionFeature>, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete feature */
export function deleteFeature(featureId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}`, projectId), {
    method: "DELETE",
  });
}

/** Link feature to task */
export function linkFeatureToTask(featureId: string, taskId: string, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/link-task`, projectId), {
    method: "POST",
    body: JSON.stringify({ taskId }),
  });
}

/** Unlink feature from task */
export function unlinkFeatureFromTask(featureId: string, projectId?: string): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/unlink-task`, projectId), {
    method: "POST",
  });
}

/** Triage a feature — create a task from the feature and link it */
export function triageFeature(
  featureId: string,
  taskTitle?: string,
  taskDescription?: string,
  projectId?: string,
  options?: {
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: { mode: "shared" | "per-task-derived" };
    workflowId?: string | null;
  },
): Promise<MissionFeature> {
  return api<MissionFeature>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/triage`, projectId), {
    method: "POST",
    body: JSON.stringify({ taskTitle, taskDescription, ...options }),
  });
}

/** Triage all "defined" features in a slice */
export function triageAllSliceFeatures(
  sliceId: string,
  projectId?: string,
  options?: {
    branchSelection?: {
      mode: "project-default" | "auto-new" | "existing" | "custom-new";
      branchName?: string;
      baseBranch?: string;
    };
    branchAssignment?: { mode: "shared" | "per-task-derived" };
    workflowId?: string | null;
  },
): Promise<{ triaged: MissionFeature[]; count: number }> {
  return api<{ triaged: MissionFeature[]; count: number }>(withProjectId(`/missions/slices/${encodeURIComponent(sliceId)}/triage-all`, projectId), {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
}

// ── Contract Assertion API ─────────────────────────────────────────────────────

/** Contract assertion status */
export type MissionAssertionStatus = "pending" | "passed" | "failed" | "blocked";

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

/** List assertions for a milestone, ordered by orderIndex */
export function fetchAssertions(milestoneId: string, projectId?: string): Promise<MissionContractAssertion[]> {
  return api<MissionContractAssertion[]>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions`, projectId));
}

/** Create a new assertion for a milestone */
export function createAssertion(milestoneId: string, input: ContractAssertionCreateInput, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Reorder assertions within a milestone */
export function reorderAssertions(milestoneId: string, orderedIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/assertions/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ orderedIds }),
  });
}

/** Get a single assertion by ID */
export function fetchAssertion(assertionId: string, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId));
}

/** Update an assertion */
export function updateAssertion(assertionId: string, updates: ContractAssertionUpdateInput, projectId?: string): Promise<MissionContractAssertion> {
  return api<MissionContractAssertion>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete an assertion */
export function deleteAssertion(assertionId: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}`, projectId), {
    method: "DELETE",
  });
}

/** Link a feature to an assertion */
export function linkFeatureToAssertion(featureId: string, assertionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions/${encodeURIComponent(assertionId)}/link`, projectId), {
    method: "POST",
  });
}

/** Unlink a feature from an assertion */
export function unlinkFeatureFromAssertion(featureId: string, assertionId: string, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions/${encodeURIComponent(assertionId)}/unlink`, projectId), {
    method: "POST",
  });
}

/** List assertions linked to a feature */
export function fetchAssertionsForFeature(featureId: string, projectId?: string): Promise<MissionContractAssertion[]> {
  return api<MissionContractAssertion[]>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/assertions`, projectId));
}

/** List features linked to an assertion */
export function fetchFeaturesForAssertion(assertionId: string, projectId?: string): Promise<MissionFeature[]> {
  return api<MissionFeature[]>(withProjectId(`/missions/assertions/${encodeURIComponent(assertionId)}/features`, projectId));
}

/** Validation rollup for a milestone */
export interface MilestoneValidationRollup {
  milestoneId: string;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  blockedAssertions: number;
  pendingAssertions: number;
  unlinkedAssertions: number;
  hasProseButNoAssertions: boolean;
  state: "not_started" | "needs_coverage" | "ready" | "passed" | "failed" | "blocked";
}

/** Get milestone validation rollup */
export function fetchMilestoneValidation(milestoneId: string, projectId?: string): Promise<MilestoneValidationRollup> {
  return api<MilestoneValidationRollup>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/validation`, projectId));
}

/** Fetch grouped validation telemetry for a milestone */
export function fetchMilestoneValidationTelemetry(milestoneId: string, projectId?: string): Promise<MilestoneValidationTelemetry> {
  return api<MilestoneValidationTelemetry>(withProjectId(`/missions/milestones/${encodeURIComponent(milestoneId)}/validation-telemetry`, projectId));
}

// ── Validation Loop API ───────────────────────────────────────────────────────

/** Loop state snapshot for a feature */
export interface MissionFeatureLoopSnapshot {
  featureId: string;
  feature: MissionFeature;
  loopState: "idle" | "implementing" | "validating" | "needs_fix" | "passed" | "blocked";
  implementationAttemptCount: number;
  validatorAttemptCount: number;
  lastValidatorRunId?: string;
  lastValidatorStatus?: "running" | "passed" | "failed" | "blocked" | "error";
  generatedFromFeatureId?: string;
  generatedFromRunId?: string;
  retryBudgetRemaining: number;
}

/** Validator run */
export interface MissionValidatorRun {
  id: string;
  featureId: string;
  milestoneId: string;
  sliceId: string;
  status: "running" | "passed" | "failed" | "blocked" | "error";
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

/** Trigger validation for a feature */
export function triggerValidation(featureId: string, projectId?: string): Promise<{ runId: string; featureId: string; status: string; triggerType: string; implementationAttempt: number; validatorAttempt: number; startedAt: string }> {
  return api(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validate`, projectId), {
    method: "POST",
  });
}

/** Get validation loop state for a feature */
export function fetchValidationLoopState(featureId: string, projectId?: string): Promise<MissionFeatureLoopSnapshot> {
  return api<MissionFeatureLoopSnapshot>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validation-loop`, projectId));
}

/** Paginated response wrapper for validation runs */
export interface ValidationRunsResponse {
  runs: MissionValidatorRun[];
  total: number;
  limit: number;
  offset: number;
}

/** List validation runs for a feature */
export function fetchValidationRuns(featureId: string, options?: { limit?: number; offset?: number }, projectId?: string): Promise<MissionValidatorRun[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<ValidationRunsResponse>(withProjectId(`/missions/features/${encodeURIComponent(featureId)}/validation-runs${suffix}`, projectId))
    .then((response) => response.runs);
}

/** Get a single validator run */
export function fetchValidationRun(runId: string, projectId?: string): Promise<MissionValidatorRun & { failures?: Array<{ id: string; assertionId: string; message?: string; expected?: string; actual?: string }> }> {
  return api(withProjectId(`/missions/validation-runs/${encodeURIComponent(runId)}`, projectId));
}

/** Pause a mission (sets status to "blocked", in-flight tasks continue) */
export function pauseMission(missionId: string, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}/pause`, projectId), {
    method: "POST",
  });
}

/** Resume a paused mission (sets status back to "active") */
export function resumeMission(missionId: string, projectId?: string): Promise<Mission> {
  return api<Mission>(withProjectId(`/missions/${encodeURIComponent(missionId)}/resume`, projectId), {
    method: "POST",
  });
}

/** Stop a mission (sets status to "blocked" and pauses all linked tasks) */
export function stopMission(missionId: string, projectId?: string): Promise<Mission & { pausedTaskIds: string[] }> {
  return api<Mission & { pausedTaskIds: string[] }>(withProjectId(`/missions/${encodeURIComponent(missionId)}/stop`, projectId), {
    method: "POST",
  });
}

/** Start a planning mission: sets status to "active" and activates the first pending slice */
export function startMission(missionId: string, projectId?: string): Promise<MissionWithHierarchy> {
  return api<MissionWithHierarchy>(withProjectId(`/missions/${encodeURIComponent(missionId)}/start`, projectId), {
    method: "POST",
  });
}

// ── Mission Autopilot API ────────────────────────────────────────────────

/** Fetch autopilot status for a mission */
export function fetchMissionAutopilotStatus(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot`, projectId));
}

/** Update autopilot settings for a mission (enable/disable) */
export function updateMissionAutopilot(missionId: string, updates: { enabled?: boolean }, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Manually start autopilot watching for a mission */
export function startMissionAutopilot(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot/start`, projectId), {
    method: "POST",
  });
}

/** Manually stop autopilot watching for a mission */
export function stopMissionAutopilot(missionId: string, projectId?: string): Promise<AutopilotStatus> {
  return api<AutopilotStatus>(withProjectId(`/missions/${encodeURIComponent(missionId)}/autopilot/stop`, projectId), {
    method: "POST",
  });
}

