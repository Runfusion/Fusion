import { computeBlockerFanoutMap } from "./blocker-fanout.js";
import type { Task } from "./types.js";

export type DependencyBlockedTodoCode = "dependency-blocked-todo";

export interface DependencyBlockedTodoGroup {
  blockerId: string;
  blockerColumn: Task["column"] | "unknown";
  blockerTitle?: string;
  blockedTodoIds: string[];
  blockedTodoCount: number;
  blockingAgeMs: number;
  ageBucket: "fresh" | "aging" | "stale";
  viaDependencies: string[];
  viaBlockedBy: string[];
}

export interface DependencyBlockedTodoReport {
  observedAt: string;
  totalBlockedTodoCount: number;
  uniqueBlockerCount: number;
  groups: DependencyBlockedTodoGroup[];
  thresholds: {
    freshMs: number;
    staleMs: number;
    minBlockedTodoCount: number;
  };
}

export interface DependencyBlockedTodoReportContext {
  now?: number;
  freshAgeMs?: number;
  staleAgeMs?: number;
  minBlockedTodoCount?: number;
  maxGroups?: number;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-28-02:40 (PR #2470 review, P1):
  The task's resolved lifecycle roles. `computeBlockerFanoutMap` already accepted
  these, but this report called it with NEITHER — so a renamed workflow silently
  fell back to the legacy sets. The failures pointed in opposite directions: a
  FINISHED blocker in a renamed terminal column counted as ACTIVE (over-reporting
  dead blockers), while dependents in a renamed hold column were not counted as
  blocked todos at all (under-reporting real ones).

  Both default to the legacy values, so a caller that cannot resolve a workflow
  is byte-identical.
  */
  /** Columns that end a task's life (`complete` + `archived` roles). */
  terminalColumns?: readonly string[];
  /** The capacity-wait column whose residents are the report's "blocked todos". */
  holdColumn?: string;
  /*
  PLURAL form. This report runs BOARD-WIDE, and a board may span more than one
  workflow — so there can be more than one hold column and collapsing them to one
  silently drops every card held by the other workflows. The engine reporter
  passes the union across the workflows actually present on the board.
  */
  holdColumns?: readonly string[];
}

/* Legacy role ids — the builtin coding workflow's names, used when a caller
   cannot resolve the task's workflow. */
const DEFAULT_REPORT_TERMINAL_COLUMNS: readonly string[] = ["done", "archived"];
const DEFAULT_REPORT_HOLD_COLUMN = "todo";

export const DEFAULT_DEPENDENCY_BLOCKED_TODO_FRESH_MS = 30 * 60_000;
export const DEFAULT_DEPENDENCY_BLOCKED_TODO_STALE_MS = 4 * 60 * 60_000;
export const DEFAULT_DEPENDENCY_BLOCKED_TODO_MIN_COUNT = 1;
export const DEFAULT_DEPENDENCY_BLOCKED_TODO_MAX_GROUPS = 10;

const AGE_BUCKET_PRIORITY: Record<DependencyBlockedTodoGroup["ageBucket"], number> = {
  stale: 0,
  aging: 1,
  fresh: 2,
};

function sanitizeContext(context: DependencyBlockedTodoReportContext | undefined) {
  const now = context?.now ?? Date.now();
  const freshMs = Number.isFinite(context?.freshAgeMs) && (context?.freshAgeMs ?? 0) > 0
    ? Math.floor(context!.freshAgeMs as number)
    : DEFAULT_DEPENDENCY_BLOCKED_TODO_FRESH_MS;
  const requestedStaleMs = Number.isFinite(context?.staleAgeMs) && (context?.staleAgeMs ?? 0) > 0
    ? Math.floor(context!.staleAgeMs as number)
    : DEFAULT_DEPENDENCY_BLOCKED_TODO_STALE_MS;
  const staleMs = requestedStaleMs <= freshMs ? freshMs + 1 : requestedStaleMs;
  const minBlockedTodoCount = Number.isFinite(context?.minBlockedTodoCount)
    ? Math.max(1, Math.floor(context!.minBlockedTodoCount as number))
    : DEFAULT_DEPENDENCY_BLOCKED_TODO_MIN_COUNT;
  const maxGroups = Number.isFinite(context?.maxGroups)
    ? Math.max(1, Math.floor(context!.maxGroups as number))
    : DEFAULT_DEPENDENCY_BLOCKED_TODO_MAX_GROUPS;

  return { now, freshMs, staleMs, minBlockedTodoCount, maxGroups };
}

export function computeDependencyBlockedTodoReport(
  tasks: Task[],
  maxAutoMergeRetries: number,
  context: DependencyBlockedTodoReportContext = {},
): DependencyBlockedTodoReport {
  const { now, freshMs, staleMs, minBlockedTodoCount, maxGroups } = sanitizeContext(context);
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-28-02:40 (PR #2470 review, P1):
  Thread the resolved roles into the fan-out AND into this function's own two
  literals below. Threading only the fan-out would leave the `todoTaskIds` filter
  and the terminal-blocker skip on legacy ids, so a renamed workflow would still
  report nothing — a fix that looks complete and changes no outcome.
  */
  const terminalColumns = context.terminalColumns ?? DEFAULT_REPORT_TERMINAL_COLUMNS;
  const holdColumns = new Set(
    context.holdColumns ?? [context.holdColumn ?? DEFAULT_REPORT_HOLD_COLUMN],
  );
  const terminalColumnSet = new Set(terminalColumns);

  const blockerFanout = computeBlockerFanoutMap(tasks, maxAutoMergeRetries, {
    nowMs: now,
    terminalColumns: terminalColumnSet,
    holdColumns,
  });
  const todoTaskIds = new Set(tasks.filter((task) => holdColumns.has(task.column)).map((task) => task.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const groups: DependencyBlockedTodoGroup[] = [];

  for (const [blockerId, entry] of blockerFanout.entries()) {
    if (entry.activeTodoCount < minBlockedTodoCount) {
      continue;
    }

    const blocker = taskById.get(blockerId);
    // Terminal by the workflow's OWN roles, not the legacy done/archived pair.
    if (!blocker || terminalColumnSet.has(blocker.column)) {
      continue;
    }

    const viaDependencies = [...new Set(entry.dependencyDependentIds.filter((id) => todoTaskIds.has(id)))].sort();
    const viaBlockedBy = [...new Set(entry.overlapBlockedDependentIds.filter((id) => todoTaskIds.has(id)))].sort();
    const blockedTodoIds = [...new Set([...viaDependencies, ...viaBlockedBy])].sort();
    const blockedTodoCount = blockedTodoIds.length;
    if (blockedTodoCount < minBlockedTodoCount) {
      continue;
    }

    const anchor = Date.parse(blocker.columnMovedAt ?? blocker.updatedAt);
    const blockingAgeMs = Number.isFinite(anchor) ? Math.max(0, now - anchor) : 0;
    const ageBucket: DependencyBlockedTodoGroup["ageBucket"] =
      blockingAgeMs < freshMs ? "fresh" : blockingAgeMs >= staleMs ? "stale" : "aging";

    groups.push({
      blockerId,
      blockerColumn: blocker.column ?? "unknown",
      blockerTitle: blocker.title,
      blockedTodoIds,
      blockedTodoCount,
      blockingAgeMs,
      ageBucket,
      viaDependencies,
      viaBlockedBy,
    });
  }

  groups.sort((a, b) => {
    const agePriority = AGE_BUCKET_PRIORITY[a.ageBucket] - AGE_BUCKET_PRIORITY[b.ageBucket];
    if (agePriority !== 0) return agePriority;
    if (a.blockedTodoCount !== b.blockedTodoCount) return b.blockedTodoCount - a.blockedTodoCount;
    if (a.blockingAgeMs !== b.blockingAgeMs) return b.blockingAgeMs - a.blockingAgeMs;
    return a.blockerId.localeCompare(b.blockerId);
  });

  const keptGroups = groups.slice(0, maxGroups);
  const totalBlockedTodoCount = new Set(keptGroups.flatMap((group) => group.blockedTodoIds)).size;

  return {
    observedAt: new Date(now).toISOString(),
    totalBlockedTodoCount,
    uniqueBlockerCount: keptGroups.length,
    groups: keptGroups,
    thresholds: {
      freshMs,
      staleMs,
      minBlockedTodoCount,
    },
  };
}
