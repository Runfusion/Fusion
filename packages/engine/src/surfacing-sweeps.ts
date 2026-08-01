/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-23:10 (U4 — the surfacing family):

ONE runner for the three surfacing sweeps — `surfaceStalePausedTodos`,
`surfaceStalePausedReviews`, `surfaceInReviewStalled`. They are migrated together
so the family cannot drift apart: before this they were three copies of the same
skeleton, and a fix applied to one (the FN-5719-era dedup, the fresh-row skip)
had to be remembered for the other two.

WHAT THE RUNNER OWNS (identical in all three, and the bulk of each body):
  - the global pause gates;
  - the threshold resolution, now POLICY-OVER-SETTING;
  - the fresh-row skip (a row updated during this cycle is re-read next pass);
  - the at-most-once dedup keyed on the durable log prefix + signal code;
  - the log write, the count, and the never-throw contract.

WHAT EACH SPEC OWNS (genuinely per-sweep):
  - which lifecycle ROLE it watches and which operator setting it inherits;
  - its eligibility predicate;
  - its signal evaluation and its operator-facing sentence.

SAFEGUARD POSITION: surfacing is OBSERVATIONAL. Per the re-ratified invariant the
user-pause safeguard gates lifecycle MUTATION, not observation, so these sweeps
report on user-paused cards — which is their entire purpose. The runner writes a
task-log entry and mutates no lifecycle field. It must stay that way: adding a
mutating action here would need the safeguard, and that is why the action is not
parameterized.

AT-MOST-ONCE is a SAFEGUARD and lives here, outside the policy table: a workflow
must not be able to author repeated notification of the same signal.
*/
import {
  resolveEffectiveRecovery,
  type ResolvedRecoveryPolicy,
} from "./recovery-reconciler.js";
import {
  columnsWithFlag,
  resolveReviewColumns,
  resolveWorkflowIrForTask,
  type Settings,
  type Task,
  type TaskStore,
  type WorkflowIr,
} from "@fusion/core";

/** Legacy ids for each role, used when a workflow cannot resolve one. */
const LEGACY_ROLE_COLUMN: Record<SurfacingSpec["role"], string> = {
  hold: "todo",
  review: "in-review",
};

/** The per-task outcome a spec produces, normalized across the three sweeps. */
export interface SurfacingSignal {
  code: string;
  /** How long the condition has held; rendered as hours in the message. */
  ageMs: number;
}

export interface SurfacingSpec {
  /** Durable log prefix. Doubles as the dedup key, so it must stay stable. */
  logPrefix: string;
  /** The lifecycle role this sweep watches, resolved per task. */
  role: "hold" | "review";
  /*
  Synchronous eligibility filter; async proof lives in `isEligibleAsync`.

  Takes SETTINGS because some eligibility is settings-dependent — notably
  `allowsAutoMergeProcessing`, one of the six safeguards. The first cut of this
  interface omitted settings, which is precisely how that gate got dropped during
  the migration while the signal kept asserting `autoMerge: true`: the code
  claimed an eligibility it no longer checked.
  */
  isEligible(task: Task, settings: Settings): boolean;
  /** Optional async eligibility (merge-lane ownership, liveness proofs). */
  isEligibleAsync?(task: Task): Promise<boolean>;
  /*
  Evaluate the sweep's condition. `undefined` = not signalling.

  `activation` carries the engine ACTIVATION FLOOR (`engineActiveSinceMs` +
  `engineActivationGraceMs`). It is passed to every signal because dropping it
  makes a sweep report cards as stale purely because the engine was restarted —
  wall-clock the engine was not running for is not quiet time. That regression is
  silent in a diff and was caught here only by the pre-existing suite.
  */
  evaluate(
    task: Task,
    thresholdMs: number,
    cycleStartMs: number,
    activation: { engineActiveSinceMs?: number; engineActivationGraceMs?: number },
    /* The RESOLVED role column SET. Signals take it so their own column check
       stays real — passing `task.column` would make that check tautological and
       quietly delete it. A SET rather than one id because a role is a trait many
       columns may carry; see `resolveRoleColumns`. */
    roleColumns: ReadonlySet<string>,
  ): SurfacingSignal | undefined;
  /** The operator-facing sentence following `logPrefix [code]: `. */
  describe(task: Task, signal: SurfacingSignal, thresholdMs: number): string;
}

/**
 * One shared pass over the board for the whole surfacing family: a single task
 * snapshot, a single IR cache, and a single cycle clock. See the rationale on
 * `openSurfacingCycle` in self-healing.ts — the three sweeps partition the task
 * space, so sharing a snapshot cannot let one observe another's writes.
 */
export interface SurfacingCycle {
  settings: Settings;
  tasks: Task[];
  irCache: Map<string, WorkflowIr>;
  cycleStartMs: number;
}

export interface SurfacingRunnerDeps {
  store: TaskStore;
  tasks: readonly Task[];
  /** The operator setting this sweep's threshold DEFERS to when unset. */
  inheritedThresholdMs: number;
  /** Full settings, so settings-dependent safeguards stay reachable. */
  settings: Settings;
  /** Engine activation floor, forwarded to every signal (see `evaluate`). */
  activation: { engineActiveSinceMs?: number; engineActivationGraceMs?: number };
  cycleStartMs: number;
  irCache?: Map<string, WorkflowIr>;
}

/**
 * Resolve a task's effective threshold: the workflow's declared policy for the
 * role's column when present, otherwise the operator setting.
 *
 * Returns `undefined` when neither supplies an actionable threshold — including
 * when the operator set a non-positive value, which means DISABLED.
 */
/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:45 (surfacing family watched only the FIRST role column):
A lifecycle role is a TRAIT, and any number of a board's columns may carry it — a workflow with a
merge lane beside a human-review lane has two review columns. `resolveLifecycleColumns()[role]`
answers with the FIRST one only, so the role gate below (`task.column !== roleColumn`) dropped every
card resting in any other column carrying the same role: no stale-paused-review, no in-review-stalled,
no stale-paused-todo diagnostic for those cards, silently and with no error.

Membership, not first-match. `review` is the union of the three review roles (the same answer
`resolveReviewColumns` gives every other converted reader) so a board splitting merge orchestration
from human review is covered by both.
*/
function resolveRoleColumns(ir: WorkflowIr, role: SurfacingSpec["role"]): string[] {
  return role === "review" ? resolveReviewColumns(ir) : columnsWithFlag(ir, "hold");
}

async function resolveTaskThreshold(
  store: TaskStore,
  task: Task,
  spec: SurfacingSpec,
  inheritedThresholdMs: number,
  irCache: Map<string, WorkflowIr>,
): Promise<{ policy: ResolvedRecoveryPolicy; roleColumns: ReadonlySet<string> } | undefined> {
  let declared;
  let roleColumns: string[] = [];
  try {
    const ir = await resolveWorkflowIrForTask(store, task.id, irCache);
    roleColumns = resolveRoleColumns(ir, spec.role);
    if (roleColumns.length > 0 && ir.version === "v2") {
      /*
      The card's OWN column declares its recovery policy when it carries the role. Reading the
      first role column's policy instead would apply the merge lane's threshold to a card sitting
      in the human-review lane — a second first-match bug hiding inside the fix for the first.
      */
      const policyColumn = roleColumns.includes(task.column) ? task.column : roleColumns[0];
      declared = ir.columns.find((c) => c.id === policyColumn)?.recovery;
    }
  } catch {
    // Unresolvable workflow: fall through to the inherited setting.
  }

  const policy = resolveEffectiveRecovery(declared, {
    stalenessMs: inheritedThresholdMs,
    onStale: { action: "surface", code: spec.logPrefix },
  });
  if (!policy) return undefined;
  /*
  A workflow that cannot resolve the role (v1 / no column vocabulary) keeps the
  LEGACY id, so an unresolvable workflow behaves exactly as before this migration
  rather than losing the sweep entirely. Never empty, so the role gate in the
  runner is ALWAYS active — leaving it optional made the gate silently absent for
  exactly the workflows whose role failed to resolve.
  */
  return {
    policy,
    roleColumns: new Set(roleColumns.length > 0 ? roleColumns : [LEGACY_ROLE_COLUMN[spec.role]]),
  };
}

/**
 * Has this exact signal already been surfaced inside the current window?
 *
 * AT-MOST-ONCE safeguard: without it a still-stale card is re-reported every
 * poll, which trains operators to ignore the log — the failure mode that makes a
 * diagnostic worthless. Keyed on prefix AND code, so a card whose signal CHANGES
 * is reported again rather than suppressed by the previous one.
 */
function alreadySurfaced(task: Task, spec: SurfacingSpec, signal: SurfacingSignal, cycleStartMs: number, thresholdMs: number): boolean {
  const previous = [...(task.log ?? [])]
    .reverse()
    .find((entry) => entry.action.startsWith(`${spec.logPrefix} [`));
  if (!previous) return false;
  const parsed = new RegExp(`^${spec.logPrefix} \\[([^\\]]+)\\]`).exec(previous.action);
  const previousAt = Date.parse(previous.timestamp);
  return Number.isFinite(previousAt) && previousAt >= cycleStartMs - thresholdMs && parsed?.[1] === signal.code;
}

/**
 * Run one surfacing sweep. Returns how many cards were reported.
 *
 * Never throws: a surfacing sweep is a diagnostic, so one bad card or workflow
 * must not take the whole pass down. Per-task failures are skipped individually.
 */
export async function runSurfacingSweep(spec: SurfacingSpec, deps: SurfacingRunnerDeps): Promise<number> {
  const irCache = deps.irCache ?? new Map<string, WorkflowIr>();
  let surfaced = 0;

  for (const task of deps.tasks) {
    try {
      if (task.deletedAt) continue;
      if (!spec.isEligible(task, deps.settings)) continue;

      const resolved = await resolveTaskThreshold(deps.store, task, spec, deps.inheritedThresholdMs, irCache);
      if (!resolved) continue;
      const thresholdMs = resolved.policy.stalenessMs;

      /* The role gate: only cards resting in one of THIS task's own role columns. */
      if (!resolved.roleColumns.has(task.column)) continue;

      if (spec.isEligibleAsync && !(await spec.isEligibleAsync(task))) continue;

      const signal = spec.evaluate(task, thresholdMs, deps.cycleStartMs, deps.activation, resolved.roleColumns);
      if (!signal) continue;

      /* A row written during this cycle is re-read next pass, so reporting it
         now would race the writer and could describe stale state. */
      if (Date.parse(task.updatedAt) >= deps.cycleStartMs) continue;

      if (alreadySurfaced(task, spec, signal, deps.cycleStartMs, thresholdMs)) continue;

      await deps.store.logEntry(
        task.id,
        `${spec.logPrefix} [${signal.code}]: ${spec.describe(task, signal, thresholdMs)}`,
      );
      surfaced += 1;
    } catch {
      // Diagnostic sweep: skip this card, keep the pass alive.
    }
  }

  return surfaced;
}

/** Hours, to one decimal — the unit every surfacing message reports in. */
export function hours(ms: number): string {
  return (ms / 3_600_000).toFixed(1);
}
