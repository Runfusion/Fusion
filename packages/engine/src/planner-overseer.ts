/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * FN-7511 delivers the monitoring foundation for the planner overseer: an
 * engine module that watches an in-flight task's progression across five
 * lifecycle stages — executor, reviewer, merger, pull-request, and
 * workflow-gate — and records normalized `OverseerStageObservation`s gated by
 * the task's effective planner oversight level (`resolveEffectivePlannerOversightLevel`,
 * FN-7508/FN-7509/FN-7510). When the effective level is `"off"`, nothing is
 * recorded. This layer is records-only: it does not steer, retry, fix, gate,
 * or notify — those land in FN-7512 (steering/recovery), FN-7513
 * (confirmation gates), FN-7514 (human-control safeguards), and
 * FN-7515–FN-7520 (dashboard UI / run-audit events / intervention timeline).
 * The observation model + `PlannerOverseerMonitor` registry declared here is
 * the seam every later planner-oversight subtask reads from.
 */

import { DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS, type PlannerOversightLevel, type PrInfo, type Task } from "@fusion/core";

/** Alias for the `Task.reviewState` shape without requiring a separate core export. */
type OverseerTaskReviewState = NonNullable<Task["reviewState"]>;

/**
 * The five lifecycle stages the planner overseer watches. Precedence when a
 * task is in a compound state (see {@link resolveWatchedStage}):
 * workflow-gate > pull-request > merger > reviewer > executor.
 */
export const OVERSEER_WATCHED_STAGES = ["executor", "reviewer", "merger", "pull-request", "workflow-gate"] as const;
export type OverseerWatchedStage = (typeof OVERSEER_WATCHED_STAGES)[number];

/** Normalized signal describing how a watched stage is currently progressing. */
export type OverseerObservationSignal = "progressing" | "stuck" | "failed" | "blocked" | "awaiting-human" | "complete";

/**
 * FNXC:Lifecycle 2026-07-16-09:40:
 * FN-8141: the CONSTANT reason string for the executor stage's
 * failed-with-incomplete-work observation. It is already load-bearing — the
 * FN-7577 feed dedup keys on `stage|signal|reason`, so this string must never
 * embed per-failure detail (see the derivation at `deriveSignalAndSources`).
 * Exported as the single source of truth so the cross-stage no-op-finalize veto
 * derivation (`deriveExecutorSignalMemory`) can recognize this observation in
 * the durable `overseer:intervention` timeline without duplicating the literal.
 */
export const EXECUTOR_FAILED_INCOMPLETE_REASON = "Executor stage parked failed with work incomplete";

/** A link back to the concrete evidence an observation was derived from. */
export interface OverseerSourceLink {
  kind: "agent-log" | "review-comment" | "failed-check" | "merge-error" | "pr-state";
  ref: string;
  url?: string;
}

/** One normalized, oversight-gated observation of a task's current watched stage. */
export interface OverseerStageObservation {
  taskId: string;
  stage: OverseerWatchedStage;
  signal: OverseerObservationSignal;
  oversightLevel: PlannerOversightLevel;
  observedAt: number;
  reason: string;
  sources: OverseerSourceLink[];
}

/** The minimal task shape the stage resolver reads. Kept a `Pick` so callers
 *  (and tests) can pass partial/malformed fixtures without satisfying the
 *  full `Task` interface. */
export type OverseerTaskRef = Pick<
  Task,
  | "id"
  | "column"
  | "status"
  | "prInfo"
  | "reviewState"
  | "paused"
  | "pausedReason"
  | "workflowTransitionNotification"
  | "updatedAt"
  | "columnMovedAt"
>;

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Maps a task's delivered lifecycle state to exactly one watched stage, or
 * `null` when the task is not currently monitorable (e.g. `todo`, `done`,
 * `archived`, `triage`).
 *
 * Precedence (deterministic, so a compound state resolves to a single stable
 * stage): **workflow-gate > pull-request > merger > reviewer > executor**.
 * A task paused on a workflow prompt/script gate node is reported as
 * workflow-gate even if it also carries an open PR or pending review, because
 * the gate is the current blocking reason. Below that, an active PR takes
 * precedence over a bare merge/review classification since PR lifecycle is
 * the more specific state. Below that, an explicit merge-hold/merge-error
 * marker takes precedence over a generic pending-review read of `in-review`.
 *
 * Never throws — missing/partial fields degrade to `null`.
 */
export function resolveWatchedStage(task: Partial<OverseerTaskRef> | null | undefined): OverseerWatchedStage | null {
  try {
    if (!task) return null;

    // workflow-gate: paused awaiting an explicit workflow prompt/script gate
    // input (cli-approval or ask-input gate), regardless of column.
    if (task.paused === true && typeof task.pausedReason === "string") {
      if (task.pausedReason.startsWith("workflow-cli-approval:") || task.pausedReason.startsWith("workflow-input:")) {
        return "workflow-gate";
      }
    }

    const column = task.column;
    if (column !== "in-progress" && column !== "in-review") {
      return null;
    }

    if (column === "in-progress") {
      return "executor";
    }

    // column === "in-review" beyond this point.

    // pull-request: an active (non-terminal) PR lifecycle takes precedence
    // over a plain merge/review read of in-review.
    const prInfo = task.prInfo;
    if (prInfo && typeof prInfo === "object" && prInfo.status !== "merged" && prInfo.status !== "closed") {
      return "pull-request";
    }

    // merger: an explicit merge-hold notification marker or a recorded merge
    // error means the task is in the merge/integration phase.
    const marker = task.workflowTransitionNotification;
    if (marker && marker.kind === "manual-merge-hold") {
      return "merger";
    }
    if (prInfo && typeof prInfo === "object" && typeof prInfo.lastMergeError === "string" && prInfo.lastMergeError.length > 0) {
      return "merger";
    }

    // reviewer: review is in progress / pending items.
    const reviewState = task.reviewState;
    if (reviewState && typeof reviewState === "object") {
      return "reviewer";
    }

    // Plain in-review with no review state and no merge marker yet — treat as
    // the merge/integration phase (awaiting auto-merge).
    return "merger";
  } catch {
    return null;
  }
}

/**
 * FNXC:PlannerOversight 2026-07-09-00:00:
 * FN-7743 stall-detection inputs for `deriveSignalAndSources`'s `executor` branch.
 * Passed in already-resolved (never read from settings inside this pure function,
 * per the FN-7743 "keep derivation pure and testable" requirement): `now` is an
 * injectable clock (defaults to `Date.now` at the `observeTask` call site) and
 * `executorStuckAfterMs` is the resolved `plannerOverseerExecutorStuckAfterMs`
 * workflow setting value (or its declaration default).
 */
export interface ExecutorStallSignalInput {
  now: () => number;
  executorStuckAfterMs: number;
}

/**
 * FNXC:PlannerOversight 2026-07-09-00:00:
 * Validates a raw `plannerOverseerExecutorStuckAfterMs` workflow-setting value
 * (which may be missing/malformed/legacy-orphaned per `resolveEffectiveSettings`'s
 * never-throw contract) into a safe threshold, degrading to
 * `DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS` for anything that is not a
 * finite positive number. Pure, never throws.
 */
export function resolveExecutorStuckAfterMs(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS;
}

function deriveSignalAndSources(
  taskId: string,
  stage: OverseerWatchedStage,
  task: Partial<OverseerTaskRef>,
  stallInput: ExecutorStallSignalInput,
): { signal: OverseerObservationSignal; reason: string; sources: OverseerSourceLink[] } {
  switch (stage) {
    case "executor": {
      if (task.paused === true) {
        return {
          signal: "blocked",
          reason: task.pausedReason ? `Executor stage paused: ${task.pausedReason}` : "Executor stage paused",
          sources: [{ kind: "agent-log", ref: taskId }],
        };
      }

      /*
      FNXC:PlannerOversight 2026-07-15-17:05:
      FN-7965: an executor-stage row parked `status: "failed"` (e.g. the terminal fn_task_done refusal/invariant park) reported `progressing` — "Task is actively executing in-progress work" — because nothing here read `status`. The overseer observed a dead task as healthy and took no action; `failed` was only ever derived for the merger/pull-request stages, so the sole backstop was the FN-7743 stall proxy below firing HOURS later. Read the status so bounded recovery engages on the next poll instead.
      `paused` deliberately keeps precedence above: an operator/user-paused row is `blocked` because a human owns it, not an autonomously recoverable failure.
      Downstream this yields `retry_step` (executor sources are `agent-log`, never an ERROR_SOURCE_KIND), bounded by `PLANNER_RECOVERY_MAX_ATTEMPTS` and then escalated on exhaustion — the pre-existing failed-signal policy, not a new one.
      The reason must stay CONSTANT per (stage|signal): the FN-7577 feed dedup keys on `stage|signal|reason`, so never interpolate `task.error`/`status` here — a per-failure string would re-emit an observation every poll.
      */
      if (task.status === "failed") {
        return {
          signal: "failed",
          reason: EXECUTOR_FAILED_INCOMPLETE_REASON,
          sources: [{ kind: "agent-log", ref: taskId }],
        };
      }

      // FNXC:PlannerOversight 2026-07-09-00:00:
      // FN-7743: a non-paused in-progress task whose executor session has gone
      // silent (dead/hung agent, no commits/heartbeat) was previously ALWAYS
      // reported "progressing" forever (FN-7732 symptom) since nothing here
      // checked staleness. Use `columnMovedAt ?? updatedAt` as the best
      // available store-backed "last execution activity" proxy at this poll
      // seam (the live in-session `StuckTaskDetector` heartbeat state is
      // in-memory-only and not available here). A missing/malformed timestamp
      // degrades to "progressing" — never fabricate a stall. The reason is
      // bucketed to whole hours so the FN-7577 `stage|signal|reason` feed dedup
      // stays effective (it must not embed an ever-changing millisecond value).
      const activityTimestamp = task.columnMovedAt ?? task.updatedAt;
      const activityAtMs = activityTimestamp ? Date.parse(activityTimestamp) : NaN;
      if (Number.isFinite(activityAtMs) && stallInput.executorStuckAfterMs > 0) {
        const inactiveMs = stallInput.now() - activityAtMs;
        if (inactiveMs >= stallInput.executorStuckAfterMs) {
          const inactiveHours = Math.max(1, Math.floor(inactiveMs / 3_600_000));
          return {
            signal: "stuck",
            reason: `Executor stage inactive for over ${inactiveHours}h with no execution activity`,
            sources: [{ kind: "agent-log", ref: taskId }],
          };
        }
      }

      return {
        signal: "progressing",
        reason: "Task is actively executing in-progress work",
        sources: [{ kind: "agent-log", ref: taskId }],
      };
    }
    case "reviewer": {
      const reviewState = task.reviewState as OverseerTaskReviewState | undefined;
      const summary = reviewState?.summary;
      const decision = summary && "reviewDecision" in summary ? summary.reviewDecision : undefined;
      if (decision === "CHANGES_REQUESTED") {
        return {
          signal: "blocked",
          reason: "Review requested changes",
          sources: [{ kind: "review-comment", ref: reviewState?.items?.[0]?.id ?? taskId }],
        };
      }
      return {
        signal: "progressing",
        reason: "Review in progress",
        sources: [{ kind: "review-comment", ref: reviewState?.items?.[0]?.id ?? taskId }],
      };
    }
    case "merger": {
      const prInfo = task.prInfo;
      if (prInfo?.lastMergeError) {
        return {
          signal: "failed",
          reason: `Merge failed: ${prInfo.lastMergeError}`,
          sources: [{ kind: "merge-error", ref: prInfo.lastMergeError }],
        };
      }
      if (task.workflowTransitionNotification?.kind === "manual-merge-hold") {
        return {
          signal: "awaiting-human",
          reason: "Held awaiting manual merge decision",
          sources: [{ kind: "merge-error", ref: task.workflowTransitionNotification.transitionId ?? taskId }],
        };
      }
      return {
        signal: "progressing",
        reason: "Task is in the merge/integration phase",
        sources: [{ kind: "merge-error", ref: taskId }],
      };
    }
    case "pull-request": {
      const prInfo = task.prInfo as PrInfo | undefined;
      if (prInfo?.checkRollup === "failure") {
        return {
          signal: "failed",
          reason: "PR checks failing",
          sources: [{ kind: "failed-check", ref: prInfo.url, url: prInfo.url }],
        };
      }
      return {
        signal: "progressing",
        reason: "PR lifecycle in progress",
        sources: [{ kind: "pr-state", ref: prInfo?.url ?? taskId, url: prInfo?.url }],
      };
    }
    case "workflow-gate": {
      return {
        signal: "awaiting-human",
        reason: task.pausedReason ? `Paused on workflow gate: ${task.pausedReason}` : "Paused on workflow gate",
        sources: [{ kind: "agent-log", ref: task.pausedReason ?? taskId }],
      };
    }
    default: {
      return {
        signal: "progressing",
        reason: "",
        sources: [],
      };
    }
  }
}

/** Minimal store seam the monitor records best-effort observations through —
 *  mirrors `fallback-model-observer.ts`'s `FallbackLogStore` seam. */
export interface OverseerLogStore {
  logEntry?(taskId: string, action: string): Promise<unknown>;
  appendAgentLog?(
    taskId: string,
    text: string,
    type: "text" | "thinking" | "tool" | "tool_result" | "tool_error",
    detail?: string,
    agent?: string,
  ): Promise<unknown>;
}

export interface PlannerOverseerMonitorOptions {
  store?: OverseerLogStore;
  onObservation?: (observation: OverseerStageObservation) => void | Promise<void>;
  /** Max observations retained per task in the in-memory ring buffer. Default: 20. */
  maxObservationsPerTask?: number;
}

const DEFAULT_MAX_OBSERVATIONS_PER_TASK = 20;

/**
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Records-only monitor: watches a task's current lifecycle stage and, when
 * the effective oversight level is not `"off"`, records one normalized
 * `OverseerStageObservation` per call into a bounded per-task ring buffer and
 * invokes the optional `onObservation` callback best-effort. Never mutates
 * task lifecycle, never retries/fixes/merges/notifies — steering and
 * recovery are FN-7512+.
 */
export class PlannerOverseerMonitor {
  private readonly store?: OverseerLogStore;
  private readonly onObservation?: (observation: OverseerStageObservation) => void | Promise<void>;
  private readonly maxObservationsPerTask: number;
  private readonly observations = new Map<string, OverseerStageObservation[]>();

  /*
  FNXC:PlannerOversight 2026-07-05-11:00:
  The overseer logs one activity-feed entry per poll tick. On the healthy path an
  executor task re-emits the identical `signal=progressing` heartbeat every tick,
  which spammed the task feed (user report FN-7577) with no new information and no
  lifecycle change. Dedup the feed write on the composite `stage|signal|reason`
  key so a log entry is only written when the observed situation CHANGES — mirrors
  the FN-7514 withheld-oversight dedup ("not re-emitted every poll while the reason
  is unchanged"). The in-memory ring buffer and `onObservation` callback are left
  intact (they are cheap / drive downstream emission façades); only the noisy feed
  logEntry is gated. Cleared alongside the ring buffer in `clear()` so a re-run of
  the same task re-logs its first observation.
  */
  private readonly lastLoggedKey = new Map<string, string>();

  constructor(options: PlannerOverseerMonitorOptions = {}) {
    this.store = options.store;
    this.onObservation = options.onObservation;
    this.maxObservationsPerTask = options.maxObservationsPerTask ?? DEFAULT_MAX_OBSERVATIONS_PER_TASK;
  }

  /**
   * Observe a task's current watched stage and record a gated observation.
   * Returns `null` when the level is `"off"` or when no stage is currently
   * monitorable. Never throws.
   *
   * FNXC:PlannerOversight 2026-07-09-00:00:
   * FN-7743: `options.now`/`options.executorStuckAfterMs` thread the clock and
   * the resolved executor-stall threshold into the pure `deriveSignalAndSources`
   * derivation. Both default (`Date.now`, `DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS`)
   * so existing callers keep working unchanged; the poll seam
   * (`project-engine.ts#pollPlannerOverseer`) resolves the real workflow-setting
   * value once per cycle and passes it in explicitly.
   */
  async observeTask(
    task: OverseerTaskRef,
    level: PlannerOversightLevel,
    options?: { now?: () => number; executorStuckAfterMs?: number },
  ): Promise<OverseerStageObservation | null> {
    try {
      if (level === "off") {
        return null;
      }

      const stage = resolveWatchedStage(task);
      if (!stage) {
        return null;
      }

      const now = options?.now ?? Date.now;
      const executorStuckAfterMs = options?.executorStuckAfterMs ?? DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS;
      const { signal, reason, sources } = deriveSignalAndSources(task.id, stage, task, { now, executorStuckAfterMs });
      const observation: OverseerStageObservation = {
        taskId: task.id,
        stage,
        signal,
        oversightLevel: level,
        observedAt: now(),
        reason,
        sources,
      };

      this.record(observation);

      if (this.onObservation) {
        try {
          await this.onObservation(observation);
        } catch {
          // Best-effort — never let a consumer callback fail the monitor.
        }
      }

      if (this.store?.logEntry) {
        // FNXC:PlannerOversight 2026-07-05-11:00 — only write the feed entry when
        // the observed (stage, signal, reason) differs from the last one logged
        // for this task, so an unchanged heartbeat does not re-spam the feed.
        const loggedKey = `${stage}|${signal}|${reason}`;
        if (this.lastLoggedKey.get(task.id) !== loggedKey) {
          this.lastLoggedKey.set(task.id, loggedKey);
          await this.store
            .logEntry(task.id, `[planner-overseer] stage=${stage} signal=${signal}: ${reason}`)
            .catch(() => undefined);
        }
      }

      return observation;
    } catch {
      return null;
    }
  }

  private record(observation: OverseerStageObservation): void {
    const existing = this.observations.get(observation.taskId) ?? [];
    existing.push(observation);
    if (existing.length > this.maxObservationsPerTask) {
      existing.splice(0, existing.length - this.maxObservationsPerTask);
    }
    this.observations.set(observation.taskId, existing);
  }

  /** Return the recorded observations for a task, oldest first. */
  getObservations(taskId: string): OverseerStageObservation[] {
    return [...(this.observations.get(taskId) ?? [])];
  }

  /** Clear recorded observations for a task (e.g. on task completion). */
  clear(taskId: string): void {
    this.observations.delete(taskId);
    // FNXC:PlannerOversight 2026-07-05-11:00 — drop the feed-dedup key too so a
    // re-run of the same task re-logs its first observation.
    this.lastLoggedKey.delete(taskId);
  }

  /** Task IDs that currently retain at least one recorded observation. Used
   *  by the engine poll to release ring buffers for tasks that have left the
   *  in-flight set. */
  getObservedTaskIds(): string[] {
    return [...this.observations.keys()];
  }
}
