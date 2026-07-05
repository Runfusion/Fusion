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

import type { PlannerOversightLevel, PrInfo, Task } from "@fusion/core";

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
  "id" | "column" | "prInfo" | "reviewState" | "paused" | "pausedReason" | "workflowTransitionNotification"
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

function deriveSignalAndSources(
  taskId: string,
  stage: OverseerWatchedStage,
  task: Partial<OverseerTaskRef>,
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

  constructor(options: PlannerOverseerMonitorOptions = {}) {
    this.store = options.store;
    this.onObservation = options.onObservation;
    this.maxObservationsPerTask = options.maxObservationsPerTask ?? DEFAULT_MAX_OBSERVATIONS_PER_TASK;
  }

  /**
   * Observe a task's current watched stage and record a gated observation.
   * Returns `null` when the level is `"off"` or when no stage is currently
   * monitorable. Never throws.
   */
  async observeTask(task: OverseerTaskRef, level: PlannerOversightLevel): Promise<OverseerStageObservation | null> {
    try {
      if (level === "off") {
        return null;
      }

      const stage = resolveWatchedStage(task);
      if (!stage) {
        return null;
      }

      const { signal, reason, sources } = deriveSignalAndSources(task.id, stage, task);
      const observation: OverseerStageObservation = {
        taskId: task.id,
        stage,
        signal,
        oversightLevel: level,
        observedAt: Date.now(),
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
        await this.store
          .logEntry(task.id, `[planner-overseer] stage=${stage} signal=${signal}: ${reason}`)
          .catch(() => undefined);
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
  }

  /** Task IDs that currently retain at least one recorded observation. Used
   *  by the engine poll to release ring buffers for tasks that have left the
   *  in-flight set. */
  getObservedTaskIds(): string[] {
    return [...this.observations.keys()];
  }
}
