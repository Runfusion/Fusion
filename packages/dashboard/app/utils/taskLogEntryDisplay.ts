import type { TaskLogEntry } from "@fusion/core";

export type TaskLogEntryLike = Omit<Partial<TaskLogEntry>, "action" | "outcome"> & {
  action?: unknown;
  outcome?: unknown;
  text?: unknown;
  detail?: unknown;
};

/**
 * FNXC:TaskDetail 2026-06-14-13:43 Safely extract an activity-log action string with legacy `text` fallback.
 */
export function getTaskLogEntryAction(entry: TaskLogEntryLike | null | undefined): string {
  if (typeof entry?.action === "string" && entry.action.trim().length > 0) {
    return entry.action;
  }
  if (typeof entry?.text === "string" && entry.text.trim().length > 0) {
    return entry.text;
  }
  return "";
}

/**
 * FNXC:TaskDetail 2026-06-14-13:43 Safely extract an activity-log outcome string with legacy `detail` fallback.
 */
export function getTaskLogEntryOutcome(entry: TaskLogEntryLike | null | undefined): string | undefined {
  if (typeof entry?.outcome === "string" && entry.outcome.trim().length > 0) {
    return entry.outcome;
  }
  if (typeof entry?.detail === "string" && entry.detail.trim().length > 0) {
    return entry.detail;
  }
  return undefined;
}
