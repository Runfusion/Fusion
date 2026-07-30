/**
 * Default-workflow trait hook implementations (U4).
 *
 * The legacy per-column side effects of `moveTaskInternal` — timing /
 * `cumulativeActiveMs` accounting, reopen field/step resets, in-review
 * auto-merge handoff preparation + merge-queue enqueue, and abort-on-exit
 * (hard-cancel incl. `userPaused` only for user-source moves) — become the
 * default workflow's trait hook
 * implementations, registered through U2's DI seam (`registerTraitHookImpl`).
 *
 * IMPORTANT (per U4): this is the FLAG-ON path. The legacy inline code in
 * `store.ts` is NOT deleted — it IS the flag-off path. The implementations here
 * are a deliberate parallel of that inline logic so the two paths can be parity-
 * checked against each other; "moved, not duplicated" applies to the flag-ON
 * path only.
 *
 * Hook classes (KTD-2):
 *   - guard  (sync, in-lock): merge-blocker, human-review. NOT implemented here.
 *     The header used to credit an `evaluateDefaultWorkflowGuards` reader in this
 *     file; no such function has ever existed. The merge-blocker guard is enforced
 *     inline in `task-store/moves.ts` (~645 and ~821) via `getTaskMergeBlocker`,
 *     gated on the RESOLVED trait flags (`toFacts.flags.complete` +
 *     `fromFacts.flags.mergeBlocker`) rather than on column ids — which is why no
 *     `guard` trait hook is registered below and none is missing.
 *   - onEnter / onExit (mutating, applied in-lock to the in-memory task before
 *     the commit for field effects; queue effects run in-txn): timing,
 *     reset-on-entry, abort-on-exit, merge.
 *
 * Worktree allocation is explicitly NOT a hook (it stays a substrate capability
 * invoked before the move; see store.ts) — there is no `allocateWorktree` hook
 * here by design.
 *
 * The hooks are registered into the shared trait registry on `init` via
 * `registerDefaultWorkflowHooks()` (idempotent). They are resolved through
 * `getTraitRegistry().resolveTraitHook(...)` so a missing registration degrades
 * to a no-op + audit warning rather than crashing.
 */

import { getTraitRegistry } from "./trait-registry.js";
import type { LifecycleColumns } from "./workflow-lifecycle-traits.js";
import type { TraitAuditWarning } from "./trait-registry.js";
import type { Settings, Task } from "./types.js";

// ── Guard evaluation (sync, in-lock) ─────────────────────────────────────────

export interface DefaultWorkflowMoveContext {
  task: Task;
  fromColumn: string;
  toColumn: string;
  moveSource: "user" | "engine" | "scheduler";
  /*
  FNXC:WorkflowReviewGates 2026-07-26-14:20:
  Provenance of the move, distinct from `moveSource` (which only says user/engine/scheduler).
  `"workflow-graph"` is set at exactly one call site — the graph column boundary in
  `executor.buildColumnBoundaryHooks` — so it uniquely identifies a graph-owned lifecycle crossing
  as opposed to an operator reopen, a merge bounce, or a self-healing rebound. Needed because the
  pre-merge review gates now live in `in-review`, making graph-owned `in-review -> in-progress`
  routine; see `applyReopenFieldClears`.
  */
  workflowMoveSource?: string;
  /** True when guards + abort-on-exit are bypassed (engine/recovery, KTD-9). */
  bypassGuards: boolean;
  movedAt: string;
  /**
   * Settings snapshot available to move effects that need it. Review entry must
   * not copy global `autoMerge` onto the task; an undefined task value follows
   * the live global setting at processing time.
   */
  settings: Pick<Settings, "autoMerge"> | undefined;
  /** Move options that influence reopen/timing semantics. */
  options: {
    preserveStatus?: boolean;
    preserveResumeState?: boolean;
    preserveProgress?: boolean;
    preserveWorktree?: boolean;
    preservePause?: boolean;
  };
  /**
   * FNXC:WorkflowLifecycleColumns 2026-07-30-08:05 (Phase C convergence):
   * The moving task's OWN lifecycle columns, resolved by trait from its workflow IR by
   * the store (which already holds the IR on this path) and passed in because these
   * hooks are sync and in-lock — they cannot resolve anything themselves.
   *
   * WHY THIS FILE NEEDED IT AT ALL. Its name says "default workflow", but the store
   * runs these hooks on the flag-ON path for EVERY workflow — the trait registry
   * resolves the hook by trait id, not by workflow. So the column names hard-coded
   * here were the DEFAULT lineage's names being applied to a renamed board, where the
   * reopen effects simply never fired. See `applyResetOnEntryEffects`.
   *
   * `undefined` means the workflow has no column vocabulary at all (v1 IR), which is
   * NOT the same as "declares no hold column" — the hooks keep the legacy literals
   * only in that no-basis case, never as a substitute for an absent role.
   */
  lifecycleColumns?: LifecycleColumns | undefined;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-09:05 (PR #2734 review — greptile):
  THE SET-SHAPED COMPANION, because `LifecycleColumns` names ONE column per role by design — #2721
  pinned that as the contract, not a gap. A workflow may put `countsTowardWip` (or `complete`, or
  `mergeOrchestration`) on several columns, and these hooks ask "is this card IN that role", which is
  membership.

  Concretely for the timing hook: with a single id, a card moving between two WIP lanes looked like an
  EXIT from WIP followed by a re-entry, so `cumulativeActiveMs` closed and reopened a segment the card
  never left — and a card living only in the secondary lane accrued nothing at all.

  Optional and additive: absent, every read falls back to the singular struct and then the legacy id,
  so nothing changes for the default lineage or for a caller that does not supply it. The caller in
  `moves.ts` already holds the IR, so populating it costs no extra read.
  */
  lifecycleColumnSets?: { wip?: readonly string[]; complete?: readonly string[]; review?: readonly string[] } | undefined;
  /** Reset all steps to pending + currentStep 0 (store owns the impl). */
  resetSteps: () => void;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-10:40 (PR #2734 review — greptile, and it is the same
distinction I had just applied twice elsewhere and then got wrong here):
AN EMPTY SET IS AN ANSWER, NOT AN ABSENT ONE.

`lifecycleColumnSets` is supplied only when the caller resolved a workflow IR, so `set !== undefined`
already means "the board was read". An EMPTY array then says "no column carries this role" — and the
`length > 0` guard treated that as no-basis and fell back to the singular id, then to the legacy name.
The consequence: on a valid v2 workflow with no WIP lane, a traitless column happening to be NAMED
`in-progress` accrued timing as though it were one.

Same shape as #2731 (`?? {}` for resolved-but-roleless flags) and #2733 (refuse rather than invent a
complete column). Undefined means "could not read"; empty means "read, and the answer is none".
*/
/** Membership for a role: the resolved SET when the caller supplied one, else the singular id, else the legacy id. */
function inRole(
  column: string,
  set: readonly string[] | undefined,
  single: string | undefined,
  legacy: string,
): boolean {
  if (set !== undefined) return set.includes(column);
  return column === (single ?? legacy);
}

// ── Field-mutation effects (applied in-lock, before commit) ───────────────────
//
// These mirror the inline flag-off mutations in store.ts exactly. They run as
// the resolved onEnter/onExit hook bodies for the default workflow's traits.

/** `timing` trait (in-progress): accumulate active ms on exit, stamp timing on
 *  entry.
 *
 *  FNXC:WorkflowReviewGates 2026-07-26-16:20:
 *  SCOPE: `cumulativeActiveMs` measures time in WIP columns only — it is a sum of `in-progress`
 *  segments, closed on each exit. Since the pre-merge review gates moved into `in-review`, gate
 *  runtime is NOT included: the segment closes when the card crosses into review, and no new
 *  segment opens until remediation re-enters `in-progress`. Read it as "implementation time",
 *  not "wall clock from start to merge" — consumers that want the latter must use
 *  `executionStartedAt`/`executionCompletedAt`, which still span the whole run and therefore
 *  legitimately diverge from this sum.
 *  Deliberately NOT fixed by adding the `timing` trait to `in-review`: that column also holds the
 *  arbitrary human merge-wait, so counting it would overstate active time by hours of idle
 *  latency — a worse distortion than omitting the gate's own minutes. Attributing gate runtime
 *  properly needs node-scoped timing (a separate field), not a column trait.
 *  Consumers of this scope: `packages/core/src/productivity-analytics.ts`,
 *  `packages/core/src/task-timing.ts`, and the dashboard duration displays.
 */
export function applyTimingEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, fromColumn, toColumn } = ctx;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-04:20 (fleet phase):
  `cumulativeActiveMs` accrues while a card sits in the WIP lane, so both halves of the segment
  boundary must name that lane by ROLE. Keyed on one resolved value rather than two independent reads:
  the exit test and the re-entry test have to agree about which column is WIP or a rename makes the
  accounting count the same interval twice, or not at all.
  */
  const isWip = (column: string) =>
    inRole(column, ctx.lifecycleColumnSets?.wip, ctx.lifecycleColumns?.wip, "in-progress");
  if (isWip(fromColumn) && !isWip(toColumn)) {
    const segmentStartMs = Date.parse(task.executionStartedAt ?? task.columnMovedAt ?? ctx.movedAt);
    const segmentEndMs = Date.parse(task.columnMovedAt ?? ctx.movedAt);
    const segmentDeltaMs =
      Number.isFinite(segmentStartMs) && Number.isFinite(segmentEndMs)
        ? Math.max(0, segmentEndMs - segmentStartMs)
        : 0;
    task.cumulativeActiveMs = Math.max(0, task.cumulativeActiveMs ?? 0) + segmentDeltaMs;
  }
  if (isWip(toColumn)) {
    task.cumulativeActiveMs ??= 0;
    if (!task.firstExecutionAt) task.firstExecutionAt = task.columnMovedAt;
    if (!task.executionStartedAt) task.executionStartedAt = task.columnMovedAt;
    task.userPaused = undefined;
  }
}

/** Stamp `executionCompletedAt` on entry to a completion column. */
export function applyCompletionTimingEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, toColumn } = ctx;
  if (inRole(toColumn, ctx.lifecycleColumnSets?.complete, ctx.lifecycleColumns?.complete, "done") && !task.executionCompletedAt) {
    task.executionCompletedAt = task.columnMovedAt;
  }
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:05 (Phase C convergence — reopen semantics):

WHAT A "REOPEN" IS, stated once. A card leaving live work (wip / review / complete) for a
PLANNING lane (intake or hold). The three predicates below were each written as a list of
the default lineage's column names, which meant every reopen effect — status/error clear,
step reset, `workflowStepResults` clear, branch clear — was a no-op on any workflow that
renamed its columns.

THE CONSEQUENCE WAS NOT COSMETIC. `getTaskMergeBlocker` reads `workflowStepResults`; the
executor's documented bounce invariant is "moveTask(in-review -> planning) clears ALL
results". On a renamed board that clear never happened, so a card bounced out of review
and back in carried its OLD review results — and a `passed` result satisfies the merge
gate. A renamed workflow could merge with its re-review never run. That is the same
safety regression the graph-owned-crossing carve-out above was written to prevent,
arriving through the other door.

LEGACY IDS ARE A NO-BASIS FALLBACK, NOT A ROLE. When the struct is undefined (a v1 IR
with no column vocabulary) there is nothing to reason from and the legacy names are all
we have. When the struct EXISTS but a role is absent, the workflow genuinely has no such
lane and no substitution is made — that is the distinction `resolveLifecycleColumns`
returns `undefined`-for-the-whole-struct to preserve.
*/
const LEGACY_PLANNING_COLUMNS = ["todo", "triage"] as const;
const LEGACY_LIVE_WORK_COLUMNS = ["in-progress", "done", "in-review"] as const;

/** The planning lanes of THIS workflow: intake and hold. */
function planningColumnsOf(lifecycle: LifecycleColumns | undefined): readonly string[] {
  if (!lifecycle) return LEGACY_PLANNING_COLUMNS;
  return [lifecycle.intake, lifecycle.hold].filter((c): c is string => typeof c === "string");
}

/** The lanes a card is reopened OUT of: wip, review, complete. */
function liveWorkColumnsOf(lifecycle: LifecycleColumns | undefined): readonly string[] {
  if (!lifecycle) return LEGACY_LIVE_WORK_COLUMNS;
  return [lifecycle.wip, lifecycle.review, lifecycle.complete].filter(
    (c): c is string => typeof c === "string",
  );
}

/** `reset-on-entry` trait (reopen into a planning lane) + `abort-on-exit` userPaused
 *  semantics. Reproduces the legacy reopen block, by role rather than by name. */
export function applyResetOnEntryEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, fromColumn, toColumn, moveSource, options } = ctx;
  if (!isReopenIntoPlanning(ctx.lifecycleColumns, fromColumn, toColumn)) return;

  /*
  FNXC:WorkflowLifecycle 2026-07-12-09:05:
  Pause-bounce loop (observed on FN-7851, 2026-07-12): a user pause of an in-progress task hard-cancels the session and the executor teardown re-queues the row to todo. This reopen block unconditionally wiped `paused`/`pausedByAgentId`/`pausedReason`, so the pause NEVER survived its own teardown — the graph-failure classifier then saw an unpaused row, misread the abort as engine-internal, and auto-continued the session (and after the retry budget, the scheduler re-dispatched the unpaused todo row). `preservePause` lets the pause-caused teardown move keep the park; the scheduler skips paused/userPaused todo rows until an explicit unpause.
  `userPaused` promotion for user-source moves is unchanged; preservePause only prevents CLEARING an existing park, never sets one.
  */
  if (!options.preserveStatus) {
    task.status = undefined;
    task.error = undefined;
    if (!options.preservePause) {
      task.pausedReason = undefined;
    }
  }
  task.blockedBy = undefined;
  task.overlapBlockedBy = undefined;
  if (!options.preservePause) {
    task.paused = undefined;
    task.pausedByAgentId = undefined;
  }
  /*
  abort-on-exit userPaused: only for user-source moves to the HOLD lane (KTD-9).
  FNXC:WorkflowLifecycleColumns 2026-07-30-08:05: `todo` was the hold lane's name on the
  pre-U11 default lineage and is still its id post-U11 (#2515 merged Todo into Planning
  keeping `todo`), so this reads as hold-then-intake. The role matters, not the name: an
  operator dragging a card back to the queue is parking it, and on a renamed board that
  park silently stopped happening — the scheduler then re-dispatched the card the
  operator had just pulled back.
  */
  const holdLane = ctx.lifecycleColumns
    ? ctx.lifecycleColumns.hold ?? ctx.lifecycleColumns.intake
    : "todo";
  if (moveSource === "user" && toColumn === holdLane) {
    task.userPaused = true;
  } else if (!options.preservePause) {
    task.userPaused = undefined;
  }

  const hasNonPendingStepProgress = task.steps.some((step) => step.status !== "pending");
  const preserveStepProgress =
    options.preserveResumeState || (options.preserveProgress === true && hasNonPendingStepProgress);

  if (!options.preserveWorktree) {
    task.worktree = undefined;
  }
  if (!options.preserveResumeState) {
    task.executionStartedAt = undefined;
    task.executionCompletedAt = undefined;
  } else {
    task.executionCompletedAt = undefined;
  }
  if (!preserveStepProgress) {
    ctx.resetSteps();
    // Prompt-checkbox reset is a filesystem effect; the store performs it
    // post-hook (it owns the task dir). Not modeled here.
  }
}

/**
 * Is this move a reopen — live work (wip/review/complete) back into a planning lane
 * (intake/hold)?
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-08:05: EXPORTED so the store's flag-ON
 * `preserveStepProgress` mirror asks the same question. Those two predicates were
 * separately hand-written copies of the same column list ("Parity mirror of the gate in
 * applyReopenFieldClears"), and a hand-copied predicate is a divergence waiting for
 * whichever copy the next edit misses. One function cannot disagree with itself.
 */
export function isReopenIntoPlanning(
  lifecycle: LifecycleColumns | undefined,
  fromColumn: string,
  toColumn: string,
): boolean {
  return liveWorkColumnsOf(lifecycle).includes(fromColumn)
    && planningColumnsOf(lifecycle).includes(toColumn);
}

/** `merge` trait onEnter (in-review): scheduler-state clearing while
 *  preserving explicit per-task autoMerge overrides. The queue enqueue itself is
 *  in-txn and store-owned (handoff path); the field effects mirror the legacy
 *  in-review block. Keep this flag-ON path in sync with the flag-OFF inline
 *  block in store.ts. */
export function applyInReviewEnterEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, toColumn } = ctx;
  if (!inRole(toColumn, ctx.lifecycleColumnSets?.review, ctx.lifecycleColumns?.review, "in-review")) return;
  // Do not snapshot the global autoMerge setting here. Undefined means "follow
  // the live global setting"; only an explicit task value should stay sticky.
  task.recoveryRetryCount = undefined;
  task.nextRecoveryAt = undefined;
  if (task.status === "queued") {
    task.status = undefined;
  }
  task.blockedBy = undefined;
  task.overlapBlockedBy = undefined;
}

/** Reopen-from-review/done field clears (branch/summary/workflowStepResults). */
export function applyReopenFieldClears(ctx: DefaultWorkflowMoveContext): void {
  const { task, fromColumn, toColumn } = ctx;
  /*
  FNXC:WorkflowReviewGates 2026-07-26-14:25:
  The GRAPH's own in-review -> in-progress crossing must NOT wipe `workflowStepResults`.
  Since the pre-merge review gates moved into `in-review`, entering the paired remediation node
  (in-progress) is a routine graph-owned crossing that happens immediately after the gate wrote its
  `failed` result — so the ungated clear destroyed the remediation input. Three concrete breakages:
    - `routeRetryableRemediationGraphFailureToPreMergeFix` and `recoverFailedPreMergeWorkflowStep`
      select via `latestFailedPreMergeWorkflowStep` and silently no-op on an empty array, so the
      auto-recovery for a parked remediation failure never fires.
    - `getTaskMergeBlocker` reads pending/failed results; an empty array makes both branches
      vacuously false, so a card can return to `in-review` and be MERGEABLE with its gate never
      re-run. That is a safety regression, not just lost history.
    - FN-7727 `priorAttempts` history restarts at attempt zero every remediation cycle.
  Scoped deliberately to the graph-owned in-progress crossing: operator board drags, the in-review
  comment re-engagement, merge bounces, and every `-> todo`/`-> triage` rebound still clear, so the
  executor's documented bounce invariant ("moveTask(in-review->todo) already clears ALL results")
  survives unchanged.
  */
  const lifecycle = ctx.lifecycleColumns;
  const planning = planningColumnsOf(lifecycle);
  const reviewLane = lifecycle ? lifecycle.review : "in-review";
  const wipLane = lifecycle ? lifecycle.wip : "in-progress";
  const completeLane = lifecycle ? lifecycle.complete : "done";
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-08:30 (Phase C convergence):
  THE CARVE-OUT MUST BE RESOLVED TOO, and forgetting it was worse than leaving the whole
  function alone. A role-resolved clear plus a NAME-matched exemption means the renamed
  board takes the clear and never the exemption — so the graph's own remediation crossing
  destroyed the `failed` result it had just written, which is precisely the three breakages
  the note above enumerates. My own paired negative test caught this; a conversion that
  moves the rule and leaves its exception behind inverts the exception.
  */
  const graphOwnedReviewToWip = ctx.workflowMoveSource === "workflow-graph"
    && fromColumn === reviewLane
    && toColumn === wipLane;
  const leftReviewForPlanningOrWip =
    fromColumn === reviewLane && (planning.includes(toColumn) || toColumn === wipLane);
  const leftCompleteForPlanning = fromColumn === completeLane && planning.includes(toColumn);
  if (!graphOwnedReviewToWip && (leftReviewForPlanningOrWip || leftCompleteForPlanning)) {
    task.workflowStepResults = undefined;
  }
  if (fromColumn === reviewLane && planning.includes(toColumn)) {
    task.branch = undefined;
    task.executionStartBranch = undefined;
    task.baseCommitSha = undefined;
    task.summary = undefined;
    task.recoveryRetryCount = undefined;
    task.nextRecoveryAt = undefined;
  }
}

/**
 * Apply ALL default-workflow field-mutation move effects (the parallel of the
 * legacy inline block) in the legacy order. Pure in-memory mutation of
 * `ctx.task`; queue/filesystem/post-commit effects remain store-owned.
 *
 * This is the entry point the flag-ON store path calls. It resolves each
 * trait's hook through the registry first (so a missing registration degrades to
 * a no-op + audit warning, satisfying the "invokes through the registry"
 * contract and the degraded-hook path); resolution warnings are collected and
 * returned for the store to forward to audit.
 */
export function applyDefaultWorkflowMoveEffects(
  ctx: DefaultWorkflowMoveContext,
): { warnings: TraitAuditWarning[] } {
  const registry = getTraitRegistry();
  const warnings: TraitAuditWarning[] = [];

  // Resolve the hooks through the registry. The resolved impls are the closures
  // registered by registerDefaultWorkflowHooks(); resolution surfaces a warning
  // (and a no-op) if a registration is missing.
  const toRun: Array<{ traitId: string; hookKind: "onEnter" | "onExit" }> = [
    { traitId: "timing", hookKind: "onExit" },
    { traitId: "timing", hookKind: "onEnter" },
    { traitId: "reset-on-entry", hookKind: "onEnter" },
    { traitId: "abort-on-exit", hookKind: "onExit" },
    { traitId: "merge", hookKind: "onEnter" },
  ];
  for (const { traitId, hookKind } of toRun) {
    const { impl, warning } = registry.resolveTraitHook(traitId, hookKind);
    if (warning) warnings.push(warning);
    if (impl) impl(ctx);
  }

  return { warnings };
}

// ── Registration into the trait registry (DI seam) ───────────────────────────

let registered = false;

/**
 * Register the default-workflow hook implementations into the shared trait
 * registry. Idempotent. Called at store init (the store is the engine-adjacent
 * owner of the move lifecycle). Each registration is a thin adapter that runs
 * the corresponding field-effect function over the move context.
 *
 * The legacy effects map onto traits as:
 *   timing.onExit / timing.onEnter   → applyTimingEffects + completion stamp
 *   reset-on-entry.onEnter           → applyResetOnEntryEffects + reopen clears
 *   abort-on-exit.onExit             → (userPaused handled in reset-on-entry;
 *                                       session abort is an engine effect U6/U7)
 *   merge.onEnter                    → applyInReviewEnterEffects
 */
export function registerDefaultWorkflowHooks(): void {
  if (registered) return;
  const registry = getTraitRegistry();

  const cast = (fn: (ctx: DefaultWorkflowMoveContext) => void) =>
    ((...args: unknown[]) => fn(args[0] as DefaultWorkflowMoveContext)) as (
      ...args: unknown[]
    ) => unknown;

  registry.registerTraitHookImpl(
    "timing",
    "onExit",
    cast((ctx) => {
      applyTimingEffects(ctx);
    }),
  );
  registry.registerTraitHookImpl(
    "timing",
    "onEnter",
    cast((ctx) => {
      applyCompletionTimingEffects(ctx);
    }),
  );
  registry.registerTraitHookImpl(
    "reset-on-entry",
    "onEnter",
    cast((ctx) => {
      applyResetOnEntryEffects(ctx);
      applyReopenFieldClears(ctx);
    }),
  );
  registry.registerTraitHookImpl(
    "abort-on-exit",
    "onExit",
    cast(() => {
      // userPaused is set in applyResetOnEntryEffects (the legacy ordering keeps
      // it with the reopen block). Session-abort wiring is an engine effect that
      // lands with U6/U7; here it is intentionally a no-op so the resolved hook
      // exists (not a missing-impl warning) while carrying no field mutation.
    }),
  );
  registry.registerTraitHookImpl(
    "merge",
    "onEnter",
    cast((ctx) => {
      applyInReviewEnterEffects(ctx);
    }),
  );

  registered = true;
}

/** Test-only: allow re-registration after a registry reset. */
export function __resetDefaultWorkflowHooksForTests(): void {
  registered = false;
}
