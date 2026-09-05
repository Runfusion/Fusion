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

import type { Goal } from "../goals/goal-types.js";
import { redactSecrets } from "../secrets/redact-secrets.js";
import { createMissionBlockerDescriptor, dedupeMissionBlockerDescriptors, sortMissionBlockerDescriptors } from "./mission-blockers.js";

// ── Status Enums ─────────────────────────────────────────────────────

/** Status values for a Mission's lifecycle */
export const MISSION_STATUSES = ["planning", "active", "blocked", "complete", "archived"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** Statuses that hierarchy rollup can derive for missions. */
export const ROLLUP_OWNED_MISSION_STATUSES = ["planning", "active", "complete"] as const satisfies readonly MissionStatus[];

/** Version gate for the public mission-resume blocker contract. */
export const MISSION_BLOCKER_DESCRIPTOR_SCHEMA_VERSION = 1 as const;

/** Closed fail-safe vocabulary for a non-resumable mission root. */
export type MissionBlockerReason = "budget-exhausted" | "operator-intervention" | "legacy-unknown-stop";

/** Durable location from which the stop was read. */
export type MissionBlockerSource = "feature-row" | "lineage-stop";

/** Canonical versioned explanation for a mission resume conflict. */
export interface MissionBlockerDescriptor {
  schemaVersion: 1;
  kind: "mission-resume-conflict";
  rootFeatureId: string;
  reason: MissionBlockerReason;
  source: MissionBlockerSource;
  missionId?: string;
  stoppedAt?: string;
  origin?: string;
  rawReason?: string;
}

export interface MissionBlockedDiagnostics {
  missionId: string;
  status: MissionStatus;
  recomputedStatus: MissionStatus;
  clearable: boolean;
  resumable: boolean;
  blockers: MissionBlockerDescriptor[];
}

/**
 * FNXC:MissionBlockedRepair 2026-08-11-05:07:
 * Diagnostics and resume share the versioned descriptor so blocked-state repair cannot reinterpret
 * a persisted reason differently from the all-or-nothing resume gate.
 */
export function classifyMissionResumeBlockers(input: {
  rootFeatures: ReadonlyArray<Pick<MissionFeature, "id" | "implementationStopReason" | "implementationStoppedAt" | "implementationStopOrigin">>;
  lineageStops: ReadonlyArray<{ rootFeatureId: string; reason: string | null; stoppedAt?: string; origin?: string; missionId?: string | null }>;
  missionId?: string;
}): { blockers: MissionBlockerDescriptor[]; clearableFeatureIds: string[] } {
  const blockers = dedupeMissionBlockerDescriptors(sortMissionBlockerDescriptors([
    ...input.rootFeatures.filter((root) => root.implementationStopReason !== "operator-intervention")
      .map((root) => createMissionBlockerDescriptor({ rootFeatureId: root.id, source: "feature-row", missionId: input.missionId, rawReason: root.implementationStopReason, stoppedAt: root.implementationStoppedAt, origin: root.implementationStopOrigin })),
    ...input.lineageStops.filter((stop) => stop.reason !== "operator-intervention")
      .map((stop) => createMissionBlockerDescriptor({ rootFeatureId: stop.rootFeatureId, source: "lineage-stop", missionId: stop.missionId ?? input.missionId, rawReason: stop.reason, stoppedAt: stop.stoppedAt, origin: stop.origin })),
  ]));
  return { blockers, clearableFeatureIds: [...new Set([
    ...input.rootFeatures.filter((root) => root.implementationStopReason === "operator-intervention").map((root) => root.id),
    ...input.rootFeatures.filter((root) => input.lineageStops.some((stop) => stop.rootFeatureId === root.id)).map((root) => root.id),
  ])] };
}

/** Status values for a Milestone within a mission */
export const MILESTONE_STATUSES = ["planning", "active", "blocked", "complete"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** Statuses that hierarchy rollup can derive for milestones. */
export const ROLLUP_OWNED_MILESTONE_STATUSES = ["planning", "active", "complete"] as const satisfies readonly MilestoneStatus[];

/*
FNXC:MissionStatusRollup 2026-08-13-21:59:
Every automatic rollup writer—the recompute helpers in both stores and AsyncMissionStore's
in-transaction terminal-task reconcile—may move a row only between statuses it can derive.
blocked/archived are operator or system intent from pause, stop, PATCH, and fn_mission_set_status;
only explicit resumeMission, clearMissionBlockedStatus, or autopilot completion clears them.
`mission-rollup-status-writer-ratchet.test.ts` inventories the first-party writer set so a new
computed mission or milestone writer cannot bypass this predicate unnoticed.
*/
export function shouldApplyRecomputedStatus<T extends string>(
  current: T,
  computed: T,
  rollupOwned: readonly T[],
): boolean {
  return current !== computed && rollupOwned.includes(current);
}

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

/**
 * FNXC:MissionRecovery 2026-07-19-14:30:
 * Startup recovery re-drives work interrupted during validation by moving the feature back to implementing. Both mission-store backends must share this transition table so recovery cannot be accepted by the engine but rejected by persistence.
 */
export const FEATURE_LOOP_TRANSITIONS: Readonly<Record<FeatureLoopState, readonly FeatureLoopState[]>> = {
  idle: ["implementing"],
  implementing: ["validating"],
  validating: ["implementing", "needs_fix", "passed", "blocked"],
  needs_fix: ["implementing"],
  passed: [],
  blocked: [],
};

/*
FNXC:MissionValidationRepair 2026-08-11-00:06:
The execution loop consults only FEATURE_LOOP_TRANSITIONS, so failed work cannot launder its
own blocked state. Only repairFeatureValidationState, with an explicit actor, uses these repair
edges; re_run uses the validator-run path and consults neither transition table.
*/
export const FEATURE_LOOP_REPAIR_TRANSITIONS: Readonly<Record<FeatureLoopState, readonly FeatureLoopState[]>> = {
  idle: [],
  implementing: [],
  validating: [],
  needs_fix: ["idle", "implementing"],
  /* FNXC:Missions 2026-09-05-22:07: Explicit repair may return a fabricated unvalidated passed marker to idle (issue #3574). */
  passed: ["idle"],
  blocked: ["idle", "implementing"],
};

/** Status values for a validator run */
export const VALIDATOR_RUN_STATUSES = ["running", "passed", "failed", "blocked", "error"] as const;
export type ValidatorRunStatus = (typeof VALIDATOR_RUN_STATUSES)[number];

/**
 * FNXC:MissionValidationDiagnostics 2026-07-23-12:00:
 * Validator failures cross engine, both stores, and dashboard activity. This
 * normalized contract is the only persisted diagnostic source so prose cannot
 * drift from the verdict and unbounded/secret-bearing evidence cannot escape.
 */
export const VALIDATION_DIAGNOSTICS_MAX_EVIDENCE_PER_ASSERTION = 16;
export const VALIDATION_DIAGNOSTICS_MAX_TEXT_BYTES = 4096;
export const MISSION_EVENT_REASON_MAX_BYTES = 512;
export const MISSION_EVENT_METADATA_MAX_BYTES = 2048;

export type ValidationAssertionVerdict = "pass" | "fail" | "blocked";

export interface ValidationEvidenceReference {
  kind?: string;
  text?: string;
  /** True when text was bounded before persistence. */
  truncated?: boolean;
}

export interface ValidationAssertionDiagnostic {
  assertionId: string;
  verdict: ValidationAssertionVerdict;
  message?: string;
  expected?: string;
  actual?: string;
  evidence: ValidationEvidenceReference[];
  omittedEvidenceCount?: number;
}

export interface ValidationDiagnostics {
  runId: string;
  sourceFeatureId: string;
  outcome: "pass" | "fail" | "blocked" | "error" | "inconclusive";
  assertions: ValidationAssertionDiagnostic[];
  nextAction: string;
}

export interface ValidationDiagnosticsInput {
  runId: string;
  sourceFeatureId: string;
  outcome: ValidationDiagnostics["outcome"];
  assertions: Array<{
    assertionId: string;
    verdict?: ValidationAssertionVerdict;
    passed?: boolean;
    message?: unknown;
    expected?: unknown;
    actual?: unknown;
    evidence?: Array<{ kind?: unknown; text?: unknown }>;
  }>;
  projectRoot?: string;
}

/*
FNXC:MissionStatusWrites 2026-08-10-12:47:
Mission status audit metadata is constructed at the store boundary because agent reasons and
identity strings are untrusted. The total builder runs after the row write in its transaction,
so a malformed caller value cannot roll back a legitimate status repair.
*/
function boundMissionText(value: unknown, limit: number, projectRoot?: string): { value?: string; truncated?: boolean } {
  if (typeof value !== "string") return {};
  let text: string;
  try { text = redactSecrets(value); } catch { return {}; }
  text = text.replace(/(?:[A-Za-z]:\\|\/)[^\s'"`]+/g, (path) => {
    const normalizedRoot = projectRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedPath = path.replace(/\\/g, "/");
    return normalizedRoot && (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))
      ? normalizedPath.slice(normalizedRoot.length).replace(/^\//, "") || "."
      : "[external path omitted]";
  });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limit) return { value: text };
  const marker = "… [truncated]";
  const remaining = limit - Buffer.byteLength(marker, "utf8");
  let end = 0; let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > remaining) break;
    used += size; end += character.length;
  }
  return { value: `${text.slice(0, end)}${marker}`, truncated: true };
}
function boundValidationText(value: unknown, projectRoot?: string): { value?: string; truncated?: boolean } {
  return boundMissionText(value, VALIDATION_DIAGNOSTICS_MAX_TEXT_BYTES, projectRoot);
}

/** Bounds untrusted agent/operator prose before it enters a mission-event row. */
export function boundMissionEventReason(reason: unknown): { value?: string; truncated?: boolean } {
  // Check semantic emptiness before adding the truncation marker: whitespace-only
  // input must not become audit prose merely because it exceeds the byte limit.
  if (typeof reason !== "string" || !reason.trim()) return {};
  return boundMissionText(reason, MISSION_EVENT_REASON_MAX_BYTES);
}

export function normalizeMissionTransitionActorForEvent(actor: unknown): { type: MissionTransitionActorType; id: string; source: string } {
  try {
    const candidate = actor && typeof actor === "object" ? actor as Record<string, unknown> : {};
    const type = MISSION_TRANSITION_ACTOR_TYPES.includes(candidate.type as MissionTransitionActorType) ? candidate.type as MissionTransitionActorType : "system";
    const id = boundMissionText(typeof candidate.id === "string" ? candidate.id : "mission-store", 200).value || "mission-store";
    const source = boundMissionText(typeof candidate.source === "string" ? candidate.source : "mission-store", 200).value || "mission-store";
    return { type, id, source };
  } catch { return { type: "system", id: "mission-store", source: "mission-store" }; }
}

/** Builds the only persisted metadata shape for mission and feature transitions. */
export function buildMissionStatusEventMetadata(input: { entity: "feature" | "mission"; field: string; from: unknown; to: unknown; ids: Record<string, string | undefined>; actor: unknown; reason?: unknown }): Record<string, unknown> {
  /*
  FNXC:MissionStatusWrites 2026-08-10-13:04:
  This builder executes after a status row changes but before its transaction commits. It must
  tolerate hostile values and bound even its required fields, so audit metadata can never roll
  back a legitimate repair or exceed the event-row budget.
  */
  const fallbackActor = { type: "system" as const, id: "mission-store", source: "mission-store" };
  const safeText = (value: unknown, fallback: string): string => {
    try { return boundMissionText(typeof value === "string" ? value : fallback, 200).value || fallback; } catch { return fallback; }
  };
  const safePrimitive = (value: unknown): string | number | boolean | null => {
    try {
      if (typeof value === "string") return safeText(value, "");
      if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
      return safeText(String(value ?? ""), "");
    } catch { return ""; }
  };
  try {
    const actor = normalizeMissionTransitionActorForEvent(input?.actor);
    const minimal: Record<string, unknown> = {
      source: actor.source,
      actor,
      field: safeText(input?.field, "status"),
      from: safePrimitive(input?.from),
      to: safePrimitive(input?.to),
    };
    const ids = Object.fromEntries(Object.entries(input?.ids ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[safeText(key, "id"), safeText(value, "mission-store")]],
    ));
    const reason = boundMissionEventReason(input?.reason);
    const result: Record<string, unknown> = {
      ...minimal,
      ...ids,
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
      ...(reason.truncated ? { reasonTruncated: true } : {}),
    };
    const fits = () => {
      try { return Buffer.byteLength(JSON.stringify(result), "utf8") <= MISSION_EVENT_METADATA_MAX_BYTES; } catch { return false; }
    };
    if (!fits()) { delete result.reason; result.metadataTrimmed = true; }
    if (!fits()) { delete result.reasonTruncated; result.metadataTrimmed = true; }
    if (!fits()) return { ...minimal, metadataTrimmed: true };
    return result;
  } catch {
    return { source: fallbackActor.source, actor: fallbackActor, field: "status", from: "", to: "", metadataTrimmed: true };
  }
}
/** Normalize and redact validation evidence before any mission artifact persists it. */
export function normalizeValidationDiagnostics(input: ValidationDiagnosticsInput): ValidationDiagnostics {
  return {
    runId: input.runId,
    sourceFeatureId: input.sourceFeatureId,
    outcome: input.outcome,
    nextAction: input.outcome === "fail" ? "Review the failed assertions and triage the generated fix work." : "Review the validator run and retry or triage the feature when ready.",
    assertions: input.assertions.map((assertion) => {
      const evidence = (assertion.evidence ?? []).slice(0, VALIDATION_DIAGNOSTICS_MAX_EVIDENCE_PER_ASSERTION).map((item) => {
        const bounded = boundValidationText(item.text, input.projectRoot);
        return { ...(typeof item.kind === "string" ? { kind: item.kind } : {}), ...(bounded.value !== undefined ? { text: bounded.value } : {}), ...(bounded.truncated ? { truncated: true } : {}) };
      });
      const message = boundValidationText(assertion.message, input.projectRoot);
      const expected = boundValidationText(assertion.expected, input.projectRoot);
      const actual = boundValidationText(assertion.actual, input.projectRoot);
      return {
        assertionId: assertion.assertionId,
        verdict: assertion.verdict ?? (assertion.passed ? "pass" : "fail"),
        ...(message.value !== undefined ? { message: message.value } : {}),
        ...(expected.value !== undefined ? { expected: expected.value } : {}),
        ...(actual.value !== undefined ? { actual: actual.value } : {}),
        evidence,
        ...((assertion.evidence?.length ?? 0) > evidence.length ? { omittedEvidenceCount: (assertion.evidence?.length ?? 0) - evidence.length } : {}),
      };
    }),
  };
}

/** Render failure prose from normalized data only; never from non-authoritative judge summaries. */
export function renderValidationFailureDescription(diagnostics: ValidationDiagnostics): string {
  const failed = diagnostics.assertions.filter((assertion) => assertion.verdict === "fail");
  const blocked = diagnostics.assertions.filter((assertion) => assertion.verdict === "blocked");
  const failedText = `${failed.length} assertion${failed.length === 1 ? "" : "s"} failed (${failed.map((assertion) => assertion.assertionId).join(", ") || "no assertion identity"})`;
  const blockedText = blocked.length > 0
    ? `; ${blocked.length} assertion${blocked.length === 1 ? " is" : "s are"} blocked (${blocked.map((assertion) => assertion.assertionId).join(", ")})`
    : "";
  return `Validation failed for feature ${diagnostics.sourceFeatureId}: ${failedText}${blockedText}. ${diagnostics.nextAction}`;
}

/** Stable remediation context used by both store implementations and their task descriptions. */
export function renderValidationCause(diagnostics: ValidationDiagnostics): string {
  const nonPassing = diagnostics.assertions.filter((assertion) => assertion.verdict !== "pass");
  const failed = nonPassing.filter((assertion) => assertion.verdict === "fail");
  const blocked = nonPassing.filter((assertion) => assertion.verdict === "blocked");
  const lines = [
    "## Validation cause",
    `Source feature: ${diagnostics.sourceFeatureId}`,
    `Validator run: ${diagnostics.runId}`,
    `Failed assertions: ${failed.map((assertion) => assertion.assertionId).join(", ") || "none recorded"}`,
    ...(blocked.length > 0 ? [`Blocked assertions: ${blocked.map((assertion) => assertion.assertionId).join(", ")}`] : []),
  ];
  for (const assertion of nonPassing) {
    lines.push(`### ${assertion.assertionId} (${assertion.verdict})`, ...(assertion.expected ? [`Expected: ${assertion.expected}`] : []), ...(assertion.actual ? [`Observed: ${assertion.actual}`] : []), ...(assertion.message ? [`Details: ${assertion.message}`] : []), ...assertion.evidence.map((evidence) => `Evidence: ${evidence.text ?? evidence.kind ?? "recorded"}${evidence.truncated ? " (truncated)" : ""}`), ...(assertion.omittedEvidenceCount ? [`Additional evidence omitted: ${assertion.omittedEvidenceCount}`] : []));
  }
  return lines.join("\n");
}

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
  "mission_status_changed",
  "feature_status_changed",
  "feature_validation_repaired",
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

/**
 * FNXC:MissionAutonomyAudit 2026-07-23-14:20:
 * Status and autonomy switches arm behavior that can create and dispatch work.
 * Record a bounded, attributable caller identity with every such transition so
 * operator, tool, and internal-autopilot actions remain distinguishable.
 */
export const MISSION_TRANSITION_ACTOR_TYPES = ["operator", "agent", "system"] as const;
export type MissionTransitionActorType = (typeof MISSION_TRANSITION_ACTOR_TYPES)[number];

export interface MissionTransitionActor {
  type: MissionTransitionActorType;
  id: string;
  displayName?: string;
  source: string;
}

/*
FNXC:MissionValidationRepair 2026-08-11-00:06:
Core owns this fence shape so its store can verify caller-derived status without importing the
engine. An absent linked task is ground truth too: dangling and archived links must repair to
defined rather than remain permanently blocked. Lane classification stays in the engine to avoid
duplicating its workflow resolver here.
*/
export interface MissionFeatureRepairGroundTruth {
  featureId: string;
  taskId: string | null;
  taskLiveness: "live" | "absent";
  taskColumn: string | null;
  taskUpdatedAt: string | null;
  laneRole: "planner" | "wip" | "none";
  resolvedAt: string;
}

/*
FNXC:MissionValidationRepair 2026-08-11-00:06:
Blocked and needs-fix loop states are explicit stale-badge repair candidates even when feature
status remains live. A validating, implementing, or passed loop must not start another validator
run; passed validation remains available through the normal Validate control.
*/
export function featureValidationRepairEligibility(
  feature: Pick<MissionFeature, "loopState" | "status" | "lastValidatorStatus" | "lastValidatorRunId">,
): { clear: boolean; reRun: boolean } {
  const repairableLoop = feature.loopState === "blocked" || feature.loopState === "needs_fix";
  const unvalidatedPassedMarker = feature.lastValidatorStatus === "passed" && !feature.lastValidatorRunId;
  return {
    clear: repairableLoop || feature.status === "blocked" || unvalidatedPassedMarker,
    reRun: repairableLoop || (feature.status === "blocked" && (feature.loopState === undefined || feature.loopState === "idle")),
  };
}

/** Optional attribution supplied to a mission mutation that can arm autonomy. */
export interface MissionUpdateOptions {
  actor?: MissionTransitionActor;
  /** Untrusted caller prose; the store redacts and bounds it before persistence. */
  reason?: string;
}

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
export type MissionBranchStrategy = {
  mode: "project-default" | "existing" | "custom-new" | "auto-per-task";
  branchName?: string;
};

export interface MissionGoalLink {
  missionId: string;
  goalId: string;
  createdAt: string;
}

export interface Mission {
  /** Unique identifier (e.g., "M-LZ7DN0-A2B5") */
  id: string;
  /** Display name of the mission */
  title: string;
  /** Detailed description of the mission's objectives */
  description?: string;
  /** Current lifecycle status */
  status: MissionStatus;
  /** Optional integration base branch inherited by triaged feature tasks */
  baseBranch?: string;
  /** Mission triage branch strategy: auto-per-task => assignmentMode "per-task-derived"; existing/custom-new => shared branchName; project-default/absent => shared default behavior. */
  branchStrategy?: MissionBranchStrategy;
  /**
   * FNXC:MissionTaskPrefix 2026-07-26-12:00:
   * Per-mission ticket id prefix for triaged tasks (e.g. "ERR"). Absent => inherit the project-wide taskPrefix setting.
   */
  taskPrefix?: string;
  /** State of the AI specification interview process */
  interviewState: InterviewState;
  /**
   * @deprecated Superseded by `autopilotEnabled`. Kept for backward compatibility
   * with existing mission data. Autopilot now always auto-advances slices when
   * enabled and watching.
   */
  autoAdvance?: boolean;
  /** Optional mission-level auto-merge override for linked task branches. */
  autoMerge?: boolean;
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
  /** Acceptance criteria for completing the milestone */
  acceptanceCriteria?: string;
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
export interface ResearchFeatureProvenance {
  researchRunId: string;
  findingId: string;
  /** Finding-specific cited source URLs; an empty array explicitly means uncited. */
  sourceUrls: string[];
}

export type ImplementationStopReason = "budget-exhausted" | "operator-intervention";

/**
 * FNXC:SpecLockMissionAlignment 2026-08-10-16:17:
 * Alignment is a persisted roadmap projection from the linked task's deterministic drift report.
 * It stays separate from delivery and validation lifecycle state, so divergence never fabricates
 * completion or blocks work.
 */
export type MissionFeatureSpecAlignment = "on-plan" | "diverged-needs-review" | "diverged-relocked-approved" | "unavailable";

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
  /** Orthogonal, machine-derived alignment of the linked task's current plan and execution. */
  specAlignment?: MissionFeatureSpecAlignment;
  /** Durable lineage when this canonical feature came from Fusion Research. */
  researchProvenance?: ResearchFeatureProvenance;
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
  /** Why this root remediation loop was terminally stopped; absent legacy values fail closed. */
  implementationStopReason?: ImplementationStopReason;
  /** Timestamp and authority that recorded the terminal stop. */
  implementationStoppedAt?: string;
  implementationStopOrigin?: string;
  /** FN-8694 provenance for a content-addressed validation failure budget block. */
  validationBudgetFingerprint?: string;
  validationBudgetRunId?: string;
  validationBudgetBlockedAt?: string;
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

/** Atomic admission result for an automatic content-addressed validator dispatch. */
/*
FNXC:MissionValidation 2026-08-11-03:43:
Manual validation must share the reaper's six-hour liveness window so a stranded run cannot
permanently wedge an operator control. Engine parity is pinned outside core because core must not
import the engine's healing constants.
*/
export const VALIDATION_INFLIGHT_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Atomic admission result for a feature-scoped manual validator dispatch. */
export type MissionManualValidatorRunAdmission =
  | { outcome: "started"; run: MissionValidatorRun }
  | { outcome: "already-running"; run: MissionValidatorRun };

export type ValidatorRunAdmissionOutcome = "start" | "running" | "reuse-pass" | "budget-exhausted";
export interface ValidatorRunAdmission {
  outcome: ValidatorRunAdmissionOutcome;
  run?: MissionValidatorRun;
  /** FNXC:MissionValidation 2026-08-11-05:38: Distinguish content and feature-liveness refusals without changing the outcome contract. */
  blockingScope?: "fingerprint" | "feature";
}
export interface ValidatorRunAdmissionInput {
  inputFingerprint: string;
  taskId?: string;
  reusePass: boolean;
  failureBudget: number;
}

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
  /** SHA-256 fingerprint of the canonical validator input, when eligible. */
  inputFingerprint?: string;
  /** Which implementation attempt this run corresponds to */
  implementationAttempt: number;
  /** Which validation attempt this run corresponds to */
  validatorAttempt: number;
  /** Board task ID created for this validation run (for board visibility) */
  taskId?: string;
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
  /** Optional integration base branch for tasks created from this mission */
  baseBranch?: string;
  /** Optional branch strategy applied as the default for mission triage operations. */
  branchStrategy?: MissionBranchStrategy;
  /**
   * FNXC:MissionTaskPrefix 2026-07-26-12:00:
   * Optional per-mission ticket id prefix for triaged tasks (e.g. "ERR"); inherits the project setting when absent.
   */
  taskPrefix?: string;
  /** Optional mission-level auto-merge override for linked task branches. */
  autoMerge?: boolean;
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
  /** Acceptance criteria for completing the milestone */
  acceptanceCriteria?: string;
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
export interface ResearchFeatureCreateInput extends FeatureCreateInput {
  researchProvenance: ResearchFeatureProvenance;
}

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
/**
 * FNXC:MissionSliceAdmission 2026-08-08-03:30:
 * Automatic mission progression is serial: duplicate completion and recovery
 * signals may admit only the first pending slice after every earlier slice is
 * complete. Dependencies can further block admission, never bypass ordering.
 * A blocked, empty, or stale non-complete milestone is likewise an ordered
 * gate, so a later milestone cannot silently start before reconciliation.
 */
export function selectNextSerialMissionSlice(mission: MissionWithHierarchy): Slice | undefined {
  if (mission.status !== "active") return undefined;
  const milestones = [...mission.milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  if (milestones.some((milestone) => milestone.slices.some((slice) => slice.status === "active"))) return undefined;

  for (const milestone of milestones) {
    if (milestone.status === "blocked") return undefined;
    const dependenciesMet = milestone.dependencies.every((dependencyId) =>
      milestones.some((candidate) => candidate.id === dependencyId && candidate.status === "complete"),
    );
    if (!dependenciesMet) return undefined;
    const slices = [...milestone.slices].sort((a, b) => a.orderIndex - b.orderIndex);
    // An empty planning milestone has no completed slice evidence that permits
    // crossing it; only an explicitly complete empty milestone may be passed.
    if (slices.length === 0) {
      if (milestone.status !== "complete") return undefined;
      continue;
    }
    for (const slice of slices) {
      if (slice.status === "complete") continue;
      return slice.status === "pending" ? slice : undefined;
    }
    if (milestone.status !== "complete") return undefined;
  }
  return undefined;
}

export interface MissionWithHierarchy extends Mission {
  /** Goals linked to this mission */
  linkedGoals?: Goal[];
  /** Unfiltered total of all mission lifecycle events, matching `MissionSummary.eventCount` and `getMissionEvents` `total` with no `eventType` filter */
  eventCount?: number;
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

/** Payload for feature:unlinked event */
export interface FeatureUnlinkedPayload {
  /** The feature that was unlinked */
  feature: MissionFeature;
  /** ID of the task that was detached; undefined if the feature had no live link */
  taskId?: string;
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
 * Classification of a contract assertion's evidence requirement.
 *
 * - `static`: judgeable by inspecting the implementation (e.g. "documented in
 *   the README"). Retains the legacy read-only AI-judge path.
 * - `behavioral`: truth is observable only by exercising the code (bug fixes,
 *   UI behavior). Defaults to fail unless a verification run confirms it.
 *
 * `static` is the conservative default for existing/lazily-derived rows so the
 * data-model migration preserves current behavior — only assertions explicitly
 * typed `behavioral` take the stricter default-to-fail posture.
 */
export const MISSION_ASSERTION_TYPES = ["static", "behavioral"] as const;
export type MissionAssertionType = (typeof MISSION_ASSERTION_TYPES)[number];

/** The conservative default assertion type (preserves legacy static judging). */
export const DEFAULT_MISSION_ASSERTION_TYPE: MissionAssertionType = "static";

/** Assertions belong either to an individual feature or to milestone rollup. */
export const MISSION_ASSERTION_SCOPES = ["feature", "milestone"] as const;
export type MissionAssertionScope = (typeof MISSION_ASSERTION_SCOPES)[number];

/** Provenance separates the one store-managed milestone criterion from authored rows. */
export const MISSION_ASSERTION_ORIGINS = ["authored", "imported", "derived_milestone_acceptance"] as const;
export type MissionAssertionOrigin = (typeof MISSION_ASSERTION_ORIGINS)[number];

export function normalizeMissionAssertionOrigin(value: unknown): MissionAssertionOrigin {
  return value === "imported" || value === "derived_milestone_acceptance" ? value : "authored";
}

/** Normalize legacy rows to feature scope until explicitly migrated. */
export function normalizeMissionAssertionScope(value: unknown): MissionAssertionScope {
  return value === "milestone" ? "milestone" : "feature";
}

/** Normalize an arbitrary stored value to a valid assertion type, defaulting conservatively. */
export function normalizeMissionAssertionType(value: unknown): MissionAssertionType {
  return value === "behavioral" ? "behavioral" : DEFAULT_MISSION_ASSERTION_TYPE;
}

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
  /** Feature ID when this assertion is store-managed for a specific feature */
  sourceFeatureId?: string;
  /** Validation boundary; milestone assertions are never feature-link coverage. */
  scope?: MissionAssertionScope;
  /** Stable provenance; only the derived milestone origin is unique per milestone. */
  origin?: MissionAssertionOrigin;
  /** Human-readable title describing the assertion */
  title: string;
  /** The behavioral specification or acceptance test content */
  assertion: string;
  /** Current validation status */
  status: MissionAssertionStatus;
  /** Evidence requirement: `static` (inspect) or `behavioral` (exercise). */
  type: MissionAssertionType;
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
  /** True when milestone/feature prose criteria exist but no structured assertions are linked */
  hasProseButNoAssertions: boolean;
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
  /** Evidence requirement, defaults to `static` (conservative). */
  type?: MissionAssertionType;
  /** Feature ID when this assertion is store-managed for a specific feature */
  sourceFeatureId?: string;
  /** Validation boundary; defaults to a feature assertion. */
  scope?: MissionAssertionScope;
  /** Origin defaults to independently authored. */
  origin?: MissionAssertionOrigin;
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
  /** Evidence requirement */
  type?: MissionAssertionType;
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
