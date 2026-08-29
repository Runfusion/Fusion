import type { InReviewStallCode, Task, TaskLogEntry } from "@fusion/core";
import { getTaskLogEntryAction } from "./taskLogEntryDisplay";

export const IN_REVIEW_STALL_LOG_PREFIX = "In-review stall surfaced [";
export const IN_REVIEW_STALL_LOG_REGEX = /^In-review stall surfaced \[([^\]]+)\]/;

export interface InReviewStallLogMatch {
  entry: TaskLogEntry;
  reversedIndex: number;
  code: InReviewStallCode;
}

export function findInReviewStallLogEntry(
  task: Pick<Task, "log">,
  code: InReviewStallCode,
): InReviewStallLogMatch | undefined {
  if (!task.log?.length) {
    return undefined;
  }

  const reversed = [...task.log].reverse();
  for (const [reversedIndex, entry] of reversed.entries()) {
    const match = getTaskLogEntryAction(entry).match(IN_REVIEW_STALL_LOG_REGEX);
    if (!match || match[1] !== code) {
      continue;
    }

    return { entry, reversedIndex, code };
  }

  return undefined;
}
