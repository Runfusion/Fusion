import { DEFAULT_MAX_CHARS_PER_LINE, DEFAULT_MAX_LINES_PER_CARD, formatRelativeAge, formatTaskId, statusBadge, truncateLine, wrapLines } from "./format.js";
import type { FusionTask, GlassesCard } from "./types.js";

export function taskToCard(task: FusionTask, opts?: { maxCharsPerLine?: number; maxLines?: number; now?: string }): GlassesCard {
  const maxCharsPerLine = opts?.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES_PER_CARD;
  const now = opts?.now ?? new Date().toISOString();
  const assignee = task.assignedAgentId ?? task.assigneeUserId ?? "unassigned";
  const body = [`Priority ${task.priority ?? "normal"}`, `Assignee ${assignee}`, `Age ${formatRelativeAge(task.createdAt, now)}`].join(" ");

  return {
    id: task.id,
    taskId: task.id,
    kind: "task",
    title: truncateLine(formatTaskId(task.id) + " " + (task.title?.trim() || task.description), maxCharsPerLine),
    lines: wrapLines(body, maxCharsPerLine, maxLines),
    badge: statusBadge(task.column),
    updatedAt: task.updatedAt,
  };
}
