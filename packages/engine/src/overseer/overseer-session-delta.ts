/**
 * FNXC:PlannerOversight 2026-07-13-22:50:
 * Render agent-log entries into a compact markdown batch for the session
 * advisor (OMP AdvisorRuntime delta parity). Filters previously injected
 * advisory/overseer steering lines so the advisor does not recursively
 * review its own advice. Pure, never throws.
 */

/** Minimal agent-log entry shape the delta renderer needs. */
export interface OverseerLogEntry {
  type?: string;
  text?: string;
  detail?: string;
  agent?: string;
  timestamp?: string | number;
}

const ADVISORY_MARKERS = [
  "[planner-oversight]",
  "[session-advisor]",
  "<advisory",
  "severity=\"nit\"",
  "severity=\"concern\"",
  "severity=\"blocker\"",
];

/** Mirrors the agent-log reader's per-detail preview bound without coupling the two prompt modules. */
export const OVERSEER_LOG_DETAIL_PREVIEW_MAX = 600;
/** Maximum render size passed into one session-advisor update. */
export const OVERSEER_SESSION_DELTA_MAX_CHARS = 12_000;

function truncateDetailPreview(detail: string): string {
  if (detail.length <= OVERSEER_LOG_DETAIL_PREVIEW_MAX) return detail;

  let kept = OVERSEER_LOG_DETAIL_PREVIEW_MAX;
  let marker = "";
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const omitted = detail.length - kept;
    marker = `… [${omitted} characters omitted]`;
    const nextKept = Math.max(0, OVERSEER_LOG_DETAIL_PREVIEW_MAX - marker.length);
    if (nextKept === kept) break;
    kept = nextKept;
  }
  return `${detail.slice(0, kept)}${marker}`;
}

function truncateSessionDelta(value: string): string {
  if (value.length <= OVERSEER_SESSION_DELTA_MAX_CHARS) return value;
  const marker = "\n\n… [session update truncated]";
  return `${value.slice(0, Math.max(0, OVERSEER_SESSION_DELTA_MAX_CHARS - marker.length))}${marker}`;
}

/**
 * True when a log line looks like prior overseer/advisor inject content
 * that should be excluded from the next advisor delta.
 */
export function isOverseerSelfAdvisoryText(text: string): boolean {
  const lower = text.toLowerCase();
  return ADVISORY_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/*
FNXC:PlannerOversight 2026-08-29-05:17:
FN-253 makes tool detail default-persisted, but this renderer feeds an advisor LLM prompt. Mirror the
agent-reader's 600-character detail preview and 12,000-character batch bound without changing the
80-row feed ceiling. Tool arguments are not advisory recursion vectors, so marker filtering scans only
the tool name for tool rows while text/thinking rows retain the existing combined-content filter.
*/
export function formatOverseerSessionDelta(entries: ReadonlyArray<OverseerLogEntry>): string | null {
  try {
    if (!entries || entries.length === 0) return null;

    const lines: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const type = typeof entry.type === "string" && entry.type ? entry.type : "text";
      const text = typeof entry.text === "string" ? entry.text : "";
      const detail = typeof entry.detail === "string" ? truncateDetailPreview(entry.detail) : "";
      const combined = [text, detail].filter(Boolean).join("\n");
      if (!combined.trim()) continue;
      const isToolRow = type === "tool" || type === "tool_result" || type === "tool_error";
      if (isOverseerSelfAdvisoryText(isToolRow ? text : combined)) continue;
      if (entry.agent === "overseer" || entry.agent === "advisor") continue;

      const agent = typeof entry.agent === "string" && entry.agent ? entry.agent : "agent";
      lines.push(`#### ${agent} · ${type}\n\n${combined.trim()}`);
    }

    if (lines.length === 0) return null;
    return truncateSessionDelta(`### Session update\n\n${lines.join("\n\n")}`);
  } catch {
    return null;
  }
}
