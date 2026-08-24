import type { Task } from "@fusion/core";

export type TaskTitleDisplaySource = "title" | "description" | "id";

export interface TaskTitleDisplay {
  source: TaskTitleDisplaySource;
  text: string;
  fullText: string;
  isBoundedDescription: boolean;
}

const MAX_DESCRIPTION_FALLBACK_LENGTH = 200;
const DESCRIPTION_FALLBACK_SUFFIX = "...";

/**
 * Selects a display-only card label without changing the authoritative task data.
 *
 * FNXC:TaskTitleDisplay 2026-08-19-15:22:
 * FN-044 renders an ordinary titleless FN-036 task from its description only after a nonblank
 * persisted title has been ruled out. This UI seam must not restore an AI length policy or persist
 * a fallback title; selected descriptions above 200 characters use a literal `...` within 200 total.
 */
export function getTaskTitleDisplay(task: Pick<Task, "id" | "title" | "description">): TaskTitleDisplay {
  if (typeof task.title === "string" && task.title.trim().length > 0) {
    return {
      source: "title",
      text: task.title,
      fullText: task.title,
      isBoundedDescription: false,
    };
  }

  if (typeof task.description === "string" && task.description.trim().length > 0) {
    const isBoundedDescription = task.description.length > MAX_DESCRIPTION_FALLBACK_LENGTH;
    return {
      source: "description",
      text: isBoundedDescription
        ? task.description.slice(0, MAX_DESCRIPTION_FALLBACK_LENGTH - DESCRIPTION_FALLBACK_SUFFIX.length) + DESCRIPTION_FALLBACK_SUFFIX
        : task.description,
      fullText: task.description,
      isBoundedDescription,
    };
  }

  return {
    source: "id",
    text: task.id,
    fullText: task.id,
    isBoundedDescription: false,
  };
}
