/**
 * TaskReviewerStore — persistence for task-keyed Reviewer verdict runs (U6).
 *
 * The company model has the Reviewer absorb the mission Validator: entering the
 * in-review column on a company-model board starts a run keyed to the board task,
 * and the persisted write-once verdict gates the exit from in-review. This store
 * mirrors the `mission-store.ts` validator-run methods (startValidatorRun /
 * completeValidatorRun / listStaleRunningValidatorRuns / reapValidatorRun) but
 * keyed to a task/board — the mission tables and their FK constraints stay
 * untouched, so mission-path integrity is unaffected.
 *
 * WRITE-ONCE INVARIANT (U6):
 *  - `completeReviewerRun` rejects (typed {@link ReviewerRunTerminalError}) when
 *    the run is already terminal (pass | fail | blocked | error).
 *  - A `pass` verdict may only be written by the run's `reviewerAgentId`
 *    identity; a mismatch is rejected (typed {@link ReviewerRunWriterError}).
 *    Non-pass verdicts (fail/blocked/error — e.g. a recovery reap) are not
 *    identity-gated so the self-healing sweep can terminate an orphan.
 *
 * Distinct from MissionStore's run engine — task verdicts persist in their own
 * `task_reviewer_runs` table. The two share no rows and no FKs.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import {
  type TaskReviewerRun,
  type TaskReviewerRunStatus,
  type TaskReviewerFailureReason,
  TERMINAL_TASK_REVIEWER_RUN_STATUSES,
} from "./mission-types.js";

/**
 * Stable task-log action prefix recording the AE6 human manual-approval marker:
 * a human owner dragged a task out of in-review on a company-model board without
 * a passing Reviewer verdict. U7 scans for this prefix to route the completion
 * manual-never-auto. The suffix is the Reviewer verdict status at approval (or
 * `no-verdict`).
 */
export const MANUAL_APPROVAL_LOG_PREFIX = "Manual approval (in-review exit, verdict=";

/** True when a task's log carries the AE6 human manual-approval marker. */
export function hasManualApprovalMarker(
  task: { log?: Array<{ action: string }> },
): boolean {
  return (task.log ?? []).some((e) => e.action.startsWith(MANUAL_APPROVAL_LOG_PREFIX));
}

/** Thrown when completing a run that is already terminal (write-once). */
export class ReviewerRunTerminalError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: TaskReviewerRunStatus,
  ) {
    super(
      `Reviewer run '${runId}' is already terminal (status='${currentStatus}'); ` +
        `the verdict is write-once and cannot be re-written`,
    );
    this.name = "ReviewerRunTerminalError";
  }
}

/** Thrown when a non-owner identity attempts to write a `pass` verdict. */
export class ReviewerRunWriterError extends Error {
  constructor(
    public readonly runId: string,
    public readonly expectedAgentId: string | undefined,
    public readonly actualAgentId: string | undefined,
  ) {
    super(
      `Reviewer run '${runId}' pass verdict may only be written by its reviewer ` +
        `identity '${expectedAgentId ?? "(none)"}'; got '${actualAgentId ?? "(none)"}'`,
    );
    this.name = "ReviewerRunWriterError";
  }
}

interface TaskReviewerRunRow {
  id: string;
  taskId: string;
  boardId: string;
  status: string;
  summary: string | null;
  failureReasons: string | null;
  reviewerAgentId: string | null;
  reworkRound: number;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A completion verdict written to a run. */
export interface ReviewerVerdict {
  /** Terminal status to write. */
  status: "pass" | "fail" | "blocked" | "error";
  /** Verdict summary. */
  summary?: string;
  /** Structured failure reasons (for fail/blocked). */
  failureReasons?: TaskReviewerFailureReason[];
  /** The writer's effective-agent identity. Required + enforced for `pass`. */
  writerAgentId?: string;
}

export type TaskReviewerStoreEvents = {
  "reviewer-run:started": [TaskReviewerRun];
  "reviewer-run:completed": [TaskReviewerRun];
};

export class TaskReviewerStore extends EventEmitter<TaskReviewerStoreEvents> {
  constructor(private db: Database) {
    super();
    this.setMaxListeners(100);
  }

  private rowToRun(row: TaskReviewerRunRow): TaskReviewerRun {
    let failureReasons: TaskReviewerFailureReason[] | undefined;
    if (row.failureReasons) {
      try {
        const parsed = JSON.parse(row.failureReasons);
        if (Array.isArray(parsed)) failureReasons = parsed as TaskReviewerFailureReason[];
      } catch {
        failureReasons = undefined;
      }
    }
    return {
      id: row.id,
      taskId: row.taskId,
      boardId: row.boardId,
      status: row.status as TaskReviewerRunStatus,
      summary: row.summary ?? undefined,
      failureReasons,
      reviewerAgentId: row.reviewerAgentId ?? undefined,
      reworkRound: row.reworkRound,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private generateRunId(): string {
    return `RR-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  /**
   * Start a Reviewer run for a task entering in-review. The run starts in
   * `running` status owned by `reviewerAgentId` (the board's Reviewer effective
   * agent). `reworkRound` should be the count of prior fail cycles for the task.
   */
  startReviewerRun(
    taskId: string,
    options: { boardId?: string; reviewerAgentId?: string; reworkRound?: number } = {},
  ): TaskReviewerRun {
    const now = new Date().toISOString();
    const run: TaskReviewerRun = {
      id: this.generateRunId(),
      taskId,
      boardId: options.boardId ?? "",
      status: "running",
      reviewerAgentId: options.reviewerAgentId,
      reworkRound: options.reworkRound ?? 0,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO task_reviewer_runs
          (id, taskId, boardId, status, summary, failureReasons, reviewerAgentId, reworkRound, startedAt, completedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.boardId,
        run.status,
        null,
        null,
        run.reviewerAgentId ?? null,
        run.reworkRound,
        run.startedAt,
        null,
        run.createdAt,
        run.updatedAt,
      );

    this.db.bumpLastModified();
    this.emit("reviewer-run:started", run);
    return run;
  }

  /**
   * Complete a Reviewer run with a verdict. Write-once:
   *  - throws {@link ReviewerRunTerminalError} when the run is already terminal;
   *  - throws {@link ReviewerRunWriterError} when a `pass` verdict is written by
   *    an identity other than the run's `reviewerAgentId`.
   */
  completeReviewerRun(runId: string, verdict: ReviewerVerdict): TaskReviewerRun {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Reviewer run '${runId}' not found`);
    }
    if (TERMINAL_TASK_REVIEWER_RUN_STATUSES.has(existing.status)) {
      throw new ReviewerRunTerminalError(runId, existing.status);
    }
    if (verdict.status === "pass") {
      // A pass may only be written by the run's reviewer identity. When the run
      // has no recorded reviewer identity, any writer is rejected (fail closed).
      if (
        !existing.reviewerAgentId ||
        verdict.writerAgentId !== existing.reviewerAgentId
      ) {
        throw new ReviewerRunWriterError(
          runId,
          existing.reviewerAgentId,
          verdict.writerAgentId,
        );
      }
    }

    const now = new Date().toISOString();
    const failureReasonsJson =
      verdict.failureReasons && verdict.failureReasons.length > 0
        ? JSON.stringify(verdict.failureReasons)
        : null;

    this.db
      .prepare(
        `UPDATE task_reviewer_runs SET
          status = ?, summary = ?, failureReasons = ?, completedAt = ?, updatedAt = ?
         WHERE id = ?`,
      )
      .run(verdict.status, verdict.summary ?? null, failureReasonsJson, now, now, runId);

    this.db.bumpLastModified();
    const updated = this.getRun(runId)!;
    this.emit("reviewer-run:completed", updated);
    return updated;
  }

  /** Get a run by id, or undefined. */
  getRun(runId: string): TaskReviewerRun | undefined {
    const row = this.db
      .prepare(`SELECT * FROM task_reviewer_runs WHERE id = ?`)
      .get(runId) as TaskReviewerRunRow | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  /** All runs for a task, newest first. */
  listRunsForTask(taskId: string): TaskReviewerRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_reviewer_runs WHERE taskId = ? ORDER BY startedAt DESC, rowid DESC`)
      .all(taskId) as TaskReviewerRunRow[];
    return rows.map((r) => this.rowToRun(r));
  }

  /** The most recent run for a task (any status), or undefined. */
  getLatestRun(taskId: string): TaskReviewerRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM task_reviewer_runs WHERE taskId = ? ORDER BY startedAt DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as TaskReviewerRunRow | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  /**
   * The latest TERMINAL verdict for a task, or undefined when no run has yet
   * reached a terminal status. The done-transition gate consults this: an agent
   * may only exit in-review when the latest verdict is `pass`.
   */
  getLatestVerdict(taskId: string): TaskReviewerRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM task_reviewer_runs
         WHERE taskId = ? AND status IN ('pass','fail','blocked','error')
         ORDER BY completedAt DESC, startedAt DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as TaskReviewerRunRow | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  /** True when the latest terminal verdict for a task is `pass`. */
  hasPassingVerdict(taskId: string): boolean {
    return this.getLatestVerdict(taskId)?.status === "pass";
  }

  /** True when the task has a currently-running (non-terminal) run. */
  hasRunningRun(taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM task_reviewer_runs
         WHERE taskId = ? AND status IN ('pending','running') LIMIT 1`,
      )
      .get(taskId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  /**
   * List running/pending runs whose `startedAt` is older than the supplied age
   * threshold — candidates the self-healing sweep reaps to `error` (mirror of
   * MissionStore.listStaleRunningValidatorRuns).
   */
  listStaleRunningRuns(maxAgeMs: number, now = Date.now()): TaskReviewerRun[] {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM task_reviewer_runs
         WHERE status IN ('pending','running') AND startedAt < ?
         ORDER BY startedAt ASC`,
      )
      .all(cutoff) as TaskReviewerRunRow[];
    return rows.map((r) => this.rowToRun(r));
  }

  /**
   * Reap a stale/orphaned running run to `error` (mirror of
   * MissionStore.reapValidatorRun). A no-op when the run is already terminal.
   * Not identity-gated: recovery must be able to terminate an orphan whose owner
   * is gone. The reason is recorded in the summary.
   */
  reapRun(runId: string, reason: string): TaskReviewerRun {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Reviewer run '${runId}' not found`);
    }
    if (TERMINAL_TASK_REVIEWER_RUN_STATUSES.has(existing.status)) {
      return existing;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE task_reviewer_runs SET status = 'error', summary = ?, completedAt = ?, updatedAt = ? WHERE id = ?`,
      )
      .run(reason, now, now, runId);
    this.db.bumpLastModified();
    const updated = this.getRun(runId)!;
    this.emit("reviewer-run:completed", updated);
    return updated;
  }
}
