import {
  CODE_REVIEW_GROUP_ID,
  completeReviewerRunForTask,
  invalidateReviewerRunsForTask,
  isEphemeralAgent,
  listReviewerRunsForTask,
  latestTaskEnteredReviewAt,
  openReviewerRunForTask,
  resolveLifecycleColumns,
  resolveWorkflowIrForTaskWithProvenance,
} from "@fusion/core";
import type {
  Agent,
  AgentHeartbeatRun,
  AgentStore,
  ReviewerRunRow,
  Task,
  TaskStore,
  WorkflowSelectionCache,
} from "@fusion/core";
import type { HeartbeatMonitor } from "../agent-heartbeat.js";
import { createLogger } from "../logger.js";

/*
FNXC:ReviewLaneDispatch 2026-09-09 (STAS-205):
Before this sweep, review work began ONLY inside a reviewer agent's own heartbeat procedure, so
the start latency of every review was that agent's patrol interval (6 h for the live reviewer) —
and a card moved into review between patrols waited hours, or never, if no patrol ever saw it.
Eligibility here is derived from committed state each tick (lane + paused + ledger + live run),
never from process memory, so a restart re-derives the same decisions. The ledger row opened
before dispatch is the idempotency key: `task_reviewer_runs_live_unique` makes a second
concurrent attempt a no-op.
*/

const log = createLogger("ReviewDispatchSweep");

/** Matches the scheduler's own poll cadence; one shared tick, not a competing timer. */
export const DEFAULT_REVIEW_TICK_MS = 15_000;

/**
 * A card can be mid-handoff when a tick observes it (the completion handoff moves it into
 * review in its own transaction). Two ticks is enough to settle and is 2,880x below the
 * 86,400,000 ms observation threshold this sweep replaces.
 * FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review C5): the dispatch bound this
 * grace window feeds is grace + at most one tick — a card that enters right after a tick
 * waits up to 30 s + 15 s = 45 s, not one interval. The grace settles handoffs; the tick
 * cadence bounds discovery.
 */
export const DEFAULT_REVIEW_GRACE_MS = 30_000;

/**
 * `executeHeartbeat` inserts the backing `agent_runs` row in-process, so a live ledger row with
 * no visible session after this long means the dispatch never produced work (bucket B6). A
 * reviewer session that is genuinely working shows an active run, so it is never judged here.
 */
export const DEFAULT_REVIEW_START_LATENCY_MS = 120_000;

/** Bounded re-dispatch attempts per card before the sweep parks it and stops retrying. */
export const DEFAULT_REVIEW_MAX_ATTEMPTS = 3;

/**
 * One dispatch per tick: the reviewer runs a single session at a time, and `startRun` fails an
 * existing active run before starting a new one, so a second dispatch in the same tick would
 * interrupt the review the first one just started.
 */
export const DEFAULT_MAX_DISPATCHES_PER_TICK = 1;

export type ReviewDispatchClass =
  /** B1 — no ledger row at all: reviewer work never began. */
  | "never-dispatched"
  /** B2 — a verdict is recorded; applying it belongs to the lane, not to a new dispatch. */
  | "verdict-recorded"
  /** B3/B6 — an attempt ended unfinished, or began and produced no session. */
  | "stalled-attempt"
  /** B4 — an open attempt corroborated by a live reviewer session on this exact card. */
  | "review-in-flight"
  /** B5 — the residual when attempts ran out: surfaced, then left alone. */
  | "parked"
  /** E1 — deliberate no-code-review intent (review level 0 or an explicit step opt-out). */
  | "excluded-review-level"
  /** E2 — paused. */
  | "excluded-paused"
  /** E3 — the reviewer itself recorded that there was nothing to review. */
  | "nothing-reviewable"
  /** E4 — no single enabled reviewer exists to route to. */
  | "no-reviewer"
  /** The reviewer is mid-session on a different card; a second start would kill it. */
  | "reviewer-busy"
  /** Inside the grace window after the card entered the lane. */
  | "awaiting-handoff";

export interface ReviewDispatchDecision {
  /** The named bucket this card lands in; every review-lane card gets exactly one. */
  bucket: ReviewDispatchClass;
  /** Open a fresh attempt. Set for B1 and for an in-budget B3/B6. */
  dispatch: boolean;
  /** Supersede the current live row before dispatching, to free the live-slot index. */
  supersedeFirst: boolean;
  /** Next attempt number to record (1 for a never-dispatched card). */
  nextRound: number;
}

export interface ReviewDispatchTickResult {
  dispatched: string[];
  classes: Record<ReviewDispatchClass, number>;
}

/** A review-lane card plus the board its workflow resolution named, which the ledger row records. */
interface ReviewDispatchCandidate {
  task: Task;
  boardId: string;
  /** Committed `task:entered-review` time, or null for pre-0082 entries (updatedAt is the fallback then). */
  enteredReviewAt: string | null;
}

export interface ReviewDispatchSweepOptions {
  store: TaskStore;
  agentStore: AgentStore;
  heartbeatMonitor: HeartbeatMonitor;
  tickMs?: number;
  graceMs?: number;
  startLatencyMs?: number;
  maxAttempts?: number;
  maxDispatchesPerTick?: number;
}

/**
 * A finished attempt that left no verdict — a crash, a refused start, or a superseded zombie —
 * is what the retry budget counts. Approve/revise/skipped attempts achieved their purpose, so
 * counting them would let a long-lived card exhaust its budget on healthy reviews.
 */
function unfinishedAttempts(rows: ReviewerRunRow[]): number {
  return rows.filter((row) => !isVerdictRecorded(row) && row.status !== "skipped").length;
}

function isVerdictRecorded(row: ReviewerRunRow): boolean {
  return row.completedAt !== null && (row.status === "approve" || row.status === "revise");
}

function newestRow(rows: ReviewerRunRow[]): ReviewerRunRow | null {
  return rows.length > 0 ? rows[rows.length - 1]! : null;
}

/**
 * Pure classification over committed state, in the matrix's first-match order. Keeping it out of
 * the I/O path is what makes every bucket assertable without a live reviewer or engine restart.
 */
export function classifyReviewCard(input: {
  task: Task;
  rows: ReviewerRunRow[];
  activeRun: AgentHeartbeatRun | null;
  reviewerFound: boolean;
  now: number;
  graceMs: number;
  startLatencyMs: number;
  maxAttempts: number;
  /** Committed review-entry time (epoch ms); null falls back to `task.updatedAt` for pre-0082 entries. */
  reviewEnteredAt?: number | null;
}): ReviewDispatchDecision {
  const skip = (bucket: ReviewDispatchClass): ReviewDispatchDecision => ({
    bucket,
    dispatch: false,
    supersedeFirst: false,
    nextRound: 1,
  });

  /*
  FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review C6):
  Every pause authority lands in the same bucket before any dispatch logic: `paused` (engine/
  automation pause) and `userPaused` (the human's own hold) are both "do not start reviewer work".
  */
  if (input.task.paused === true || input.task.userPaused === true) return skip("excluded-paused");
  if (!input.reviewerFound) return skip("no-reviewer");
  if (isCodeReviewExcluded(input.task)) return skip("excluded-review-level");

  const rows = input.rows;
  // An invalidated attempt is history, not work in flight: supersession clears `invalidated_at`
  // but never completes the row, so the live predicate must exclude it explicitly (#3619 review D).
  const live = rows.find((row) => row.completedAt === null && row.invalidatedAt === null) ?? null;
  const nextRound = rows.length + 1;

  /*
  FNXC:ReviewLaneDispatch 2026-09-09 (STAS-205):
  A recorded verdict outranks every ledger signal: the review already happened, so dispatching a
  second one would duplicate a verdict instead of fixing missing work. `pending` is excluded on
  purpose — a step that was dispatched but never received a verdict callback is the defect shape
  (Fusion#1946), and treating it as a verdict would make the sweep blind to exactly the cards it
  exists to rescue.
  */
  if (hasRecordedCodeReviewVerdict(input.task)) return skip("verdict-recorded");

  if (live) {
    // B4 requires corroboration by the live session itself, not merely the ledger row.
    if (input.activeRun && input.activeRun.taskId === input.task.id) return skip("review-in-flight");
    if (input.activeRun) return skip("reviewer-busy");
    if (input.now - Date.parse(live.startedAt) < input.startLatencyMs) return skip("awaiting-handoff");
    if (unfinishedAttempts(rows) >= input.maxAttempts) return skip("parked");
    return { bucket: "stalled-attempt", dispatch: true, supersedeFirst: true, nextRound };
  }

  const newest = newestRow(rows);
  if (newest) {
    if (isVerdictRecorded(newest)) return skip("verdict-recorded");
    if (newest.status === "skipped") return skip("nothing-reviewable");
    if (unfinishedAttempts(rows) >= input.maxAttempts) return skip("parked");
    return { bucket: "stalled-attempt", dispatch: true, supersedeFirst: false, nextRound };
  }

  /*
  FNXC:ReviewLaneDispatch 2026-09-16-16:20 (#3619 review E):
  The handoff grace keys on the committed `task:entered-review` event, NOT `task.updatedAt`:
  any unrelated edit (a comment, a description bump) advances updatedAt, so a card that keeps
  receiving edits could sit in the grace window forever and never dispatch. updatedAt remains
  the fallback only for cards that entered review before migration 0082 wrote no event.
  */
  const enteredMs = input.reviewEnteredAt ?? Date.parse(input.task.updatedAt);
  if (input.now - enteredMs < input.graceMs) return skip("awaiting-handoff");
  return { bucket: "never-dispatched", dispatch: true, supersedeFirst: false, nextRound: 1 };
}

/**
 * `enabledWorkflowSteps` is the runtime source of truth for which optional review groups a card
 * wants (reviewLevel is creation-time only). An unset list means the card never restricted
 * itself, so only an explicit list without code-review counts as a deliberate exclusion.
 */
function isCodeReviewExcluded(task: Task): boolean {
  if (task.reviewLevel === 0) return true;
  const enabled = task.enabledWorkflowSteps;
  return Array.isArray(enabled) && !enabled.includes(CODE_REVIEW_GROUP_ID);
}

/**
 * The lane's own authority on "review happened": a non-superseded code-review step result that
 * carries an authored outcome.
 * FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review G2):
 * `skipped` counts only when a named authority skipped the step (`bypassedBy`, FN-7720) — that is
 * a recorded human decision. A `skipped` with a `notRunReason` and no bypass is the MISSING-review
 * shape this sweep exists to rescue: the merge gate refuses to approve on it for exactly the same
 * reason, so treating it as a verdict would hide the card from both authorities at once.
 * `failed`/`advisory_failure` are authored review outcomes: their re-run belongs to the bounded
 * remediation authority (failed-pre-merge-step recovery, FN-7720 bypass), and dispatching a second
 * review here would race it. Superseded results (a newer commit invalidated them) and `pending`
 * results (dispatched, verdict never delivered) must not count, or the sweep would call an
 * unanswered review a completed one.
 */
function hasRecordedCodeReviewVerdict(task: Task): boolean {
  return (task.workflowStepResults ?? []).some(
    (result) =>
      result.workflowStepId === CODE_REVIEW_GROUP_ID &&
      result.supersededAt == null &&
      (result.status === "passed" ||
        result.status === "failed" ||
        result.status === "advisory_failure" ||
        (result.status === "skipped" && result.bypassedBy != null)),
  );
}

export class ReviewDispatchSweep {
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Suppresses repeat lines when a card sits in the same state across ticks (15 s cadence). */
  private lastLoggedBucket = new Map<string, ReviewDispatchClass>();

  public constructor(private readonly options: ReviewDispatchSweepOptions) {}

  public start(): void {
    const tickMs = this.options.tickMs ?? DEFAULT_REVIEW_TICK_MS;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        log.error(`Review dispatch tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, tickMs);
    this.timer.unref?.();
    log.log(`Review dispatch sweep started (tick ${tickMs}ms)`);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Returns per-bucket counts plus the ids it dispatched, so a test asserts real decisions. */
  public async tick(now = new Date()): Promise<ReviewDispatchTickResult> {
    // Re-entrancy guard only. It is not the dedup: the durable dedup is the ledger row.
    if (this.running) return { dispatched: [], classes: emptyClasses() };
    this.running = true;
    try {
      return await this.runPass(now);
    } finally {
      this.running = false;
    }
  }

  private async runPass(now: Date): Promise<ReviewDispatchTickResult> {
    const classes = emptyClasses();
    const dispatched: string[] = [];
    /*
    FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review C6):
    Global/engine pause suppresses the whole pass — starting a reviewer session is engine work,
    and dispatching reviewer sessions while the operator has paused the engine would violate the
    pause the same way executing a task would. Unpause needs no event: the next tick re-reads
    settings and proceeds.

    FNXC:ReviewLaneDispatch 2026-09-16-16:20 (#3619 review A / greptile P1):
    An unreadable settings row ABORTS the pass — dispatching while unable to prove the engine is
    not paused would start reviewer sessions against an operator pause, and the heartbeat source
    this sweep uses does not re-check `enginePaused` downstream. A transient DB failure costs at
    most one skipped tick; a stray session during a pause costs the operator's guarantee.
    */
    const settings = await this.options.store.getSettings();
    if (settings?.globalPause || settings?.enginePaused) {
      return { dispatched, classes };
    }
    const candidates = await this.findReviewLaneCandidates();
    if (candidates.length === 0) return { dispatched, classes };

    const reviewer = await this.resolveReviewer();
    const activeRun = reviewer ? await this.options.agentStore.getActiveHeartbeatRun(reviewer.id) : null;

    let dispatches = 0;
    const maxDispatches = this.options.maxDispatchesPerTick ?? DEFAULT_MAX_DISPATCHES_PER_TICK;
    for (const candidate of candidates) {
      const rows = await listReviewerRunsForTask(this.options.store, candidate.task.id);
      const decision = classifyReviewCard({
        task: candidate.task,
        rows,
        activeRun: activeRun && activeRun.agentId === reviewer?.id ? activeRun : null,
        reviewerFound: reviewer !== null,
        now: now.getTime(),
        reviewEnteredAt: candidate.enteredReviewAt === null ? null : Date.parse(candidate.enteredReviewAt),
        graceMs: this.options.graceMs ?? DEFAULT_REVIEW_GRACE_MS,
        startLatencyMs: this.options.startLatencyMs ?? DEFAULT_REVIEW_START_LATENCY_MS,
        maxAttempts: this.options.maxAttempts ?? DEFAULT_REVIEW_MAX_ATTEMPTS,
      });
      classes[decision.bucket] += 1;
      this.logBucketChange(candidate.task.id, decision.bucket, rows);

      if (!decision.dispatch || dispatches >= maxDispatches || !reviewer) continue;
      dispatches += 1;
      if (await this.dispatch(candidate, reviewer, decision, now)) dispatched.push(candidate.task.id);
    }
    return { dispatched, classes };
  }

  /**
   * Oldest review ENTRY first: the sweep dispatches one card per tick, so the card that has
   * waited longest for review must be the one it acts on. Entry time is the committed
   * `task:entered-review` event, not `task.updatedAt` — unrelated edits must not reshuffle the
   * queue (#3619 review E). Pre-0082 cards have no event and fall back to updatedAt.
   *
   * Each candidate carries the board id its resolution named, because the dispatch has to record
   * it and cannot recover it later: `WorkflowIr` has no id field (an id present on an IR is the
   * author's, not the store's row id), so the provenance of the resolution is the only honest
   * source for "which board is this card on".
   */
  private async findReviewLaneCandidates(): Promise<ReviewDispatchCandidate[]> {
    const selectionCache: WorkflowSelectionCache = new Map();
    const tasks = await this.options.store.listTasks({ slim: true, includeArchived: false });
    const candidates: ReviewDispatchCandidate[] = [];
    for (const task of tasks) {
      // Paused cards stay candidates: the classifier buckets them as excluded-paused (E2), so a
      // paused card remains VISIBLE in the sweep's accounting instead of silently vanishing from
      // it (#3619 review G4 — pre-filtering here made the E2 bucket unreachable from a real tick).
      const provenance = await resolveWorkflowIrForTaskWithProvenance(this.options.store, task.id, undefined, selectionCache);
      const lanes = resolveLifecycleColumns(provenance.ir);
      // An unresolvable review lane is not a licence to assume the historical column name.
      if (!lanes?.review) continue;
      if (task.column !== lanes.review) continue;
      candidates.push({
        task,
        // A default-fallback card has no selected board; "" is the ledger column's own no-board value.
        boardId: provenance.workflowId ?? "",
        enteredReviewAt: await latestTaskEnteredReviewAt(this.options.store, task.id),
      });
    }
    return candidates.sort(
      (a, b) =>
        Date.parse(a.enteredReviewAt ?? a.task.updatedAt) - Date.parse(b.enteredReviewAt ?? b.task.updatedAt),
    );
  }

  /**
   * Nothing in the store records which agent owns a given card's review, so this refuses to
   * invent one: exactly one enabled non-ephemeral reviewer dispatches. Zero reviewers or several
   * is a configuration gap (bucket E4) — surfaced and left undispatched rather than routed to a
   * worse-suited agent, because a silently-chosen reviewer would be a new privilege, not a fix.
   */
  private async resolveReviewer(): Promise<Agent | null> {
    const agents = await this.options.agentStore.listAgents();
    const reviewers = agents.filter(
      (agent) => !isEphemeralAgent(agent) && agent.runtimeConfig?.enabled !== false && agent.roles.includes("reviewer"),
    );
    if (reviewers.length === 1) return reviewers[0]!;
    log.warn(
      reviewers.length === 0
        ? "E4: no enabled reviewer agent exists; review-lane cards stay undispatched by design."
        : `E4: ${reviewers.length} enabled reviewer agents cover the review lane; refusing to pick one.`,
    );
    return null;
  }

  private async dispatch(
    candidate: ReviewDispatchCandidate,
    reviewer: Agent,
    decision: ReviewDispatchDecision,
    now: Date,
  ): Promise<boolean> {
    const task = candidate.task;
    const at = now.toISOString();
    if (decision.supersedeFirst) {
      await invalidateReviewerRunsForTask(this.options.store, task.id, at);
    }

    const opened = await openReviewerRunForTask(this.options.store, {
      taskId: task.id,
      boardId: candidate.boardId,
      reviewerAgentId: reviewer.id,
      reworkRound: decision.nextRound,
      at,
    });
    // `created: false` means another tick or process won the race — the card is dispatched already.
    if (!opened.created || !opened.id) return false;

    log.log(`Dispatching review of ${task.id} to ${reviewer.id} (attempt ${decision.nextRound}, run ${opened.id})`);
    void this.options.heartbeatMonitor
      .executeHeartbeat({
        agentId: reviewer.id,
        source: "automation",
        taskId: task.id,
        triggerDetail: "review-lane dispatch sweep",
      })
      .catch((error: unknown) => {
        this.closeUnfinishedRun(
          task.id,
          opened.id!,
          reviewer.id,
          `dispatch-failed: ${error instanceof Error ? error.message : String(error)}`,
        ).catch((closeError: unknown) => {
          /*
          FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review C7):
          The close is best-effort AND its own failure must not escape as an unhandled rejection
          (this catch handler sits on a promise with no upstream handler). If the close itself
          failed, the row stays live and the stalled-attempt path supersedes it on a later tick —
          bookkeeping never crashes the engine.
          */
          log.error(
            `Review run ${opened.id} for ${task.id} could not be closed after a dispatch failure: ${
              closeError instanceof Error ? closeError.message : String(closeError)
            }`,
          );
        });
      });
    return true;
  }

  /**
   * Verdicts are not captured into the ledger yet, so a session that ends leaves an attempt with
   * no recorded outcome. Leaving it `running` would claim reviewer work is still happening and
   * suppress every future dispatch for the card — the stuck state this sweep exists to remove.
   * Closing it as a failed attempt keeps the attempt attributable AND lets a later tick re-dispatch.
   */
  private async closeUnfinishedRun(taskId: string, runId: string, reviewerAgentId: string, reason: string): Promise<void> {
    const transitioned = await completeReviewerRunForTask(this.options.store, {
      id: runId,
      taskId,
      status: "failed",
      at: new Date().toISOString(),
      failureReasons: [reason],
    });
    if (!transitioned) {
      // The attempt settled between the dispatch rejection and this close (e.g. the sweep already
      // superseded it). One-way completion keeps the earlier record; nothing to repair.
      log.debug(`Review run ${runId} for ${taskId} had already settled — late close skipped (${reason})`);
      return;
    }
    log.warn(`Closed review run ${runId} for ${taskId} as failed (${reason}, reviewer ${reviewerAgentId})`);
  }

  /** Every classification is actionable or surfaced exactly once, never once per 15 s tick. */
  private logBucketChange(taskId: string, bucket: ReviewDispatchClass, rows: ReviewerRunRow[]): void {
    if (bucket === "review-in-flight" || bucket === "awaiting-handoff") {
      this.lastLoggedBucket.delete(taskId);
      return;
    }
    if (this.lastLoggedBucket.get(taskId) === bucket) return;
    this.lastLoggedBucket.set(taskId, bucket);
    const detail = `attempts=${rows.length}`;
    if (bucket === "never-dispatched" || bucket === "stalled-attempt") {
      log.log(`${bucket}: ${taskId} (${detail})`);
      return;
    }
    log.warn(`${bucket}: ${taskId} (${detail}) — no reviewer work dispatched`);
  }
}

function emptyClasses(): Record<ReviewDispatchClass, number> {
  return {
    "never-dispatched": 0,
    "verdict-recorded": 0,
    "stalled-attempt": 0,
    "review-in-flight": 0,
    parked: 0,
    "excluded-review-level": 0,
    "excluded-paused": 0,
    "nothing-reviewable": 0,
    "no-reviewer": 0,
    "reviewer-busy": 0,
    "awaiting-handoff": 0,
  };
}
