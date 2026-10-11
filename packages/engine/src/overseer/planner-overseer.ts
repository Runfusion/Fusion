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

import { DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS, type PlannerOversightLevel, type PrInfo, type Task, type TraitFlags } from "@fusion/core";
import { diagnosticSignature, logDiagnosticOnce } from "../util/durable-diagnostic-log.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-13:40 (fleet — inline fallback arms):
DELIBERATE-LITERAL — the no-resolution fallback for the already-converted guards below.

Named sets rather than an inline `=== "in-progress"` arm. Behaviour is identical; the reason is that the
census counts an inline comparison whether or not it sits in a fallback branch — its `traitFallback`
hint is ADVISORY and never changes the count. So a correctly-converted guard with an inline legacy
arm stays on the backlog permanently, and the number stops distinguishing real debt from documented
degraded answers. Same shape as `LEGACY_PLANNER_LANES` and `LEGACY_TERMINAL_COLUMNS`.
*/
const LEGACY_WIP_LANES: ReadonlySet<string> = new Set(["in-progress"]);
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);



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

/**
 * FNXC:PlannerOversight 2026-09-18-02:03:
 * The CONSTANT reason string for the executor stage's "no live session behind the card"
 * observation. Dedup-safe for the same reason as `EXECUTOR_FAILED_INCOMPLETE_REASON`: the FN-7577
 * feed keys on `stage|signal|reason`, so it must never embed a duration or task detail.
 */
export const EXECUTOR_SESSION_NOT_LIVE_REASON = "Executor stage has no live agent session";

/**
 * FNXC:PlannerOversight 2026-09-18-02:03:
 * A card that JUST entered the wip lane has not claimed its session yet, so a not-live reading is
 * expected for a short window and must not bounce a session that was about to start. The
 * dead-session signal therefore waits for the younger of this floor and the operator's own stall
 * threshold — never earlier, and never the 2h column-entry wait the FN-7743 proxy imposes.
 */
const DEAD_SESSION_GRACE_MS = 5 * 60_000;

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
  // FNXC:WorkflowReviewGates 2026-07-26-16:35: the in-review stages (reviewer AND merger) need the
  // pre-merge gate's pending lease to anchor their stall check on when the GATE started, not when
  // the card entered the column. See `reviewGateStallReason`.
  | "workflowStepResults"
  /*
  FNXC:PlannerOversight 2026-10-07-16:19:
  RUFU-308: the executor-stage activity anchor also reads the step-report ledger. A delivered step
  report is the strongest durable proof the executing lane produced work (`TaskStepReport.recordedAt`
  is stamped when the executor reports that step's summary), and it is the ONLY per-step completion
  clock that survives a replan — `task.steps` is replaced wholesale and `TaskStep` carries no
  timestamp at all. RUFU-291's Step 3 and Step 4 completed at 04:43 and 05:17 through exactly these
  rows while the hourly "no execution activity" sentence kept broadcasting.
  */
  | "stepReports"
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
export function resolveWatchedStage(
  task: Partial<OverseerTaskRef> | null | undefined,
  columnFlags?: TraitFlags,
): OverseerWatchedStage | null {
  try {
    if (!task) return null;

    // workflow-gate: paused awaiting an explicit workflow prompt/script gate
    // input (cli-approval or ask-input gate), regardless of column.
    if (task.paused === true && typeof task.pausedReason === "string") {
      if (task.pausedReason.startsWith("workflow-cli-approval:") || task.pausedReason.startsWith("workflow-input:")) {
        return "workflow-gate";
      }
    }

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-00:20:
    Keyed on the ROLE, because keyed on the id this returned null for every card on a renamed board.

    The blast radius is why this is worth the parameter rather than a fallback: `observeTask` returns
    early on a null stage, so no observation is recorded, no `overseer:intervention` entry is emitted,
    and `PlannerRecoveryController` — which consumes those observations — has nothing to steer, retry
    or targeted-fix. The entire oversight loop went inert and said nothing about it, the same shape as
    the self-healing sweeps whose queries returned empty arrays.

    THE FLAGS ARRIVE AS A PARAMETER because this function is pure and sync with no store and no task
    id to resolve from. The cost objection I recorded when first auditing this — "resolving inside
    `observeTask` buys a workflow read per card per poll" — turned out to be answered by the caller:
    `project-engine.ts`'s poll ALREADY awaits `resolveEffectiveSettings` per task, so it is a per-task
    async loop already, and an IR cache keyed by workflow makes the addition (distinct workflows)
    resolutions rather than (cards).

    THE REVIEW TEST IS THE THREE-TRAIT UNION, not `isReviewColumnRole`, which checks only
    `mergeBlocker || humanReview`. A board whose review lane carries `merge` (mergeOrchestration) —
    the default's own shape — would otherwise be classified as not-in-review and skipped, which is the
    bug this change is removing, arriving through the helper meant to fix it.

    `columnFlags` is in the unwired-lane-parameter vocabulary, so the wiring cannot silently rot.
    */
    const column = task.column;
    if (column === undefined) return null;
    const isWip = columnFlags ? columnFlags.countsTowardWip === true : LEGACY_WIP_LANES.has(column);
    const isReview = columnFlags
      ? Boolean(columnFlags.mergeOrchestration || columnFlags.mergeBlocker || columnFlags.humanReview)
      : LEGACY_REVIEW_LANES.has(column);
    if (!isWip && !isReview) {
      return null;
    }

    if (isWip) {
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
  /*
  FNXC:PlannerOversight 2026-09-18-02:03:
  A card can sit in the wip lane with NO live session behind it: the executor died, or the engine
  restarted and took the in-place stuck-session detector's in-memory state with it (WIP liveness is
  owned only by that detector — see the `recoverInProgressLimbo` tombstone in self-healing.ts).
  Before this probe existed the only surviving store-backed proxy was the FN-7743 timestamp below,
  which is measured from COLUMN ENTRY and defaults to 2h, so such a card reported `progressing`
  ("Task is actively executing in-progress work") for up to two hours and autonomous recovery never
  engaged. Observed 2026-09-17: a card sat in-progress with zero live agent sessions, its last real
  work ~1h30 old, and every poll still reported `progressing`.
  The poll seam passes the same predicate the retry handler already gates on
  (`isTaskLiveForOverseerRetry`), so observation and action cannot disagree about liveness.
  Tri-state on purpose: `undefined` (probe not wired) preserves the previous behaviour exactly,
  which keeps this inert for every caller that does not pass it.
  */
  isTaskLive?: (taskId: string) => boolean | undefined;
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

/*
FNXC:WorkflowReviewGates 2026-07-26-16:50:
Gate-anchored stall detection for the in-review stages. Neither the `reviewer` nor the `merger`
branch had ANY time-based check — both fell through to `progressing` unconditionally. That was
tolerable while the pre-merge gates ran in `in-progress` (the FN-7743 executor check covered them),
but Code Review / Browser Verification now run with the card in `in-review`, so a hung gate that
never posts a verdict produced no stall signal at all, however long it hung.

Applied to BOTH in-review stages deliberately: `resolveWatchedStage` maps a plain in-review card
with no `reviewState` to `merger`, not `reviewer`, so a task running its first gate usually lands
in the merger branch. The pending pre-merge lease is the authoritative "a gate is running" fact
regardless of which sub-stage was inferred.

Anchored on the gate's own `startedAt`, never `columnMovedAt`: the latter conflates "entered
review" with "gate started" and would fire during a legitimate human merge-wait — the false
positive that would make the signal untrustworthy. Only engages while a pre-merge result is
actually `pending`; a card whose gates have settled and is awaiting a human merge stays
`progressing`.

Reuses the resolved `executorStuckAfterMs` threshold — this is a hung agent session, the same
failure the executor check covers, so it needs no second setting. The reason is bucketed to whole
hours so the FN-7577 `stage|signal|reason` feed dedup stays effective (it must never embed a
changing millisecond value). A missing/malformed timestamp degrades to no signal; never fabricate a
stall. The FN-7514 human-control guard still runs upstream, so `autoMerge:false` rows stay
human-owned regardless of what this returns.
*/
function reviewGateStallReason(
  task: Partial<OverseerTaskRef>,
  stallInput: ExecutorStallSignalInput,
): string | undefined {
  if (!(stallInput.executorStuckAfterMs > 0)) return undefined;
  const pendingGate = task.workflowStepResults?.find((result) => {
    const phase = result.phase || "pre-merge";
    return phase === "pre-merge" && result.status === "pending" && Boolean(result.startedAt);
  });
  if (!pendingGate?.startedAt) return undefined;
  const gateStartedMs = Date.parse(pendingGate.startedAt);
  if (!Number.isFinite(gateStartedMs)) return undefined;
  const inactiveMs = stallInput.now() - gateStartedMs;
  if (inactiveMs < stallInput.executorStuckAfterMs) return undefined;
  const inactiveHours = Math.max(1, Math.floor(inactiveMs / 3_600_000));
  return `Review gate running for over ${inactiveHours}h with no verdict`;
}

/*
FNXC:PlannerOversight 2026-10-07-16:15:
RUFU-308: the executor-stage inactivity verdict must be measured from the card's LAST EXECUTION
EVIDENCE, not from the moment it entered the WIP lane. `columnMovedAt ?? updatedAt` — the FN-7743
proxy — prefers the column-entry clock whenever it exists, so a card that kept completing steps
after entry was still declared inactive: measured on RUFU-291 (main tip `5b7cdd962b`) the overseer
emitted "Executor stage inactive for over 3h / … / over 9h with no execution activity" every hour
while its Step 3 and Step 4 completed at 04:43 and 05:17. Measured again on RUFU-308 itself on
2026-10-07: the first steering injection landed at 17:34, three hours after column entry, while
the card's own step bookkeeping had been written less than an hour earlier — the claim is false in
both directions (silent during a real stall, loud during real progress).
`updateTask` bumps `updatedAt` unconditionally for every writer (AGENTS.md, RUFU-350), and
`TaskStep` carries no per-step timestamps, so the freshest durable proof that the executing lane
touched this card is the row clock itself plus the newest workflow-step-result lease/completion.
Taking the maximum costs nothing in sharpness: a genuinely stalled card writes nothing, so its
row clock stays as cold as its column entry and the verdict fires on exactly the same schedule it
always did. It is deliberately NOT the base for the dead-session probe above — that probe answers
"is anything running this card?", which no amount of recent row-writing can answer yes to.
*/
function latestExecutionEvidenceMs(
  task: Partial<OverseerTaskRef>,
  fallbacks: Array<string | undefined>,
): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const stamp of fallbacks) {
    const ms = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  for (const result of task.workflowStepResults ?? []) {
    for (const stamp of [result.startedAt, result.completedAt]) {
      const ms = stamp ? Date.parse(stamp) : NaN;
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    }
  }
  for (const report of task.stepReports ?? []) {
    const ms = report?.recordedAt ? Date.parse(report.recordedAt) : NaN;
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  return latest;
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

      const activityTimestamp = task.columnMovedAt ?? task.updatedAt;
      const activityAtMs = activityTimestamp ? Date.parse(activityTimestamp) : NaN;

      /*
      FNXC:PlannerOversight 2026-09-18-02:03:
      Dead-session observation, ahead of the FN-7743 proxy below. Why ahead: the proxy answers "has
      this card been quiet long enough?", which needs 2h measured from column entry even when the
      card has been provably sessionless the whole time. A wired `isTaskLive` probe answers the
      sharper question the operator actually cares about ("is anything running this card at all?"),
      so it is checked first and yields the SAME `stuck` signal the proxy yields — same bounded
      `retry_step` recovery, no new policy. The reason is constant (never a duration) so the FN-7577
      feed dedup stays effective, and a not-wired probe (undefined) or a missing/malformed timestamp
      changes nothing: never fabricate a stall.
      */
      if (stallInput.isTaskLive && Number.isFinite(activityAtMs)) {
        const deadSessionFloorMs = Math.min(stallInput.executorStuckAfterMs, DEAD_SESSION_GRACE_MS);
        if (
          deadSessionFloorMs > 0
          && stallInput.now() - activityAtMs >= deadSessionFloorMs
          && stallInput.isTaskLive(taskId) === false
        ) {
          return {
            signal: "stuck",
            reason: EXECUTOR_SESSION_NOT_LIVE_REASON,
            sources: [{ kind: "agent-log", ref: taskId }],
          };
        }
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
      /*
      FNXC:PlannerOversight 2026-10-07-16:16:
      RUFU-308, two corrections to this verdict — it is the sentence that lied about RUFU-291
      (`over 3h … over 9h with no execution activity` broadcast hourly while Steps 3 and 4 finished)
      and about RUFU-308 itself on 2026-10-07 (first steering injection 3h after column entry while
      the card's own step bookkeeping was under an hour old).
      (a) The clock is the card's latest execution evidence (`latestExecutionEvidenceMs`), not its
          column entry. A stalled card writes nothing, so this cannot soften a genuine stall; a
          card that keeps finishing steps is no longer called inert for finishing them.
      (b) A live executor session IS execution activity, so it refutes this sentence outright. The
          probe is the same predicate the retry handler gates on (`isTaskLiveForOverseerRetry`,
          FN-8471), so observation and action cannot disagree; a session that is registered yet
          wedged stays the in-session `StuckTaskDetector`'s job, and a sessionless card is already
          caught earlier and sharper by the dead-session probe above. `undefined` (probe unwired)
          keeps the FN-7743 behaviour exactly, as it does everywhere else in this input.
      Both the dead-session probe and this proxy keep their exact reason strings: the FN-7577 feed
      dedup keys on `stage|signal|reason`, and neither verdict's policy changes here.
      */
      const executionEvidenceMs = latestExecutionEvidenceMs(task, [task.columnMovedAt, task.updatedAt]);
      if (Number.isFinite(executionEvidenceMs) && stallInput.executorStuckAfterMs > 0 && stallInput.isTaskLive?.(taskId) !== true) {
        const inactiveMs = stallInput.now() - executionEvidenceMs;
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
      const reviewerGateStall = reviewGateStallReason(task, stallInput);
      if (reviewerGateStall) {
        return {
          signal: "stuck",
          reason: reviewerGateStall,
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
      // A plain in-review card with no reviewState resolves HERE, not to `reviewer`
      // (see resolveWatchedStage), so this is the branch a running first gate lands in.
      const mergerGateStall = reviewGateStallReason(task, stallInput);
      if (mergerGateStall) {
        return {
          signal: "stuck",
          reason: mergerGateStall,
          sources: [{ kind: "merge-error", ref: taskId }],
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
    options?: { now?: () => number; executorStuckAfterMs?: number; columnFlags?: TraitFlags; isTaskLive?: (taskId: string) => boolean | undefined },
  ): Promise<OverseerStageObservation | null> {
    try {
      if (level === "off") {
        return null;
      }

      const stage = resolveWatchedStage(task, options?.columnFlags);
      if (!stage) {
        return null;
      }

      const now = options?.now ?? Date.now;
      const executorStuckAfterMs = options?.executorStuckAfterMs ?? DEFAULT_PLANNER_OVERSEER_EXECUTOR_STUCK_AFTER_MS;
      const { signal, reason, sources } = deriveSignalAndSources(task.id, stage, task, { now, executorStuckAfterMs, isTaskLive: options?.isTaskLive });
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
          /*
          FNXC:PlannerOversight 2026-07-19-00:00:
          Activity feed label is short "planner" (not "planner-overseer") so operators scanning the task feed can tell this is planner lifecycle observation without the longer overseer product name.
          */
          /*
          FNXC:DiagnosticLogDedupe 2026-10-11-22:51 (RUFU-643):
          `lastLoggedKey` is per-process, so it bounded the feed inside one run and nowhere else: an
          unchanged (stage, signal) observation still measured 11,465 rows board-wide, because every
          supervised-dashboard restart (RUFU-642) let the next sweep re-announce every card. The durable
          append is keyed on the same triple the in-process gate uses, so a card that has sat in the merge
          phase all day says so once per window instead of once per restart.
          */
          await logDiagnosticOnce(this.store, task.id, {
            action: `[planner] stage=${stage} signal=${signal}: ${reason}`,
            dedupeKey: `planner-oversight:${diagnosticSignature(loggedKey)}`,
          });
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
