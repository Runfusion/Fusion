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
  now?: number;
  thresholdMs?: number;
}

export const DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS = 24 * 60 * 60_000;

export function getStalePausedTodoSignal(
  task: Pick<Task, "column" | "paused" | "columnMovedAt" | "updatedAt" | "pausedReason" | "pausedByAgentId">,
  context: StalePausedTodoContext = {},
): StalePausedTodoSignal | undefined {
  if (task.column !== "todo" || task.paused !== true) return undefined;

  const thresholdMs = context.thresholdMs ?? DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return undefined;

  const now = context.now ?? Date.now();
  const anchor = Date.parse(task.columnMovedAt ?? task.updatedAt);
  if (!Number.isFinite(anchor)) return undefined;

  const ageMs = now - anchor;
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
