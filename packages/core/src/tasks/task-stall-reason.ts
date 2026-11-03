import {
  PLAN_ADMISSION_STALL_METADATA_KEY,
  PLAN_PREMISE_REJECTION_METADATA_KEY,
  type Task,
  type TaskPlanAdmissionStallCode,
  type TaskPlanAdmissionStallEpisode,
  type TaskWipAdmissionStallCode,
} from "../types.js";
/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The withheld-hold->WIP episode lives in its own module, read and written from here so the stall authority
and the recorder share one validator and one pair of floors. The episode CODES reach this file through
`../types.js` (the type barrel) rather than through this module on purpose: a table keyed by the code
union must fail to compile if the union grows, which is the same reason `PLAN_ADMISSION_STALL_SENTENCES`
is keyed rather than switch-cased.
*/
import {
  readWipAdmissionStallEpisode,
  wipAdmissionStallAgeMs,
  WIP_ADMISSION_STALL_ESCALATION_FLOOR_MS,
} from "./wip-admission-park.js";
import type { LifecycleColumns } from "../workflows/workflow-lifecycle-traits.js";
import {
  getTaskCompletionBlocker,
  getTaskMergeBlocker,
  isPreMergeStepsNotRunBlocker,
  isPreMergeStepsNotRunRefusal,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
} from "../merge/task-merge.js";
/* FNXC:ReviewRevisionWait 2026-09-29-14:12 (RUFU-280): the chip and the stall ladder must reach the same verdict from ONE predicate, so the derived reason imports the classifier instead of restating its conjuncts. */
import {
  AWAITING_REVIEW_REVISION_STALL_REASON,
  isAwaitingReviewRevision,
} from "./review-revision-wait.js";

/*
FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
The board could say WHEN a card stopped moving (age staleness, in-review quiet windows) but not WHY.
The answering authorities already exist but each covers one slice: `getTaskMergeBlocker` for the
review lane, `allowsAutoMergeProcessing` for human-held cards, `getTaskCompletionBlocker` for the
real `blockedBy`/`dependencies` edges, and the lifecycle traits for terminal lanes. No read surface
stitched them together, so the same card reported "Merge stalled" in one lane and NOTHING when it
sat behind a dependency or in a hold column.

This helper is the canonical stitch, evaluated server-side at every task hydration site so list
consumers (board, search, the incremental sync stream) get one uniform `Task["stallReason"]`:
- answer is DERIVED, never persisted — the four inputs move on their own and a stored copy would
  drift from all of them;
- `undefined` means "moving or not derivable", so absence is not a claim of health — a WIP card
  whose agent died mid-run shows no reason until its stall badge fires;
- fail-OPEN by contract: a probe that throws must never break a task read, it only removes the
  diagnostic. That is the opposite of the merge authority, which fails closed — here a lying
  reason is worse than a missing one, so an unresolvable dependency reference is never asserted
  as a blocker.
The field is diagnostic-only: it must not be used as an auto-completion signal or as merge-gate
authority (the gate keeps asking the authorities directly, never this summary).
*/

/** Machine-readable classification of a stall/hold. The `reason` text is display copy and may be
 *  reworded; consumers that branch must branch on `code`. */
export type TaskStallReasonCode =
  /** The review lane refuses to merge: paused, blocking status, failed pre-merge step, … */
  | "merge-blocker"
  /** An enabled pre-merge gate has not run yet — a pipeline step pending, not a human task. */
  | "pre-merge-gate-pending"
  /*
  FNXC:ReviewRevisionWait 2026-09-29-14:12 (RUFU-280):
  An authored `REVISE` verdict whose named remediation is still unfinished. This is a WORK state, so it
  sits beside the two other "a step is still owed" codes rather than beside `merge-blocker`: the merge
  door does refuse this card, but nothing is broken, and the entity that owns the next move is the
  executor running the published corrections — not the operator.

  The code exists because the two words that used to answer here were wrong in the same sentence.
  `Merge blocked` plus `Open the Review tab to see why it cannot merge` pointed an operator at a remedy
  for a state the card was already leaving on its own.
  */
  | "awaiting-review-revision"
  /** Nothing refuses; the card waits on a human because auto-merge processing is off for it. */
  | "held-human-review"
  /** A live `blockedBy`/`dependencies` edge keeps the card from being treated as complete. */
  | "dependency-blocker"
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning lane. RUFU-174's union answered only for delivery lanes, so the reported population —
  half a backlog sitting in the planning lane for days with `status: null` — produced no code at all
  and the operator had to patrol for it. These seven name the gate the card is behind.

  They are SEPARATE codes from the delivery ones on purpose: "the planner is full" and "the merge
  door refuses" need opposite remedies, and collapsing them would make the two answers
  indistinguishable to every consumer that branches on `code`.
  */
  /** Planning admission was withheld because no top-level planning slot was reservable. */
  | "plan-admission-throttled"
  /** The workflow's planning lane exists but excludes this card (manual intake / fast-lane skip). */
  | "plan-lane-ineligible"
  /** Planning is held by a plan-premise contract refusal (RUFU-246's episode is the evidence). */
  | "plan-premise-held"
  /** The card's spec artifact exists but cannot be read, so planning cannot start. */
  | "plan-spec-unreadable"
  /** The engine is waiting out a scheduled recovery backoff before it may re-attempt planning. */
  | "plan-recovery-backoff"
  /** Aged and eligible with nothing refusing it — no admission and no gate that can be named. */
  | "plan-no-admission"
  /** The row claims a branch holding commits that are not on the default branch. */
  | "recoverable-work"
  /*
  FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
  The execution lane's twin of `plan-admission-throttled`. A card refused at a hold->WIP seam had NO code
  at all — RUFU-180's stall sweep is review-lane only and RUFU-273's is planning-lane only — so a board
  could show a card that had been refused 16 536 times over two days and the card itself said nothing.
  It is a SEPARATE code from the planning family on the same grounds that family gives: "no planner slot
  is free" and "this card will not cross into WIP" need different remedies, and collapsing them would
  send an operator to triage capacity for a card that is already planned.
  */
  /** A hold->WIP crossing has been refused and the card is parked at the seam. */
  | "wip-admission-throttled";

export interface TaskStallReason {
  code: TaskStallReasonCode;
  /** Operator-facing sentence: canonical blocker text from the underlying authority, or a fixed
   *  human-hold sentence for `held-human-review`. */
  reason: string;
  /** ISO timestamp of the read that produced this assessment (same clock as sibling signals). */
  observedAt: string;
  /**
   * Elapsed wait of a throttle-class stall, in milliseconds, measured by core from the durable episode's
   * OWN `firstAt` — never from `updatedAt`, which naming a card bumps (RUFU-350's measured
   * self-retraction). Present only for the throttle-class codes; every other code reports no measured
   * wait rather than a guessed one.
   *
   * The field exists because "a two-day block must read differently from a fresh one", and every surface
   * that renders a stall resolves a CODE to its own localized copy and deliberately ignores this
   * `reason` string — a duration smuggled into the English sentence would be invisible to exactly the
   * operator the age is for. The number travels in the vocabulary; each surface formats it.
   */
  waitedMs?: number;
  /*
  FNXC:CapacityGateFacts 2026-11-02-22:20 (RUFU-372):
  The capacity-gate forensics, carried for the throttle-class capacity codes only. They exist so a card
  face can answer "which pool, how full, who holds it, since when" from the board payload it already
  fetched — before this, the answer lived only in a run-audit table no dashboard route reads, which is
  what made "capacity: none" on a stalled card a lie nobody could check.

  The three absence shapes are load-bearing and must stay distinct across every hop:
  - `capacityPoolId: null` — no pool was consulted (a scheduler-owned seam hand-off), so no fill exists.
  - `capacityHeldBy: undefined` — the holder set was never recorded.
  - `capacityHeldBy: []` — the pool is genuinely empty at zero occupancy (a limit-0 refusal).
  A mapper that coerces either of the first two to the second would silently turn "we did not look" into
  "we looked and found nothing", the exact misread that cost 16 536 rows to discover. `capacityGate` is
  the only field carrying the gate IDENTITY (`columnWip` / `schedulerAgentActive` / `maxConcurrent` /
  `unknown`); null means the writer predates the split, and a card that has since crossed a column may
  legitimately keep an older row while its lane-appropriate stall copy still renders from `code`.
  */
  /** Which admission gate bound, in the engine's `CapacityGateId` vocabulary; null = writer predates it. */
  capacityGate?: "columnWip" | "schedulerAgentActive" | "maxConcurrent" | "unknown" | null;
  /** The refused pool's identity; null when no pool was consulted. */
  capacityPoolId?: string | null;
  /** Occupants at the refusing sample; absent when no sample was taken. */
  capacityOccupants?: number;
  /** The resolved limit at the refusing sample; absent when no pool was consulted. */
  capacityLimit?: number;
  /** Task ids occupying the pool at the refusing sample; undefined when unrecorded, [] when empty. */
  capacityHeldBy?: string[];
  /** How long the pool's longest-held occupant has stood there, in ms. */
  capacityOldestHolderAgeMs?: number;
}

/** The task fields the derivation reads. `getTaskMergeBlocker`/`getTaskCompletionBlocker` take
 *  narrower picks; this is their union plus `column` for the lane gates. */
export type StallableTask = Pick<
  Task,
  | "id"
  | "column"
  | "paused"
  | "pausedReason"
  | "status"
  | "error"
  | "steps"
  | "workflowStepResults"
  | "repositoryScope"
  | "blockedBy"
  | "dependencies"
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning branch reads the two row episodes (`sourceMetadata` carries both `planAdmissionStall`
  and RUFU-246's `planPremiseRejection`), the scheduler's backoff timestamp, and the pause the
  operator authored. Every field is already persisted, so the branch costs no additional read.
  */
  | "sourceMetadata"
  | "nextRecoveryAt"
  | "userPaused"
> & Partial<Pick<Task, /*
  FNXC:ZeroCommitWorkspaceDelivery 2026-09-30-20:52 (RUFU-451):
  The review-lane branch composes `getTaskMergeBlocker`'s answer, and that door now looks past exactly
  one false terminal — the workspace partial-land park written for a card authorized to deliver zero
  commits. Declaring the flag OPTIONAL here keeps the two classifiers answering the same question about
  the same row: a card whose stall reason is derived without the flag keeps today's refusal (fail-closed),
  while a hydrated row reports no `merge-blocker` stall for a delivery its own plan called source-free.
  */ "noCommitsExpected">>;

export interface TaskStallReasonContext {
  /** Clock (ms epoch) shared with sibling signals; `observedAt` derives from it. */
  now?: number;
  /**
   * Resolved review-lane membership (`resolveReviewColumnsForTask`). Omitted or empty keeps the
   * legacy `"in-review"` literal, matching the DELIBERATE-LITERAL default the merge authority
   * documents for unconverted callers.
   */
  reviewColumns?: ReadonlySet<string>;
  /**
   * Resolved lifecycle lanes for the task's own workflow. Each terminal role falls back to its
   * literal (`done`/`archived`) independently, mirroring the sibling fallback style.
   */
  lifecycleColumns?: LifecycleColumns | undefined;
  /**
   * Resolved required pre-merge gate ids (`resolveRequiredPreMergeStepIds`). Omitted, the gate
   * keeps the legacy results-only semantics and `pre-merge-gate-pending` cannot occur.
   */
  requiredPreMergeStepIds?: ReadonlySet<string>;
  /**
   * `allowsAutoMergeProcessing(task, settings)`. A `false` here is what surfaces a clean review
   * card as `held-human-review`; omitted is treated as allowed. NOTE: unlike `inReviewStall`,
   * which SUPPRESSES its stall signal under this flag, this derivation must still name the hold —
   * the card genuinely waits on a human then.
   */
  autoMergeAllowed?: boolean;
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  Resolved planning-lane membership for the task's own workflow — the union of the `intake` and
  `hold` trait columns (`columnsWithFlag`). Omitted or empty means "the caller could not resolve a
  planning lane", and the planning branch stays silent: an unnamed card is acceptable, a card told
  it is stalled in a lane its workflow does not have is a lie. There is deliberately no legacy
  literal fallback here, unlike the review/terminal lanes — `todo`/`triage` as a fallback would
  stamp a planning stall on cards in a workflow that renamed its planning column.
  */
  /** Resolved planning-lane column ids (the `intake` and `hold` trait columns). */
  planningColumns?: ReadonlySet<string>;
  /** Suppression decided by the call site: merge-queued, or fresh `agent:log` activity means an
   *  agent is actively working the card, so no stall may be asserted. */
  suppressed?: boolean;
  /**
   * Lock-free reference resolver for `blockedBy`/`dependencies` targets. Called ONLY when the card
   * reaches the dependency branch, and only once per unresolved reference. A resolver that cannot
   * find the reference (missing or soft-deleted) returns null — a stale marker must never be
   * reported as a live blocker, so an unresolved `blockedBy` silently clears exactly like the
   * completion gate treats it.
   */
  resolveDependency?: (taskId: string) => Promise<Pick<Task, "id" | "column"> | null | undefined>;
  /** Per-dependency terminal/review lanes keyed by the DEPENDENCY's id (its workflow decides).
   *  A dependency absent from the map keeps the legacy literals. */
  satisfactionColumnsByTaskId?: ReadonlyMap<string, { terminal: ReadonlySet<string>; review: ReadonlySet<string> }>;
}

/**
FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
Fixed sentence for the human-hold branch, exported so tests and consumers assert the literal instead of restating it.
The branch fires when `allowsAutoMergeProcessing(task, settings)` answers false, which is a BOARD-level gate with a per-task and per-PR
exception: automatic merge processing is withheld when project `settings.autoMerge === false` unless the task opts back in with
`autoMerge: true`, or when the card carries a live human-authored open PR. A per-task `autoMerge: false` under a project that is ON
is NOT a hold on this gate (the merger parks it as manual-required elsewhere), so the sentence deliberately describes the gate's answer
about the card rather than claiming a task-level setting caused it.
*/
export const HELD_HUMAN_REVIEW_STALL_REASON =
  "Waiting on a human: automatic merge processing is withheld for this card, so review completion does not merge it";

/*
FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
One fixed sentence per planning-lane code, exported on the `HELD_HUMAN_REVIEW_STALL_REASON` pattern so
tests assert the literal instead of restating it. Each names the gate that is holding the card and who
owns it; none of them pair "merge" with "blocked", because nothing about the merge is at stake here and
the operator reading a planning card must not be sent to the delivery lane for an answer.
*/

/** Capacity gate (FN-8600): the planner declined to admit the card, it did not refuse it. */
export const PLAN_ADMISSION_THROTTLED_STALL_REASON =
  "Waiting for a planner slot: planning admission is withheld while the running planner capacity is full";

/** The card sits in a declared planning lane that never plans cards of this kind. */
export const PLAN_LANE_INELIGIBLE_STALL_REASON =
  "Waiting for a person to release it: this card's workflow lane does not plan it automatically";

/** RUFU-246's premise episode is present: the plan was refused against its own contract. */
export const PLAN_PREMISE_HELD_STALL_REASON =
  "Planning is held: the last plan was refused for violating its own stated premises, so a corrected plan is required";

/** The spec artifact exists but the read failed (a missing file is `ENOENT` and is NOT this code). */
export const PLAN_SPEC_UNREADABLE_STALL_REASON =
  "Planning cannot start: the card's written plan exists but cannot be read from task storage";

/** A future `nextRecoveryAt` parks the card until the scheduled retry. */
export const PLAN_RECOVERY_BACKOFF_STALL_REASON =
  "Waiting out a scheduled recovery pause before planning is attempted again";

/** The residual: aged, eligible, nothing refuses it, and no admission happened. */
export const PLAN_NO_ADMISSION_STALL_REASON =
  "No planning admission has been recorded for this card, and no gate that refuses it can be named";

/** The row names a branch whose commits are not on the default branch. */
export const RECOVERABLE_WORK_STALL_REASON =
  "This card's claimed branch holds commits that are not on the default branch, so work exists that the card does not show";

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
One fixed sentence per REFUSING GATE, in the shape `PLAN_*_STALL_REASON` establishes — each names its own
gate rather than sharing a generic "capacity" phrase. Two deliberate differences from the planning table:

- All eight gate literals collapse onto the ONE stall code `wip-admission-throttled`. The planning family
  exposes its episode codes as stall codes; here the operator's question is one thing ("why has this
  planned card not entered WIP?") and the gate is the detail, so the code stays stable while the
  sentence names the gate. Splitting it into eight codes would force every consumer that branches on
  code to enumerate a vocabulary it does not need.
- `scheduler-seam` says plainly that NO capacity pool was consulted. RUFU-372's entire finding was that
  two different shapes both reported `reason=capacity`, which sent operators hunting a limit that was
  never binding; a sentence that repeats that mistake would undo the label the enum exists to carry.

No sentence interpolates an id, a count, or a path. Age is the one variable that must read differently
for a two-day block, and it travels as `TaskStallReason.waitedMs` rather than inside these strings, so
the surfaces that localize by code can still render it.
*/

/** KTD-2 authority hand-off: the graph declined to move and NO capacity pool was consulted. */
export const WIP_ADMISSION_SCHEDULER_SEAM_STALL_REASON =
  "Waiting to enter work-in-progress: the scheduler owns this crossing and has not released the card; no capacity pool was consulted";

/** A real in-transaction move was refused by a finite work-in-progress pool. */
export const WIP_ADMISSION_COLUMN_CAPACITY_STALL_REASON =
  "Waiting to enter work-in-progress: the work-in-progress column is at its limit for this card's pool";

/** A capacity refusal arrived with no structured facts, so the refusing column is unknown. */
export const WIP_ADMISSION_UNPROVEN_STALL_REASON =
  "Waiting to enter work-in-progress: the move was refused for capacity but the refusing column cannot be identified";

/** The sweep measured the target column at or over its limit. */
export const WIP_ADMISSION_DOWNSTREAM_FULL_STALL_REASON =
  "Waiting to enter work-in-progress: the next column is full";

/** A slot was found and the in-transaction move still refused. */
export const WIP_ADMISSION_MOVE_REFUSED_STALL_REASON =
  "Waiting to enter work-in-progress: a slot was found but the move was refused";

/** The workflow declares nowhere to release the card into. */
export const WIP_ADMISSION_NO_TARGET_STALL_REASON =
  "Waiting to enter work-in-progress: this card's workflow declares no column to release it into";

/** Readiness, not capacity: the card is not planned yet. */
export const WIP_ADMISSION_AWAITING_PLANNING_STALL_REASON =
  "Waiting to enter work-in-progress: the card is not planned yet, so release is withheld";

/** Readiness, not capacity: an approval gate holds it. */
export const WIP_ADMISSION_AWAITING_APPROVAL_STALL_REASON =
  "Waiting to enter work-in-progress: an approval gate is withholding release";

/** Code union of the persisted WIP-admission episode — the gates the row itself can carry (RUFU-393). */
type WipAdmissionEpisodeCode = TaskWipAdmissionStallCode;

/** Episode gate -> stall sentence. A fixed table: a gate with no entry cannot appear as a stall. */
export const WIP_ADMISSION_STALL_SENTENCES: Record<WipAdmissionEpisodeCode, string> = {
  "scheduler-seam": WIP_ADMISSION_SCHEDULER_SEAM_STALL_REASON,
  "column-capacity": WIP_ADMISSION_COLUMN_CAPACITY_STALL_REASON,
  "capacity-rejection-without-facts": WIP_ADMISSION_UNPROVEN_STALL_REASON,
  "downstream-full": WIP_ADMISSION_DOWNSTREAM_FULL_STALL_REASON,
  "move-rejected-or-no-slot": WIP_ADMISSION_MOVE_REFUSED_STALL_REASON,
  "no-downstream-capacity-column": WIP_ADMISSION_NO_TARGET_STALL_REASON,
  "awaiting-planning": WIP_ADMISSION_AWAITING_PLANNING_STALL_REASON,
  "awaiting-approval": WIP_ADMISSION_AWAITING_APPROVAL_STALL_REASON,
};

/** Code union of the persisted episode — the codes the row itself can carry (RUFU-273). */
type PlanAdmissionEpisodeCode = TaskPlanAdmissionStallCode;

/** Episode code -> stall reason. A fixed table: an episode code with no entry cannot appear as a stall. */
const PLAN_ADMISSION_STALL_SENTENCES: Record<PlanAdmissionEpisodeCode, string> = {
  "plan-admission-throttled": PLAN_ADMISSION_THROTTLED_STALL_REASON,
  "plan-lane-ineligible": PLAN_LANE_INELIGIBLE_STALL_REASON,
  "plan-spec-unreadable": PLAN_SPEC_UNREADABLE_STALL_REASON,
  "plan-no-admission": PLAN_NO_ADMISSION_STALL_REASON,
  "recoverable-work": RECOVERABLE_WORK_STALL_REASON,
};

/**
 * Read the persisted planning-admission-stall episode off a row (RUFU-273).
 *
 * Validation is structural, not permissive: a stored payload whose `code` is outside the fixed union
 * is treated as no episode at all. The episode is written by two engine lanes and read on every task
 * read, so a malformed or hand-edited value must degrade to silence rather than surface a code the
 * dashboard has no copy for.
 */
export function readPlanAdmissionStallEpisode(
  sourceMetadata: Record<string, unknown> | undefined,
): TaskPlanAdmissionStallEpisode | undefined {
  const raw = sourceMetadata?.[PLAN_ADMISSION_STALL_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<TaskPlanAdmissionStallEpisode>;
  if (!isPlanAdmissionEpisodeCode(candidate.code)) return undefined;
  if (typeof candidate.lastAt !== "string" || typeof candidate.firstAt !== "string") return undefined;
  if (typeof candidate.stallCount !== "number" || !Number.isFinite(candidate.stallCount)) return undefined;
  return candidate as TaskPlanAdmissionStallEpisode;
}

/** True when `code` is one of the codes the row may carry. Keeps the union the single source of truth. */
function isPlanAdmissionEpisodeCode(code: unknown): code is PlanAdmissionEpisodeCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(PLAN_ADMISSION_STALL_SENTENCES, code);
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-18:20 (RUFU-273):
The WRITE half of the episode contract, placed next to the read half so the two can never drift.
Triage's throttle site and the reconciliation sweep are independent writers of the same key, and each
one runs on a short poll. Without one shared decider, the obvious implementations are both wrong: a
naive "write what I just observed" stamps `firstAt` with the current poll and rewrites the row every
~15 s for a stall that lasts hours, while a naive "write only if the key is absent" freezes the FIRST
gate ever observed and hides the later, truer one (a card throttled for capacity that has since lost
its lane eligibility would claim "waiting for a planner slot" forever).

So the rule is: the same code refreshes `lastAt` and preserves `firstAt`, a DIFFERENT code restarts
the episode and resets `stallCount`, and `stallCount` increments only for a same-code repeat. The
refresh floor is what makes an hourly poll cheap: a sustained stall writes at most once per floor.
*/

/** How often a sustained same-code stall may re-stamp `lastAt` (RUFU-273). */
export const PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS = 15 * 60_000;

/** Observation payload a writer contributes; `code` is required, the rest is optional evidence. */
export interface PlanAdmissionStallObservation {
  code: TaskPlanAdmissionStallCode;
  /** Stable dedupe signature supplied by the writer (e.g. triage's gate signature). */
  signature?: string;
  ageMs?: number;
  uniqueCommitCount?: number;
}

/**
 * Decide whether an observation justifies a row write, and produce the episode to write.
 *
 * Returns `undefined` when the write must be skipped — a sustained same-code stall inside the refresh
 * floor, or a `recoverable-work` re-observation whose commit evidence is unchanged and already fresh.
 * The caller writes the returned episode through `sourceMetadataPatch` keyed by
 * `PLAN_ADMISSION_STALL_METADATA_KEY`, which is what keeps unrelated provenance keys alive.
 */
export function planAdmissionStallWrite(
  existing: TaskPlanAdmissionStallEpisode | undefined,
  observation: PlanAdmissionStallObservation,
  observedAt: number = Date.now(),
): TaskPlanAdmissionStallEpisode | undefined {
  const now = new Date(observedAt).toISOString();
  const lastAtMs = existing ? Date.parse(existing.lastAt) : Number.NaN;
  const freshEnough = Number.isFinite(lastAtMs) && observedAt - lastAtMs < PLAN_ADMISSION_STALL_REFRESH_FLOOR_MS;
  const sameCode = existing?.code === observation.code;

  // A different gate is a new episode: it restarts the clock and resets the repeat counter.
  if (existing && !sameCode) {
    return {
      code: observation.code,
      lastAt: now,
      firstAt: now,
      stallCount: 1,
      ...(observation.signature !== undefined ? { signature: observation.signature } : {}),
      ...(observation.ageMs !== undefined ? { ageMs: observation.ageMs } : {}),
      ...(observation.uniqueCommitCount !== undefined ? { uniqueCommitCount: observation.uniqueCommitCount } : {}),
    };
  }

  if (existing && sameCode && freshEnough) return undefined;

  // Unchanged recoverable-work evidence adds nothing; the counts are the whole signal.
  if (
    existing
    && sameCode
    && observation.code === "recoverable-work"
    && observation.uniqueCommitCount === existing.uniqueCommitCount
  ) {
    return undefined;
  }

  return {
    code: observation.code,
    lastAt: now,
    firstAt: existing?.firstAt ?? now,
    stallCount: (existing?.stallCount ?? 0) + 1,
    ...(observation.signature !== undefined ? { signature: observation.signature } : existing?.signature !== undefined ? { signature: existing.signature } : {}),
    ...(observation.ageMs !== undefined ? { ageMs: observation.ageMs } : {}),
    ...(observation.uniqueCommitCount !== undefined ? { uniqueCommitCount: observation.uniqueCommitCount } : {}),
  };
}

/**
 * The key-preserving clear patch for the episode (RUFU-273). Writers must use this rather than
 * touching `sourceMetadata` wholesale — a whole-field wipe would orphan `duplicateOf`, `handoffFrom`,
 * and `contentFingerprint` alongside the stall episode.
 */
export function clearPlanAdmissionStallPatch(): Record<string, unknown> {
  return { [PLAN_ADMISSION_STALL_METADATA_KEY]: null };
}

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The execution-lane branch, deliberately THIN: unlike `derivePlanningAdmissionStall` it invents no
inference of its own and reads exactly one persisted episode. The reason is the failure this task fixes.
Every earlier reading of the storm had to guess between "the pool is full" and "nothing ever evaluates
the card", and the guesses were made from a 30-sweep average because a task read cannot ask the executor
why the run ended `suspended` — the durable episode is the ONE surface that can carry that answer, and it
is written by the lane that observed the refusal. An inference here would be a second authority competing
with the observer, which is what RUFU-372 removed from the audit row.

Guards, and why each is the same shape as the planning branch:
- `paused`/`userPaused` defer to the pause family, which already owns that card's badge — two causes on
  one card is how a chip stops being actionable.
- a non-empty `status` defers to whatever wrote it, including `"queued"`, which is a live scheduler
  transient: chipping it would mark every card mid-dispatch abnormal (RUFU-273's argument, adopted).
- the ESCALATION floor, not the refresh floor, gates the badge. The first park is normal scheduling; a
  refusal still holding an hour later is not. RUFU-292's rule — a card in its lane's ordinary resting
  state is not a stall — is what keeps `todo` from becoming a permanent badge for every queued card.

The one positional guard is `task.column === episode.fromColumn`, because the move-seam clear below cannot be
awaited. That clear is fire-and-forget inside the move's own task lock — the lock is NON-REENTRANT
(`task-store/lifecycle-ops.ts`), which is why RUFU-297's post-commit notice pair has the same shape — so a dropped
clear (a one-shot CLI exiting right after the commit, a throwing sink) stays possible, and the badge it would
leave behind would name a slot the card no longer needs. Reading the episode only while the card still sits on
the column it was refused at makes the clear a tidy-up rather than a correctness dependency, and costs a parked
card nothing: a card the sweep refuses is in the hold lane by definition, so it is on `fromColumn`.
*/
function deriveWipAdmissionStall(
  task: StallableTask,
  context: TaskStallReasonContext,
  observedAt: string,
): TaskStallReason | undefined {
  const episode = readWipAdmissionStallEpisode(task.sourceMetadata);
  if (!episode) return undefined;
  // A claim about a crossing is only true while the card still waits at that crossing.
  if (task.column !== episode.fromColumn) return undefined;
  if (task.paused === true || task.userPaused === true) return undefined;
  if (typeof task.status === "string" && task.status.length > 0) return undefined;

  const waitedMs = wipAdmissionStallAgeMs(episode, context.now ?? Date.now());
  if (waitedMs < WIP_ADMISSION_STALL_ESCALATION_FLOOR_MS) return undefined;

  return {
    code: "wip-admission-throttled",
    reason: WIP_ADMISSION_STALL_SENTENCES[episode.code],
    observedAt,
    waitedMs,
    /*
    FNXC:CapacityGateFacts 2026-11-02-22:20 (RUFU-372):
    The episode's forensics ride the derived stall reason so every surface that renders a stall can name
    the pool, its fill, and its holders from the SAME accepted write that produced the audit row — one
    measurement, three surfaces, no second read that could disagree.

    Absence is a fact and is preserved as absence: `capacityPoolId: null` means no pool was consulted (a
    scheduler-owned seam park), `capacityHeldBy: undefined` means the holder set was never recorded, and
    an EMPTY `capacityHeldBy` means the pool is genuinely empty at zero occupancy. Collapsing any of those
    three would recreate the defect this event exists to remove, which is why the copy on the other side
    of this field is required to say "not recorded" rather than "nobody".
    */
    ...(episode.poolId !== undefined ? { capacityPoolId: episode.poolId } : { capacityPoolId: null }),
    ...(episode.occupants !== undefined ? { capacityOccupants: episode.occupants } : {}),
    ...(episode.limit !== undefined ? { capacityLimit: episode.limit } : {}),
    ...(episode.heldBy !== undefined ? { capacityHeldBy: episode.heldBy } : {}),
    ...(episode.oldestHolderAgeMs !== undefined ? { capacityOldestHolderAgeMs: episode.oldestHolderAgeMs } : {}),
  };
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
The planning-lane branch of the derivation, factored out so its own guards are testable in isolation
and so the parent function keeps reading as a lane dispatch.

Evidence precedence is deliberate and mirrors "the most specific proven answer wins":
1. RUFU-246's premise episode — a *named contract violation* outranks a generic admission stall, and it
   is derived rather than copied into this episode so the two writers can never disagree.
2. The persisted admission episode — maps 1:1 onto its code. Triage wrote it for the capacity gate; the
   reconciliation sweep wrote it for the lanes triage cannot observe.
3. A future `nextRecoveryAt` — the engine already scheduled its own retry, so the wait has a cause even
   though no episode was written.

The population guards are the definition of the silent set, not decoration: a paused or user-paused card
is owned by the pause family (which writes its own badge), a non-empty `status` is owned by whatever
wrote it — `"queued"` in particular is a live scheduler transient, so naming it would put a stall chip on
every card that is being dispatched — and a card outside its workflow's planning lane has nothing to say.
*/
function derivePlanningAdmissionStall(
  task: StallableTask,
  context: TaskStallReasonContext,
  observedAt: string,
): TaskStallReason | undefined {
  const planningColumns = context.planningColumns;
  if (!planningColumns?.size || !planningColumns.has(task.column)) return undefined;
  if (task.paused === true || task.userPaused === true) return undefined;
  if (typeof task.status === "string" && task.status.length > 0) return undefined;

  const metadata = task.sourceMetadata;
  /*
  The premise episode is read as "the key is present and object-shaped", NOT through a validator: the
  writer (plan-review node) owns its schema, and this branch only needs to know a refusal is held.
  A malformed-but-present value still means the card is premise-held, and claiming otherwise would
  send the operator to a capacity gate that is not holding them.
  */
  const premise = metadata?.[PLAN_PREMISE_REJECTION_METADATA_KEY];
  if (premise && typeof premise === "object" && !Array.isArray(premise)) {
    return { code: "plan-premise-held", reason: PLAN_PREMISE_HELD_STALL_REASON, observedAt };
  }

  const episode = readPlanAdmissionStallEpisode(metadata);
  if (episode) {
    return { code: episode.code, reason: PLAN_ADMISSION_STALL_SENTENCES[episode.code], observedAt };
  }

  if (typeof task.nextRecoveryAt === "string" && task.nextRecoveryAt.length > 0) {
    const until = new Date(task.nextRecoveryAt).getTime();
    if (Number.isFinite(until) && until > (context.now ?? Date.now())) {
      return { code: "plan-recovery-backoff", reason: PLAN_RECOVERY_BACKOFF_STALL_REASON, observedAt };
    }
  }
  return undefined;
}

/** Legacy literals used only when the corresponding lane resolution is absent. */
const LEGACY_COMPLETE_COLUMN = "done";
const LEGACY_ARCHIVED_COLUMN = "archived";
const LEGACY_REVIEW_COLUMN = "in-review";

/**
 * The two admission-stall lanes, in the one order both call sites must agree on (RUFU-393).
 *
 * The execution-lane episode is consulted FIRST, for the reason the planning family already states twice
 * in this function: precedence decides which remedy an operator is handed. A planned card refused out of
 * `todo` into `in-progress` can absolutely still carry `status: "needs-replan"` from an earlier rejection,
 * and a card whose branch has unmerged work can be refused by a column at its limit — the planning arm
 * would claim either and send the operator to a planner or to git while the real refusal was a WIP
 * budget. Each arm refuses to guess, so whichever fires reports something it can prove; this helper only
 * fixes which proof is shown first, and keeps the two sites from drifting apart.
 */
function deriveAdmissionStall(
  task: StallableTask,
  context: TaskStallReasonContext,
  observedAt: string,
): TaskStallReason | undefined {
  return deriveWipAdmissionStall(task, context, observedAt) ?? derivePlanningAdmissionStall(task, context, observedAt);
}

/**
 * Derive the canonical stall/hold reason for one task, or `undefined` when the card is moving,
 * terminal, suppressed, or the reason cannot be proven. Never throws: every probe failure degrades
 * to `undefined` (fail-open — a missing diagnostic is acceptable, a broken read is not).
 *
 * Determination order (pinned by unit tests): suppressed > terminal > review lane > dependencies >
 * planning admission.
 */
export async function deriveTaskStallReason(
  task: StallableTask,
  context: TaskStallReasonContext = {},
): Promise<TaskStallReason | undefined> {
  if (context.suppressed) return undefined;

  const lifecycle = context.lifecycleColumns;
  const completeLane = lifecycle?.complete;
  /*
  FNXC:TaskArchivingRemoved 2026-09-06 (merge origin/main dd808ed2c6, FN-295):
  The `archived` lifecycle trait no longer exists, so no live workflow can route a card to an archived
  lane. The historical literal stays terminal: soft-delete/legacy sentinel rows still carry the literal
  `"archived"` column and must never report a stall reason.
  */
  const inTerminalLane =
    (completeLane ? task.column === completeLane : task.column === LEGACY_COMPLETE_COLUMN)
    || task.column === LEGACY_ARCHIVED_COLUMN;
  if (inTerminalLane) return undefined;

  const observedAt = new Date(context.now ?? Date.now()).toISOString();

  const reviewColumns = context.reviewColumns?.size ? context.reviewColumns : undefined;
  const inReviewLane = reviewColumns
    ? reviewColumns.has(task.column)
    : task.column === LEGACY_REVIEW_COLUMN;
  if (inReviewLane) {
    /*
    The identity gate is passed the SAME resolved lane set, so a renamed review lane is checked
    against its real id and the helper can never emit the "must be in 'in-review'" identity sentence
    for a card that is legitimately standing in its own board's review lane.
    */
    let blocker: string | undefined;
    try {
      blocker = getTaskMergeBlocker(task, {
        reviewColumns,
        requiredPreMergeStepIds: context.requiredPreMergeStepIds,
      });
    } catch {
      return undefined;
    }
    if (blocker) {
      /*
      FNXC:TaskStallReason 2026-09-22-23:05 (RUFU-276, AC3):
      A never-ran-gate refusal can reach this arm in two spellings. The canonical one is the exact
      sentence, which `isPreMergeStepsNotRunBlocker` names. The second is the failed-status wrapper —
      `task is marked 'failed': AUTO_MERGE_RETRY_REJECTED: Cannot merge <id>: <canonical sentence>` —
      because the blocking-status arm of `getTaskMergeBlocker` composes the persisted error ahead of
      the not-run arm. Exact equality cannot see through that composition, so the wedge projected the
      generic `merge-blocker` and the operator lost both the gate-pending name and the RUFU-180 alert
      for the one class the engine can actually repair. The wrap-aware classifier recognises the
      embedded sentence; the reason stays the canonical gate sentence so the board chip and the
      notifier never show the composed park prose.
      */
      const unrunGate = isPreMergeStepsNotRunBlocker(blocker) || isPreMergeStepsNotRunRefusal(blocker);
      /*
      FNXC:ReviewRevisionWait 2026-09-29-14:12 (RUFU-280):
      A card mid-remediation was answering `merge-blocker` with the door's own refusal sentence, and the
      dashboard renders that code as "Merge blocked / Open the Review tab to see why it cannot merge" —
      pointing the operator at a Review tab that had already done its job by publishing the work.

      Ordered AFTER the unrun-gate test on purpose: the never-ran class has an automatic re-run lane and
      must never be swallowed by this arm, which is why the same hazard is checked before the park in
      `getInReviewStallReason`'s ladder rather than folded into a single shared branch. A card can hold
      both facts (a revised gate plus a later gate that has not run), and the gate with zero rows is the
      more urgent of the two because only a re-run can move it.

      FNXC:ReviewRevisionConsentPrecedence 2026-09-30-07:19 (RUFU-280 code-review remediation, P0):
      The deferral is conditional on auto-merge CONSENT, and the mirror this arm exists to agree with
      already says so: `getInReviewStallReason` suppresses the WHOLE ladder at
      `context.autoMerge === false`, so a withheld-consent card has no engine stall signal at all —
      nothing counts it, nothing can park it — while the pre-fix read side named it
      `awaiting-review-revision` and the dashboard rendered a green "working through review
      corrections" chip for a card whose every engine lane the operator closed by hand. With consent
      withheld the pre-existing classification is the truthful one: `merge-blocker` while the door
      refuses the card, `held-human-review` otherwise (the rung directly below).
      */
      if (!unrunGate && context.autoMergeAllowed !== false && isAwaitingReviewRevision(task)) {
        return {
          code: "awaiting-review-revision",
          reason: AWAITING_REVIEW_REVISION_STALL_REASON,
          observedAt,
        };
      }
      return {
        code: unrunGate ? "pre-merge-gate-pending" : "merge-blocker",
        reason: unrunGate && !isPreMergeStepsNotRunBlocker(blocker) ? PRE_MERGE_STEPS_NOT_RUN_BLOCKER : blocker,
        observedAt,
      };
    }
    if (context.autoMergeAllowed === false) {
      return { code: "held-human-review", reason: HELD_HUMAN_REVIEW_STALL_REASON, observedAt };
    }
    return undefined;
  }

  const hasBlockedBy = Boolean(task.blockedBy?.trim());
  const hasDependencies = (task.dependencies?.length ?? 0) > 0;
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  No dependency marker means the dependency question is already answered — that used to end the
  derivation, and it is exactly why a card sitting in the planning lane for five days reported nothing.
  The dependency probe is now skipped rather than returning, so the planning branch below still runs.
  */
  if (!hasBlockedBy && !hasDependencies) {
    try {
      return deriveAdmissionStall(task, context, observedAt);
    } catch {
      return undefined;
    }
  }
  /*
  Without a resolver every `blockedBy` would read as blocking (`getTaskCompletionBlocker`'s
  documented no-resolver contract). A stale marker on an already-terminal or deleted blocker would
  then lie on every card forever, so the diagnostic stays silent instead of unverified.
  */
  if (!context.resolveDependency) return undefined;

  try {
    const blocker = await getTaskCompletionBlocker(task, {
      resolveTask: context.resolveDependency,
      satisfactionColumnsByTaskId: context.satisfactionColumnsByTaskId,
    });
    /*
    FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
    A proven blocker is the stronger, already-authoritative answer and returns as before. A probe that
    PROVED there is no live blocker (every reference resolved terminal or deleted) no longer ends the
    derivation: the card is genuinely unblocked, so the planning lane may now name whatever else is
    holding it. A probe that threw still ends it — an unproven dependency question outranks any
    planning answer, because guessing here is exactly the lie the fail-open contract forbids.
    */
    if (blocker) return { code: "dependency-blocker", reason: blocker, observedAt };
  } catch {
    return undefined;
  }

  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning-lane branch sits LAST — after suppression, the terminal lane, the review lane, and the
  dependency probe — because every earlier answer is more specific and more actionable than "a planner
  has not picked this card up". It shares the derivation's fail-open contract: a malformed episode or an
  unparseable `nextRecoveryAt` degrades to silence, never to a broken task read.
  */
  try {
    return deriveAdmissionStall(task, context, observedAt);
  } catch {
    return undefined;
  }
}
