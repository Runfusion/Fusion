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
  const holdColumn = context.holdColumn ?? "todo";
  if (task.column !== holdColumn || task.paused !== true) return undefined;

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
