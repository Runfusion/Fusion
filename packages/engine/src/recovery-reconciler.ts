/*
FNXC:WorkflowRecoveryPolicy 2026-07-28-14:05 (U4 vertical slice):

THE recovery reconciler — one engine that walks live cards, resolves each card's
`recovery` policy from ITS OWN workflow, and applies the matching rule. It
replaces the per-sweep imperative bodies that the U4 survey classified as POLICY.

This file is the vertical slice: one policy key (`stalenessMs` + `onStale`), one
migrated sweep (stale paused hold-column cards), and a real reconciler — built to
measure the ACTUAL line cost before committing to the full table, because the
survey's ~900-line estimate was reasoned rather than prototyped.

WHY A RECONCILER AND NOT 53 SWEEPS: the sweeps were already data at the call site
(`{ name, fn }` registry entries); only the bodies were imperative, and those
bodies mostly re-implemented the same four shapes — is this card stale, where does
it rebound to, how many attempts remain, what does an unmet dependency mean. Those
are rules a workflow should declare.

── SAFETY BOUNDARY (ratified, non-negotiable) ──────────────────────────────────
The six safeguards — user pause, `autoMerge:false`, dependency, capacity,
merge-proof, at-most-once — are enforced HERE, outside the policy table, and are
NOT expressible in `WorkflowColumnRecovery`. A workflow author must never be able
to author away a safety invariant. `isSuppressedBySafeguard` below is the single
chokepoint; `recovery-policy-safety.test.ts` fails if any of the six becomes
reachable from policy.

Only the safeguards RELEVANT TO THE ACTIONS THIS SLICE IMPLEMENTS are wired.
`surface` mutates no lifecycle state, so it is gated on user pause only — the
others (autoMerge, dependency, capacity, merge-proof) gate lifecycle-MUTATING
actions and land with `rebound`/`archive`. That is a deliberate scope limit, not
an oversight: wiring an unreachable guard now would be untestable code, and the
safety test asserts the boundary rather than a guard count.
*/
import {
  resolveLifecycleColumns,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowIrColumn,
  type WorkflowColumnRecovery,
} from "@fusion/core";

/*
FNXC:WorkflowRecoveryPolicy 2026-07-28-15:35 (PR #2478 review, P2):
THE TYPE-DRIVEN SAFETY RATCHET. Every key `WorkflowColumnRecovery` accepts,
reified as a value.

The first cut of the safety test read keys off a FIXTURE, so it guarded the
fixture rather than the type: adding a safeguard-adjacent property to the
interface left the advertised guarantee unenforced, because the fixture simply
never set it. This manifest closes that hole.

`Record<keyof WorkflowColumnRecovery, true>` forces exhaustiveness at COMPILE
time — adding a key to the interface fails the build here until it is listed, and
removing one fails as an excess property. It lives in PRODUCTION code
deliberately: the engine tsconfig EXCLUDES the __tests__ directory, so a
compile-time assertion placed in the test file would never be checked by `tsc`
and the ratchet would be decorative.

Two-stage effect. A new interface key breaks the build here; listing it to fix
the build then fails `recovery-policy-safety.test.ts`, which asserts this manifest
against the reviewed allow-list. Either way a human must re-state the safety
argument. That friction is the point.
*/
export const RECOVERY_POLICY_KEYS: Record<keyof WorkflowColumnRecovery, true> = {
  stalenessMs: true,
  onStale: true,
};

/** One card's resolved recovery decision. */
export interface RecoveryDecision {
  taskId: string;
  /** The column the card rests in. */
  column: string;
  action: "surface";
  code: string;
  /** How long the card has rested, measured from `columnMovedAt`. */
  ageMs: number;
}

/** Why a card that otherwise matched a policy was NOT acted on. */
export type RecoverySuppression = "user-paused" | "not-stale" | "no-policy" | "unresolvable-workflow";

export interface ReconcilerDeps {
  now: () => number;
  /** Caller-owned IR cache so one pass reads one IR per workflow, not per card. */
  irCache?: Map<string, WorkflowIr>;
}

function columnsOf(ir: WorkflowIr): WorkflowIrColumn[] {
  return ir.version === "v2" ? ir.columns : [];
}

/**
 * The recovery policy for the column a card rests in, or `undefined` when the
 * workflow declares none. Resolution is by column ID; lifecycle ROLES are
 * resolved by the caller when a policy is expressed against a role.
 */
export function resolveColumnRecovery(ir: WorkflowIr, columnId: string): WorkflowColumnRecovery | undefined {
  return columnsOf(ir).find((c) => c.id === columnId)?.recovery;
}

/*
FNXC:WorkflowRecoveryPolicy 2026-07-28-14:05 (U4):
THE safeguard chokepoint. Every safeguard suppression flows through here so there
is exactly one place to audit, and so the safety test has a single seam to assert
against. Returns the suppressing safeguard, or `undefined` when none applies.

`surface` writes no lifecycle state, so only the user-pause safeguard is
load-bearing for it — a user-paused card must not have engine-authored signals
attributed to it. The remaining five gate lifecycle-mutating actions and are
wired when those actions land.
*/
export function isSuppressedBySafeguard(
  task: Pick<Task, "userPaused">,
  action: RecoveryDecision["action"],
): "user-paused" | undefined {
  if (action === "surface" && task.userPaused === true) return "user-paused";
  return undefined;
}

/**
 * Decide what recovery action a single card warrants.
 *
 * Pure apart from the injected clock: it returns a decision, it does not apply
 * one. Keeping the decision separate is what lets the safety test assert the
 * boundary without running an engine.
 */
export function decideRecovery(
  task: Pick<Task, "id" | "column" | "columnMovedAt" | "updatedAt" | "userPaused">,
  ir: WorkflowIr,
  deps: ReconcilerDeps,
): { decision: RecoveryDecision } | { suppressed: RecoverySuppression } {
  const policy = resolveColumnRecovery(ir, task.column);
  if (!policy?.stalenessMs || !policy.onStale) return { suppressed: "no-policy" };

  const suppressed = isSuppressedBySafeguard(task, policy.onStale.action);
  if (suppressed) return { suppressed };

  const anchor = Date.parse(task.columnMovedAt ?? task.updatedAt);
  if (!Number.isFinite(anchor)) return { suppressed: "not-stale" };
  const ageMs = Math.max(0, deps.now() - anchor);
  if (ageMs < policy.stalenessMs) return { suppressed: "not-stale" };

  return {
    decision: {
      taskId: task.id,
      column: task.column,
      action: policy.onStale.action,
      code: policy.onStale.code,
      ageMs,
    },
  };
}

/**
 * Walk a task snapshot and return every card warranting a recovery action.
 *
 * The IR is resolved PER TASK (a board spans workflows, each with its own
 * policy) but shared through `deps.irCache`, so a 400-card board across three
 * workflows reads three IRs. An unresolvable workflow is skipped rather than
 * guessed — a card whose policy cannot be read gets no engine-authored action.
 */
export async function reconcileRecovery(
  store: TaskStore,
  tasks: readonly Task[],
  deps: ReconcilerDeps,
): Promise<RecoveryDecision[]> {
  const irCache = deps.irCache ?? new Map<string, WorkflowIr>();
  const decisions: RecoveryDecision[] = [];

  for (const task of tasks) {
    let ir: WorkflowIr;
    try {
      ir = await resolveWorkflowIrForTask(store, task.id, irCache);
    } catch {
      continue; // unresolvable-workflow: skip, never guess
    }
    const outcome = decideRecovery(task, ir, { ...deps, irCache });
    if ("decision" in outcome) decisions.push(outcome.decision);
  }

  return decisions;
}

/*
FNXC:WorkflowRecoveryPolicy 2026-07-28-14:05 (U4):
Role-addressed policy lookup. A workflow may express a policy against the column
it names, but the MIGRATED sweeps are written against lifecycle ROLES ("the hold
column"), so this resolves a role to the column carrying it and reads the policy
there. Returns undefined for a v1/column-less IR.
*/
export function resolveRoleRecovery(
  ir: WorkflowIr,
  role: "intake" | "hold" | "wip" | "review" | "complete" | "archived",
): { columnId: string; policy: WorkflowColumnRecovery } | undefined {
  const lifecycle = resolveLifecycleColumns(ir);
  const columnId = lifecycle?.[role];
  if (!columnId) return undefined;
  const policy = resolveColumnRecovery(ir, columnId);
  return policy ? { columnId, policy } : undefined;
}
