import { isTerminalColumnRole, type ColumnRoleTraitFlags } from "../column-roles.js";

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

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-02:00 (batch-core feed):
"Finished either way" comes from core's role helper, not from a local copy of the two ids.

`isTerminalColumnRole` already encodes exactly this union AND its legacy-id degraded mode, so passing
`undefined` flags reproduces this function's previous behaviour byte for byte — there is no bespoke
fallback to get wrong here, which is the point of routing through the helper rather than adding
another optional set to this module.

Keyed on the literals, the Wake Delta inventory counted a FINISHED card on a renamed board as open
assigned work, so a coordinator was asked to unblock or reassign tasks that had already shipped.
*/
function isTerminalColumn(
  column: string,
  flagsByColumnId?: ReadonlyMap<string, ColumnRoleTraitFlags>,
): boolean {
  return isTerminalColumnRole(flagsByColumnId?.get(column), column);
}

/*
FNXC:WakeDeltaMultiAssign 2026-07-14-00:10:
Custom workflows use non-default column ids for ready/active work. Only treating
default `todo`/`in-progress` as titled hid assigned work as a bare count.
Map known default columns for rank quality; treat all other non-terminal open
columns (including custom workflow columns) as titled `other` so inventory stays
visible. Paused stays count-only to avoid re-chase noise.
*/
/*
FNXC:WorkflowLifecycleColumns 2026-07-29-13:35 (U11):
The two ACTIONABLE lifecycle roles. `todo`/`in-progress` are only what the builtin
coding workflow calls them. The comment above already records that unrecognised
columns fall to `other` so assigned work stays visible — but that is a floor, not
a fix: a renamed HOLD column loses `ready_todo` and `partial_blocked` entirely, so
work that is genuinely ready to start ranks below everything already in progress.
Nothing errors and nothing disappears; the ordering is just wrong, which is how it
survived.

Defaults to the legacy ids so every unconverted caller is byte-identical.
*/
export interface AssignedTaskRankRoles {
  hold: string;
  wip: string;
}

const LEGACY_RANK_ROLES: AssignedTaskRankRoles = { hold: "todo", wip: "in-progress" };

function tierForTask(
  task: AssignedTaskLike,
  roles: AssignedTaskRankRoles = LEGACY_RANK_ROLES,
): AssignedTaskRankTier | "not_actionable" {
  if (task.paused) return "not_actionable";
  if (task.column === roles.wip) return "in_progress";
  if (task.column === roles.hold) {
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
 * Excludes workflow Complete rows; titled lines only for actionable tiers; cap applied.
 */
export function rankAssignedTasksForWakeDelta(
  tasks: AssignedTaskLike[],
  options: {
    agentId: string;
    boundTaskId?: string | null;
    cap?: number;
    /** Resolved lifecycle roles; omitted keeps the legacy builtin ids. */
    roles?: AssignedTaskRankRoles;
    /** Resolved trait flags per column id; omitted keeps the legacy builtin ids. */
    flagsByColumnId?: ReadonlyMap<string, ColumnRoleTraitFlags>;
  },
): RankAssignedTasksForWakeDeltaResult {
  const cap = options.cap ?? WAKE_DELTA_ASSIGNED_TASKS_CAP;
  const open = tasks.filter((t) => !t.deletedAt && !isTerminalColumn(t.column, options.flagsByColumnId));

  const titled: RankedAssignedTaskLine[] = [];
  let notActionableCount = 0;

  for (const task of open) {
    const tierOrNa = tierForTask(task, options.roles);
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
