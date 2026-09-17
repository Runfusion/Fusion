/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509 replaces the task-priority contract (urgent/high/normal/low) with ONE chronological queue
order shared by the domain, the PostgreSQL readers, every admission producer/consumer, and the
Dashboard. There are no priority levels any more: an ordinary queue is strictly arrival-ordered
(`createdAt ASC`, then the id's numeric suffix, then the full id), and the ONLY way to move a card
forward is an explicit operator **Boost**, which is a move-to-head — not a level, not a counter, and
not a local display preference.

WHY A SEPARATE MODULE RATHER THAN AN EDIT IN PLACE. The old comparator lived beside the priority
rank table and the fan-out weighting, so every caller that merely wanted "which card is next"
transitively depended on priority. Splitting the queue contract out lets the priority module be
deleted wholesale while a single browser-safe module is shared by core, engine, the dashboard server
and the dashboard app — SQL and TypeScript must produce the SAME order, so there can only be one
definition of it.
*/

import { isActiveMergeStatus } from "../merge/active-merge-status.js";
import {
  isCompleteColumnRole,
  isIntakeColumnRole,
  isReviewColumnRole,
  type ColumnRoleTraitFlags,
} from "../column-roles.js";

// ── Boost record ────────────────────────────────────────────────────────────

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
A Boost belongs to the card's CURRENT STAY in ONE column of ONE workflow. That scope is the whole
reason the record carries four identity fields rather than a bare flag: a boost must survive the
different phases of a single stay (planning, then waiting for capacity, in the same Planning column)
while being invalidated by a real lifecycle change (a column move, a Reset, a workflow switch). A
boolean could not tell those two cases apart, and a timestamp alone could not order two concurrent
clicks — hence the server-assigned monotonic `sequence`, never a browser clock.
*/
export interface TaskQueueBoost {
  /**
   * Server-assigned monotonic decimal sequence, stored as a STRING.
   *
   * A PostgreSQL sequence is the ordering authority for concurrent clicks. It is kept as a decimal
   * string rather than a `number` so a long-lived project cannot silently lose ordering once the
   * sequence passes `Number.MAX_SAFE_INTEGER`.
   */
  sequence: string;
  /** The effective workflow id at the moment the boost was accepted. */
  workflowId: string;
  /** The column id the boost belongs to. */
  column: string;
  /** Column-entry marker for the stay this boost belongs to. */
  columnEntryAt: string;
  /** Caller-supplied idempotency key: a retried network call must not mint a new rank. */
  requestId: string;
}

/** The minimal task shape the queue order reads. */
export interface TaskQueueSortable {
  id: string;
  createdAt: string;
  column?: string;
  columnMovedAt?: string;
  updatedAt?: string;
  status?: string | null;
  queueBoost?: TaskQueueBoost | null;
}

const DECIMAL_SEQUENCE_PATTERN = /^\d{1,32}$/;

/** Structural validation of a persisted/incoming boost record. Invalid legacy data is never a boost. */
export function isTaskQueueBoost(value: unknown): value is TaskQueueBoost {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TaskQueueBoost>;
  return (
    typeof candidate.sequence === "string" &&
    DECIMAL_SEQUENCE_PATTERN.test(candidate.sequence) &&
    typeof candidate.workflowId === "string" &&
    candidate.workflowId.length > 0 &&
    typeof candidate.column === "string" &&
    candidate.column.length > 0 &&
    typeof candidate.columnEntryAt === "string" &&
    candidate.columnEntryAt.length > 0 &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0
  );
}

/**
 * Normalize an arbitrary persisted value into a boost or `null`.
 *
 * Deliberately total and lossy in ONE direction: malformed or legacy data degrades to "no boost",
 * and nothing can ever be promoted INTO a boost by a read.
 */
export function normalizeTaskQueueBoost(value: unknown): TaskQueueBoost | null {
  if (!isTaskQueueBoost(value)) return null;
  return {
    sequence: value.sequence.replace(/^0+(?=\d)/, ""),
    workflowId: value.workflowId,
    column: value.column,
    columnEntryAt: value.columnEntryAt,
    requestId: value.requestId,
  };
}

/**
 * The durable marker identifying one stay of a card in one column.
 *
 * `columnMovedAt` is the authoritative move stamp; `createdAt` covers a card that has never moved.
 * `updatedAt` is deliberately NOT part of it — a title edit must not end a boost's scope.
 */
export function resolveTaskColumnEntryAt(task: Pick<TaskQueueSortable, "createdAt" | "columnMovedAt">): string {
  return task.columnMovedAt ?? task.createdAt;
}

/** Compare two decimal sequence strings; the LATER (larger) sequence wins the head of the queue. */
export function compareQueueBoostSequence(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ResolveEffectiveBoostOptions {
  /** The card's effective workflow id. When omitted the workflow identity check is skipped. */
  workflowId?: string;
}

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
The stored boost is only EFFECTIVE while its scope still matches the card. This is the single place
that decision is made so a reader, an admission pass and the UI cannot disagree about whether a card
is still boosted. A stale record is inert rather than an error: A -> B -> A must NOT resurrect the
first stay's boost, which is exactly what comparing the column id alone would do.
*/
export function resolveEffectiveQueueBoost(
  task: Pick<TaskQueueSortable, "createdAt" | "column" | "columnMovedAt" | "queueBoost">,
  options: ResolveEffectiveBoostOptions = {},
): TaskQueueBoost | null {
  const boost = normalizeTaskQueueBoost(task.queueBoost);
  if (!boost) return null;
  if (task.column !== undefined && boost.column !== task.column) return null;
  if (boost.columnEntryAt !== resolveTaskColumnEntryAt(task)) return null;
  if (options.workflowId !== undefined && boost.workflowId !== options.workflowId) return null;
  return boost;
}

// ── Deterministic id / age ordering ─────────────────────────────────────────

function getTaskIdNumericToken(id: string): number | null {
  const token = id.slice(id.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(token)) return null;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Ascending id order: numeric suffix first so `FN-2` precedes `FN-10`, then the whole id. */
export function compareTaskIdNumeric(a: string, b: string): number {
  const aNum = getTaskIdNumericToken(a);
  const bNum = getTaskIdNumericToken(b);
  if (aNum !== null && bNum !== null && aNum !== bNum) return aNum - bNum;
  return a.localeCompare(b);
}

/** Descending id order — the mirror used by newest-first display lanes. */
export function compareTaskIdNumericDesc(a: string, b: string): number {
  return -compareTaskIdNumeric(a, b);
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
Arrival is CREATION, never `updatedAt` and never a re-entry into a column: renaming a card or
bouncing it back from review must not rejuvenate it past cards that have waited longer. Missing or
unparseable legacy timestamps sort AFTER every valid one, with the id tiebreak keeping them stable
instead of arbitrary — an unordered tail would make SQL and TypeScript disagree.
*/
export function compareTasksByAgeAndId<T extends Pick<TaskQueueSortable, "id" | "createdAt">>(a: T, b: T): number {
  const aTime = parseTimestamp(a.createdAt);
  const bTime = parseTimestamp(b.createdAt);
  if ((aTime === null) !== (bTime === null)) return aTime === null ? 1 : -1;
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
  return compareTaskIdNumeric(a.id, b.id);
}

// ── The queue order ─────────────────────────────────────────────────────────

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
THE queue comparator. Boosted cards come first, most-recent boost at the very head (so a second
click reclaims the head from an earlier boost), then everything else oldest-first. Nothing else
participates: no level, no dependency fan-out weight, no lane rank. The visible order is the order
the engine will TRY candidates in — it is not permission to start, so a blocked boosted card keeps
its place while admission moves on to the next admissible candidate.
*/
export function compareTasksByQueueOrder<T extends TaskQueueSortable>(a: T, b: T): number {
  const aBoost = resolveEffectiveQueueBoost(a);
  const bBoost = resolveEffectiveQueueBoost(b);
  if (!!aBoost !== !!bBoost) return aBoost ? -1 : 1;
  if (aBoost && bBoost) {
    const sequenceCmp = compareQueueBoostSequence(bBoost.sequence, aBoost.sequence);
    if (sequenceCmp !== 0) return sequenceCmp;
  }
  return compareTasksByAgeAndId(a, b);
}

/** Return a queue-ordered copy; the input array is never mutated. */
export function sortTasksByQueueOrder<T extends TaskQueueSortable>(tasks: readonly T[]): T[] {
  return [...tasks].sort(compareTasksByQueueOrder);
}

/** Manual-intake display order (Coding Ideas' "Ideas" lane): newest first, deterministic id tiebreak. */
export function compareTasksByIntakeDisplayOrder<T extends Pick<TaskQueueSortable, "id" | "createdAt">>(
  a: T,
  b: T,
): number {
  const aTime = parseTimestamp(a.createdAt);
  const bTime = parseTimestamp(b.createdAt);
  if ((aTime === null) !== (bTime === null)) return aTime === null ? 1 : -1;
  if (aTime !== null && bTime !== null && aTime !== bTime) return bTime - aTime;
  return compareTaskIdNumericDesc(a.id, b.id);
}

/** Complete-lane arrival timestamp: the durable move stamp with the documented legacy fallbacks. */
export function getCompleteArrivalTimestamp(task: TaskQueueSortable): number {
  const timestamp = task.columnMovedAt ?? task.updatedAt ?? task.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Complete display order: most recent arrival first — deliberately NOT creation order. */
export function compareTasksByCompleteArrival<T extends TaskQueueSortable>(a: T, b: T): number {
  const timestampCmp = getCompleteArrivalTimestamp(b) - getCompleteArrivalTimestamp(a);
  if (timestampCmp !== 0) return timestampCmp;
  return compareTaskIdNumeric(a.id, b.id);
}

// ── Display ordering per column role ────────────────────────────────────────

export interface DisplayColumnOrderOptions {
  /** Resolved column traits; omitted only while retaining legacy-id compatibility. */
  columnFlags?: ColumnRoleTraitFlags & { manualIntake?: boolean };
  /** Predicate for "this card is really being worked on right now". */
  isActive?: (task: TaskQueueSortable) => boolean;
}

/*
Manual intake is trait CONFIG (`intake` with `autoTriage: false`), surfaced to clients as the
`manualIntake` flag. There is deliberately NO legacy-id fallback: the legacy intake columns all
auto-triage, so an unresolved column must not be guessed into the newest-first idea ordering.
*/
function isManualIntakeColumn(
  flags: (ColumnRoleTraitFlags & { manualIntake?: boolean }) | undefined,
): boolean {
  return flags?.manualIntake === true;
}

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
One sorter for every board lane, replacing the per-column sort modes the column "…" menu used to
offer (FN-509 deletes that menu; there is no configurable display order any more).

  - Manual intake (Ideas): newest first — an idea list reads top-down as "what did I just think of".
  - Complete (Done): most recent ARRIVAL first, unchanged, so Done does not become creation-ordered.
  - Everything else: genuinely ACTIVE cards first, then the whole waiting queue in Boost/FIFO order.
    Active cards are ordered among themselves by arrival and never by boost — a boost must not let a
    waiting card appear to jump ahead of work already in flight.
*/
export function sortTasksForDisplayColumn<T extends TaskQueueSortable>(
  tasks: readonly T[],
  column: string,
  options: DisplayColumnOrderOptions = {},
): T[] {
  const { columnFlags, isActive } = options;

  if (isManualIntakeColumn(columnFlags)) {
    return [...tasks].sort(compareTasksByIntakeDisplayOrder);
  }

  if (isCompleteColumnRole(columnFlags, column)) {
    return [...tasks].sort(compareTasksByCompleteArrival);
  }

  const activeOf = (task: T): boolean => {
    if (isActive) return isActive(task);
    // Without a caller-supplied activity predicate, an active merge is the one signal available
    // from the task row alone; everything else is treated as waiting.
    return isReviewColumnRole(columnFlags, column) && isActiveMergeStatus(task.status);
  };

  return [...tasks].sort((a, b) => {
    const aActive = activeOf(a);
    const bActive = activeOf(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive && bActive) return compareTasksByAgeAndId(a, b);
    return compareTasksByQueueOrder(a, b);
  });
}

// ── Queue presence / Boost availability ─────────────────────────────────────

/** Why a card has no boostable queue. `null` means it HAS one. */
export type QueueUnavailableReason =
  | "manual-intake"
  | "complete"
  | "historical"
  | "deleted"
  | "active"
  | "no-automatic-processing"
  | "human-only-wait"
  | "unresolved";

export interface QueuePresenceInput {
  /** Resolved column traits plus the `manualIntake` config fact. Absent means unresolved metadata. */
  columnFlags?: (ColumnRoleTraitFlags & { manualIntake?: boolean; mergeOrchestration?: boolean }) | undefined;
  column: string;
  /** The card is being worked on right now. */
  isActive: boolean;
  /** Soft-deleted or otherwise not a live board row. */
  isDeleted?: boolean;
  /** A read-only historical snapshot rather than a live card. */
  isHistorical?: boolean;
  /** Effective auto-merge for this card (task override resolved against project settings). */
  autoMergeEnabled?: boolean;
  /** At least one automatic review/gate still has to run in this review lane. */
  hasRemainingAutomaticReview?: boolean;
}

export interface QueuePresenceVerdict {
  /** The card sits in a lane whose remaining processing is performed automatically. */
  hasQueue: boolean;
  /** The Boost affordance may be offered for this card. */
  boostAvailable: boolean;
  reason: QueueUnavailableReason | null;
}

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
Boost availability is derived from the REAL workflow lane and its remaining automatic processing —
never from the strings `todo`, `Ideas` or `Done`, which do not exist in a renamed or custom
workflow. Availability deliberately IGNORES why a card currently cannot start: capacity, overlap, a
dependency, an approval, a pause or a retry cooldown all leave the card in a queue, and clicking
Boost removes none of them. It only says "when this lane next admits work, try me first".

Unresolved metadata returns `boostAvailable: false`: showing an action we cannot prove is permitted
is worse than omitting it, because the click would be refused by the server anyway.
*/
export function resolveQueuePresence(input: QueuePresenceInput): QueuePresenceVerdict {
  const deny = (reason: QueueUnavailableReason, hasQueue = false): QueuePresenceVerdict => ({
    hasQueue,
    boostAvailable: false,
    reason,
  });

  if (input.isDeleted) return deny("deleted");
  if (input.isHistorical) return deny("historical");
  if (!input.columnFlags) return deny("unresolved");

  const flags = input.columnFlags;
  if (isCompleteColumnRole(flags, input.column)) return deny("complete");
  if (flags.manualIntake === true) return deny("manual-intake");

  const isReviewLane = isReviewColumnRole(flags, input.column) || flags.mergeOrchestration === true;
  /*
  A review lane with auto-merge OFF is a purely human wait — unless an automatic review gate still
  has to run, in which case the automatic queue is real and Boost stays meaningful.
  */
  if (isReviewLane && input.autoMergeEnabled === false && input.hasRemainingAutomaticReview !== true) {
    return deny("human-only-wait");
  }

  const hasAutomaticProcessing =
    isReviewLane ||
    isIntakeColumnRole(flags, input.column) ||
    flags.hold === true ||
    flags.countsTowardWip === true;

  if (!hasAutomaticProcessing) return deny("no-automatic-processing");
  if (input.isActive) return deny("active", true);

  return { hasQueue: true, boostAvailable: true, reason: null };
}
