/**
 * Merge trait behavior (U7, R10) — `@fusion/engine` side.
 *
 * The merge trait turns merge/PR orchestration, merge strategy, squash posture
 * and file-scope enforcement mode into *configuration* over the substrate merge
 * capability (KTD-6). This module owns two things:
 *
 *   1. The merge trait's hook implementations, registered into core's trait
 *      registry via the `registerTraitHookImpl` DI seam (mirrors
 *      `setCreateFnAgent`):
 *        - `onEnter`  → enqueue the task onto the *persisted* merge-request
 *          queue (reuse the store's existing enqueue path). It NEVER awaits a
 *          merge inline; completion is driven by the merge-queue worker loop
 *          (`ProjectEngine.pickNextMergeTaskId` → `aiMergeTask` →
 *          `store.moveTask(id, "done")`) and resolved via the queue, so a
 *          graph walk / transition never blocks on a merge (the plan-002
 *          deadlock hazard).
 *        - `onExit`   → leaving the merge column dequeues a pending request.
 *          The store already performs this in-lock inside `moveTaskInternal`
 *          (`dequeueMergeQueueOnColumnExit`, a private method); the hook
 *          delegates to that existing mechanism rather than reimplementing the
 *          dequeue (see the onExit impl note). It is registered so the registry
 *          resolves a real impl (not a degraded no-op + audit warning).
 *
 *   2. `resolveMergePolicy` — a small read-through resolver consulted by
 *      `merger.ts` at its existing policy-knob read sites. When the
 *      `workflowColumns` flag is ON it reads the merge-trait config from the
 *      task's resolved workflow; otherwise (and when the workflow's merge
 *      trait carries no config, e.g. the built-in default workflow) it falls
 *      back to the existing settings knobs (`directMergeCommitStrategy`,
 *      `mergeStrategy`, scope settings) for back-compat.
 *
 * The three 2026-05-23 lost-work guards stay in `merger.ts` mechanics and are
 * UNREACHABLE from this config (KTD-6 / R10): sibling `fusion/fn-*` merge-target
 * rejection, line-anchored commit attribution, and the no-op-finalize
 * `modifiedFiles` preservation are not gated by any field this resolver
 * exposes.
 */

import {
  isWorkflowColumnsEnabled,
  registerTraitHookImpl,
  resolveWorkflowIrForTask,
  type DirectMergeCommitStrategy,
  type Settings,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowIrColumn,
} from "@fusion/core";
import { mergerLog } from "./logger.js";

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

// ── Merge trait hook implementations (DI into core's trait registry) ─────────

/**
 * onEnter: enqueue the task onto the persisted merge-request queue. NEVER awaits
 * a merge (KTD-6) — the merge-queue worker loop drives the actual merge and the
 * subsequent move to the `complete`-flagged column. Delegates to the store's
 * existing `enqueueMergeQueue` so the queue mechanics (audit, priority,
 * idempotent ON CONFLICT insert) are not reimplemented.
 *
 * Idempotent: `enqueueMergeQueue` is `ON CONFLICT(taskId) DO NOTHING`, so a
 * crash-then-rerun (recovery sweep replaying `transitionPending` hooks) holds
 * exactly one queue entry.
 *
 * Invoked by the store's post-commit hook runner with `(store, task)`.
 */
async function mergeOnEnter(store: TaskStore, task: Pick<Task, "id" | "priority">): Promise<void> {
  try {
    store.enqueueMergeQueue(task.id, { priority: task.priority });
  } catch (err) {
    // Enqueue rejects (e.g. task not in the merge column) degrade to a no-op:
    // the card is never stranded and the queue is never corrupted. The store
    // already audits the rejection.
    const message = err instanceof Error ? err.message : String(err);
    mergerLog.warn(`merge enqueue skipped for task ${task.id}: ${message}`);
  }
}

/**
 * onExit: leaving the merge column dequeues a pending (unleased) request.
 *
 * NOTE (design / delegation): the store ALREADY performs dequeue-on-column-exit
 * in-lock inside `moveTaskInternal` via the private
 * `dequeueMergeQueueOnColumnExit`, which runs unconditionally on every move and
 * owns the lease-aware semantics (drop an unleased entry; audit a leased one as
 * a stale-lease event). The merge trait's onExit therefore *delegates to that
 * existing mechanism* — it does not reissue a dequeue (which would be a
 * redundant second pass and could not see the lease columns without a store API
 * change the prompt forbids). Registering the hook makes the registry resolve a
 * real impl (not a degraded no-op + audit warning) and documents that the
 * substrate, not the trait, owns the dequeue mechanic (KTD-6: traits configure
 * and invoke capabilities; they never reimplement them).
 */
function mergeOnExit(): void {
  // Intentional no-op: dequeue is owned by the store's in-lock
  // `dequeueMergeQueueOnColumnExit` (see note above).
}

let registered = false;

/**
 * Register the merge trait's hook implementations into core's shared trait
 * registry. Idempotent (guarded), so importing this module (or calling it from
 * engine startup) more than once is safe. Mirrors the `setCreateFnAgent` DI
 * pattern: core declares the hook descriptors; the engine supplies the impls.
 */
export function registerMergeTraitHooks(): void {
  if (registered) return;
  registered = true;
  registerTraitHookImpl("merge", "onEnter", mergeOnEnter as never);
  registerTraitHookImpl("merge", "onExit", mergeOnExit as never);
}

/** Test-only: re-arm registration so a fresh registry can be exercised. */
export function __resetMergeTraitRegistrationForTests(): void {
  registered = false;
}

// Register on import (idempotent) so the engine's trait registry resolves real
// merge-hook impls without a separate wiring call.
registerMergeTraitHooks();
