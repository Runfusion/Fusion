import type { Task } from "@fusion/core";

export type TaskTitleDisplaySource = "title" | "description" | "id";

export interface TaskTitleDisplay {
  source: TaskTitleDisplaySource;
  text: string;
  fullText: string;
  isBoundedDescription: boolean;
}

/**
 * Exact number of description characters used as a card label when no title is stored.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * FN-391 fixes this at 220 characters taken EXACTLY — no ellipsis, no suffix, no word-boundary
 * rounding. The operator contract is "les 220 premiers caractères de la description": a suffix
 * would make the rendered label a different string from the description prefix it claims to be,
 * and it consumed three of the characters it was supposed to show. Visual shortening stays where
 * it belongs — contextual CSS line clamps in the consuming components.
 */
export const MAX_DESCRIPTION_FALLBACK_LENGTH = 220;

/**
 * The minimal task shape this projection reads.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * Fields are optional so partial rows (search hits, dependency pickers, mention results, agent
 * assignment summaries) can reach the same precedence without being widened to a full `Task`.
 */
export type TaskTitleDisplayInput =
  | Pick<Task, "id" | "title" | "description">
  | { id: string; title?: string | null; description?: string | null };

/**
 * Selects a display-only card label without changing the authoritative task data.
 *
 * FNXC:TaskTitleDisplay 2026-08-19-15:22:
 * FN-044 renders an ordinary titleless FN-036 task from its description only after a nonblank
 * persisted title has been ruled out. This UI seam must not restore an AI length policy or persist
 * a fallback title.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * FN-391 makes this the ONE projection every task label goes through: card, list row (desktop and
 * mobile), search result, dependency picker, mention result, agent/mission/research/dev-server
 * selectors. Precedence is fixed:
 *   1. a non-blank stored title, rendered IN FULL (never truncated here — an explicit title is the
 *      operator's own words and clamping it belongs to the component's geometry);
 *   2. otherwise the first {@link MAX_DESCRIPTION_FALLBACK_LENGTH} characters of the description,
 *      exactly;
 *   3. otherwise the task ID, so two tasks sharing one description are still distinguishable.
 * `fullText` carries the untruncated source for tooltips; `isBoundedDescription` is true only when
 * a description was actually longer than the bound. Nothing here is ever persisted.
 */
export function getTaskTitleDisplay(task: TaskTitleDisplayInput): TaskTitleDisplay {
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
        ? task.description.slice(0, MAX_DESCRIPTION_FALLBACK_LENGTH)
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

/**
 * Convenience label accessor for surfaces that only need the rendered string.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * Exists so a picker/mention/search row can replace a `task.title || task.description || task.id`
 * expression with one call, instead of destructuring `.text` at a dozen call sites.
 */
export function getTaskTitleDisplayText(task: TaskTitleDisplayInput): string {
  return getTaskTitleDisplay(task).text;
}
