import type { TraitFlags } from "@fusion/core";
import type { TaskItem } from "./state.js";

// ── TUI bucket model (U11, R18) ──────────────────────────────────────────────
//
// The TUI renders a fixed set of buckets. The first four are the legacy kanban
// columns it has always shown. The fifth, "other", is a read-only catch-all for
// cards whose resolved workflow column the TUI cannot express as one of its
// legacy buckets — it sits between "in-review" and "done" so a custom column
// roughly "after review, before done" reads in a sensible place, and each card
// in it keeps its real column name as a secondary label so the user never loses
// the true position. The cardinal rule (R18): a card is NEVER dropped.

export const LEGACY_KANBAN_COLUMNS = ["todo", "in-progress", "in-review", "done"] as const;
export type LegacyKanbanColumn = (typeof LEGACY_KANBAN_COLUMNS)[number];

/** The "other (custom)" catch-all bucket id. Read-only. */
export const OTHER_BUCKET = "other" as const;

/** All TUI buckets in render order: legacy columns with "other" wedged between
 *  in-review and done (U11 ordering requirement). */
export const TUI_BUCKETS = ["todo", "in-progress", "in-review", OTHER_BUCKET, "done"] as const;
export type TuiBucket = (typeof TUI_BUCKETS)[number];

/** True when the bucket is the read-only custom catch-all. */
export function isOtherBucket(bucket: TuiBucket): bucket is typeof OTHER_BUCKET {
  return bucket === OTHER_BUCKET;
}

/**
 * Map a task to its TUI bucket (U11, R18).
 *
 * 1. If the task sits in one of the legacy kanban column ids, keep it there
 *    verbatim — flag-OFF and all-legacy boards behave exactly as before.
 * 2. Otherwise, if the task carries resolved column flags (flag-ON payload),
 *    map by trait flags into the nearest legacy bucket:
 *      - complete                       → done
 *      - humanReview || mergeBlocker     → in-review
 *      - countsTowardWip                 → in-progress
 *      - hold || intake                  → todo
 * 3. Anything still unmapped lands in the read-only "other" bucket. The card is
 *    never dropped.
 *
 * Precedence note: `complete` wins over the others (a terminal column is shown
 * as done even if it carried other advisory flags); review beats wip; wip beats
 * the todo-like flags. This mirrors the lane priority the dashboard board uses.
 */
export function bucketForTask(task: TaskItem): TuiBucket {
  if ((LEGACY_KANBAN_COLUMNS as readonly string[]).includes(task.column)) {
    return task.column as LegacyKanbanColumn;
  }

  const flags: TraitFlags | undefined = task.columnFlags;
  if (flags) {
    if (flags.complete) return "done";
    if (flags.humanReview || flags.mergeBlocker) return "in-review";
    if (flags.countsTowardWip) return "in-progress";
    if (flags.hold || flags.intake) return "todo";
  }

  return OTHER_BUCKET;
}

/** Group tasks into the five TUI buckets, preserving input order within each.
 *  Every task lands in exactly one bucket; none are dropped. */
export function groupTasksByBucket(tasks: TaskItem[]): Record<TuiBucket, TaskItem[]> {
  const out: Record<TuiBucket, TaskItem[]> = {
    todo: [],
    "in-progress": [],
    "in-review": [],
    [OTHER_BUCKET]: [],
    done: [],
  };
  for (const task of tasks) {
    out[bucketForTask(task)].push(task);
  }
  return out;
}

/** Secondary label shown under a card in the "other" bucket: its real column
 *  name (falling back to the column id) so the user keeps the true position. */
export function otherBucketSecondaryLabel(task: TaskItem): string {
  return task.columnName ?? task.column;
}
