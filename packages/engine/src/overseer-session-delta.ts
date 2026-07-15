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

/**
 * True when a log line looks like prior overseer/advisor inject content
 * that should be excluded from the next advisor delta.
 */
export function isOverseerSelfAdvisoryText(text: string): boolean {
  const lower = text.toLowerCase();
  return ADVISORY_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Render a slice of agent-log entries as a session-update markdown block.
 * Returns null when the slice is empty after filtering.
 */
export function formatOverseerSessionDelta(entries: ReadonlyArray<OverseerLogEntry>): string | null {
  try {
    if (!entries || entries.length === 0) return null;

    const lines: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const text = typeof entry.text === "string" ? entry.text : "";
      const detail = typeof entry.detail === "string" ? entry.detail : "";
      const combined = [text, detail].filter(Boolean).join("\n");
      if (!combined.trim()) continue;
      if (isOverseerSelfAdvisoryText(combined)) continue;
      if (entry.agent === "overseer" || entry.agent === "advisor") continue;

      const type = typeof entry.type === "string" && entry.type ? entry.type : "text";
      const agent = typeof entry.agent === "string" && entry.agent ? entry.agent : "agent";
      lines.push(`#### ${agent} · ${type}\n\n${combined.trim()}`);
    }

    if (lines.length === 0) return null;
    return `### Session update\n\n${lines.join("\n\n")}`;
  } catch {
    return null;
  }
}
