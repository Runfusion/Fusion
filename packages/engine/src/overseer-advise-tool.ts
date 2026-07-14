/**
 * FNXC:PlannerOversight 2026-07-13-22:55:
 * Session-advisor `advise` tool contract (OMP AdviseTool parity). Accepts
 * one note + optional severity; applies severity-rank dedupe at the tool
 * layer, then forwards to the host callback. The host still runs
 * OverseerEmissionGuard before inject. Pure execute path for unit tests —
 * no pi tool registry dependency required for the controller to work.
 */

import {
  normalizeOverseerAdviceNote,
  overseerAdviceSeverityRank,
  type OverseerAdviceSeverity,
} from "@fusion/core";

export interface OverseerAdviseParams {
  note: string;
  severity?: OverseerAdviceSeverity;
}

export interface OverseerAdviseResult {
  recorded: boolean;
  message: string;
  details: { note: string; severity?: OverseerAdviceSeverity };
}

/**
 * In-memory advise recorder with OMP-style severity-rank dedupe on the tool
 * itself (defense in depth alongside OverseerEmissionGuard).
 */
export class OverseerAdviseRecorder {
  #deliveredNoteSeverities = new Map<string, number>();

  constructor(
    private readonly onAdvice: (note: string, severity?: OverseerAdviceSeverity) => void | Promise<void>,
  ) {}

  resetDeliveredNotes(): void {
    this.#deliveredNoteSeverities.clear();
  }

  async execute(args: OverseerAdviseParams): Promise<OverseerAdviseResult> {
    const note = typeof args?.note === "string" ? args.note : "";
    const severity = args?.severity;
    const key = normalizeOverseerAdviceNote(note) || note.trim().replace(/\s+/g, " ");
    const rank = overseerAdviceSeverityRank(severity);
    const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
    if (!key || rank <= previousRank) {
      return {
        recorded: false,
        message: "Duplicate advice ignored.",
        details: { note, severity },
      };
    }
    this.#deliveredNoteSeverities.set(key, rank);
    await this.onAdvice(note, severity);
    return {
      recorded: true,
      message: "Recorded.",
      details: { note, severity },
    };
  }
}

/**
 * Parse a free-form advisor model reply for a single ADVISE payload.
 * Accepts:
 * - ```json { "note": "...", "severity": "concern" } ```
 * - ADVISE: note text
 * - bare JSON object
 * Returns null for silence / unparseable content.
 */
export function parseAdvisorReplyForAdvice(text: string): OverseerAdviseParams | null {
  try {
    if (typeof text !== "string" || !text.trim()) return null;
    const trimmed = text.trim();

    // Fenced JSON
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonCandidate = fence?.[1]?.trim() ?? (trimmed.startsWith("{") ? trimmed : null);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate) as { note?: unknown; severity?: unknown; silence?: unknown };
        if (parsed.silence === true || parsed.note === null) return null;
        if (typeof parsed.note === "string" && parsed.note.trim()) {
          const severity =
            parsed.severity === "nit" || parsed.severity === "concern" || parsed.severity === "blocker"
              ? parsed.severity
              : undefined;
          return { note: parsed.note.trim(), severity };
        }
      } catch {
        /* fall through */
      }
    }

    const adviseLine = trimmed.match(/^ADVISE(?:\s*\((nit|concern|blocker)\))?\s*:\s*(.+)$/im);
    if (adviseLine?.[2]?.trim()) {
      const severity =
        adviseLine[1] === "nit" || adviseLine[1] === "concern" || adviseLine[1] === "blocker"
          ? adviseLine[1]
          : undefined;
      return { note: adviseLine[2].trim(), severity };
    }

    // Explicit silence tokens
    if (/^(silence|none|no advice|ok|lgtm)\.?$/i.test(trimmed)) return null;

    return null;
  } catch {
    return null;
  }
}

/** System-prompt fragment instructing the model how to reply. */
export const OVERSEER_ADVISOR_REPLY_CONTRACT = `You are a session advisor shadowing an executor agent on a Fusion task.
Prefer silence when the agent is on track.
When you must advise, reply with ONLY one JSON object:
{"note":"<one concrete, terse, actionable sentence>","severity":"nit"|"concern"|"blocker"}
Severity guide:
- nit: non-urgent cleanup or better approach
- concern: material risk or wrong direction
- blocker: continuing will clearly waste work or ship broken output
If you have nothing to add, reply with: {"silence":true}
Never restate errors already visible in the transcript.
Never say only "stop" or "done" without a concrete reason.`;
