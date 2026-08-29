/**
 * step-integration — the ordered integration stage for worktree-isolated foreach
 * instances (step-inversion KTD-11, U10).
 *
 * Under `isolation: "worktree"` each foreach step instance runs in its OWN
 * worktree/branch off a common integration base. Completing the instance's
 * sub-walk does NOT mark the step done — instead the instance enqueues here as
 * `awaiting-integration`. The {@link IntegrationQueue} then lands completed
 * branches onto the task's main branch (the integration base) **strictly in step
 * order**: instance `i` integrates only after instances `0..i-1` are integrated
 * or skipped. This is the single place where a worktree-isolated instance's work
 * becomes visible on main history, so:
 *
 *   - **Success**: flip the projection FIRST (`updateStep(..., "done", graph)` —
 *     the dependency-order guard admits it because predecessors are done), THEN
 *     mark the instance row `completed`/`integratedAt` (projection-first ordering,
 *     KTD-7: closes the merge-blocker race), THEN release the instance worktree
 *     (pool hygiene).
 *   - **Conflict**: discard the instance branch (release worktree), and emit
 *     `outcome:integration-conflict` for that instance. The foreach sub-walk
 *     routes that like a rework — re-execute the step on the UPDATED integration
 *     base in a fresh worktree, counting against the instance's `maxReworkCycles`
 *     budget (exhaustion → rework-exhausted as usual).
 *
 * All git mechanics are behind the injectable {@link IntegrationGitOps} so this
 * module is hermetically testable with fakes. Production wires it (executor.ts)
 * to a rebase/cherry-pick onto the task's main branch that reuses merger.ts's
 * conflict-classification helpers (`getConflictedFiles`) for conflict detection —
 * NOT reimplemented here.
 *
 * Reconcile alignment (KTD-11): `complete step N` commits live on instance
 * branches before integration and on main history after it; the projection rule
 * ("done iff integrated") therefore agrees with `reconcileStepsFromGitHistory`
 * (which reads main-worktree history) by construction.
 */

import { schedulerLog } from "../logger.js";

/** The outcome of attempting to integrate one instance branch onto the base. */
export type IntegrationAttemptResult =
  | { kind: "integrated"; integratedAt: string }
  | { kind: "conflict"; conflictedFiles: string[] };

/**
 * Injectable git mechanics for the ordered integration stage (KTD-11). Production
 * (executor.ts) implements these over real git — `integrate` does a rebase /
 * cherry-pick of the instance branch onto the task's main branch and uses
 * merger.ts's `getConflictedFiles` to detect conflicts; `discardBranch` deletes
 * the conflicting branch. Tests inject fakes for fast, deterministic runs.
 */
export interface IntegrationGitOps {
  /**
   * Land `branchName` onto the integration base (the task's main branch) for step
   * `stepIndex`. Returns `integrated` on a clean rebase/cherry-pick (the base now
   * contains the step's commits), or `conflict` with the conflicting file list.
   * MUST NOT mutate the projection or instance rows — that is the queue's job
   * (projection-first ordering). On `conflict` the implementation MUST leave the
   * base clean (abort the rebase) so the next instance can integrate.
   */
  integrate(
    branchName: string,
    stepIndex: number,
  ): Promise<IntegrationAttemptResult>;
  /**
   * Discard a conflicting (or abandoned) instance branch and release its worktree
   * (pool hygiene). Best-effort — never throws into the queue.
   */
  discardBranch(branchName: string, stepIndex: number): Promise<void>;
}

/**
 * Identity of the persisted instance row to flip on integration. The queue
 * sources this from the foreach environment (the SINGLE source of truth for
 * runId/foreachNodeId/pinnedStepCount — the same values the sub-walk persisted
 * the row under) so `markInstanceIntegrated` updates the EXISTING row keyed by
 * `(taskId, runId, foreachNodeId, stepIndex)` instead of writing an orphan.
 */
export interface IntegrationInstanceIdentity {
  runId: string;
  foreachNodeId: string;
  pinnedStepCount: number;
  /** The instance branch being integrated (carried onto the flipped row). */
  branchName: string;
}

/** Projection + persistence side-effects the queue performs on a successful
 *  integration (KTD-7 projection-first ordering). Injected so the queue stays
 *  engine-agnostic and unit-testable. */
export interface IntegrationProjection {
  /**
   * Flip the projection FIRST (KTD-7): `updateStep(taskId, stepIndex, "done")`
   * with graph source so the dependency-order guard admits it. Awaited before the
   * instance row flips to `completed`, closing the merge-blocker race.
   */
  markStepDone(stepIndex: number): Promise<void>;
  /**
   * Mark the instance row `completed` with `integratedAt` AFTER the projection
   * flip (projection-first ordering). The queue passes the row's REAL identity
   * (runId/foreachNodeId/pinnedStepCount/branchName) so the production impl flips
   * the SAME row the sub-walk persisted — never an orphan. Optional — a fully
   * in-memory run needs none.
   */
  markInstanceIntegrated?(
    stepIndex: number,
    integratedAt: string,
    identity: IntegrationInstanceIdentity,
  ): Promise<void> | void;
}

/** One enqueued, completed instance awaiting ordered integration. */
export interface PendingIntegration {
  stepIndex: number;
  branchName: string;
}

/** The disposition of one instance after the queue drained as far as it could. */
export type InstanceIntegrationOutcome =
  | { stepIndex: number; status: "integrated"; integratedAt: string }
  | { stepIndex: number; status: "conflict"; conflictedFiles: string[] };

/**
 * Per-(task, run, foreach) ordered integration queue (KTD-11).
 *
 * Completed worktree-isolated instances enqueue via {@link enqueue}; the queue
 * lands them onto the integration base **strictly in step order**. The scheduler
 * calls {@link drain} whenever a new instance becomes available (or on each
 * scheduler tick); `drain` integrates every contiguous run of ready instances
 * starting at the lowest not-yet-resolved step index, stopping at the first gap
 * (a step not yet completed) or the first conflict. Conflicts are reported back
 * so the scheduler can route `outcome:integration-conflict` for that instance.
 *
 * The queue NEVER skips ahead past a gap: instance `i` integrates only after
 * `0..i-1` are integrated or skipped, so completion-order inversion (a later step
 * finishing first) cannot reorder integration — integration order is step order.
 */
export class IntegrationQueue {
  /** Instances that have completed and are waiting to integrate, by step index. */
  private readonly pending = new Map<number, PendingIntegration>();
  /** Step indices whose integration is resolved (integrated OR routed conflict). */
  private readonly resolved = new Set<number>();
  /** The next step index eligible to integrate (advances as the queue drains). */
  private cursor = 0;
  /** Steps the scheduler told us to SKIP (e.g. dependency-failed) — treated as
   *  resolved so the cursor advances past them without blocking later steps. */
  private readonly skipped = new Set<number>();

  constructor(
    private readonly gitOps: IntegrationGitOps,
    private readonly projection: IntegrationProjection,
    private readonly pinnedStepCount: number,
    /** Identity context for instance-row flips on integration (KTD-6/KTD-11):
     *  the REAL runId + foreachNodeId the sub-walk persisted rows under, so
     *  `markInstanceIntegrated` updates the existing row, not an orphan. Optional
     *  for fully in-memory runs that pass no `markInstanceIntegrated`. */
    private readonly rowIdentity?: { runId: string; foreachNodeId: string },
  ) {}

  /** Enqueue a completed instance awaiting integration. Idempotent per step. */
  enqueue(stepIndex: number, branchName: string): void {
    if (this.resolved.has(stepIndex)) return;
    this.pending.set(stepIndex, { stepIndex, branchName });
  }

  /**
   * Mark a step index as skipped (resolved without integration), so the ordered
   * cursor can advance past it. Used when an instance failed before producing a
   * branch (the projection stays non-done; the foreach reports the failure).
   */
  skip(stepIndex: number): void {
    if (this.resolved.has(stepIndex)) return;
    this.skipped.add(stepIndex);
    this.resolved.add(stepIndex);
    this.advanceCursor();
  }

  /** Whether step `i` is still awaiting integration in the queue. */
  isPending(stepIndex: number): boolean {
    return this.pending.has(stepIndex);
  }

  /** Whether step `i` has been integrated or routed to conflict/skip. */
  isResolved(stepIndex: number): boolean {
    return this.resolved.has(stepIndex);
  }

  /**
   * Integrate every contiguous ready instance starting at the cursor, in step
   * order. Stops at the first gap (the cursor's step hasn't completed yet) or the
   * first conflict (the conflicting step is reported and NOT marked resolved here
   * — the scheduler routes it to rework, then re-enqueues or re-skips). Returns
   * the per-instance outcomes produced THIS drain (callers act on conflicts).
   */
  async drain(): Promise<InstanceIntegrationOutcome[]> {
    const outcomes: InstanceIntegrationOutcome[] = [];
    for (;;) {
      // Advance past any already-resolved/skipped steps so the cursor points at
      // the lowest unresolved step.
      this.advanceCursor();
      if (this.cursor >= this.pinnedStepCount) break;

      const ready = this.pending.get(this.cursor);
      if (!ready) break; // Gap: the lowest unresolved step hasn't completed yet.

      const result = await this.gitOps.integrate(ready.branchName, ready.stepIndex);
      if (result.kind === "integrated") {
        // Projection-first ordering (KTD-7): flip the step done BEFORE the instance
        // row, then release the worktree (the discard path releases on conflict;
        // here the worktree is released after a clean integration via discardBranch
        // which the production op treats as "release, branch already merged").
        await this.projection.markStepDone(ready.stepIndex);
        await this.projection.markInstanceIntegrated?.(ready.stepIndex, result.integratedAt, {
          runId: this.rowIdentity?.runId ?? "",
          foreachNodeId: this.rowIdentity?.foreachNodeId ?? "",
          pinnedStepCount: this.pinnedStepCount,
          branchName: ready.branchName,
        });
        // Release the instance worktree post-integration (pool hygiene). The branch
        // is already on the base; discardBranch in production only releases here.
        await this.safeDiscard(ready.branchName, ready.stepIndex);
        this.pending.delete(this.cursor);
        this.resolved.add(this.cursor);
        outcomes.push({
          stepIndex: ready.stepIndex,
          status: "integrated",
          integratedAt: result.integratedAt,
        });
        this.advanceCursor();
        continue;
      }

      // Conflict: discard the branch + release worktree, report the conflict, and
      // STOP draining (the conflicting step is not resolved — the scheduler routes
      // it to rework on the updated base, then re-enqueues a fresh branch or skips).
      await this.safeDiscard(ready.branchName, ready.stepIndex);
      this.pending.delete(this.cursor);
      outcomes.push({
        stepIndex: ready.stepIndex,
        status: "conflict",
        conflictedFiles: result.conflictedFiles,
      });
      break;
    }
    return outcomes;
  }

  /** True once every step index is resolved (integrated or skipped). */
  isDrained(): boolean {
    return this.resolved.size >= this.pinnedStepCount;
  }

  /** Drain-and-release any remaining pending branches (abort/cleanup path). */
  async discardAllPending(): Promise<void> {
    for (const { branchName, stepIndex } of this.pending.values()) {
      await this.safeDiscard(branchName, stepIndex);
    }
    this.pending.clear();
  }

  private advanceCursor(): void {
    while (this.cursor < this.pinnedStepCount && this.resolved.has(this.cursor)) {
      this.cursor += 1;
    }
  }

  private async safeDiscard(branchName: string, stepIndex: number): Promise<void> {
    try {
      await this.gitOps.discardBranch(branchName, stepIndex);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      schedulerLog.warn(`integration discardBranch failed for ${branchName} (step ${stepIndex}): ${message}`);
    }
  }
}
