/**
 * Merge trait behavior (U7, R10) — `@fusion/engine` side.
 *
 * The merge trait turns merge/PR orchestration, merge strategy, squash posture
 * and file-scope enforcement mode into *configuration* over the substrate merge
 * capability (KTD-6). This module owns `resolveMergePolicy` — a small
 * read-through resolver consulted by `merger.ts` at its existing policy-knob
 * read sites. It reads merge-trait config from the task's resolved workflow;
 * when the workflow's merge trait carries no config, e.g. the built-in default
 * workflow, it falls back to the existing settings knobs
 * (`directMergeCommitStrategy`, `mergeStrategy`, scope settings).
 *
 * The three 2026-05-23 lost-work guards stay in `merger.ts` mechanics and are
 * UNREACHABLE from this config (KTD-6 / R10): sibling `fusion/fn-*` merge-target
 * rejection, line-anchored commit attribution, and the no-op-finalize
 * `modifiedFiles` preservation are not gated by any field this resolver
 * exposes.
 */

import {
  isWorkflowColumnsEnabled,
  resolveWorkflowIrForTask,
  type DirectMergeCommitStrategy,
  type Settings,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowIrColumn,
} from "@fusion/core";

// ── Resolved merge policy ────────────────────────────────────────────────────

/** File-scope enforcement mode (R10). `custom` evaluates `rules` in place of
 *  the task's File Scope section. */
export type MergeFileScopeMode = "strict" | "warn" | "off" | "custom";

/** The merge strategy as authored on the trait. Direct-merge commit strategies
 *  plus `pr-only` (which routes to the pull-request flow without a direct
 *  merge). Absent on the trait → resolved from settings. */
export type MergeTraitStrategy = DirectMergeCommitStrategy | "pr-only";

/** Fully-resolved merge policy consumed by `merger.ts`. */
export interface ResolvedMergePolicy {
  /** Direct-merge commit strategy. For `pr-only` this is the fallback used if
   *  a direct merge is ever taken; `pullRequestOnly` is the authoritative
   *  routing signal. */
  commitStrategy: DirectMergeCommitStrategy;
  /** True when the trait authored `strategy: "pr-only"` — the merge is routed
   *  through the PR flow (enqueue-with-prState marker) without a direct merge. */
  pullRequestOnly: boolean;
  /** File-scope enforcement mode. */
  fileScope: MergeFileScopeMode;
  /** Custom scope rules (only meaningful when `fileScope === "custom"`). */
  fileScopeRules: string[];
  /** Where the policy came from — `workflow` when read from the task's merge
   *  trait config (flag ON), `settings` for the legacy/back-compat read-through. */
  source: "workflow" | "settings";
}

// ── Workflow IR resolution (read-only, flag-gated) ───────────────────────────
// The selection → builtin/custom → default rule is shared via @fusion/core's
// resolveWorkflowIrForTask (GitHub #1402); a missing/corrupt definition degrades
// to the default workflow so policy resolution never throws.

/** Find the column the task currently sits in (by id). */
function findColumn(ir: WorkflowIr, columnId: string): WorkflowIrColumn | undefined {
  if (ir.version !== "v2") return undefined;
  return ir.columns.find((c) => c.id === columnId);
}

/** Extract the merge trait's config from a column, if it carries one. */
function readMergeTraitConfig(column: WorkflowIrColumn | undefined): Record<string, unknown> | undefined {
  if (!column) return undefined;
  const ct = column.traits.find((t) => t.trait === "merge");
  if (!ct) return undefined;
  return ct.config ?? {};
}

// ── Policy read-through resolver ─────────────────────────────────────────────

const VALID_COMMIT_STRATEGIES: ReadonlySet<string> = new Set([
  "auto",
  "always-squash",
  "always-rebase",
]);
const VALID_FILE_SCOPE_MODES: ReadonlySet<string> = new Set(["strict", "warn", "off", "custom"]);

/** The settings-only fallback policy (legacy / flag-OFF / no trait config). */
function settingsPolicy(settings: Pick<Settings, "directMergeCommitStrategy" | "mergeStrategy">): ResolvedMergePolicy {
  return {
    commitStrategy: settings.directMergeCommitStrategy ?? "always-squash",
    pullRequestOnly: settings.mergeStrategy === "pull-request",
    // Legacy file-scope behavior is a soft warn (see
    // `enforceSquashFileScopeInvariant`, which logs + proceeds), so the
    // back-compat read-through reports `warn` — the existing call path is
    // unchanged when the flag is OFF.
    fileScope: "warn",
    fileScopeRules: [],
    source: "settings",
  };
}

/**
 * Resolve the effective merge policy for a task (R10). Flag ON: read the merge
 * trait's config from the task's resolved workflow column; fall back to
 * settings for any field the trait leaves unset (the built-in default
 * workflow's merge trait carries no config, so it resolves entirely from
 * settings — verbatim back-compat). Flag OFF: settings only.
 *
 * The lost-work guard trio is intentionally NOT represented here: no field this
 * resolver returns can disable the sibling-branch rejection, line-anchored
 * attribution, or the no-op-finalize `modifiedFiles` guard (KTD-6).
 */
export async function resolveMergePolicy(
  store: TaskStore,
  task: Pick<Task, "id" | "column">,
  settings?: Pick<Settings, "directMergeCommitStrategy" | "mergeStrategy" | "experimentalFeatures">,
): Promise<ResolvedMergePolicy> {
  const resolvedSettings = settings ?? (await store.getSettings());
  const fallback = settingsPolicy(resolvedSettings);

  if (!isWorkflowColumnsEnabled(resolvedSettings)) {
    return fallback;
  }

  let config: Record<string, unknown> | undefined;
  try {
    const ir = await resolveWorkflowIrForTask(store, task.id);
    config = readMergeTraitConfig(findColumn(ir, task.column));
  } catch {
    config = undefined;
  }
  // No merge trait, or a merge trait carrying no policy fields (e.g. the
  // built-in default workflow's `{ trait: "merge" }` with no config) → resolve
  // entirely from settings (verbatim back-compat).
  if (!config || (config.strategy === undefined && config.fileScope === undefined)) {
    return fallback;
  }

  // strategy → commitStrategy + pullRequestOnly
  let commitStrategy = fallback.commitStrategy;
  let pullRequestOnly = fallback.pullRequestOnly;
  const rawStrategy = config.strategy;
  if (rawStrategy === "pr-only") {
    pullRequestOnly = true;
  } else if (typeof rawStrategy === "string" && VALID_COMMIT_STRATEGIES.has(rawStrategy)) {
    commitStrategy = rawStrategy as DirectMergeCommitStrategy;
    pullRequestOnly = false;
  }

  // fileScope → mode + rules
  let fileScope = fallback.fileScope;
  const rawFileScope = config.fileScope;
  if (typeof rawFileScope === "string" && VALID_FILE_SCOPE_MODES.has(rawFileScope)) {
    fileScope = rawFileScope as MergeFileScopeMode;
  }
  const fileScopeRules = Array.isArray(config.rules)
    ? (config.rules.filter((r): r is string => typeof r === "string"))
    : [];

  return {
    commitStrategy,
    pullRequestOnly,
    fileScope,
    fileScopeRules,
    source: "workflow",
  };
}

// ── Merge trait hooks: owned by core, NOT this module ────────────────────────
//
// The engine deliberately does NOT register `merge` onEnter/onExit impls.
//
// `merge.onEnter` is invoked by core's `applyDefaultWorkflowMoveEffects` as
// `impl(ctx)` with a single `DefaultWorkflowMoveContext` — an in-lock,
// pre-commit, in-memory field-mutation phase that carries NO store handle. Core
// registers the correct ctx-shaped impl (`applyInReviewEnterEffects`) via
// `registerDefaultWorkflowHooks()`; it clears the in-review scheduler state
// (`status: queued`, `blockedBy`, `overlapBlockedBy`) and mirrors the flag-OFF
// inline block in `store.ts`.
//
// An earlier version of this module registered a `mergeOnEnter(store, task)`
// impl here that enqueued onto the merge queue. That was wrong on three counts:
//   1. Signature mismatch — the only caller passes `ctx`, so `store`/`task` bound
//      to `(ctx, undefined)` and dereferencing `task.id` threw at runtime
//      (TypeError: cannot read 'id' of undefined) during the hold-release sweep.
//   2. Slot collision — it clobbered core's field-effects adapter on the
//      last-write-wins registry, dropping the in-review state clears.
//   3. Redundant responsibility — the queue enqueue is in-txn and store-owned on
//      the handoff path (`store.ts` enqueues on `fromHandoff`, shared by both
//      flag states), and direct non-handoff entry into `in-review` is audited as
//      a handoff-invariant violation. There is no sanctioned entry into the
//      merge column that needs a hook-driven enqueue.
//
// `merge.onExit` similarly needs no impl: the store dequeues in-lock via the
// private `dequeueMergeQueueOnColumnExit` on every move (lease-aware), and the
// ctx move-effects path never invokes `merge.onExit` at all.

/*
FNXC:MergeTrait 2026-06-18-13:05:
The engine must not register `merge.onEnter` or `merge.onExit` hooks because core owns the ctx-shaped `merge.onEnter` field-effects adapter. Keeping hook registration out of this module prevents last-write-wins registry collisions and preserves in-review scheduler-state clears under workflow columns.
*/
