import type { Column, RunAuditEvent } from "./types.js";
import { VALID_TRANSITIONS } from "./types.js";
import type { WorkflowIr } from "./workflow-ir-types.js";
import { resolveAllowedColumns, workflowHasColumn } from "./workflow-transitions.js";

export const WORKFLOW_PARITY_OBSERVED_MUTATION = "workflow:parity-observed" as const;
export const WORKFLOW_PARITY_DRIFT_MUTATION = "workflow:parity-drift" as const;

export type WorkflowStage = "triage" | "execute" | "review" | "merge";
export type WorkflowParityDiffCategory = "lifecycle" | "invariant" | "audit";
export type WorkflowParityDiffSeverity = "info" | "warning" | "error";

export interface WorkflowReliabilityInvariantSignals {
  fileScopeGuardOutcome: string | null;
  squashMergeContractOutcome: string | null;
  autoMergeTerminalUntilMergedRespected: boolean;
  moveTaskHardCancelRespected: boolean;
}

/**
 * Observe-only workflow snapshot used for parity checks.
 * Legacy remains authoritative; interpreter observations are advisory diagnostics only.
 */
export interface WorkflowRunObservation {
  stageTransitions: WorkflowStage[];
  terminalColumn: string | null;
  terminalStatus: string | null;
  reviewVerdict: string | null;
  mergeOutcome: string | null;
  invariants: WorkflowReliabilityInvariantSignals;
}

export interface WorkflowParityDiff {
  field: string;
  legacy: unknown;
  interpreter: unknown;
  category: WorkflowParityDiffCategory;
  severity: WorkflowParityDiffSeverity;
}

export interface WorkflowParityDriftReport {
  agree: boolean;
  diffs: WorkflowParityDiff[];
}

function isEqualScalarArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function pushDiff(
  diffs: WorkflowParityDiff[],
  field: string,
  legacy: unknown,
  interpreter: unknown,
  category: WorkflowParityDiffCategory,
  severity: WorkflowParityDiffSeverity = "warning",
): void {
  diffs.push({ field, legacy, interpreter, category, severity });
}

/**
 * Pure observation comparison contract for dual-observe shadow checks.
 * Legacy observation is authoritative; interpreter drift is diagnostics only.
 */
export function compareWorkflowRunObservations(
  legacy: WorkflowRunObservation,
  interpreter: WorkflowRunObservation,
): WorkflowParityDriftReport {
  const diffs: WorkflowParityDiff[] = [];

  if (!isEqualScalarArray(legacy.stageTransitions, interpreter.stageTransitions)) {
    pushDiff(
      diffs,
      "stageTransitions",
      legacy.stageTransitions,
      interpreter.stageTransitions,
      "lifecycle",
      "error",
    );
  }

  const lifecycleChecks: Array<[field: string, legacyValue: unknown, interpreterValue: unknown]> = [
    ["terminalColumn", legacy.terminalColumn, interpreter.terminalColumn],
    ["terminalStatus", legacy.terminalStatus, interpreter.terminalStatus],
    ["reviewVerdict", legacy.reviewVerdict, interpreter.reviewVerdict],
    ["mergeOutcome", legacy.mergeOutcome, interpreter.mergeOutcome],
  ];

  for (const [field, legacyValue, interpreterValue] of lifecycleChecks) {
    if (legacyValue !== interpreterValue) {
      pushDiff(diffs, field, legacyValue, interpreterValue, "lifecycle", "error");
    }
  }

  const invariantChecks: Array<[field: string, legacyValue: unknown, interpreterValue: unknown]> = [
    [
      "invariants.fileScopeGuardOutcome",
      legacy.invariants.fileScopeGuardOutcome,
      interpreter.invariants.fileScopeGuardOutcome,
    ],
    [
      "invariants.squashMergeContractOutcome",
      legacy.invariants.squashMergeContractOutcome,
      interpreter.invariants.squashMergeContractOutcome,
    ],
    [
      "invariants.autoMergeTerminalUntilMergedRespected",
      legacy.invariants.autoMergeTerminalUntilMergedRespected,
      interpreter.invariants.autoMergeTerminalUntilMergedRespected,
    ],
    [
      "invariants.moveTaskHardCancelRespected",
      legacy.invariants.moveTaskHardCancelRespected,
      interpreter.invariants.moveTaskHardCancelRespected,
    ],
  ];

  for (const [field, legacyValue, interpreterValue] of invariantChecks) {
    if (legacyValue !== interpreterValue) {
      pushDiff(diffs, field, legacyValue, interpreterValue, "invariant", "error");
    }
  }

  return {
    agree: diffs.length === 0,
    diffs,
  };
}

export const WORKFLOW_COMPARABLE_AUDIT_MUTATIONS = [
  "task:move",
  "task:update",
  "task:pause",
  "task:unpause",
  "task:dependency:add",
  "merge:request-enqueued",
  "merge:dependency-parity-diff",
  "merge:lease-parity-diff",
] as const;

const WORKFLOW_COMPARABLE_AUDIT_MUTATION_SET = new Set<string>(WORKFLOW_COMPARABLE_AUDIT_MUTATIONS);

export interface WorkflowAuditObservation {
  mutationType: string;
  target: string;
  phase: string | null;
}

export function extractWorkflowAuditObservations(events: readonly RunAuditEvent[]): WorkflowAuditObservation[] {
  return events
    .filter(
      (event) =>
        event.domain === "database"
        && WORKFLOW_COMPARABLE_AUDIT_MUTATION_SET.has(String(event.mutationType)),
    )
    .map((event) => ({
      mutationType: String(event.mutationType),
      target: event.target,
      phase: typeof event.metadata?.phase === "string" ? event.metadata.phase : null,
    }));
}

export function compareWorkflowRunAudits(
  legacyEvents: readonly RunAuditEvent[],
  interpreterEvents: readonly RunAuditEvent[],
): WorkflowParityDriftReport {
  const legacy = extractWorkflowAuditObservations(legacyEvents);
  const interpreter = extractWorkflowAuditObservations(interpreterEvents);
  const diffs: WorkflowParityDiff[] = [];

  if (legacy.length !== interpreter.length) {
    pushDiff(diffs, "audit.length", legacy.length, interpreter.length, "audit");
  }

  const count = Math.max(legacy.length, interpreter.length);
  for (let index = 0; index < count; index += 1) {
    const left = legacy[index];
    const right = interpreter[index];
    if (!left || !right) {
      pushDiff(diffs, `audit[${index}]`, left ?? null, right ?? null, "audit");
      continue;
    }

    if (left.mutationType !== right.mutationType) {
      pushDiff(
        diffs,
        `audit[${index}].mutationType`,
        left.mutationType,
        right.mutationType,
        "audit",
      );
    }

    if (left.target !== right.target) {
      pushDiff(diffs, `audit[${index}].target`, left.target, right.target, "audit");
    }

    if (left.phase !== right.phase) {
      pushDiff(diffs, `audit[${index}].phase`, left.phase, right.phase, "audit");
    }
  }

  return {
    agree: diffs.length === 0,
    diffs,
  };
}

// ── Observation builders (CU-U5) ─────────────────────────────────────────────
// Construct a WorkflowRunObservation from real run data so the legacy and
// interpreter sides can be compared without either side hand-rolling the shape.

/** Conservative defaults: a run that didn't signal an invariant is assumed to
 *  have respected the terminal/cancel contracts (the common, non-drift case). */
export const DEFAULT_WORKFLOW_INVARIANTS: WorkflowReliabilityInvariantSignals = {
  fileScopeGuardOutcome: null,
  squashMergeContractOutcome: null,
  autoMergeTerminalUntilMergedRespected: true,
  moveTaskHardCancelRespected: true,
};

const COLUMN_TO_STAGE: Record<string, WorkflowStage | undefined> = {
  triage: "triage",
  todo: "triage",
  "in-progress": "execute",
  "in-review": "review",
  done: "merge",
};

/**
 * Map the ordered list of columns a run passed through to workflow stages,
 * collapsing consecutive repeats. This is how the legacy side derives its
 * stageTransitions — from the real task-move history rather than a guess.
 */
export function deriveStageTransitions(columnSequence: readonly string[]): WorkflowStage[] {
  const stages: WorkflowStage[] = [];
  for (const column of columnSequence) {
    const stage = COLUMN_TO_STAGE[column];
    if (stage && stages[stages.length - 1] !== stage) stages.push(stage);
  }
  return stages;
}

export interface WorkflowObservationTaskInput {
  column: string;
  status?: string | null;
  review?: { verdict?: string } | null;
  mergeDetails?: { outcome?: string } | null;
}

export interface WorkflowObservationBuildOptions {
  /** Explicit stage sequence (wins over columnSequence). */
  stageTransitions?: readonly WorkflowStage[];
  /** Ordered columns the run passed through; mapped to stages when stageTransitions is absent. */
  columnSequence?: readonly string[];
  invariants?: Partial<WorkflowReliabilityInvariantSignals>;
}

/**
 * Build a parity observation from a task's terminal persisted state (the legacy
 * authoritative side). stageTransitions come from the caller's recorded column
 * history when available, else fall back to the terminal column alone.
 */
export function buildWorkflowObservationFromTask(
  task: WorkflowObservationTaskInput,
  options?: WorkflowObservationBuildOptions,
): WorkflowRunObservation {
  const stageTransitions = options?.stageTransitions
    ? [...options.stageTransitions]
    : deriveStageTransitions(options?.columnSequence ?? [task.column]);
  return {
    stageTransitions,
    terminalColumn: task.column ?? null,
    terminalStatus: task.status ?? null,
    reviewVerdict: task.review?.verdict ?? null,
    mergeOutcome: task.mergeDetails?.outcome ?? (task.column === "done" ? "merged" : null),
    invariants: { ...DEFAULT_WORKFLOW_INVARIANTS, ...options?.invariants },
  };
}

/** Aggregate of dual-observe parity audit events — the graduation signal. */
export interface WorkflowParitySummary {
  /** Total `workflow:parity-observed` events in scope. */
  observed: number;
  /** Of those, how many reported agree=true. */
  agreed: number;
  /** Total `workflow:parity-drift` events in scope. */
  drift: number;
  /** agreed / observed in [0,1]; 0 when nothing observed yet. */
  agreeRate: number;
  /** Count of drift occurrences per observation field, most-divergent first. */
  driftFieldCounts: Record<string, number>;
  /** Most recent drift events (capped) for inspection. */
  recentDrift: Array<{ taskId: string; timestamp: string; diffs: WorkflowParityDiff[] }>;
}

export interface WorkflowObservationParts {
  stageTransitions: readonly WorkflowStage[];
  terminalColumn?: string | null;
  terminalStatus?: string | null;
  reviewVerdict?: string | null;
  mergeOutcome?: string | null;
  invariants?: Partial<WorkflowReliabilityInvariantSignals>;
}

/**
 * Build a parity observation from explicit parts (the interpreter/shadow side
 * assembles these from its graph-walk result).
 */
export function buildWorkflowObservation(parts: WorkflowObservationParts): WorkflowRunObservation {
  return {
    stageTransitions: [...parts.stageTransitions],
    terminalColumn: parts.terminalColumn ?? null,
    terminalStatus: parts.terminalStatus ?? null,
    reviewVerdict: parts.reviewVerdict ?? null,
    mergeOutcome: parts.mergeOutcome ?? null,
    invariants: { ...DEFAULT_WORKFLOW_INVARIANTS, ...parts.invariants },
  };
}

// ── Transition parity (U12) ──────────────────────────────────────────────────
//
// The transition-parity suite (U4) proves, as a unit test, that the default
// workflow's resolved column adjacency equals the legacy VALID_TRANSITIONS
// graph. U12 surfaces the SAME comparison as a runtime check so the graduation
// gate can re-evaluate it against whatever IR is actually resolved for the
// default workflow in the field (not just the static fixture), catching a
// deliberately or accidentally drifted default-workflow adjacency.

/** One adjacency disagreement between the legacy graph and the resolved IR. */
export interface TransitionParityDiff {
  /** The `from` column whose allowed-set diverged. */
  from: string;
  /** Allowed targets per the legacy VALID_TRANSITIONS graph. */
  legacyAllowed: string[];
  /** Allowed targets per the resolved workflow IR column graph. */
  resolvedAllowed: string[];
}

export interface TransitionParityReport {
  /** True when every legacy column's allowed-set matches the resolved IR's. */
  agree: boolean;
  /** Per-column adjacency disagreements (empty when `agree`). */
  diffs: TransitionParityDiff[];
}

const LEGACY_COLUMNS = Object.keys(VALID_TRANSITIONS) as Column[];

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Compare the default-workflow IR's resolved column adjacency against the legacy
 * VALID_TRANSITIONS graph (R12 transition parity, machine-checked). For every
 * legacy column, the resolved allowed-set must equal the legacy allowed-set
 * exactly (allowed AND rejected). The IR must also recognize every legacy
 * column. Any divergence is a graduation blocker.
 */
export function checkTransitionParity(ir: WorkflowIr): TransitionParityReport {
  const diffs: TransitionParityDiff[] = [];
  for (const from of LEGACY_COLUMNS) {
    const legacyAllowed = sortedUnique(VALID_TRANSITIONS[from]);
    // A column the resolved IR doesn't even define diverges by construction.
    const resolvedAllowed = workflowHasColumn(ir, from)
      ? sortedUnique(resolveAllowedColumns(ir, from))
      : [];
    const equal =
      legacyAllowed.length === resolvedAllowed.length &&
      legacyAllowed.every((value, index) => value === resolvedAllowed[index]);
    if (!equal) diffs.push({ from, legacyAllowed, resolvedAllowed });
  }
  return { agree: diffs.length === 0, diffs };
}

// ── Dual-accept disagreement counter (U12) ───────────────────────────────────
//
// U6 logs `merge:dependency-parity-diff` audits whenever the explicit handoff
// marker and the complete-flag column disagree during the FN-5719 dual-accept
// window. The window CLOSES at graduation, so any disagreement above zero over
// the observation period blocks the flip. This surfaces the count (and the
// lease-parity counterpart) from the audit trail as a graduation signal.

export const DUAL_ACCEPT_PARITY_MUTATIONS = [
  "merge:dependency-parity-diff",
  "merge:lease-parity-diff",
] as const;

const DUAL_ACCEPT_PARITY_MUTATION_SET = new Set<string>(DUAL_ACCEPT_PARITY_MUTATIONS);

export interface DualAcceptDisagreementReport {
  /** Total dual-accept disagreement audit events in scope. */
  total: number;
  /** Count per mutation type (dependency vs lease parity diff). */
  byMutationType: Record<string, number>;
}

/**
 * Count the dual-accept marker/column disagreement audits (U6) in scope. Pure
 * over the supplied events so the store can feed it whatever audit window the
 * graduation report observes.
 */
export function countDualAcceptDisagreements(
  events: readonly RunAuditEvent[],
): DualAcceptDisagreementReport {
  const byMutationType: Record<string, number> = {};
  let total = 0;
  for (const event of events) {
    const type = String(event.mutationType);
    if (event.domain !== "database" || !DUAL_ACCEPT_PARITY_MUTATION_SET.has(type)) continue;
    byMutationType[type] = (byMutationType[type] ?? 0) + 1;
    total += 1;
  }
  return { total, byMutationType };
}

// ── Graduation report (U12) ──────────────────────────────────────────────────
//
// The flag default-flip criteria, aggregated into one report (KTD-8). The flip
// is a FIELD decision — this report is the GATE, not the trigger. `ready` is
// true only when ALL of:
//   - the five-invariant dual-observe parity shows zero drift (drift === 0) over
//     a non-empty observation window;
//   - the default workflow's transition parity holds (no adjacency drift);
//   - zero dual-accept marker/column disagreements over the window.

export interface WorkflowColumnsGraduationReport {
  /** Five-invariant dual-observe parity (from the audit trail). */
  parity: WorkflowParitySummary;
  /** Default-workflow transition-graph parity vs VALID_TRANSITIONS. */
  transitionParity: TransitionParityReport;
  /** Dual-accept marker/column disagreement count (U6). */
  dualAccept: DualAcceptDisagreementReport;
  /** True only when every gate passes — the flag is eligible to default on. */
  ready: boolean;
  /** Human-readable blockers when not ready (empty when ready). */
  blockers: string[];
}

export interface GraduationReportInputs {
  /** Dual-observe parity summary (e.g. `store.getWorkflowParitySummary()`). */
  parity: WorkflowParitySummary;
  /** The resolved default-workflow IR to transition-parity-check. */
  defaultWorkflowIr: WorkflowIr;
  /** Audit events in the observation window for dual-accept counting. */
  dualAcceptEvents: readonly RunAuditEvent[];
}

/**
 * Aggregate the flag default-flip criteria into a single graduation report
 * (U12, absorbing plan 002's M-D). Pure: the caller assembles the inputs from
 * the store's audit trail and resolved default workflow, and decides whether to
 * flip the flag — this function only computes the gate.
 */
export function computeWorkflowColumnsGraduationReport(
  inputs: GraduationReportInputs,
): WorkflowColumnsGraduationReport {
  const { parity, defaultWorkflowIr, dualAcceptEvents } = inputs;
  const transitionParity = checkTransitionParity(defaultWorkflowIr);
  const dualAccept = countDualAcceptDisagreements(dualAcceptEvents);

  const blockers: string[] = [];
  if (parity.observed === 0) {
    blockers.push("no parity observations recorded yet (observation window empty)");
  }
  if (parity.drift > 0) {
    blockers.push(`five-invariant parity drift observed (${parity.drift} drift events)`);
  }
  if (!transitionParity.agree) {
    const cols = transitionParity.diffs.map((d) => d.from).join(", ");
    blockers.push(`default-workflow transition parity drifted (columns: ${cols})`);
  }
  if (dualAccept.total > 0) {
    blockers.push(`dual-accept marker/column disagreements above zero (${dualAccept.total})`);
  }

  return {
    parity,
    transitionParity,
    dualAccept,
    ready: blockers.length === 0,
    blockers,
  };
}
