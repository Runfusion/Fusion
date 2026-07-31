/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-14:05 (U4 vertical slice):

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
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowIrColumn,
  type WorkflowColumnRecovery,
  type WorkflowColumnOnStale,
} from "@fusion/core";

/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-15:35 (PR #2478 review, P2):
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

/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-19:05 (U4 — the OVERRIDE LAYER):
Compose a workflow's DECLARED policy over the operator's settings.

  declared explicitly -> workflow policy WINS
  left unset          -> DEFER to the project/global setting, exactly as today

This mirrors the two-tier merge `effective-settings.ts` already implements for
workflow settings (a stored value overrides the base; a declaration default only
fills an absent key) rather than inventing a fourth precedence system beside
model selection, project settings, and workflow settings.

ABSENCE STAYS ABSENT. `??` treats an explicitly-`undefined` field as unset, so a
policy is never normalized into a built-in default. The distinction that matters:
**equal-to-default is not the same as unset.** A declaration whose value happens
to equal the legacy literal is a deliberate CHOICE and must still override a
customized operator setting; only true absence defers. This is the same discipline
`workflow-settings-resolver.ts` documents for keys whose declaration omits a
default — they are absent from the map, never `undefined`, so the merge cannot
clobber a real project value.

Composition is PER FIELD, so a workflow may declare a threshold while inheriting
the action. Returns `undefined` unless BOTH halves resolve: a threshold with no
action never fires, and an action with no threshold has nothing to fire on — an
effective policy that is present but inert is the failure mode this program keeps
finding.

Consequence that makes migration safe: retiring a sweep no longer requires
builtin:coding to declare anything. Unset defers to the existing setting, so
behavior cannot silently vanish on upgrade and no project needs touching.
*/
/**
 * A policy that RESOLVED — both halves present. Distinct from
 * `WorkflowColumnRecovery`, whose fields are optional because an author may
 * declare either half. Encoding the guarantee in the TYPE is what lets the
 * consumer check presence alone; a comment promising it would let the two layers
 * drift apart again.
 */
export interface ResolvedRecoveryPolicy {
  stalenessMs: number;
  onStale: WorkflowColumnOnStale;
}

export function resolveEffectiveRecovery(
  declared: WorkflowColumnRecovery | undefined,
  inherited: InheritedRecovery,
): ResolvedRecoveryPolicy | undefined {
  const stalenessMs = declared?.stalenessMs ?? inherited.stalenessMs;
  const onStale = declared?.onStale ?? inherited.onStale;
  if (onStale === undefined) return undefined;
  /*
  FNXC:WorkflowRecoveryPolicy 2026-07-27-21:40 (PR #2482 review, P1):
  A NON-POSITIVE threshold is ABSENT, not "always stale".

  The review found the resolver and its consumer disagreeing about 0: the
  resolver returned it, the consumer's truthiness check dropped it as
  "no-policy". Two layers disagreeing is the real bug and it is fixed — but they
  are reconciled toward ABSENT rather than toward always-stale, deliberately:

    - `parseWorkflowIr` already REJECTS a declared `stalenessMs <= 0`, so a
      workflow cannot author "always stale" in the first place;
    - the only path that can supply 0 is the INHERITED operator setting, where
      `stalePausedTodoThresholdMs <= 0` means DISABLED today
      (`surfaceStalePausedTodos` returns early on it).

  Treating an inherited 0 as always-stale would invert an operator's DISABLE into
  surface-everything — the loudest possible misreading of an explicit off switch.
  */
  if (stalenessMs === undefined || !Number.isFinite(stalenessMs) || stalenessMs <= 0) return undefined;
  return { stalenessMs, onStale };
}

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

/**
 * The operator-settings values a policy key DEFERS to when left undeclared.
 * Supplied by the caller from the resolved project/global settings.
 */
export interface InheritedRecovery {
  stalenessMs?: number;
  onStale?: WorkflowColumnOnStale;
}

export interface ReconcilerDeps {
  now: () => number;
  /** What an UNSET policy inherits. Absent = the sweep is simply off. */
  inherited?: InheritedRecovery;
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
FNXC:WorkflowRecoveryPolicy 2026-07-27-21:10 (U4 — RE-RATIFIED, narrowed):
Every recovery action, whether or not the policy vocabulary can author it yet.

Declared beyond the authorable set on purpose. The user-pause safeguard is scoped
BY ACTION, so the scoping is only testable if the mutating actions exist as
values — and a rule that cannot be tested is a rule that erodes. `parseWorkflowIr`
keeps a CLOSED action list, so nothing here becomes authorable by being named.
*/
export type RecoveryActionKind = "surface" | "rebound" | "archive" | "requeue" | "resume";

/**
 * OBSERVATIONAL actions: they read state and report it. They write no lifecycle
 * field, move no card, and change nothing an operator would have to undo.
 */
const OBSERVATIONAL_ACTIONS: ReadonlySet<RecoveryActionKind> = new Set<RecoveryActionKind>(["surface"]);

/** True when an action changes lifecycle state rather than merely reporting it. */
export function isLifecycleMutatingAction(action: RecoveryActionKind): boolean {
  return !OBSERVATIONAL_ACTIONS.has(action);
}

/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-21:10 (U4 — THE safeguard chokepoint):
Every safeguard suppression flows through here, so there is exactly one place to
audit and the safety test has a single seam to assert against.

THE INVARIANT, in the words that make the distinction survive a future reader:

  The user-pause safeguard means NEVER MUTATE LIFECYCLE STATE of a user-paused
  card. It does NOT mean never observe one.

The purpose of respecting a pause is to stop the engine acting on a card BEHIND
the operator who paused it — moving it, rebounding it, archiving it, resuming it.
A read-only diagnostic does the opposite: it tells that same operator what their
paused card is doing. Blinding them to their own paused work is not safety; it is
the engine deciding they should not be told.

This was ratified BROADLY first (suppress every action on a user-paused card) and
re-ratified narrowly after that reading was caught suppressing the very sweeps it
was meant to protect: `surfaceStalePausedTodos` exists to report cards that have
sat paused too long, so the broad rule turned a diagnostic into one that silently
reported nothing. Scoping is therefore BY ACTION, never by sweep — a sweep cannot
opt itself out, and a new mutating action is suppressed by default because
`OBSERVATIONAL_ACTIONS` is an allow-list.

WHICH FIELD, chosen deliberately rather than inherited from whatever was nearest:
this gate reads `userPaused` — the explicit operator park — NOT `paused`. The two
diverge (see `branch-group-ops.ts:128`: "userPaused remains true but legacy
`paused` is false"). `paused` also covers automation pauses such as
dispatch-storm, which are engine-authored and carry no operator intent to respect,
so gating lifecycle mutation on `paused` would suppress recovery from the engine's
own throttles. The safeguard exists to defer to a HUMAN decision, so it keys on
the field that records one.
*/
export function isSuppressedBySafeguard(
  task: Pick<Task, "userPaused">,
  action: RecoveryActionKind,
): "user-paused" | undefined {
  if (!isLifecycleMutatingAction(action)) return undefined;
  if (task.userPaused === true) return "user-paused";
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
  /* Declared policy overrides; absence defers to the operator setting. */
  const policy = resolveEffectiveRecovery(resolveColumnRecovery(ir, task.column), deps.inherited ?? {});
  // `resolveEffectiveRecovery` guarantees BOTH fields or `undefined`, so the
  // presence check is the only one needed — a truthiness check here would
  // re-introduce the layer disagreement it was written to fix.
  if (!policy) return { suppressed: "no-policy" };

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
