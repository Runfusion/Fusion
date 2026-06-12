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
 *   - guard  (sync, in-lock): merge-blocker, human-review. Implemented as the
 *     `evaluateDefaultWorkflowGuards` reader; pure DB-free reads off the task.
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
import type { TraitAuditWarning } from "./trait-registry.js";
import { getTaskMergeBlocker } from "./task-merge.js";
import type { Settings, Task } from "./types.js";

// ── Guard evaluation (sync, in-lock) ─────────────────────────────────────────

/** A guard verdict: undefined = allow; a string reason = reject. */
export type GuardVerdict = string | undefined;

/**
 * Evaluate the default workflow's sync guards for a move. Reproduces the legacy
 * `getTaskMergeBlocker` gate on `in-review → done`. (The default workflow does
 * not carry the human-review trait — see the Trait Vocabulary note — so there
 * is no human-review guard on this workflow.)
 *
 * `bypassGuards` (engine-sourced moves, KTD-9) skips guards entirely — the
 * caller is responsible for honoring that; this function still computes the
 * verdict so callers can choose. The store only consults it when not bypassing.
 */
export function evaluateMergeBlockerGuard(
  task: Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults">,
  fromColumn: string,
  toColumn: string,
): GuardVerdict {
  if (fromColumn === "in-review" && toColumn === "done") {
    return getTaskMergeBlocker(task);
  }
  return undefined;
}

// ── Move-effect context ───────────────────────────────────────────────────────

/** Side-effect callbacks the store provides so the hooks stay engine-free and
 *  DB-handle-free; the store wires these to its in-txn / post-commit machinery. */
export interface DefaultWorkflowMoveContext {
  task: Task;
  fromColumn: string;
  toColumn: string;
  moveSource: "user" | "engine" | "scheduler";
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
  };
  /** Reset all steps to pending + currentStep 0 (store owns the impl). */
  resetSteps: () => void;
}

// ── Field-mutation effects (applied in-lock, before commit) ───────────────────
//
// These mirror the inline flag-off mutations in store.ts exactly. They run as
// the resolved onEnter/onExit hook bodies for the default workflow's traits.

/** `timing` trait (in-progress): accumulate active ms on exit, stamp timing on
 *  entry. */
export function applyTimingEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, fromColumn, toColumn } = ctx;
  if (fromColumn === "in-progress" && toColumn !== "in-progress") {
    const segmentStartMs = Date.parse(task.executionStartedAt ?? task.columnMovedAt ?? ctx.movedAt);
    const segmentEndMs = Date.parse(task.columnMovedAt ?? ctx.movedAt);
    const segmentDeltaMs =
      Number.isFinite(segmentStartMs) && Number.isFinite(segmentEndMs)
        ? Math.max(0, segmentEndMs - segmentStartMs)
        : 0;
    task.cumulativeActiveMs = Math.max(0, task.cumulativeActiveMs ?? 0) + segmentDeltaMs;
  }
  if (toColumn === "in-progress") {
    task.cumulativeActiveMs ??= 0;
    if (!task.firstExecutionAt) task.firstExecutionAt = task.columnMovedAt;
    if (!task.executionStartedAt) task.executionStartedAt = task.columnMovedAt;
    task.userPaused = undefined;
  }
}

/** Stamp `executionCompletedAt` on entry to a completion column. */
export function applyCompletionTimingEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, toColumn } = ctx;
  if (toColumn === "done" && !task.executionCompletedAt) {
    task.executionCompletedAt = task.columnMovedAt;
  }
}

/** `reset-on-entry` trait (todo/triage reopen) + `abort-on-exit` userPaused
 *  semantics. Reproduces the legacy reopen block. */
export function applyResetOnEntryEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, fromColumn, toColumn, moveSource, options } = ctx;
  const isReopenToTodoOrTriage =
    (fromColumn === "in-progress" || fromColumn === "done" || fromColumn === "in-review") &&
    (toColumn === "todo" || toColumn === "triage");
  if (!isReopenToTodoOrTriage) return;

  if (!options.preserveStatus) {
    task.status = undefined;
    task.error = undefined;
    task.pausedReason = undefined;
  }
  task.blockedBy = undefined;
  task.overlapBlockedBy = undefined;
  task.paused = undefined;
  task.pausedByAgentId = undefined;
  // abort-on-exit userPaused: only for user-source moves to todo (KTD-9).
  if (moveSource === "user" && toColumn === "todo") {
    task.userPaused = true;
  } else {
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

/** `merge` trait onEnter (in-review): scheduler-state clearing while
 *  preserving explicit per-task autoMerge overrides. The queue enqueue itself is
 *  in-txn and store-owned (handoff path); the field effects mirror the legacy
 *  in-review block. Keep this flag-ON path in sync with the flag-OFF inline
 *  block in store.ts. */
export function applyInReviewEnterEffects(ctx: DefaultWorkflowMoveContext): void {
  const { task, toColumn } = ctx;
  if (toColumn !== "in-review") return;
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
  if (
    (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "in-progress" || toColumn === "triage")) ||
    (fromColumn === "done" && (toColumn === "todo" || toColumn === "triage"))
  ) {
    task.workflowStepResults = undefined;
  }
  if (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "triage")) {
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
