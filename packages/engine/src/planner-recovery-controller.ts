/**
 * FNXC:PlannerOversight 2026-07-04-12:00:
 * FN-7512 engine-side dispatcher for bounded autonomous planner recovery.
 * Consumes the FN-7511 `PlannerOverseerMonitor` observation (or an injected
 * snapshot provider), calls the pure `decidePlannerRecovery` from
 * `@fusion/core`, and — ONLY when the observation's effective oversight
 * level is `"autonomous"` — dispatches the chosen bounded action (inject
 * guidance / retry the step / request a targeted fix) through injected
 * `PlannerRecoveryHandlers`. Mirrors the `AutoRecoveryDispatcher` +
 * `StuckTaskDetector` conventions: a per-`(taskId, watchedStage)` in-memory
 * attempt registry, degrade-to-no-op on any error, never throw.
 *
 * Minimum guards owned by this task (FN-7514 owns the comprehensive
 * human-control safeguards): `tick()` is a no-op when `task.userPaused` is
 * true, and no handler here ever performs a merge/PR or destructive/
 * external-service action — those are excluded by construction (only
 * `injectGuidance` / `retryStep` / `requestTargetedFix` exist) and are owned
 * by FN-7513's confirmation-gated layer.
 *
 * FNXC:PlannerOverseer 2026-07-04-15:00:
 * FN-7514 upgrades the userPaused-only guard above to the full human-control
 * predicate `evaluateOverseerHumanControl` (auto-merge-off/human-review PLUS
 * user-pause, including the non-`userPaused` `task.paused` user-source park
 * shape). The predicate is consulted at the TOP of `tick()`, before
 * `decidePlannerRecovery`/confirmation classification even runs — a
 * user-paused or auto-merge-off/human-review task never even records a
 * pending `PlannerConfirmationRequest`. When withheld, a bounded
 * `overseer:oversight-withheld-human-control` no-action audit event is
 * recorded (via the optional `recordHumanControlWithheld` handler) at most
 * once per (taskId, watchedStage, reason) — repeated `tick()`s for the same
 * still-withheld reason do not re-emit until the reason changes or the task
 * leaves the withheld state, so the audit trail isn't spammed every poll.
 *
 * FNXC:PlannerOversight 2026-07-04-19:45:
 * FN-7551 adds the optional `onConfirmationResolved` handler, invoked from
 * `resolveConfirmation` for both "approved" and "denied" outcomes so the
 * engine wiring (`project-engine.ts`) can emit a matching
 * `emitOverseerConfirmation({..., outcome: "succeeded"|"skipped"})`
 * resolution entry through the FN-7520 façade. Purely additive/audit-only —
 * it does not change the approve/deny execution semantics above.
 */

import type { PlannerConfirmationRequest, PlannerRecoveryDecision, PlannerRecoveryObservation, Settings, Task } from "@fusion/core";
import { decidePlannerRecovery, PLANNER_RECOVERY_MAX_ATTEMPTS } from "@fusion/core";
import { createLogger, type Logger } from "./logger.js";
import type { OverseerStageObservation } from "./planner-overseer.js";
import {
  evaluateOverseerHumanControl,
  type OverseerHumanControlDecision,
  type OverseerHumanControlWithholdReason,
} from "./overseer-human-control-policy.js";

/** Minimal shared context threaded through to handlers (e.g. a run-id or clock). */
export interface PlannerRecoveryContext {
  now?: () => number;
  /**
   * FN-7514: current engine `Settings` (or a narrowed pick of just
   * `autoMerge`), used ONLY by the human-control guard's
   * `allowsAutoMergeProcessing` check. When omitted, the guard falls back to
   * `{ autoMerge: true }` (auto-merge globally enabled) so existing callers
   * that don't yet thread settings are unaffected — the per-task
   * `autoMerge`/`prInfo`/`prInfos` fields on `task` itself still fully
   * participate in that check regardless.
   */
  settings?: Pick<Settings, "autoMerge">;
  [key: string]: unknown;
}

/**
 * Side-effecting handlers a caller wires up using ONLY existing mechanisms
 * (steering-comment API for guidance/targeted-fix, store retry/re-enqueue
 * for step retry). All optional and all async; a missing handler simply
 * means that action is not dispatched (degrades to no-op, never throws).
 */
export interface PlannerRecoveryHandlers {
  injectGuidance?: (task: Task, decision: PlannerRecoveryDecision, ctx: PlannerRecoveryContext) => Promise<void>;
  retryStep?: (task: Task, decision: PlannerRecoveryDecision, ctx: PlannerRecoveryContext) => Promise<void>;
  requestTargetedFix?: (task: Task, decision: PlannerRecoveryDecision, ctx: PlannerRecoveryContext) => Promise<void>;
  /**
   * FN-7513: records/surfaces a pending `PlannerConfirmationRequest` for a
   * confirmation-required decision. MUST NOT perform the proposed side
   * effect itself — that only ever happens via `resolveConfirmation` after
   * an explicit approval. Optional; when absent the controller still tracks
   * the pending request in its own registry (so `getPendingConfirmations`
   * still reflects it), it just has no external surface to notify.
   */
  requestConfirmation?: (task: Task, request: PlannerConfirmationRequest, ctx: PlannerRecoveryContext) => Promise<void>;
  /**
   * FN-7513: executes a `"merge_pr"`-classified action (advance/retry a
   * merge, promote a shared branch, open/update/merge a pull request) by
   * reusing existing store/merger mechanisms. Invoked ONLY from
   * `resolveConfirmation(..., "approved")` — never from `tick`. Receives
   * `taskId` rather than a full `Task` because `resolveConfirmation` (an
   * out-of-band approval entry point) is not handed the task object;
   * wire a handler that looks the task up via its own store access if needed.
   */
  executeMergePrAction?: (taskId: string, request: PlannerConfirmationRequest, ctx: PlannerRecoveryContext) => Promise<void>;
  /**
   * FN-7513: executes a `"destructive_external"`-classified action. Invoked
   * ONLY from `resolveConfirmation(..., "approved")` — never from `tick`.
   */
  executeDestructiveExternalAction?: (taskId: string, request: PlannerConfirmationRequest, ctx: PlannerRecoveryContext) => Promise<void>;
  /**
   * FN-7514: notified (at most once per distinct withheld reason per
   * `(taskId, watchedStage)`, see `tick()`) when the human-control guard
   * withholds ALL oversight for a task. Callers wire this to a bounded
   * `RunAuditor.database({ type: "overseer:oversight-withheld-human-control", ... })`
   * no-action event. Optional; a missing handler is a pure no-op (the guard
   * still withholds action either way — this handler is audit-only).
   */
  recordHumanControlWithheld?: (
    task: Task,
    decision: OverseerHumanControlDecision & { reason: OverseerHumanControlWithholdReason },
    ctx: PlannerRecoveryContext,
  ) => Promise<void>;
  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: audit-only notification invoked from `resolveConfirmation` for
   * BOTH `"approved"` and `"denied"` resolutions, mirroring the optional/
   * never-throw contract of `recordHumanControlWithheld`. This handler must
   * NOT perform (or influence) the approve/deny execution path itself —
   * that remains `executeMergePrAction`/`executeDestructiveExternalAction`,
   * invoked separately from `executeApproved`. Callers wire this to
   * `emitOverseerConfirmation({..., outcome: resolution === "approved" ?
   * "succeeded" : "skipped"})` so the intervention timeline shows both the
   * request and its resolution. Optional; a missing handler is a pure no-op.
   */
  onConfirmationResolved?: (
    taskId: string,
    request: PlannerConfirmationRequest,
    resolution: "approved" | "denied",
    ctx: PlannerRecoveryContext,
  ) => Promise<void>;
}

/** Minimal seam for fetching the current watched-stage observation for a task. */
export interface PlannerRecoverySnapshotProvider {
  getSnapshot(taskId: string): OverseerStageObservation | null | undefined | Promise<OverseerStageObservation | null | undefined>;
}

/** The delivered `PlannerOverseerMonitor` shape this controller can also accept directly (FN-7511). */
export interface PlannerRecoveryObservationSource {
  getObservations(taskId: string): OverseerStageObservation[];
}

export interface PlannerRecoveryControllerOptions {
  /** Either a `{ getSnapshot(taskId) }` provider, or a `PlannerOverseerMonitor`-shaped source (adapted via its latest recorded observation). */
  snapshotProvider: PlannerRecoverySnapshotProvider | PlannerRecoveryObservationSource;
  handlers?: PlannerRecoveryHandlers;
  logger?: Logger;
}

const controllerLog = createLogger("planner-recovery-controller");

function isSnapshotProvider(value: unknown): value is PlannerRecoverySnapshotProvider {
  return typeof (value as PlannerRecoverySnapshotProvider)?.getSnapshot === "function";
}

function normalizeProvider(
  provider: PlannerRecoverySnapshotProvider | PlannerRecoveryObservationSource,
): PlannerRecoverySnapshotProvider {
  if (isSnapshotProvider(provider)) {
    return provider;
  }
  const source = provider as PlannerRecoveryObservationSource;
  return {
    getSnapshot: (taskId: string) => {
      const observations = source.getObservations(taskId);
      return observations.length > 0 ? observations[observations.length - 1] : null;
    },
  };
}

/**
 * FNXC:PlannerOversight 2026-07-04-12:00:
 * Bounded autonomous-recovery dispatcher. Holds a per-`(taskId,
 * watchedStage)` attempt registry (in-memory; not persisted — the wider
 * intervention timeline is FN-7519's responsibility) and increments it only
 * when an action is actually dispatched. Once a stage's attempt count
 * reaches `PLANNER_RECOVERY_MAX_ATTEMPTS`, `decidePlannerRecovery` returns
 * `exhausted: true` and `tick()` takes no further action for that stage.
 */
export class PlannerRecoveryController {
  private readonly snapshotProvider: PlannerRecoverySnapshotProvider;
  private readonly handlers: PlannerRecoveryHandlers;
  private readonly logger: Logger;
  private readonly attempts = new Map<string, number>();
  /**
   * FN-7513: pending confirmation requests keyed by `(taskId, watchedStage)`.
   * A stage can carry at most one pending request at a time — `tick` never
   * creates a duplicate for a stage that already has one pending, keeping
   * the request surface idempotent for downstream UX/audit consumers.
   */
  private readonly pendingConfirmations = new Map<string, PlannerConfirmationRequest>();
  private confirmationSeq = 0;
  /**
   * FN-7514: last withheld reason recorded per taskId, so the
   * `overseer:oversight-withheld-human-control` audit event is emitted only
   * on the first `tick()` a task enters (or changes) a withheld state — not
   * on every subsequent poll while it remains withheld for the same reason.
   */
  private readonly lastWithheldReason = new Map<string, OverseerHumanControlWithholdReason>();
  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517 addition: last dispatched bounded-recovery action OR manually
   * recorded operator action (see `recordManualAction`) per
   * `(taskId, watchedStage)`, surfaced via `getLastAction` for the
   * task-detail "explain current action" control. Purely additive
   * inspection state — never read by `tick()`'s decision logic.
   */
  private readonly lastActions = new Map<string, { action: string; at: number }>();

  constructor(options: PlannerRecoveryControllerOptions) {
    this.snapshotProvider = normalizeProvider(options.snapshotProvider);
    this.handlers = options.handlers ?? {};
    this.logger = options.logger ?? controllerLog;
  }

  private attemptKey(taskId: string, stage: string): string {
    return `${taskId}::${stage}`;
  }

  private nextRequestId(taskId: string): string {
    this.confirmationSeq += 1;
    return `planner-confirm-${taskId}-${Date.now()}-${this.confirmationSeq}`;
  }

  /**
   * Evaluate and, when warranted, dispatch one bounded recovery action for
   * `task`'s currently watched stage. Never throws — any handler/registry
   * error degrades to a no-op. Returns the computed decision (even when no
   * action was dispatched) for logging/testing, or `null` when the task is
   * user-paused, has no active observation, or the snapshot lookup failed.
   */
  async tick(task: Task, ctx: PlannerRecoveryContext = {}): Promise<PlannerRecoveryDecision | null> {
    try {
      if (!task) {
        return null;
      }

      // FN-7514: the human-control guard runs BEFORE anything else — before
      // the snapshot lookup, before decidePlannerRecovery, before confirmation
      // classification. A withheld task never even reaches the point where a
      // pending confirmation could be recorded.
      const humanControl = evaluateOverseerHumanControl(task, ctx.settings);
      if (humanControl.withhold) {
        // Snapshot lookup here is READ-ONLY metadata enrichment for the audit
        // event (stage/oversightLevel) — it never feeds back into the
        // withhold decision, which was already made above purely from `task`
        // + `ctx.settings`.
        const snapshotForAudit = await this.getSnapshotSafe(task.id);
        await this.recordWithheldIfChanged(
          task,
          humanControl as OverseerHumanControlDecision & { reason: OverseerHumanControlWithholdReason },
          snapshotForAudit,
          ctx,
        );
        return null;
      }
      this.lastWithheldReason.delete(task.id);

      const snapshot = await this.getSnapshotSafe(task.id);
      if (!snapshot) {
        return null;
      }

      const key = this.attemptKey(task.id, snapshot.stage);
      const attemptCount = this.attempts.get(key) ?? 0;

      const decision = decidePlannerRecovery({
        snapshot: snapshot as unknown as PlannerRecoveryObservation,
        attemptState: { attemptCount, attemptLimit: PLANNER_RECOVERY_MAX_ATTEMPTS },
      });

      if (decision.action === "none") {
        return decision;
      }

      // FN-7513: confirmation-required decisions (merge/PR, destructive/
      // external) NEVER dispatch a side-effecting handler from `tick` — they
      // only ever surface (idempotently) as a pending `PlannerConfirmationRequest`.
      // Actual execution happens strictly via `resolveConfirmation(..."approved"...)`.
      if (decision.requiresConfirmation) {
        await this.requestConfirmationIfAbsent(task, decision, key, ctx);
        return decision;
      }

      const dispatched = await this.dispatch(decision, task, ctx);
      if (dispatched) {
        this.attempts.set(key, attemptCount + 1);
        this.lastActions.set(key, { action: decision.action, at: ctx.now?.() ?? Date.now() });
      }
      return decision;
    } catch (err) {
      this.logger.warn(`tick failed for ${task?.id ?? "?"}: ${(err as Error)?.message ?? String(err)}`);
      return null;
    }
  }

  private async dispatch(decision: PlannerRecoveryDecision, task: Task, ctx: PlannerRecoveryContext): Promise<boolean> {
    try {
      if (decision.action === "inject_guidance") {
        if (!this.handlers.injectGuidance) return false;
        await this.handlers.injectGuidance(task, decision, ctx);
        return true;
      }
      if (decision.action === "retry_step") {
        if (!this.handlers.retryStep) return false;
        await this.handlers.retryStep(task, decision, ctx);
        return true;
      }
      if (decision.action === "request_targeted_fix") {
        if (!this.handlers.requestTargetedFix) return false;
        await this.handlers.requestTargetedFix(task, decision, ctx);
        return true;
      }
      return false;
    } catch (err) {
      this.logger.warn(`handler for action="${decision.action}" failed on ${task.id}: ${(err as Error)?.message ?? String(err)}`);
      return false;
    }
  }

  /**
   * FN-7514: records `overseer:oversight-withheld-human-control` (via the
   * optional `recordHumanControlWithheld` handler) the first time `task`
   * enters a withheld reason, or when the withheld reason changes — never
   * on repeated `tick()`s for the same still-withheld reason. Never throws.
   */
  private async recordWithheldIfChanged(
    task: Task,
    decision: OverseerHumanControlDecision & { reason: OverseerHumanControlWithholdReason },
    snapshotForAudit: OverseerStageObservation | null,
    ctx: PlannerRecoveryContext,
  ): Promise<void> {
    const previous = this.lastWithheldReason.get(task.id);
    if (previous === decision.reason) {
      return;
    }
    this.lastWithheldReason.set(task.id, decision.reason);

    if (!this.handlers.recordHumanControlWithheld) {
      return;
    }
    try {
      await this.handlers.recordHumanControlWithheld(task, decision, {
        ...ctx,
        stage: snapshotForAudit?.stage,
        oversightLevel: snapshotForAudit?.oversightLevel,
      });
    } catch (err) {
      this.logger.warn(`recordHumanControlWithheld handler failed for ${task.id}: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  private async getSnapshotSafe(taskId: string): Promise<OverseerStageObservation | null> {
    try {
      const result = await this.snapshotProvider.getSnapshot(taskId);
      return result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * FN-7513: records a pending `PlannerConfirmationRequest` for `decision`
   * (which has `requiresConfirmation: true`) unless one already exists for
   * this `(taskId, watchedStage)` — idempotent, so repeated `tick`s never
   * create duplicates. Never throws — a `requestConfirmation` handler
   * rejection is swallowed (the pending record is still tracked locally).
   */
  private async requestConfirmationIfAbsent(
    task: Task,
    decision: PlannerRecoveryDecision,
    key: string,
    ctx: PlannerRecoveryContext,
  ): Promise<void> {
    const existing = this.pendingConfirmations.get(key);
    if (existing && existing.status === "pending") {
      return;
    }

    const request: PlannerConfirmationRequest = {
      requestId: this.nextRequestId(task.id),
      taskId: task.id,
      watchedStage: decision.watchedStage ?? (key.split("::")[1] as PlannerConfirmationRequest["watchedStage"]),
      sideEffectClass: decision.sideEffectClass,
      proposedAction: decision.proposedAction ?? decision.action,
      reason: decision.reason,
      sourceLinks: decision.sourceLinks,
      requestedAt: Date.now(),
      status: "pending",
    };
    this.pendingConfirmations.set(key, request);

    if (this.handlers.requestConfirmation) {
      try {
        await this.handlers.requestConfirmation(task, request, ctx);
      } catch (err) {
        this.logger.warn(`requestConfirmation handler failed for ${task.id}: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  }

  /**
   * FN-7513: getters so downstream UX/audit (FN-7515+/FN-7517/FN-7519/FN-7520)
   * can read the currently pending confirmation requests for a task.
   */
  getPendingConfirmations(taskId: string): PlannerConfirmationRequest[] {
    const prefix = `${taskId}::`;
    const result: PlannerConfirmationRequest[] = [];
    for (const [key, request] of this.pendingConfirmations) {
      if (key.startsWith(prefix) && request.status === "pending") {
        result.push(request);
      }
    }
    return result;
  }

  /**
   * FN-7513: resolves a pending confirmation. On `"approved"`, dispatches the
   * proposed action through the matching execution handler (`merge_pr` →
   * `executeMergePrAction`, `destructive_external` →
   * `executeDestructiveExternalAction`) and clears the pending request. On
   * `"denied"`, clears the request with no side effect — the task is left
   * for other escalation (FN-7514+).
   *
   * FNXC:PlannerOversight 2026-07-04-14:30: a `"denied"` resolution also
   * consumes one bounded-recovery attempt for this `(taskId, watchedStage)`
   * pair (the same attempt budget `dispatch()` consumes for bounded actions).
   * Without this, a denial simply cleared the pending slot and the very next
   * `tick()` would recreate an identical confirmation prompt forever — a
   * human `"denied"` a merge/PR/destructive action, so it must not keep
   * resurfacing on every poll. Counting denials against
   * `PLANNER_RECOVERY_MAX_ATTEMPTS` means the same gated action stops
   * re-prompting once the budget is exhausted (surfaced as `none,
   * exhausted: true` by `decidePlannerRecovery`), matching bounded-recovery
   * exhaustion semantics rather than inventing a new state machine.
   * Never throws — a rejecting execution handler is logged and swallowed;
   * the request is still cleared so it does not linger as pending forever.
   */
  async resolveConfirmation(
    taskId: string,
    requestId: string,
    resolution: "approved" | "denied",
    resolvedBy?: string,
    ctx: PlannerRecoveryContext = {},
  ): Promise<PlannerConfirmationRequest | null> {
    try {
      const prefix = `${taskId}::`;
      let matchedKey: string | null = null;
      let matched: PlannerConfirmationRequest | null = null;
      for (const [key, request] of this.pendingConfirmations) {
        if (key.startsWith(prefix) && request.requestId === requestId && request.status === "pending") {
          matchedKey = key;
          matched = request;
          break;
        }
      }
      if (!matchedKey || !matched) {
        return null;
      }

      const resolved: PlannerConfirmationRequest = {
        ...matched,
        status: resolution === "approved" ? "approved" : "denied",
        resolvedAt: Date.now(),
        resolvedBy,
      };

      // Clear the pending slot regardless of outcome — an approved/denied
      // request must never be re-surfaced as pending.
      this.pendingConfirmations.delete(matchedKey);

      if (resolution === "approved") {
        await this.executeApproved(taskId, resolved, ctx);
      } else {
        // FN-7513: a denial consumes one bounded-recovery attempt for this
        // (taskId, watchedStage) pair so the identical confirmation prompt
        // does not resurface on every subsequent tick() — it stops once the
        // shared PLANNER_RECOVERY_MAX_ATTEMPTS budget is exhausted (see the
        // resolveConfirmation JSDoc above).
        const stage = resolved.watchedStage ?? matchedKey.split("::")[1];
        if (stage) {
          const attemptKey = this.attemptKey(taskId, stage);
          this.attempts.set(attemptKey, (this.attempts.get(attemptKey) ?? 0) + 1);
        }
      }

      // FN-7551: audit-only resolution notification, additive to the
      // approve/deny execution above — never influences it. Best-effort.
      if (this.handlers.onConfirmationResolved) {
        try {
          await this.handlers.onConfirmationResolved(taskId, resolved, resolution, ctx);
        } catch (err) {
          this.logger.warn(`onConfirmationResolved handler failed for ${taskId}: ${(err as Error)?.message ?? String(err)}`);
        }
      }

      return resolved;
    } catch (err) {
      this.logger.warn(`resolveConfirmation failed for ${taskId}: ${(err as Error)?.message ?? String(err)}`);
      return null;
    }
  }

  private async executeApproved(taskId: string, request: PlannerConfirmationRequest, ctx: PlannerRecoveryContext): Promise<void> {
    try {
      if (request.sideEffectClass === "merge_pr") {
        await this.handlers.executeMergePrAction?.(taskId, request, ctx);
        return;
      }
      if (request.sideEffectClass === "destructive_external") {
        await this.handlers.executeDestructiveExternalAction?.(taskId, request, ctx);
        return;
      }
    } catch (err) {
      this.logger.warn(
        `execution handler for sideEffectClass="${request.sideEffectClass}" failed on ${taskId}: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /** Reset all attempt state and pending confirmations for `taskId` (every watched stage) — call on terminal task transitions. */
  clear(taskId: string): void {
    const prefix = `${taskId}::`;
    for (const key of [...this.attempts.keys()]) {
      if (key.startsWith(prefix)) {
        this.attempts.delete(key);
      }
    }
    for (const key of [...this.pendingConfirmations.keys()]) {
      if (key.startsWith(prefix)) {
        this.pendingConfirmations.delete(key);
      }
    }
    this.lastWithheldReason.delete(taskId);
    for (const key of [...this.lastActions.keys()]) {
      if (key.startsWith(prefix)) {
        this.lastActions.delete(key);
      }
    }
  }

  /** Test/inspection seam: current attempt count for a `(taskId, watchedStage)` pair. */
  getAttemptCount(taskId: string, stage: string): number {
    return this.attempts.get(this.attemptKey(taskId, stage)) ?? 0;
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517: the last dispatched bounded-recovery action label, or a
   * manually recorded operator action (see `recordManualAction`), for a
   * `(taskId, watchedStage)` pair. Read by the task-detail "explain current
   * action" control via `ProjectEngine.explainOverseerTask`.
   */
  getLastAction(taskId: string, stage: string): string | undefined {
    return this.lastActions.get(this.attemptKey(taskId, stage))?.action;
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-17:00:
   * FN-7517: records a manual operator action (e.g. "manual_nudge" from the
   * task-detail nudge button, "manual_stop" from the stop-oversight button)
   * against a `(taskId, watchedStage)` pair so `getLastAction`/`explain`
   * reflects operator-driven actions, not only autonomous bounded-recovery
   * dispatches. Never mutates the attempt-budget registry — manual actions
   * are guidance-only and do not consume/gate the autonomous recovery
   * attempt budget.
   */
  recordManualAction(taskId: string, stage: string, action: string, now: () => number = Date.now): void {
    this.lastActions.set(this.attemptKey(taskId, stage), { action, at: now() });
  }
}
