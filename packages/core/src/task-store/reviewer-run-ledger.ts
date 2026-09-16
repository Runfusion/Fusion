import { sql } from "drizzle-orm";
import type { DbTransaction } from "../postgres/data-layer.js";
import type { TaskStore } from "../store.js";

/*
FNXC:ReviewLaneDispatch 2026-09-09 (STAS-205):
`task_reviewer_runs` had a schema and zero writers, so nothing could answer "has reviewer
work already begun for this card?" and a surfaced verdict could exist with no durable
attempt behind it. This module is the ledger's only writer. The open run row is the
idempotency key the dispatch sweep reads, so a restart re-derives dispatch state from
committed rows rather than process memory.
*/

/** `running` is the un-finished state; every other value is terminal for that attempt. */
export type ReviewerRunStatus = "running" | "approve" | "revise" | "skipped" | "failed";

export const TERMINAL_REVIEWER_RUN_STATUSES = ["approve", "revise", "skipped", "failed"] as const;

export interface ReviewerRunRow {
  id: string;
  taskId: string;
  reviewerAgentId: string;
  status: ReviewerRunStatus;
  reworkRound: number;
  startedAt: string;
  completedAt: string | null;
  /**
   * Set by supersession. Invalidation marks history without completing it, so the live-row
   * predicate needs this column explicitly: an invalidated row keeps `completedAt = null` and
   * must not be mistaken for the live attempt (#3619 review round 3).
   */
  invalidatedAt: string | null;
}

export interface OpenReviewerRunInput {
  projectId: string;
  taskId: string;
  /**
   * The board (workflow definition id) the card sat on when the review opened, and the value the
   * column requires. The schema's own "no board" value is `""` (its default), which is what a card
   * running the default fallback gets — provenance names a board only for a resolved selection, and
   * inventing one would misattribute the attempt. Nullable here once meant "live tasks carry no
   * board", but the column is NOT NULL: passing null failed the INSERT (caught by
   * review-lane-cli-entry-dispatch.pg.test.ts, the first caller this table ever had).
   */
  boardId: string;
  reviewerAgentId: string;
  reworkRound: number;
  /** ISO-8601 review start time; recorded even if the attempt never finishes. */
  at: string;
}

/**
 * One live row per (project, task): the partial unique index `task_reviewer_runs_live_unique`
 * rejects a second unfinished attempt instead of letting a second sweep tick double-dispatch.
 * "Live" means neither completed nor invalidated — an attempt that can still become a verdict —
 * which is the same definition the sweep classifier uses, so an index conflict and a classifier
 * "already dispatched" verdict can never disagree. A conflict returns `created: false`, which the
 * caller reads as "already dispatched" rather than as an error.
 */
export async function openReviewerRunInTransaction(
  tx: DbTransaction,
  input: OpenReviewerRunInput,
): Promise<{ created: boolean; id: string | null }> {
  const id = `revrun_${input.taskId}_r${input.reworkRound}_${input.at}`;
  const rows = await tx.execute(sql`
    INSERT INTO project.task_reviewer_runs
      (project_id, id, task_id, board_id, status, rework_round, reviewer_agent_id, started_at, created_at, updated_at)
    VALUES
      (${input.projectId}, ${id}, ${input.taskId}, ${input.boardId}, 'running', ${input.reworkRound},
       ${input.reviewerAgentId}, ${input.at}, ${input.at}, ${input.at})
    ON CONFLICT (project_id, task_id) WHERE invalidated_at IS NULL AND completed_at IS NULL DO NOTHING
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { created: rows.length > 0, id: rows[0]?.id ?? null };
}

/** Terminal transition for the attempt, so the outcome survives restart and rework. */
export async function completeReviewerRunInTransaction(
  tx: DbTransaction,
  input: {
    projectId: string;
    id: string;
    /** The completion is additionally bound to this task: a caller that pairs a card with another card's run id completes nothing (#3619 review round 3). */
    taskId: string;
    status: Exclude<ReviewerRunStatus, "running">;
    at: string;
    summary?: string | null;
    failureReasons?: string[] | null;
  },
): Promise<boolean> {
  /*
  FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review C4):
  Completion is a ONE-WAY transition, guarded in the UPDATE itself: only a still-running, still-
  live row may take a terminal status. Without the guard, a late or duplicate completion (a stalled
  reviewer session whose callback finally lands after the sweep already superseded the attempt and
  dispatched a replacement) could overwrite a recorded approve/revise verdict or resurrect an
  invalidated attempt — rewriting review history from a straggling callback. `false` means the row
  had already left the running state; callers treat it as an already-settled attempt, not an error.
  */
  const rows = await tx.execute(sql`
    UPDATE project.task_reviewer_runs
       SET status = ${input.status},
           completed_at = ${input.at},
           updated_at = ${input.at},
           summary = COALESCE(${input.summary ?? null}, summary),
           failure_reasons = COALESCE(${input.failureReasons ? JSON.stringify(input.failureReasons) : null}, failure_reasons)
     WHERE project_id = ${input.projectId} AND id = ${input.id}
       AND task_id = ${input.taskId}
       AND status = 'running'
       AND invalidated_at IS NULL
       AND completed_at IS NULL
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Store-level entry point for callers outside task-store (the dispatch sweep), which have a
 * TaskStore rather than a transaction. `asyncLayer` is the same accessor the move path uses,
 * so ledger writes commit through one data layer instead of a second one.
 */
export async function openReviewerRunForTask(
  store: TaskStore,
  input: { taskId: string; boardId: string; reviewerAgentId: string; reworkRound: number; at: string },
): Promise<{ created: boolean; id: string | null }> {
  const projectId = requireProjectId(store, "openReviewerRunForTask", input.taskId);
  return projectId.layer.transactionImmediate((tx: DbTransaction) =>
    openReviewerRunInTransaction(tx, { ...input, projectId: projectId.projectId }),
  );
}

/**
 * Store-level counterpart of `completeReviewerRunInTransaction` for engine callers.
 * Returns whether this call performed the transition (`false` = the attempt had already settled).
 */
export async function completeReviewerRunForTask(
  store: TaskStore,
  input: {
    taskId: string;
    id: string;
    status: Exclude<ReviewerRunStatus, "running">;
    at: string;
    summary?: string | null;
    failureReasons?: string[] | null;
  },
): Promise<boolean> {
  const { layer, projectId } = requireProjectId(store, "completeReviewerRunForTask", input.taskId);
  return layer.transactionImmediate((tx: DbTransaction) => completeReviewerRunInTransaction(tx, { ...input, projectId }));
}

/**
 * Store-level counterpart of `findLiveReviewerRun` for engine callers holding a TaskStore.
 */
export async function findLiveReviewerRunForTask(store: TaskStore, taskId: string): Promise<ReviewerRunRow | null> {
  const { layer, projectId } = requireProjectId(store, "findLiveReviewerRunForTask", taskId);
  return layer.transactionImmediate((tx: DbTransaction) => findLiveReviewerRun(tx, { projectId, taskId }));
}

/**
 * Every attempt this card has ever had, oldest first, superseded rows included. The dispatch
 * sweep derives its anti-loop budget from these committed rows rather than from counters in
 * process memory, so a restart cannot hand a wedged card a fresh budget.
 */
export async function listReviewerRunsForTask(store: TaskStore, taskId: string): Promise<ReviewerRunRow[]> {
  const { layer, projectId } = requireProjectId(store, "listReviewerRunsForTask", taskId);
  return layer.transactionImmediate((tx: DbTransaction) => listReviewerRuns(tx, { projectId, taskId }));
}

/**
 * Store-level entry point for taking a stalled attempt out of the live slot. Callers must
 * supersede the stale row before opening its replacement: the partial unique index allows only
 * one live attempt per card, so an undispatchable zombie would otherwise block every retry.
 */
export async function invalidateReviewerRunsForTask(
  store: TaskStore,
  taskId: string,
  at: string,
): Promise<number> {
  const { layer, projectId } = requireProjectId(store, "invalidateReviewerRunsForTask", taskId);
  return layer.transactionImmediate((tx: DbTransaction) =>
    invalidateReviewerRunsInTransaction(tx, { projectId, taskId, at }),
  );
}

/**
 * Ledger rows are project-scoped, and an unbound data layer would write rows no reader can
 * query. Both facts are required, so they fail loud instead of defaulting.
 */
function requireProjectId(store: TaskStore, fnName: string, taskId: string): { layer: NonNullable<TaskStore["asyncLayer"]>; projectId: string } {
  const layer = store.asyncLayer;
  if (!layer) throw new Error(`${fnName} requires the async data layer (task ${taskId})`);
  const projectId = layer.projectId;
  if (!projectId) throw new Error(`${fnName} requires a project-bound data layer (task ${taskId})`);
  return { layer, projectId };
}

/**
 * A newer commit makes prior attempts evidence about an older tip, not the current one.
 * Invalidation marks history rather than deleting it, so the rework round can advance and
 * the pre-existing attempts stay attributable.
 */
export async function invalidateReviewerRunsInTransaction(
  tx: DbTransaction,
  input: { projectId: string; taskId: string; at: string },
): Promise<number> {
  const rows = await tx.execute(sql`
    UPDATE project.task_reviewer_runs
       SET invalidated_at = ${input.at}, updated_at = ${input.at}
     WHERE project_id = ${input.projectId} AND task_id = ${input.taskId} AND invalidated_at IS NULL
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length;
}

/**
 * The question the pre-fix build could not ask: does this card already have an open
 * reviewer attempt? `null` means never dispatched.
 */
export async function findLiveReviewerRun(
  tx: DbTransaction,
  input: { projectId: string; taskId: string },
): Promise<ReviewerRunRow | null> {
  const rows = await tx.execute(sql`
    SELECT id, task_id, reviewer_agent_id, status, rework_round, started_at, completed_at, invalidated_at
      FROM project.task_reviewer_runs
     WHERE project_id = ${input.projectId} AND task_id = ${input.taskId}
       AND invalidated_at IS NULL AND completed_at IS NULL
     ORDER BY started_at DESC
     LIMIT 1
  `) as unknown as Array<Record<string, unknown>>;
  return reviewerRunRow(rows[0]);
}

/**
 * The full attempt history for one card. Deliberately includes invalidated and terminal rows:
 * the questions the sweep asks ("how many attempts never finished?") are about history, not
 * just the open slot.
 */
export async function listReviewerRuns(
  tx: DbTransaction,
  input: { projectId: string; taskId: string },
): Promise<ReviewerRunRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, task_id, reviewer_agent_id, status, rework_round, started_at, completed_at, invalidated_at
      FROM project.task_reviewer_runs
     WHERE project_id = ${input.projectId} AND task_id = ${input.taskId}
     ORDER BY started_at, id
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map(reviewerRunRow).filter((row): row is ReviewerRunRow => row !== null);
}

function reviewerRunRow(row: Record<string, unknown> | undefined): ReviewerRunRow | null {
  if (!row) return null;
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    reviewerAgentId: String(row.reviewer_agent_id ?? ""),
    status: String(row.status) as ReviewerRunStatus,
    reworkRound: Number(row.rework_round ?? 0),
    startedAt: String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    invalidatedAt: row.invalidated_at == null ? null : String(row.invalidated_at),
  };
}
