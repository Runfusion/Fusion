/**
 * The one auto-merge chokepoint (company-model U7, KTD "One auto-merge
 * chokepoint, consulted additively").
 *
 * `shouldAutoMergeTask` is the single predicate every auto-merge *trigger* layer
 * consults (merger enqueue gate, self-healing sweeps, the moved-to-in-review fast
 * path, the verdict-pass enqueue seam). It returns a discriminated routing result
 * — not a bare boolean — so each trigger gate can route to the right destination:
 *
 *   - `auto-enqueue`     → hand the task to the legacy merge queue.
 *   - `pr-subgraph`      → the board is PR-mode; the unified PR entity sub-graph
 *                          (`pr-create` …) drives completion. NEVER the legacy
 *                          queue (the PR plan's R14).
 *   - `manual-required`  → park for a human merge decision (explicit per-task
 *                          `autoMerge: false`, or an explicit manual-approval
 *                          marker). Never auto-enqueued.
 *   - `blocked`          → not eligible *yet* (company board, verdict not pass).
 *                          NOT stranded: the verdict-completion path re-evaluates
 *                          and the self-healing sweep re-drives.
 *
 * Gating is ADDITIVE relative to the global setting, exactly preserving the
 * trigger-gate semantics established by `allowsAutoMergeProcessing` (see
 * `docs/solutions/logic-errors/per-task-auto-merge-override-ignored-by-trigger-gates.md`
 * and CONCEPTS.md "Auto-merge"):
 *
 *   - global ON  + per-task unset/true  → flows through (auto-enqueue / pr-subgraph)
 *   - global ON  + per-task false       → manual-required (parked, NOT skipped, so
 *                                         the merger's manual-required path + merged
 *                                         finalization sweeps still see it)
 *   - global OFF + per-task true        → flows through (the override path)
 *   - global OFF + per-task unset/false → manual-required
 *
 * Layered on top, only when the company-model flag is on AND the board is a
 * company board (`isCompanyBoard`), the enqueue is VERDICT-DRIVEN: a pass verdict
 * is required before `auto-enqueue` / `pr-subgraph`; pending/fail → `blocked`; an
 * explicit manual-approval marker → `manual-required`, never auto. Flag-off /
 * non-company boards degrade EXACTLY to the additive global×override behavior
 * (the verdict is never consulted) — byte-identical to today.
 *
 * The function is pure: callers pass the resolved facts (task fields, settings,
 * merge mode, whether the board is PR-mode / a company board, the latest verdict
 * status, the manual-approval marker) so `@fusion/core` stays dependency-clean.
 * The engine-side binding lives in `auto-merge-gate-engine.ts`.
 */

import type { Settings, Task } from "./types.js";

/** Where a trigger gate should route the task. */
export type AutoMergeRoute =
  | "auto-enqueue"
  | "pr-subgraph"
  | "manual-required"
  | "blocked";

/** The latest Reviewer verdict status relevant to gating (company boards only).
 *  `undefined` means no verdict has been recorded yet (pending). */
export type ReviewerVerdictStatus = "pass" | "fail" | "pending" | undefined;

export interface ShouldAutoMergeInput {
  /** Per-task auto-merge override (explicit true/false) or undefined (unset). */
  task: Pick<Task, "autoMerge">;
  /** Global auto-merge setting. */
  settings: Pick<Settings, "autoMerge">;
  /**
   * True when the board's workflow IR contains any `pr-*` node kind. PR-mode
   * boards merge exclusively through the `pr-merge` node — never the legacy
   * queue. When true, the route is always `pr-subgraph` (on a pass / processing-
   * eligible task) regardless of any residual `autoMerge` stamp.
   */
  prMode: boolean;
  /**
   * True when the company-model flag is ON *and* the board is a company board
   * (`isCompanyBoardIr`). Only then is the enqueue verdict-driven. Off-flag and
   * non-company boards degrade to global×override only.
   */
  isCompanyBoard: boolean;
  /** Latest Reviewer verdict status. Consulted only when `isCompanyBoard`. */
  verdictStatus?: ReviewerVerdictStatus;
  /**
   * True when the task carries the explicit manual-approval marker (an EXPLICIT
   * merge-request approval affordance, not a human drag). Such tasks route
   * `manual-required`, never auto.
   */
  hasManualApprovalMarker?: boolean;
}

export interface ShouldAutoMergeResult {
  route: AutoMergeRoute;
  reason: string;
}

/**
 * The additive global×override processing decision shared with
 * `allowsAutoMergeProcessing` (task-merge.ts). Returns whether the task should be
 * *processed at all* by the auto-merge machinery.
 *
 * - global ON  → always true (per-task false tasks flow to the merger which parks
 *   them as manual-required; resolution would starve that path).
 * - global OFF → only explicit per-task true.
 */
function allowsProcessing(
  task: Pick<Task, "autoMerge">,
  settings: Pick<Settings, "autoMerge">,
): boolean {
  return settings.autoMerge !== false || task.autoMerge === true;
}

/**
 * The one auto-merge chokepoint. Pure, additive, verdict-aware. See the module
 * doc for the full routing semantics.
 */
export function shouldAutoMergeTask(input: ShouldAutoMergeInput): ShouldAutoMergeResult {
  const { task, settings, prMode, isCompanyBoard, verdictStatus, hasManualApprovalMarker } = input;

  // 1. Per-task / global disposition (additive, mirrors `allowsAutoMergeProcessing`).
  //    - Explicit per-task `false` → manual-required even when global is on (the
  //      user opted this task out of auto-merge).
  //    - Global off without an explicit per-task `true` → manual-required.
  //    `manual-required` means "do not AUTO-enqueue for autonomous completion".
  //    NOTE for trigger gates: this is distinct from "skip processing entirely".
  //    Under global-on, an explicit-`false` task is still PROCESSED by the merger
  //    (it parks it as `manual-required`, and merged-task finalization sweeps
  //    still see it) — so trigger gates must treat `manual-required` as
  //    "flows through to the merger, which parks", NOT as "skip" (only `blocked`
  //    and `pr-subgraph` are hard skips). See the per-task auto-merge-override
  //    solution doc: resolution that excludes these would break manual-required
  //    parking + finalization.
  if (task.autoMerge === false) {
    return { route: "manual-required", reason: "per-task autoMerge disabled — manual merge required" };
  }
  if (!allowsProcessing(task, settings)) {
    return {
      route: "manual-required",
      reason: "global auto-merge off and no per-task override — manual merge required",
    };
  }

  // 2. Explicit manual-approval marker (an EXPLICIT merge-request approval, not a
  //    human drag): always manual, never auto. Checked before the verdict so an
  //    approved task is not re-gated on a stale/pending verdict.
  if (hasManualApprovalMarker) {
    return {
      route: "manual-required",
      reason: "task carries an explicit manual-approval marker — manual merge",
    };
  }

  // 3. Company-board verdict gate (flag-on company boards only). The enqueue is
  //    verdict-driven: a pass is required; pending/fail blocks (not stranded —
  //    the verdict-completion path + self-healing re-evaluate).
  if (isCompanyBoard) {
    if (verdictStatus !== "pass") {
      return {
        route: "blocked",
        reason:
          verdictStatus === "fail"
            ? "Reviewer verdict is fail — blocked from auto-merge"
            : "Reviewer verdict pending — blocked until pass",
      };
    }
  }

  // 4. Route by merge mode. PR-mode boards never touch the legacy queue.
  if (prMode) {
    return { route: "pr-subgraph", reason: "PR-mode board — routes to PR entity sub-graph" };
  }

  return { route: "auto-enqueue", reason: "eligible — enqueue to merge queue" };
}
