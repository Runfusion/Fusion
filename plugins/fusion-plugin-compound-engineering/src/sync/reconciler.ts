import type { PluginContext, Task } from "@fusion/core";
import { columnsWithFlag, resolveReviewColumns, resolveWorkflowIrForTask } from "@fusion/core";
import { listPipelineStages } from "../session/stage-registry.js";
import { createCeTaskWithLink } from "./ce-task.js";
import {
  getCePipelineStore,
  type CePipelineLink,
  type CePipelineState,
  type CePipelineStore,
} from "./pipeline-store.js";

/**
 * BIDIRECTIONAL SYNC RECONCILER (U8 / FN-5719 pattern).
 *
 * Two SEPARATE state machines are kept in sync, never merged (KTD4):
 *   - Board-task ownership  → the task's `column` (board is authoritative).
 *   - CE-pipeline ownership → `ce_pipeline_state.{currentStage,status}` (CE flow
 *                             is authoritative for artifact/pipeline content).
 *
 * INBOUND (board → pipeline): the lifecycle hooks (`onTaskMoved`/`onTaskCompleted`
 * in index.ts) do the MINIMUM under the 5s hook budget — resolve the link and
 * `enqueueSync(...)`, then return. They do NOT advance the pipeline inline.
 *
 * RECONCILE (the convergence guarantee): `reconcile()` is a single on-demand
 * sweep — NOT a tight interval poll (per docs/performance/dashboard-load.md).
 * It (1) drains the queue and (2) INDEPENDENTLY re-derives transitions by
 * comparing live board state (`ctx.taskStore`) against pipeline state. Step (2)
 * is why a DROPPED or never-enqueued hook event still converges: the queue is an
 * optimization; the board↔state comparison is the source of truth.
 *
 * OUTBOUND (pipeline → board): when a pipeline advances to a stage that produces
 * board work, the reconciler creates the next-stage board task via
 * `ctx.taskStore.createTask` and links it — propagating the CE-flow change onto
 * the board.
 *
 * TRIGGER MODEL (honest about the host seam): there is NO host scheduler wired to
 * call this on a timer. In production the sweep is invoked (a) right after the
 * hooks enqueue (a cheap drain on the same board mutation that triggered the
 * hook), and (b) on demand from a route (U9 settings/refresh surface) or on a
 * dashboard session-change. Because step (2) re-derives from board truth, any
 * single missed trigger is recovered on the NEXT sweep — no continuous poll loop
 * is needed for correctness.
 */

/*
FNXC:WorkflowResolvedColumns 2026-07-31-04:30:
DELIBERATE-LITERAL — the no-IR fallback for the pipeline's "this stage is finished" test.

Retained so a task whose workflow cannot be resolved behaves exactly as before. It is no longer the
decision: gating advancement on these ids alone meant `allTerminal` was FALSE FOREVER on a board
whose review and completion lanes are renamed, so the pipeline never advanced a stage, never created
its outbound task, and sat `running` indefinitely. Nothing errors — it reads as work that has not
finished, which is why it could sit unnoticed.
*/
const TERMINAL_COLUMNS = new Set(["in-review", "done"]);

/*
FNXC:WorkflowResolvedColumns 2026-07-31-04:35:
"Finished for pipeline purposes" is a ROLE question, resolved against the task's OWN workflow.

The set below means complete OR review — the comment at its declaration says a stage is done when its
board work reaches either. Resolved per task rather than board-wide because a column id is meaningful
only relative to its workflow, and a CE pipeline can span several.

Falls back to the legacy pair whenever the IR cannot be resolved or declares neither trait, so an
unconverted board and a resolution failure both keep the previous behaviour rather than stalling on
an empty set — which would be the same defect wearing a different cause.

EXPORTED because it is the whole decision. Left private it could only be reached through a full
reconcile fixture (pipeline state + links + board tasks), and the half that actually needed proving
is that a renamed board resolves to its own lanes through this store.
*/
export async function isStageTerminalColumn(
  taskStore: PluginContext["taskStore"],
  task: Task,
): Promise<boolean> {
  try {
    const ir = await resolveWorkflowIrForTask(taskStore, task.id);
    if (ir) {
      /* `resolveReviewColumns` is the documented review SET — mergeOrchestration ∪ mergeBlocker ∪
         humanReview — so a board that splits those across a merge lane and a human lane is covered
         without this site re-deriving the union and drifting from it. */
      const terminal = new Set<string>([
        ...columnsWithFlag(ir, "complete"),
        ...resolveReviewColumns(ir),
      ]);
      if (terminal.size > 0) return terminal.has(task.column);
    }
  } catch {
    /* fall through to the documented legacy pair */
  }
  return TERMINAL_COLUMNS.has(task.column);
}

export interface ReconcileResult {
  /** Queue entries drained this sweep. */
  drained: number;
  /** Pipelines whose state advanced this sweep. */
  advanced: number;
  /** Board tasks created outbound this sweep (next-stage propagation). */
  tasksCreated: number;
  /** Pipelines inspected. */
  inspected: number;
}

/**
 * The linear CE stage order. The pipeline advances along this sequence.
 * Manual utility stages are excluded; remaining stages are sorted by explicit
 * `order`, so runtime stages inserted mid-pipeline slot into the right place.
 */
function stageOrder(): string[] {
  return listPipelineStages().map((s) => s.stageId);
}

/** The stage AFTER `stageId` in the pipeline, or `undefined` if it's terminal. */
export function nextStageAfter(stageId: string): string | undefined {
  const order = stageOrder();
  const idx = order.indexOf(stageId);
  if (idx < 0 || idx >= order.length - 1) return undefined;
  return order[idx + 1];
}

export class CeReconciler {
  private readonly ctx: PluginContext;
  private readonly store: CePipelineStore;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.store = getCePipelineStore(ctx);
  }

  /**
   * Drain the queue AND re-derive missed transitions from live board state, then
   * apply any pipeline advancement (with outbound board propagation). Idempotent:
   * running it twice is a no-op once everything has converged.
   */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { drained: 0, advanced: 0, tasksCreated: 0, inspected: 0 };

    // (1) Drain the queue. Draining is just an audit/ack — the actual decision is
    // re-derived from board truth below, so a queue entry for an already-handled
    // transition is harmless.
    const pending = await this.store.listPendingSyncAsync();
    for (const entry of pending) {
      await this.store.markSyncProcessedAsync(entry.id);
      result.drained++;
    }

    // (2) Convergence sweep: inspect EVERY pipeline that has state, not only the
    // ones with queued entries. This is what recovers a dropped/never-enqueued
    // hook event — board truth is compared against pipeline state regardless of
    // whether a queue row exists.
    const states = await this.store.listAllStateAsync();
    for (const state of states) {
      result.inspected++;
      const advanced = await this.reconcileOne(state);
      if (advanced) {
        result.advanced++;
        if (advanced.created) result.tasksCreated++;
      }
    }
    return result;
  }

  /**
   * Re-derive whether ONE pipeline should advance by reading the live board
   * column of its current-stage task(s). Board is authoritative for task state;
   * we never write the task column from here for the current stage.
   */
  private async reconcileOne(
    state: CePipelineState,
  ): Promise<{ created: boolean } | undefined> {
    if (state.status === "completed") return undefined;

    // All links for this pipeline (fetched once, reused by advance's idempotency
    // check). The board tasks whose completion gates advancement are this
    // pipeline's links AT its current stage.
    const links = await this.store.listByPipelineAsync(state.cePipelineId);
    const currentStageLinks = links.filter((l) => l.ceStageId === state.currentStage);
    if (currentStageLinks.length === 0) return undefined;

    const tasks = await this.loadTasks(currentStageLinks);
    if (tasks.length === 0) return undefined;

    // A deleted/missing task yields `undefined` (treated as ABSENT, not
    // terminal AND not blocking). Compute terminality over the tasks that still
    // EXIST so one deleted current-stage task cannot wedge the pipeline forever.
    const existing = tasks.filter((t): t is Task => t != null);
    if (existing.length === 0) {
      // Every current-stage task was deleted — there is nothing left on the
      // board to gate advancement, but also no completion signal to act on.
      // Safest non-wedging behavior: leave the pipeline state unchanged (do not
      // advance off a vanished stage, do not crash). A later sweep with a real
      // board task re-derives the transition.
      return undefined;
    }

    // Advancement rule: every EXISTING current-stage board task has reached a
    // terminal column (board-authoritative read). Partial completion keeps it
    // running; deleted tasks are excluded above rather than counted as blocking.
    const terminalFlags = await Promise.all(existing.map((t) => isStageTerminalColumn(this.ctx.taskStore, t)));
    const allTerminal = terminalFlags.every(Boolean);
    if (!allTerminal) {
      // Still running on the board — make sure our status reflects that and stop.
      if (state.status !== "running") {
        await this.store.transitionStateAsync(state.cePipelineId, { status: "running" });
      }
      return undefined;
    }

    const next = nextStageAfter(state.currentStage);
    if (!next) {
      // Terminal stage finished → pipeline completed. No outbound task.
      await this.store.transitionStateAsync(state.cePipelineId, { status: "completed" });
      this.ctx.emitEvent("compound-engineering:pipeline-completed", {
        cePipelineId: state.cePipelineId,
        stage: state.currentStage,
      });
      return { created: false };
    }

    // CONFLICT POLICY (explicit): board is authoritative for the task columns we
    // just READ (we never rewrote them); CE flow is authoritative for the
    // pipeline content we WRITE (currentStage, artifact, the next-stage task).
    // Advancing only moves the CE-owned fields + creates a NEW board task; it
    // never mutates the already-terminal board tasks, so the two writers never
    // contend over the same cell.
    const created = await this.advance(state, next, links);
    return { created };
  }

  /**
   * Advance the pipeline to `nextStage` (CE-owned write) and propagate OUTBOUND
   * by creating the next-stage board task (board-owned write on a NEW row).
   * Idempotent: if a link for the next stage already exists, we don't duplicate.
   */
  private async advance(
    state: CePipelineState,
    nextStage: string,
    links: CePipelineLink[],
  ): Promise<boolean> {
    // Idempotency guard: if we already advanced (a next-stage link exists), just
    // ensure state is consistent and skip the outbound create.
    const already = links.some((l) => l.ceStageId === nextStage);

    if (already) {
      await this.store.transitionStateAsync(state.cePipelineId, {
        currentStage: nextStage,
        status: "running",
      });
      return false;
    }

    // Shared contract: create the CE-tagged next-stage board task AND its
    // authoritative pipeline-link row (FN-5719) in one place.
    const task = await createCeTaskWithLink(this.ctx.taskStore, this.store, {
      title: `CE ${nextStage}: continue pipeline`,
      description: `Continue the compound-engineering pipeline at the "${nextStage}" stage.`,
      cePipelineId: state.cePipelineId,
      ceStageId: nextStage,
      ceArtifactPath: state.lastArtifactPath,
    });

    // Single state write on the create path: advance to the next stage and mark
    // the pipeline as waiting on the freshly-created board task.
    await this.store.transitionStateAsync(state.cePipelineId, {
      currentStage: nextStage,
      status: "awaiting_board",
    });

    this.ctx.emitEvent("compound-engineering:pipeline-advanced", {
      cePipelineId: state.cePipelineId,
      fromStage: state.currentStage,
      toStage: nextStage,
      taskId: task.id,
    });
    return true;
  }

  /** Load the live board tasks for a set of links (board-authoritative read). */
  private async loadTasks(links: CePipelineLink[]): Promise<Array<Task | undefined>> {
    const out: Array<Task | undefined> = [];
    for (const link of links) {
      try {
        const task = await this.ctx.taskStore.getTask(link.taskId);
        out.push(task ?? undefined);
      } catch {
        // A deleted/missing task is treated as absent, not terminal.
        out.push(undefined);
      }
    }
    return out;
  }
}

/**
 * Convenience: build a reconciler and run one sweep. This is the entry point a
 * route handler or post-hook drain calls.
 */
export async function reconcileCePipelines(ctx: PluginContext): Promise<ReconcileResult> {
  return new CeReconciler(ctx).reconcile();
}
