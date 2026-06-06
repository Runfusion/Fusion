/**
 * ReviewerGate — drives the task-keyed Reviewer verdict run (company-model U6).
 *
 * On a company-model board (flag on + `isCompanyBoardIr`), a task entering the
 * in-review column triggers a Reviewer run executed as the board's Reviewer
 * effective agent. The persisted write-once verdict (in `task_reviewer_runs`,
 * via {@link TaskReviewerStore}) gates the exit from in-review — the gate itself
 * lives in `store.moveTask` (U6 block 2c); this module is the run DRIVER that
 * produces the verdict and handles the fail → backward-move / rework-budget /
 * needs-attention-diagnostic / recovery flows.
 *
 * Reuses the mission Validator's execution shape (read-only AI judge: no code
 * edits, no board task creation) but is task-keyed and self-contained so the
 * mission machinery stays untouched. The assertion evaluation is a pluggable
 * seam (`evaluate`) so:
 *   - production wires an AI-session-backed evaluator (mirrors
 *     MissionExecutionLoop.runValidation — readonly tools, structured-JSON parse);
 *   - tests supply a deterministic stub.
 * When no assertion is explicitly linked, the evaluator derives one lazily from
 * the task description / PROMPT.md (mirroring how mission features lazily link
 * Contract Assertions) — encapsulated in the evaluator.
 *
 * Idempotency: `driveReviewForTask` is a no-op when a run is already in flight
 * for the task or a terminal verdict already exists for the current round. This
 * is what makes the self-healing re-drive safe and the trigger seam's
 * "exactly once" non-critical.
 */

import type { TaskStore, TaskReviewerRun, TaskReviewerFailureReason, Settings } from "@fusion/core";
import {
  isCompanyModelEnabled,
  isCompanyBoardIr,
  resolveCompanyRoleColumnId,
  resolveColumnAgentForColumn,
  resolveMaxReworkCycles,
  resolveWorkflowIrForTask,
} from "@fusion/core";
import { createLogger } from "./logger.js";

const gateLog = createLogger("reviewer-gate");

/** Stable task-log action prefix recording the rework-budget-exhausted
 *  needs-attention diagnostic (U6). The board surfaces this as a distinct
 *  stuck-style badge; the task detail shows the diagnostic message. */
export const REVIEWER_NEEDS_ATTENTION_LOG_PREFIX = "Reviewer needs attention [rework-budget-exhausted]:";

/** Stable task-log action prefix recording a Reviewer fail verdict's feedback
 *  attached to the task before the backward move (U6). */
export const REVIEWER_FAIL_FEEDBACK_LOG_PREFIX = "Reviewer verdict [fail]:";

/** The structured verdict an evaluator returns for a task. */
export interface ReviewerEvaluation {
  status: "pass" | "fail" | "blocked" | "error";
  summary: string;
  failureReasons?: TaskReviewerFailureReason[];
}

/** Evaluator seam: judge the task (read-only) and return a structured verdict.
 *  `reworkRound` lets the evaluator factor in prior failure context if desired. */
export type ReviewerEvaluator = (input: {
  task: Awaited<ReturnType<TaskStore["getTask"]>>;
  reworkRound: number;
}) => Promise<ReviewerEvaluation>;

export interface ReviewerGateOptions {
  store: TaskStore;
  /** The assertion evaluator. Defaults to an error-returning stub so a
   *  misconfigured production wiring fails loudly rather than silently passing. */
  evaluate?: ReviewerEvaluator;
  /** Settings provider override (tests). Defaults to `store.getSettings()`. */
  getSettings?: () => Promise<Pick<Settings, "experimentalFeatures"> | undefined>;
  /** Backward-move target column on fail (default: the board's executor column,
   *  falling back to "in-progress"). */
  backwardTargetColumn?: string;
  /** Override the max rework budget (default: resolveMaxReworkCycles default). */
  maxReworkCycles?: number;
  /**
   * U7 verdict-driven enqueue seam ("Auto-merge enqueue is verdict-driven, not
   * entry-driven"). Fired exactly when a drive produces a PASS verdict on a
   * company-model board. The runtime wires this to consult the auto-merge
   * chokepoint (`shouldAutoMergeTask`) and route the task: auto-enqueue → the
   * merge queue; pr-subgraph → the unified PR sub-graph (no legacy enqueue);
   * manual-required → existing manual parking. Fire-and-forget + best-effort: a
   * throw is swallowed (logged) so the verdict itself is never lost; the
   * self-healing sweep re-evaluates a missed pass.
   */
  onVerdictPass?: (taskId: string) => void | Promise<void>;
}

/** The result of a single drive attempt (for tests/observability). */
export interface DriveResult {
  /** What the drive did. */
  outcome:
    | "skipped-flag-off"
    | "skipped-not-company-board"
    | "skipped-not-in-review"
    | "skipped-run-in-flight"
    | "skipped-verdict-exists"
    | "passed"
    | "failed-moved-backward"
    | "failed-budget-exhausted"
    | "blocked"
    | "error";
  run?: TaskReviewerRun;
}

const DEFAULT_EVALUATOR: ReviewerEvaluator = async () => ({
  status: "error",
  summary: "No Reviewer evaluator configured for ReviewerGate",
});

export class ReviewerGate {
  private store: TaskStore;
  private evaluate: ReviewerEvaluator;
  private getSettings: () => Promise<Pick<Settings, "experimentalFeatures"> | undefined>;
  private backwardTargetColumnOverride?: string;
  private maxReworkCyclesOverride?: number;
  private onVerdictPass?: (taskId: string) => void | Promise<void>;
  /** Task ids with a drive currently running, to dedupe concurrent triggers. */
  private inFlight = new Set<string>();

  constructor(options: ReviewerGateOptions) {
    this.store = options.store;
    this.evaluate = options.evaluate ?? DEFAULT_EVALUATOR;
    this.getSettings = options.getSettings ?? (() => this.store.getSettings());
    this.backwardTargetColumnOverride = options.backwardTargetColumn;
    this.maxReworkCyclesOverride = options.maxReworkCycles;
    this.onVerdictPass = options.onVerdictPass;
  }

  /** Late-bind the verdict-pass enqueue seam (U7). The runtime constructs the
   *  gate before the ProjectEngine's enqueue path exists, so this allows wiring
   *  it after construction. */
  setVerdictPassHandler(handler: (taskId: string) => void | Promise<void>): void {
    this.onVerdictPass = handler;
  }

  private get reviewerStore() {
    return this.store.getTaskReviewerStore();
  }

  private maxReworkCycles(): number {
    return this.maxReworkCyclesOverride ?? resolveMaxReworkCycles(undefined);
  }

  /**
   * Drive (or re-drive) the Reviewer run for a task currently in in-review on a
   * company-model board. Idempotent: a no-op when the flag is off, the board is
   * not a company board, the task is not in the reviewer column, a run is
   * already in flight, or a terminal verdict already exists for this round.
   */
  async driveReviewForTask(taskId: string): Promise<DriveResult> {
    const settings = await this.getSettings();
    if (!isCompanyModelEnabled(settings)) {
      return { outcome: "skipped-flag-off" };
    }
    if (this.inFlight.has(taskId)) {
      return { outcome: "skipped-run-in-flight" };
    }

    const ir = await resolveWorkflowIrForTask(this.store, taskId);
    if (!isCompanyBoardIr(ir)) {
      return { outcome: "skipped-not-company-board" };
    }
    const reviewerColumnId = resolveCompanyRoleColumnId(ir, "reviewer");
    const executorColumnId = resolveCompanyRoleColumnId(ir, "executor");

    const task = await this.store.getTask(taskId);
    if (reviewerColumnId === undefined || task.column !== reviewerColumnId) {
      return { outcome: "skipped-not-in-review" };
    }

    // Idempotency: already running, or already has a terminal verdict.
    if (this.reviewerStore.hasRunningRun(taskId)) {
      return { outcome: "skipped-run-in-flight" };
    }
    const existingVerdict = this.reviewerStore.getLatestVerdict(taskId);
    if (existingVerdict) {
      // A terminal verdict exists. `error` verdicts NEVER cover — a reaped orphan
      // produced no real judgment, so it must be re-driven (recovery path). A
      // `pass` is final. A `fail`/`blocked` covers only its own rework round: the
      // fail flow already moved the task backward, so a task parked back in
      // in-review at this point is either the same round (skip — avoid re-judging)
      // or a fresh round (re-drive). The round is keyed off the prior fail count.
      if (existingVerdict.status !== "error") {
        const priorFails = this.countPriorFails(taskId);
        if (existingVerdict.reworkRound >= priorFails) {
          return { outcome: "skipped-verdict-exists", run: existingVerdict };
        }
      }
    }

    const reviewerAgentId = resolveColumnAgentForColumn(ir, reviewerColumnId)?.agentId;
    const reworkRound = this.countPriorFails(taskId);

    this.inFlight.add(taskId);
    let run: TaskReviewerRun;
    try {
      run = this.reviewerStore.startReviewerRun(taskId, {
        boardId: this.store.getTaskBoardId(taskId) ?? "",
        reviewerAgentId,
        reworkRound,
      });

      let evaluation: ReviewerEvaluation;
      try {
        evaluation = await this.evaluate({ task, reworkRound });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        gateLog.error(`Reviewer evaluation threw for task ${taskId}: ${message}`);
        evaluation = { status: "error", summary: `Reviewer evaluation error: ${message}` };
      }

      const completed = this.reviewerStore.completeReviewerRun(run.id, {
        status: evaluation.status,
        summary: evaluation.summary,
        failureReasons: evaluation.failureReasons,
        writerAgentId: reviewerAgentId,
      });

      if (evaluation.status === "pass") {
        // U7: verdict-driven enqueue. A pass on a company board is the trigger
        // for the auto-merge handoff (deferred from in-review ENTRY). The handler
        // consults the chokepoint and routes (merge queue / PR sub-graph / manual).
        // Best-effort: a throw here must not lose the persisted pass verdict —
        // the self-healing sweep / the merger's periodic enqueue re-evaluate.
        if (this.onVerdictPass) {
          try {
            await this.onVerdictPass(taskId);
          } catch (err) {
            gateLog.warn(
              `onVerdictPass handler failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        return { outcome: "passed", run: completed };
      }
      if (evaluation.status === "blocked") {
        return { outcome: "blocked", run: completed };
      }
      if (evaluation.status === "error") {
        return { outcome: "error", run: completed };
      }

      // FAIL: attach feedback + either move backward (budget remaining) or park
      // with a needs-attention diagnostic (budget exhausted).
      // reworkRound is 0-based; after THIS fail the task will have (reworkRound+1)
      // total failures. The budget caps the number of automatic backward moves.
      const budget = this.maxReworkCycles();
      const failsAfterThis = reworkRound + 1;
      if (failsAfterThis >= budget) {
        await this.parkNeedsAttention(taskId, completed, budget);
        return { outcome: "failed-budget-exhausted", run: completed };
      }

      await this.moveBackwardWithFeedback(
        taskId,
        completed,
        this.backwardTargetColumnOverride ?? executorColumnId ?? "in-progress",
        reviewerAgentId,
      );
      return { outcome: "failed-moved-backward", run: completed };
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  /** Count the prior FAIL verdicts for a task (defines the current rework round
   *  — a 0-based index, so the first review is round 0). */
  private countPriorFails(taskId: string): number {
    return this.reviewerStore
      .listRunsForTask(taskId)
      .filter((r) => r.status === "fail").length;
  }

  /** Attach the fail feedback to the task log and move it backward as the
   *  Reviewer actor (the Reviewer is permitted to move cards backward, U3). */
  private async moveBackwardWithFeedback(
    taskId: string,
    run: TaskReviewerRun,
    targetColumn: string,
    reviewerAgentId: string | undefined,
  ): Promise<void> {
    const feedback = formatFailureFeedback(run);
    await this.store.logEntry(taskId, `${REVIEWER_FAIL_FEEDBACK_LOG_PREFIX} ${run.summary ?? "failed"}`, feedback);
    await this.store.moveTask(taskId, targetColumn as never, {
      actor: reviewerAgentId
        ? { kind: "agent", agentId: reviewerAgentId }
        : { kind: "agent" },
    });
  }

  /** Park the task in in-review with a persisted needs-attention diagnostic
   *  (rework budget exhausted) instead of looping forever. No further automatic
   *  backward move occurs. */
  private async parkNeedsAttention(
    taskId: string,
    run: TaskReviewerRun,
    budget: number,
  ): Promise<void> {
    const detail = formatFailureFeedback(run);
    await this.store.logEntry(
      taskId,
      `${REVIEWER_NEEDS_ATTENTION_LOG_PREFIX} ${budget} rework cycles exhausted`,
      `The Reviewer failed this task after ${budget} rework cycles; it is parked in ` +
        `in-review for human attention.\n${detail}`,
    );
  }

  /**
   * Recovery sweep for orphaned Reviewer runs (U6, mirrors the stale mission
   * validator-run sweep). Reaps running runs older than `maxAgeMs` to error, then
   * re-drives any task still parked in the reviewer column with no running run
   * and no terminal verdict for the current round — so a verdict-pending task is
   * never silently stranded.
   *
   * Returns counts for observability/tests.
   */
  async recoverOrphanedReviewerRuns(
    maxAgeMs: number,
    now = Date.now(),
  ): Promise<{ reapedCount: number; reDrivenCount: number }> {
    let reapedCount = 0;
    let reDrivenCount = 0;

    // 1. Reap stale running runs.
    const stale = this.reviewerStore.listStaleRunningRuns(maxAgeMs, now);
    const candidateTaskIds = new Set<string>();
    for (const run of stale) {
      this.reviewerStore.reapRun(
        run.id,
        `Reaped by self-healing: run running > ${maxAgeMs}ms with no live owner`,
      );
      reapedCount++;
      candidateTaskIds.add(run.taskId);
    }

    // 2. Re-drive tasks that are parked in in-review with no live run and no
    //    pass verdict (reaped ones, plus any verdict-pending orphan we observed).
    for (const taskId of candidateTaskIds) {
      try {
        if (this.reviewerStore.hasRunningRun(taskId)) continue;
        if (this.reviewerStore.hasPassingVerdict(taskId)) continue;
        const result = await this.driveReviewForTask(taskId);
        if (
          result.outcome === "passed" ||
          result.outcome === "failed-moved-backward" ||
          result.outcome === "failed-budget-exhausted" ||
          result.outcome === "blocked" ||
          result.outcome === "error"
        ) {
          reDrivenCount++;
        }
      } catch (err) {
        gateLog.warn(`Re-drive failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { reapedCount, reDrivenCount };
  }
}

/** Render a fail verdict's structured reasons into human-readable feedback. */
export function formatFailureFeedback(run: TaskReviewerRun): string {
  const lines: string[] = [];
  if (run.summary) lines.push(run.summary);
  for (const reason of run.failureReasons ?? []) {
    lines.push(`- ${reason.title}: ${reason.message}`);
    if (reason.expected) lines.push(`    expected: ${reason.expected}`);
    if (reason.actual) lines.push(`    actual: ${reason.actual}`);
  }
  return lines.join("\n");
}
