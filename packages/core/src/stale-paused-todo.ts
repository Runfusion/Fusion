import type { Task } from "./types.js";

export type StalePausedTodoCode = "stale-paused-todo";

export interface StalePausedTodoSignal {
  code: StalePausedTodoCode;
  reason: string;
  observedAt: string;
  ageMs: number;
  thresholdMs: number;
  pausedReason?: string;
  pausedByAgentId?: string;
}

export interface StalePausedTodoContext {
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-27-21:35 (Phase B / U6):
  The lifecycle role this signal is about is HOLD (the capacity-wait column), not
  the id `todo` — that is merely what the built-in coding workflow calls it. A
  workflow naming its hold column `drafting` has the identical stall condition,
  and before this parameter existed the guard silently stopped matching for it:
  no error, no failing test, just a recovery signal that never fired.

  Defaults to `"todo"` so every existing caller is byte-identical (R11 keeps
  `todo` a legal column id). Callers that can resolve the task's workflow pass
  `resolveLifecycleColumns(ir).hold` instead.
  */
  holdColumn?: string;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the lane seam, MEMBERSHIP not one column):
  `holdColumn` is `resolveLifecycleColumns().hold` — the FIRST column carrying the hold trait. A
  board declaring more than one hold lane (a capacity wait beside a blocked-on-dependency park) has
  several, and a card resting in the second read as not-on-hold and was never surfaced.

  Mirrors `reviewColumns` in in-review-stalled.ts / stale-paused-review.ts. Optional, with today's
  behaviour preserved as the fallback, so a caller that does not pass it is byte-identical.
  */
  holdColumns?: ReadonlySet<string>;
  now?: number;
  thresholdMs?: number;
  engineActiveSinceMs?: number;
  engineActivationGraceMs?: number;
}

export const DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS = 24 * 60 * 60_000;

export function getStalePausedTodoSignal(
  task: Pick<Task, "column" | "paused" | "columnMovedAt" | "updatedAt" | "pausedReason" | "pausedByAgentId">,
  context: StalePausedTodoContext = {},
): StalePausedTodoSignal | undefined {
  const onHoldLane = context.holdColumns
    ? context.holdColumns.has(task.column)
    /* DELIBERATE-LITERAL — the no-metadata fallback; a supplied set always wins. */
    : task.column === (context.holdColumn ?? "todo");
  if (!onHoldLane || task.paused !== true) return undefined;

  const thresholdMs = context.thresholdMs ?? DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return undefined;

  const now = context.now ?? Date.now();
  const anchor = Date.parse(task.columnMovedAt ?? task.updatedAt);
  if (!Number.isFinite(anchor)) return undefined;

  const activationFloorMs = getActivationFloorMs(context);
  const effectiveAnchor = activationFloorMs !== undefined ? Math.max(anchor, activationFloorMs) : anchor;
  const ageMs = Math.max(0, now - effectiveAnchor);
  if (ageMs < thresholdMs) return undefined;

  return {
    code: "stale-paused-todo",
    reason: "Task has remained paused in todo beyond threshold",
    observedAt: new Date(now).toISOString(),
    ageMs,
    thresholdMs,
    pausedReason: task.pausedReason,
    pausedByAgentId: task.pausedByAgentId,
  };
}

function getActivationFloorMs(context: StalePausedTodoContext): number | undefined {
  if (typeof context.engineActiveSinceMs !== "number" || !Number.isFinite(context.engineActiveSinceMs)) {
    return undefined;
  }

  return context.engineActiveSinceMs + Math.max(0, context.engineActivationGraceMs ?? 0);
}
