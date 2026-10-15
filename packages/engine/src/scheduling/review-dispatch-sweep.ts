import {
  CODE_REVIEW_GROUP_ID,
  completeReviewerRunForTask,
  formatLaneCapabilityDeclineReason,
  invalidateReviewerRunsForTask,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  isEphemeralAgent,
  laneCapabilityDeclinePolicy,
  listReviewerRunsForTask,
  latestTaskEnteredReviewAt,
  openReviewerRunForTask,
  resolveLifecycleColumns,
  resolveWorkflowIrForTaskWithProvenance,
  isEngineLossReviewerRun,
  reviewerRunLaneDeclineSignature,
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

/**
 * FNXC:ReviewDispatch 2026-10-02-16:40: how often one project's reviewer-configuration gap may repeat. Five
 * minutes keeps a genuine gap visible (~60 lines/day/project) without drowning the per-card outcome lines.
 */
const DEFAULT_E4_LOG_COOLDOWN_MS = 5 * 60_000;

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

/*
FNXC:ReviewLanePool 2026-10-03-21:23 (RUFU-530):
This was 1, which combined with `resolveReviewerPool`'s old "exactly one reviewer" rule made the review lane's
host-wide concurrency exactly one. Measured on the saneca board: 18 cards sat in review behind a single enabled
reviewer (`Tester`), draining at 6 reviews/hour while `moves/30m` fell to 1. The real bound is not this number —
it is the pool of enabled reviewers, because a reviewer runs one session at a time (`startRun` fails the active
run before starting a new one). So this is now only a ceiling ABOVE the pool: a project with one reviewer still
dispatches at most one card per tick, a project with three gets three. Raising it changes nothing for the 12
projects that have one enabled reviewer and unblocks any project that configures more.
*/
export const DEFAULT_MAX_DISPATCHES_PER_TICK = 4;

export type ReviewDispatchClass =
  /** B1 — no ledger row at all: reviewer work never began. */
  | "never-dispatched"
  /** B2 — a verdict is recorded; applying it belongs to the lane, not to a new dispatch. */
  | "verdict-recorded"
  /** B3/B6 — an attempt ended unfinished, or began and produced no session. */
  | "stalled-attempt"
  /** B4 — an open attempt corroborated by a live reviewer session on this exact card. */
  | "review-in-flight"
  /*
  FNXC:ReviewDispatchRefusal 2026-10-15-17:24 (RUFU-682):
  A lane that REFUSES the card on capability grounds is not a lane that is busy. Before this bucket existed the
  refusal was reported as `reviewer-busy` (SANE-484: `Dispatching review of SANE-484 to agent-0031e775 (attempt 24…)`
  → `declined bound task … has roles "reviewer"; implementation task …` → `reviewer-busy … (attempts=24)`), so the
  board looked congested while the real state was a deterministic mismatch nobody could see, and every ~40 minutes
  the identical attempt repeated. This bucket is the named, countable refusal that stops routing to the declined
  binding; it is NOT a lifecycle move — the card stays in its lane with its branch, worktree, and step progress.
  */
  /** RUFU-682 — every enabled reviewer already refused this card on capability grounds; re-dispatch repeats it. */
  | "capability-declined"
  /** B5 — the residual when attempts ran out: surfaced, then left alone. */
  | "parked"
  /** E1 — deliberate no-code-review intent (review level 0 or an explicit step opt-out). */
  | "excluded-review-level"
  /** E2 — paused. */
  | "excluded-paused"
  /** E3 — the reviewer itself recorded that there was nothing to review. */
  | "nothing-reviewable"
  /** E4 — no enabled reviewer exists to route to (zero pool; several is now supported). */
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

/*
FNXC:ReviewDispatchRefusal 2026-10-15-17:26 (RUFU-682):
The ledger already knew WHO refused and WHY (the decline witness names the lane and its policy signature); what
was missing is the derivation the routing decision needs. Matched per (lane, signature), never by signature alone:
two reviewers can share a policy signature, and a refusal by lane A is not a refusal by lane B — B has never been
asked. The signature comparison is what keeps the refusal liftable: an operator who edits the lane's roles or
assignment policy changes its signature, the recorded refusal stops matching, and the next tick routes again.
No timer, no manual row edit, and no state for a sweep to forget on restart.
*/
/** The reviewers in `pool` whose CURRENT policy signature equals the one their refusal was recorded under. */
export function declinedReviewersForTask(
  rows: ReviewerRunRow[],
  policySignatureByAgent: ReadonlyMap<string, string>,
): Set<string> {
  const declined = new Set<string>();
  for (const row of rows) {
    const signature = reviewerRunLaneDeclineSignature(row);
    if (signature === null) continue;
    if (policySignatureByAgent.get(row.reviewerAgentId) === signature) declined.add(row.reviewerAgentId);
  }
  return declined;
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
  /*
  FNXC:ReviewDispatch 2026-10-02-16:40 (RUFU-479 follow-up on RUFU-478):
  The sweep runs once per project runtime, but its log line carried no project, so a production log with 68
  `E4: no enabled reviewer agent exists` lines could not be read as either "the review lane is dead" or "half
  the projects are unconfigured" — and it was filed as the former. Measured: 12 of 24 projects on this host
  have no enabled reviewer agent at all, so E4 is true for them and irrelevant for the other 12. Attribution
  is the whole difference, so the sweep now names its project on every line.
  */
  /** Project identity for log attribution; defaults to the store's own project. */
  projectId?: string;
  /** Injectable clock, so the E4 rate limit is testable without waiting out a cooldown. */
  now?: () => number;
  /** How often a reviewer-configuration gap may repeat in the log. Default 5 minutes. */
  e4LogCooldownMs?: number;
  graceMs?: number;
  startLatencyMs?: number;
  maxAttempts?: number;
  maxDispatchesPerTick?: number;
}

/**
 * A finished attempt that left no verdict — a crash, a refused start, or a superseded zombie —
 * is what the retry budget counts. Approve/revise/skipped attempts achieved their purpose, so
 * counting them would let a long-lived card exhaust its budget on healthy reviews.
 *
 * FNXC:ReviewLaneDispatch 2026-10-05-00:24 (RUFU-559):
 * An attempt the engine orphaned was never an attempted review, so it must not spend the card's anti-loop
 * budget. Without this exemption the RUFU-559 reconcile would be worse than leaving the zombie: closing the row
 * turns "stranded, cannot dispatch" into "attempts spent, parked forever". The exemption is keyed on the shared
 * `engine-lost:` reason prefix that sweep writes, not on status or age, and deliberately does NOT exempt the
 * dispatch sweep's own `dispatch-failed:` refusals, which were attempts that reached the point of failing.
 *
 * FNXC:ReviewDispatchRefusal 2026-10-15-17:25 (RUFU-682):
 * A lane-capability refusal is exempt for the same reason, and the exemption is what makes the new bucket the
 * operative authority instead of the counter. The refusal happens BEFORE any session starts, so counting it would
 * (a) burn the card's budget on policy the reviewer never got to exercise, and (b) let the card land in `parked`
 * — "attempts spent" — when the true fact is "this lane cannot take this card", which is the mislabel this card
 * was filed against. Refusals are read as refusals by the binding-routing check below, not as attempts.
 */
function unfinishedAttempts(rows: ReviewerRunRow[]): number {
  return rows.filter(
    (row) =>
      !isVerdictRecorded(row)
      && row.status !== "skipped"
      && !isEngineLossReviewerRun(row)
      && reviewerRunLaneDeclineSignature(row) === null,
  ).length;
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
  /**
   * RUFU-682 — every reviewer the sweep could route this card to has already declined it on capability grounds.
   * Computed by the caller from the ledger's decline witnesses (`declinedReviewersForTask`), never from a guess.
   */
  capabilityDeclinedForPool?: boolean;
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

  FNXC:ReviewLaneDispatch 2026-09-28-08:06 (RUFU-380):
  That blanket made the engine's OWN in-review stall-deadlock park self-sustaining, and on the saneca
  board it is the dominant wedge: 27 `in-review` cards sit `failed` with `completed-review-status-none
  repeated 3× without progress` while their Code Review row is `failed` / `NOT_REVIEWED`, and every tick
  logs `[ReviewDispatchSweep] excluded-paused: SANE-509 (attempts=1) — no reviewer work dispatched`
  (same for SANE-510/512/513). Nothing can produce the missing verdict, so nothing reaches the merge
  door, so the park is re-confirmed forever — 1 lifecycle move in 40 minutes across the whole project.
  A park the engine authored is not an operator stop, the invariant `1da1e59381` already encodes for
  capacity eligibility and stall-park recovery. A human hold (`userPaused`) and every other engine pause
  keep the old meaning. A card whose review genuinely produced a verdict is still protected — the
  recorded-verdict rule below outranks the ledger, so relaxing the pause filter only ever lets through
  cards with NO verdict, which is exactly the work the reviewer lane owes.
  */
  if (input.task.userPaused === true
    || (input.task.paused === true && input.task.pausedReason !== IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON)) {
    return skip("excluded-paused");
  }
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
    /*
    FNXC:ReviewDispatchRefusal 2026-10-15-17:26 (RUFU-682):
    The refusal is checked BEFORE `reviewer-busy`, and the order is the whole point of the card. A busy reviewer
    is a wait that ends; a capability refusal is the same verdict forever, and reporting it as a wait is what made
    24 attempts look like congestion. The corroborated-session arm above still outranks it: a review that is
    demonstrably running is not a refusal.
    */
    if (input.capabilityDeclinedForPool) return skip("capability-declined");
    if (input.activeRun) return skip("reviewer-busy");
    if (input.now - Date.parse(live.startedAt) < input.startLatencyMs) return skip("awaiting-handoff");
    if (unfinishedAttempts(rows) >= input.maxAttempts) return skip("parked");
    return { bucket: "stalled-attempt", dispatch: true, supersedeFirst: true, nextRound };
  }

  const newest = newestRow(rows);
  if (newest) {
    if (isVerdictRecorded(newest)) return skip("verdict-recorded");
    if (newest.status === "skipped") return skip("nothing-reviewable");
    if (input.capabilityDeclinedForPool) return skip("capability-declined");
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
  if (input.capabilityDeclinedForPool) return skip("capability-declined");
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
        ((result.status === "failed" || result.status === "advisory_failure") &&
          carriesAuthoredReviewOutcome(result)) ||
        (result.status === "skipped" && result.bypassedBy != null)),
  );
}

/*
FNXC:ReviewDispatch 2026-10-04-17:25 (RUFU-343):
The `failed` / `advisory_failure` arm above used to count ANY row with that status, on the premise that such a
row is an authored reviewer outcome. Measured on production it is not always one: SANE-406/468/504/531 carry
`code-review -> {status: "failed", verdict: null, bypassedBy: null}` with ZERO completed reviewer runs
(`task_reviewer_runs`: 3 rows, 0 completed, 2 invalidated), while their `plan-review` row on the same card does
carry a real verdict. An evidence-free failure row is the exact shape this sweep exists to rescue, and counting
it as a verdict made the card invisible to BOTH authorities at once: dispatch said `verdict-recorded` while the
merge gate refused the same reason.
The authority split stays: a failure that carries its verdict (REVISE/RETHINK/UNAVAILABLE) or an operator bypass
is still authored work, owned by failed-pre-merge-step recovery and FN-7720, and must not be re-dispatched here.
Only the row with no authored evidence at all stops counting.
*/
function carriesAuthoredReviewOutcome(result: { verdict?: unknown; bypassedBy?: unknown }): boolean {
  return result.verdict != null || result.bypassedBy != null;
}

/**
 * Which reviewer slot a card gets, and which run the classifier must see.
 *
 * FNXC:ReviewLanePool 2026-10-03-21:23 (RUFU-530):
 * Pulled out of the tick loop so the pool's routing rules are assertable without a store, a heartbeat, or a
 * Postgres fixture. The rules are the whole contract of the pool:
 * 1. a reviewer already running THIS card keeps it (its run is handed over, so classification is `review-in-flight`);
 * 2. otherwise the first unallocated reviewer with no run takes the card, and is told `activeRun: null` — that
 *    null is what authorises a dispatch, so passing a busy run here would serialise the pool back to one;
 * 3. when every reviewer is busy elsewhere, a busy run is handed over so the card is counted as `reviewer-busy`
 *    rather than vanishing from the sweep's accounting.
 *
 * FNXC:ReviewDispatchRefusal 2026-10-15-17:27 (RUFU-682): a reviewer that has ALREADY refused this card on
 * capability grounds is excluded from arms 2 and 3 — that is what "stop further dispatch to the same binding"
 * means while a second, capable reviewer still gets the card. Arm 1 is deliberately unfiltered: a lane running
 * THIS card is a fact about a live session, and misreporting real work as a refusal is the worse error.
 */
export function resolveReviewSlot(input: {
  pool: Agent[];
  busyRunByReviewer: Map<string, AgentHeartbeatRun | null>;
  allocatedThisTick: Set<string>;
  taskId: string;
  /** Reviewers whose refusal is on record for this card; never offered the card again this tick. */
  declined?: ReadonlySet<string>;
}): { chosen: Agent | null; free: Agent | null; activeRun: AgentHeartbeatRun | null } {
  const routable = input.declined
    ? input.pool.filter((agent) => !input.declined!.has(agent.id))
    : input.pool;
  const onThisCard = input.pool.find((agent) => input.busyRunByReviewer.get(agent.id)?.taskId === input.taskId) ?? null;
  const free = routable.find((agent) => !input.allocatedThisTick.has(agent.id) && !input.busyRunByReviewer.get(agent.id)) ?? null;
  const chosen = onThisCard ?? free ?? routable.find((agent) => input.busyRunByReviewer.get(agent.id)) ?? null;
  const busyRun = chosen ? input.busyRunByReviewer.get(chosen.id) ?? null : null;
  return { chosen, free, activeRun: free && !onThisCard ? null : busyRun };
}

export class ReviewDispatchSweep {
  private timer?: NodeJS.Timeout;
  /** How far apart two History refusals for one unchanged episode may be. */
  private static readonly REFUSAL_HISTORY_WINDOW_MS = 6 * 60 * 60_000;
  private running = false;
  /** Suppresses repeat lines when a card sits in the same state across ticks (15 s cadence). */
  private lastLoggedBucket = new Map<string, ReviewDispatchClass>();
  /** Prefix naming the owning project on every line; empty only when the store has no project id. */
  private readonly projectTag: string;
  private readonly now: () => number;
  private readonly e4LogCooldownMs: number;
  private lastE4LogAt = 0;
  private e4Suppressed = 0;
  /*
  FNXC:ReviewDispatchRefusal 2026-10-15-17:29 (RUFU-682): the refusal is announced to the card ONCE per episode, not
  every 15 s tick. `logEntryOnce`'s window is the durable bound; this set is what stops the sweep from taking the
  card's advisory lock four times a minute while the misconfiguration stands.
  */
  private readonly refusalAnnounced = new Map<string, string>();

  public constructor(private readonly options: ReviewDispatchSweepOptions) {
    const projectId = options.projectId ?? options.store.getProjectId?.() ?? null;
    this.projectTag = projectId ? `[${projectId}] ` : "";
    this.now = options.now ?? Date.now;
    this.e4LogCooldownMs = options.e4LogCooldownMs ?? DEFAULT_E4_LOG_COOLDOWN_MS;
  }

  /**
   * A reviewer-configuration gap is steady state, not an event: at a 15 s cadence it wrote 68 identical lines
   * while the four lines that actually described cards were buried under them. The first occurrence is always
   * written; later ones repeat only after the cooldown and report how many were suppressed in between.
   */
  private logReviewerConfigurationGap(message: string, level: "warn" | "log" = "warn"): void {
    const at = this.now();
    if (this.lastE4LogAt !== 0 && at - this.lastE4LogAt < this.e4LogCooldownMs) {
      this.e4Suppressed += 1;
      return;
    }
    const suffix = this.e4Suppressed > 0 ? ` (${this.e4Suppressed} repeats suppressed since the last line)` : "";
    this.lastE4LogAt = at;
    this.e4Suppressed = 0;
    const line = `${this.projectTag}${message}${suffix}`;
    if (level === "log") log.log(line);
    else log.warn(line);
  }

  public start(): void {
    const tickMs = this.options.tickMs ?? DEFAULT_REVIEW_TICK_MS;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
      log.error(`${this.projectTag}Review dispatch tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, tickMs);
    this.timer.unref?.();
    log.log(`${this.projectTag}Review dispatch sweep started (tick ${tickMs}ms)`);
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

    /*
    FNXC:ReviewLanePool 2026-10-03-21:23 (RUFU-530):
    Every enabled reviewer is a slot, so a card is routed to whichever slot is free instead of the whole lane
    switching itself off because two reviewers exist. Attribution is not weakened by the pool: the ledger row
    written by `openReviewerRunForTask` carries `reviewerAgentId`, and the dispatch line names the reviewer id,
    so "which session produced this verdict" is answered from durable state, not from log ordering — which is
    what the old single-reviewer rule was really protecting.
    */
    const pool = await this.resolveReviewerPool();
    const busyRunByReviewer = new Map<string, AgentHeartbeatRun | null>();
    const policyByReviewer = new Map<string, string>();
    for (const reviewer of pool) {
      busyRunByReviewer.set(reviewer.id, await this.options.agentStore.getActiveHeartbeatRun(reviewer.id));
      policyByReviewer.set(reviewer.id, laneCapabilityDeclinePolicy(reviewer));
    }
    /*
     * A reviewer given work during this tick is busy for the remainder of it: the snapshot above was taken
     * before `executeHeartbeat` ran, and a second start on the same agent would fail the session just begun.
     */
    const allocatedThisTick = new Set<string>();

    let dispatches = 0;
    const maxDispatches = this.options.maxDispatchesPerTick ?? DEFAULT_MAX_DISPATCHES_PER_TICK;
    for (const candidate of candidates) {
      const rows = await listReviewerRunsForTask(this.options.store, candidate.task.id);
      /*
       * Three routing cases, in this order, chosen so `classifyReviewCard` keeps its exact meaning:
       * 1. a reviewer already working on THIS card → hand it its own run (bucket `review-in-flight`);
       * 2. a reviewer with no run at all → hand it `null`, which is what authorises a dispatch;
       * 3. every reviewer busy on other cards → hand over a busy run (bucket `reviewer-busy`), which keeps
       *    the wait countable in the sweep's accounting instead of dropping the card from it.
       *
       * FNXC:ReviewDispatchRefusal 2026-10-15-17:28 (RUFU-682): a lane that refused THIS card is not a candidate
       * for it, so the refusal is resolved before routing rather than after — dispatching to a refused binding to
       * then refuse it in the classifier would keep writing attempts, which is the loop this closes.
       */
      const declined = declinedReviewersForTask(rows, policyByReviewer);
      const { free, activeRun } = resolveReviewSlot({
        pool,
        busyRunByReviewer,
        allocatedThisTick,
        taskId: candidate.task.id,
        declined,
      });
      const decision = classifyReviewCard({
        task: candidate.task,
        rows,
        activeRun,
        reviewerFound: pool.length > 0,
        capabilityDeclinedForPool: pool.length > 0 && declined.size >= pool.length,
        now: now.getTime(),
        reviewEnteredAt: candidate.enteredReviewAt === null ? null : Date.parse(candidate.enteredReviewAt),
        graceMs: this.options.graceMs ?? DEFAULT_REVIEW_GRACE_MS,
        startLatencyMs: this.options.startLatencyMs ?? DEFAULT_REVIEW_START_LATENCY_MS,
        maxAttempts: this.options.maxAttempts ?? DEFAULT_REVIEW_MAX_ATTEMPTS,
      });
      classes[decision.bucket] += 1;
      this.logBucketChange(candidate.task.id, decision.bucket, rows);
      if (decision.bucket === "capability-declined") {
        await this.announceCapabilityDecline(
          candidate.task,
          pool.filter((lane) => declined.has(lane.id)),
          policyByReviewer,
        );
      } else {
        this.refusalAnnounced.delete(candidate.task.id);
      }

      // A dispatch needs a reviewer that is genuinely free — never the one already holding a run.
      if (!decision.dispatch || dispatches >= maxDispatches || !free) continue;
      dispatches += 1;
      allocatedThisTick.add(free.id);
      if (await this.dispatch(candidate, free, decision, now)) dispatched.push(candidate.task.id);
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
    /*
    FNXC:ListTasksDeriveOptOut 2026-10-09-20:25 (RUFU-201 follow-through):
    This sweep ticks every 15 s (DEFAULT_REVIEW_TICK_MS) and it reads ONLY persisted columns —
    `column`, `enabledWorkflowSteps`, `id`, `paused`, `pausedReason`, `reviewLevel`,
    `updatedAt`, `userPaused`, `workflowStepResults` — here, in `classifyReviewCard`, and in
    `dispatch`. It never reads a derived board badge (`stalledReview`, `inReviewStall*`,
    `retrySummary`, `stallReason`, `reviewBypass`, `ageStaleness`, `timedExecutionMs`), yet with
    derivation on it paid nine per-row derivations AND the full `log` jsonb column every tick.
    Measured live: `log` is 42.7% of every live row's bytes (31.4 MB of 73.6 MB, 12.7 KiB/card
    over 2 417 cards), and ~91% of the server's allocation churn sits in this one row→Task read
    path, which is what drives board latency and the RSS climb to the watchdog's 16 GiB kill.

    `derive: false` keeps every persisted field byte-identical (it is `workflow_step_results`
    that routes this sweep, and it stays), drops `log` from the SQL projection, and skips the
    derivation prelude (settings read, merge-queue set, selection + IR prefetch). If a future
    edit here starts reading a derived badge, `derive` has to come back — and the read should
    move to the detail fetch instead of the 15 s sweep.
    */
    // FNXC:ListTasksExcludeLog 2026-10-12-16:20 (RUFU-615 tranche 4): this scan never reads task log or markers (no non-logger `.log` token in the file), so `slim` must not pay for hydrating the whole board's log. See list-tasks-slim-excludes-log.test.ts.
    const tasks = await this.options.store.listTasks({ slim: true, derive: false, includeArchived: false, excludeLog: true });
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
 * The lane's reviewer pool: every enabled, non-ephemeral agent carrying the `reviewer` role.
   *
   * FNXC:ReviewLanePool 2026-10-03-21:23 (RUFU-530):
   * This used to require EXACTLY one such agent and returned `null` for two or more, so enabling a second
   * reviewer turned the review lane off entirely (`E4 … refusing to pick one`) — the configuration an operator
   * would write to speed reviews up was the configuration that stopped them. Pool semantics are honest about
   * the thing the old rule could not see anyway: nothing in the store names which agent owns a given card's
   * review, so routing is first-free-wins and the durable ledger row (`reviewerAgentId`) is what records who
   * actually did the work. Zero enabled reviewers remains bucket E4 — a real configuration gap, surfaced and
   * left undispatched.
   */
  private async resolveReviewerPool(): Promise<Agent[]> {
    const agents = await this.options.agentStore.listAgents();
    const reviewers = agents.filter(
      (agent) => !isEphemeralAgent(agent) && agent.runtimeConfig?.enabled !== false && agent.roles.includes("reviewer"),
    );
    if (reviewers.length === 0) {
      this.logReviewerConfigurationGap(
        "E4: no enabled reviewer agent exists; review-lane cards stay undispatched by design.",
      );
      return reviewers;
    }
    if (reviewers.length > 1) {
      // Steady state, not an event: rate-limited, and it names the ceiling so a reader can tell the
      // configured concurrency from the observed one.
      this.logReviewerConfigurationGap(
        `Review lane pool: ${reviewers.length} enabled reviewers, so up to ${reviewers.length} concurrent reviews (one session per reviewer).`,
        "log",
      );
    }
    return reviewers;
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
    log.warn(`${this.projectTag}Closed review run ${runId} for ${taskId} as failed (${reason}, reviewer ${reviewerAgentId})`);
  }

  /**
   * FNXC:ReviewDispatchRefusal 2026-10-15-17:30 (RUFU-682):
   * The refusal is worth one line on the card, because the alternative is the operator reading engine logs to learn
   * why a review never happened. SANE-484 sat in `in-review` with no run, no merge, and 24 attempts while every
   * fact about it lived in a warn line nobody scrolls. The sentence is the shared decline contract (never local
   * prose), the write is append-only History — no column, no status, no pause — and `logEntryOnce`'s window plus
   * this sweep's episode key bound it to one line per (card, declined-lane-set).
   *
   * Reached duck-typed the way RUFU-382 reaches the once-seam: a store without `logEntryOnce` keeps the refusal in
   * the log line and the ledger witness rather than failing the tick.
   */
  private async announceCapabilityDecline(
    task: Task,
    declinedLanes: Agent[],
    policyByReviewer: ReadonlyMap<string, string>,
  ): Promise<void> {
    const lanes = [...declinedLanes].sort((a, b) => a.id.localeCompare(b.id));
    const episode = lanes.map((lane) => `${lane.id}=${policyByReviewer.get(lane.id) ?? "?"}`).join(",");
    if (this.refusalAnnounced.get(task.id) === episode) return;
    this.refusalAnnounced.set(task.id, episode);

    const [first, ...rest] = lanes;
    // The sentence names the lane, its roles/policy, the card, and the remedy; siblings are listed by id.
    const sentence = first
      ? formatLaneCapabilityDeclineReason(first, task)
      : `Review dispatch refused for ${task.id}: the lane that declined it is no longer configured.`;
    const action = rest.length > 0
      ? `${sentence} Also declined by: ${rest.map((lane) => lane.id).join(", ")}.`
      : sentence;
    try {
      await this.options.store.logEntryOnce?.(task.id, {
        action,
        outcome: "refused",
        dedupeKey: `review-dispatch-capability-declined:${episode}`,
        windowMs: ReviewDispatchSweep.REFUSAL_HISTORY_WINDOW_MS,
      });
    } catch (error) {
      // Announcing is never the point; the refusal already stands in the ledger and the sweep's own line.
      log.debug(`${this.projectTag}Could not record the review refusal for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      log.log(`${this.projectTag}${bucket}: ${taskId} (${detail})`);
      return;
    }
    log.warn(`${this.projectTag}${bucket}: ${taskId} (${detail}) — no reviewer work dispatched`);
  }
}

function emptyClasses(): Record<ReviewDispatchClass, number> {
  return {
    "never-dispatched": 0,
    "capability-declined": 0,
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
