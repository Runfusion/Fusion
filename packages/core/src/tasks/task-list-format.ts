export const MAX_TASK_LIST_TEXT_CHARS = 3_000;

const TRUNCATION_HINT = "truncated to fit; narrow with column/limit";

function markerLine(droppedCount: number): string {
  return `... and ${droppedCount} more tasks (${TRUNCATION_HINT})`;
}

function joinWithMarker(lines: string[], marker: string): string {
  return [...lines, marker].join("\n");
}

/**
 * FNXC:TaskListOutput 2026-06-16-17:45:
 * FN-6492 requires every fn_task_list surface to emit bounded plain text so column-filtered or otherwise large board listings remain readable to text-only heartbeat agents and stay below host runtimes' imageification thresholds.
 * The default budget is intentionally below common MCP attachment-conversion limits while preserving dozens of compact task rows.
 *
 * FNXC:TaskListOutput 2026-06-18-03:12:
 * FN-6629 lowers the budget from 12,000 because realistic column-filtered heartbeat listings stayed under that old clamp while still exceeding the host imageification threshold. Keep the bound in the low-thousands so todo/triage/done limit-50 outputs remain text-only for heartbeat and other text agents.
 */
export function clampTaskListText(
  lines: string[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? MAX_TASK_LIST_TEXT_CHARS));
  const text = lines.join("\n");
  if (text.length <= maxChars) {
    return text;
  }

  const droppedTotal = lines.length;
  let kept = lines.slice();
  while (kept.length > 0) {
    const droppedCount = droppedTotal - kept.length;
    const candidate = joinWithMarker(kept, markerLine(droppedCount));
    if (candidate.length <= maxChars) {
      return candidate;
    }
    kept = kept.slice(0, -1);
  }

  const marker = markerLine(droppedTotal);
  if (marker.length <= maxChars) {
    return marker;
  }

  return marker.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function fallbackClampTaskListText(lines: string[], maxChars: number): string {
  const text = lines.join("\n");
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}

/**
 * FNXC:TaskListOutput 2026-06-17-05:44:
 * FN-6570 requires fn_task_list tool surfaces to resolve the formatter defensively because stale or mismatched @fusion/core builds can omit the clampTaskListText export and crash ambient heartbeat agents as `(0 , _core.clampTaskListText) is not a function`.
 * Keep the canonical clamp as the normal path, but degrade to a bounded inline fallback so board listing tools return text instead of throwing.
 */
export function formatTaskListText(
  lines: string[],
  opts: {
    maxChars?: number;
    clamp?: (lines: string[], opts?: { maxChars?: number }) => string;
  } = {},
): string {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? MAX_TASK_LIST_TEXT_CHARS));
  const clamp = opts.clamp ?? clampTaskListText;
  if (typeof clamp !== "function") {
    return fallbackClampTaskListText(lines, maxChars);
  }

  try {
    const text = clamp(lines, { maxChars });
    return typeof text === "string" ? text : fallbackClampTaskListText(lines, maxChars);
  } catch {
    return fallbackClampTaskListText(lines, maxChars);
  }
}
