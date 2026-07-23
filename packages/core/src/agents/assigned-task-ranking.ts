/*
FNXC:WakeDeltaMultiAssign 2026-07-13-12:15:
Permanent agents can own many tasks via assignedAgentId while agent.taskId is singular.
Heartbeat Wake Delta must surface a compact ranked inventory so coordinators can unblock/reassign without full-board thrash.
Membership is assignment-based; lease is annotation only; fully unactionable blocked stay count-only to avoid re-chase spam.
*/

/**
 * Cap for titled multi-assign Wake Delta lines (plan U5: fixed 8, no setting).
 */
export const WAKE_DELTA_ASSIGNED_TASKS_CAP = 8;

export type AssignedTaskRankTier =
  | "in_progress"
  | "ready_todo"
  | "partial_blocked"
  | "other";

export interface AssignedTaskLike {
  id: string;
  column: string;
  title?: string | null;
  description?: string | null;
  paused?: boolean | null;
  dependencies?: string[] | null;
  checkedOutBy?: string | null;
  columnMovedAt?: string | null;
  createdAt?: string | null;
  deletedAt?: string | null;
}

export interface RankedAssignedTaskLine {
  task: AssignedTaskLike;
  tier: AssignedTaskRankTier;
  labels: string[];
  titleSnippet: string;
}

export interface RankAssignedTasksForWakeDeltaResult {
  ranked: RankedAssignedTaskLine[];
  totalOpen: number;
  notActionableCount: number;
  truncated: boolean;
}

function sortKey(task: AssignedTaskLike): string {
  return task.columnMovedAt ?? task.createdAt ?? "";
}

function titleSnippet(task: AssignedTaskLike, max = 72): string {
  const raw = (task.title?.trim() || task.description?.trim() || task.id).replace(/\s+/g, " ");
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}

function isTerminalColumn(column: string): boolean {
  return column === "done" || column === "archived";
}

/*
FNXC:WakeDeltaMultiAssign 2026-07-14-00:10:
Custom workflows use non-default column ids for ready/active work. Only treating
default `todo`/`in-progress` as titled hid assigned work as a bare count.
Map known default columns for rank quality; treat all other non-terminal open
columns (including custom workflow columns) as titled `other` so inventory stays
visible. Paused stays count-only to avoid re-chase noise.
*/
function tierForTask(task: AssignedTaskLike): AssignedTaskRankTier | "not_actionable" {
  if (task.paused) return "not_actionable";
  if (task.column === "in-progress") return "in_progress";
  if (task.column === "todo") {
    const deps = task.dependencies ?? [];
    if (deps.length === 0) return "ready_todo";
    // Coarse v1: non-empty deps ⇒ partial_blocked visibility (full dep hydrate deferred).
    return "partial_blocked";
  }
  // Default triage/in-review and any project-specific open columns: keep titled
  // at lowest rank so custom workflows do not hide assigned work as count-only.
  return "other";
}

const TIER_ORDER: Record<AssignedTaskRankTier, number> = {
  in_progress: 0,
  ready_todo: 1,
  partial_blocked: 2,
  other: 3,
};

/**
 * Rank open assigned tasks for Wake Delta multi-assign inventory.
 * Excludes done/archived; titled lines only for actionable tiers; cap applied.
 */
export function rankAssignedTasksForWakeDelta(
  tasks: AssignedTaskLike[],
  options: {
    agentId: string;
    boundTaskId?: string | null;
    cap?: number;
  },
): RankAssignedTasksForWakeDeltaResult {
  const cap = options.cap ?? WAKE_DELTA_ASSIGNED_TASKS_CAP;
  const open = tasks.filter((t) => !t.deletedAt && !isTerminalColumn(t.column));

  const titled: RankedAssignedTaskLine[] = [];
  let notActionableCount = 0;

  for (const task of open) {
    const tierOrNa = tierForTask(task);
    if (tierOrNa === "not_actionable") {
      notActionableCount += 1;
      continue;
    }
    const labels: string[] = [];
    if (options.boundTaskId && task.id === options.boundTaskId) {
      labels.push("bound");
    }
    if (task.checkedOutBy && task.checkedOutBy !== options.agentId) {
      labels.push(`lease: held-by-other`);
    }
    titled.push({
      task,
      tier: tierOrNa,
      labels,
      titleSnippet: titleSnippet(task),
    });
  }

  titled.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return sortKey(a.task).localeCompare(sortKey(b.task));
  });

  const truncated = titled.length > cap;
  return {
    ranked: titled.slice(0, cap),
    totalOpen: open.length,
    notActionableCount,
    truncated,
  };
}

/**
 * Format ranked assigned tasks for Wake Delta markdown injection.
 * Returns empty string when there is nothing useful to show.
 */
export function formatAssignedTasksWakeDeltaSection(
  result: RankAssignedTasksForWakeDeltaResult,
  options?: { showWhenSingleBoundOnly?: boolean; boundTaskId?: string | null },
): string {
  const { ranked, totalOpen, notActionableCount, truncated } = result;
  if (totalOpen === 0) return "";

  // Prefer omit when only the bound task is titled and nothing else is open.
  if (
    ranked.length === 1 &&
    options?.boundTaskId &&
    ranked[0]?.task.id === options.boundTaskId &&
    notActionableCount === 0 &&
    !options.showWhenSingleBoundOnly
  ) {
    return "";
  }

  if (ranked.length === 0 && notActionableCount === 0) return "";

  const lines: string[] = [];
  const actionableTotal = totalOpen - notActionableCount;
  if (ranked.length > 0) {
    const headerTotal = truncated
      ? `${ranked.length} of ${actionableTotal}`
      : `${ranked.length}`;
    lines.push(
      `- your assigned tasks (coordination inventory — not an implement-from-heartbeat queue; ranked, ${headerTotal}):`,
    );
    ranked.forEach((row, index) => {
      const labelSuffix = row.labels.length > 0 ? ` (${row.labels.join(", ")})` : "";
      lines.push(
        `  ${index + 1}. ${row.task.id} [${row.tier}]${labelSuffix} ${row.titleSnippet}`,
      );
    });
    if (truncated && actionableTotal > ranked.length) {
      lines.push(
        `  (+${actionableTotal - ranked.length} more assigned open tasks; ranked list truncated — do not auto-retry checkout/claim)`,
      );
    }
  }

  if (notActionableCount > 0) {
    lines.push(
      `- also assigned not actionable now: ${notActionableCount} (paused)`,
    );
  }

  return lines.join("\n");
}
