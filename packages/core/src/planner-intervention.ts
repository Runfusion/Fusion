import type {
  PlannerInterventionAction,
  PlannerInterventionEntry,
  PlannerInterventionOutcome,
  PlannerInterventionSourceLink,
  PlannerOversightStage,
  RunAuditEvent,
  RunAuditEventFilter,
  RunAuditEventInput,
} from "./types.js";
import { OVERSEER_INTERVENTION_MUTATION } from "./types.js";

/**
 * FNXC:PlannerOversight 2026-07-04-18:00:
 * FN-7519 record/read helpers for the planner-intervention timeline. These
 * build ON TOP OF the existing run-audit store (`recordRunAuditEvent` /
 * `getRunAuditEvents`) rather than introducing a parallel audit store.
 * `recordPlannerIntervention` is the SINGLE canonical writer: FN-7520 (which
 * wires emission call-sites at overseer decision points) and FN-7511/FN-7512
 * (which produce the actual interventions) must call this helper instead of
 * emitting `overseer:intervention` run-audit events directly.
 */

/** Minimal store seam this module depends on (satisfied by `TaskStore`). */
export interface PlannerInterventionStore {
  recordRunAuditEvent(input: RunAuditEventInput): RunAuditEvent | Promise<RunAuditEvent>;
  getRunAuditEvents(options?: RunAuditEventFilter): RunAuditEvent[];
}

/** Input for recording a planner-intervention timeline entry. */
export interface RecordPlannerInterventionInput {
  taskId: string;
  stage: PlannerOversightStage;
  reason: string;
  action: PlannerInterventionAction;
  outcome: PlannerInterventionOutcome;
  attemptCount?: number;
  attemptLimit?: number;
  sourceLinks?: PlannerInterventionSourceLink[];
  /** Heartbeat run ID that produced this intervention. Defaults to a synthetic per-call ID when omitted. */
  runId?: string;
  /** Agent ID that produced this intervention. Defaults to "overseer" when omitted. */
  agentId?: string;
  /** ISO-8601 timestamp override. Defaults to now. */
  timestamp?: string;
}

const KNOWN_STAGES: readonly PlannerOversightStage[] = ["executor", "reviewer", "merger", "pull-request", "workflow-gate"];
const KNOWN_ACTIONS: readonly PlannerInterventionAction[] = [
  "observe",
  "inject-guidance",
  "retry",
  "request-fix",
  "escalate",
  "request-confirmation",
];
const KNOWN_OUTCOMES: readonly PlannerInterventionOutcome[] = [
  "succeeded",
  "failed",
  "pending",
  "awaiting-confirmation",
  "skipped",
];
const KNOWN_SOURCE_LINK_KINDS: readonly PlannerInterventionSourceLink["kind"][] = [
  "agent-log",
  "review-comment",
  "failed-check",
  "merge-error",
  "pr-state",
  "url",
];

/** Records one planner-intervention timeline entry as a run-audit event under `overseer:intervention`. Non-throwing on optional-field absence. */
export function recordPlannerIntervention(
  store: PlannerInterventionStore,
  input: RecordPlannerInterventionInput,
): RunAuditEvent | Promise<RunAuditEvent> {
  const metadata: Record<string, unknown> = {
    stage: input.stage,
    reason: input.reason,
    action: input.action,
    outcome: input.outcome,
  };
  if (typeof input.attemptCount === "number") metadata.attemptCount = input.attemptCount;
  if (typeof input.attemptLimit === "number") metadata.attemptLimit = input.attemptLimit;
  if (input.sourceLinks && input.sourceLinks.length > 0) metadata.sourceLinks = input.sourceLinks;

  return store.recordRunAuditEvent({
    timestamp: input.timestamp,
    taskId: input.taskId,
    agentId: input.agentId ?? "overseer",
    runId: input.runId ?? `planner-intervention-${input.taskId}-${Date.now()}`,
    domain: "database",
    mutationType: OVERSEER_INTERVENTION_MUTATION,
    target: input.taskId,
    metadata,
  });
}

function toSafeStage(value: unknown): PlannerOversightStage {
  return typeof value === "string" && (KNOWN_STAGES as readonly string[]).includes(value)
    ? (value as PlannerOversightStage)
    : "workflow-gate";
}

function toSafeAction(value: unknown): PlannerInterventionAction {
  return typeof value === "string" && (KNOWN_ACTIONS as readonly string[]).includes(value)
    ? (value as PlannerInterventionAction)
    : "observe";
}

function toSafeOutcome(value: unknown): PlannerInterventionOutcome {
  return typeof value === "string" && (KNOWN_OUTCOMES as readonly string[]).includes(value)
    ? (value as PlannerInterventionOutcome)
    : "pending";
}

function toSafeSourceLinks(value: unknown): PlannerInterventionSourceLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: PlannerInterventionSourceLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const kind =
      typeof raw.kind === "string" && (KNOWN_SOURCE_LINK_KINDS as readonly string[]).includes(raw.kind)
        ? (raw.kind as PlannerInterventionSourceLink["kind"])
        : "url";
    const label = typeof raw.label === "string" && raw.label.length > 0 ? raw.label : kind;
    links.push({
      kind,
      label,
      target: typeof raw.target === "string" ? raw.target : undefined,
      url: typeof raw.url === "string" ? raw.url : undefined,
    });
  }
  return links.length > 0 ? links : undefined;
}

/**
 * Tolerantly maps a run-audit event's metadata back to a `PlannerInterventionEntry`.
 * Returns `null` for non-intervention events. Never throws \u2014 unknown/legacy/
 * missing fields fall back to safe defaults so a malformed or future-version
 * metadata payload cannot break the timeline.
 */
export function parseInterventionEntry(event: RunAuditEvent): PlannerInterventionEntry | null {
  if (event.mutationType !== OVERSEER_INTERVENTION_MUTATION) return null;

  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  const attemptCount = typeof metadata.attemptCount === "number" ? metadata.attemptCount : undefined;
  const attemptLimit = typeof metadata.attemptLimit === "number" ? metadata.attemptLimit : undefined;

  return {
    id: event.id,
    taskId: event.taskId ?? event.target,
    timestamp: event.timestamp,
    stage: toSafeStage(metadata.stage),
    reason: typeof metadata.reason === "string" && metadata.reason.length > 0 ? metadata.reason : "Unknown reason",
    action: toSafeAction(metadata.action),
    outcome: toSafeOutcome(metadata.outcome),
    attemptCount,
    attemptLimit,
    sourceLinks: toSafeSourceLinks(metadata.sourceLinks),
    runId: event.runId,
    agentId: event.agentId,
  };
}

/** Reads the planner-intervention timeline for a task, newest-first. Returns `[]` when there are none. */
export function getPlannerInterventionTimeline(
  store: PlannerInterventionStore,
  taskId: string,
  opts?: { limit?: number },
): PlannerInterventionEntry[] {
  const events = store.getRunAuditEvents({
    taskId,
    mutationType: OVERSEER_INTERVENTION_MUTATION,
    limit: opts?.limit,
  });

  const entries: PlannerInterventionEntry[] = [];
  for (const event of events) {
    const entry = parseInterventionEntry(event);
    if (entry) entries.push(entry);
  }
  // getRunAuditEvents already orders `timestamp DESC, rowid DESC` (newest-first);
  // re-sort defensively so this helper's contract holds even if the store's
  // ordering changes upstream.
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return entries;
}
