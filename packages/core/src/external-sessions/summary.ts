import { and, desc, eq, sql } from "drizzle-orm";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { externalSessionSummaries, externalSessionTurns } from "../postgres/schema/project.js";
import type { ExternalSessionTurn } from "./turn-contract.js";

/*
FNXC:ExternalSessionSummary 2026-09-24-07:05 (operator decision F3 = A):
AI summaries of a remote agent session, as a NEW Fusion capability. This is explicitly NOT AgentPulse parity:
the AgentPulse watcher ran 817 times and produced zero durable summary rows, so there is no prior behaviour to
reproduce — only a gap to fill (docs/agentpulse-used-feature-inventory.md).

Three properties make a summary trustworthy rather than decorative:

1. It says WHAT IT COVERED. Coverage is the turn range that went into it, stored with the text. Without it a
   summary of a since-continued session is indistinguishable from a current one.
2. Staleness is DERIVED, never stored. Comparing stored coverage against the session's turns now is correct at
   every instant; a stored flag is wrong from the moment the next turn is ingested until something rewrites it.
3. A failure never destroys the previous summary. During an inference outage the last good summary plus "this
   failed at T, for this reason" is strictly more useful than an empty pane.

Input and output are both bounded before they reach a model: a transcript is unbounded operator content, and an
unbounded prompt is both a cost and an availability problem.
*/

/** Turns read per summary. The tail is chosen over the head: recent work is what a reader is orienting on. */
export const SUMMARY_TURN_LIMIT = 40;
/** Characters kept from each turn's prompt and response before assembly. */
export const SUMMARY_TURN_EXCERPT = 1200;
/** Hard cap on the assembled prompt, applied after per-turn trimming. */
export const SUMMARY_INPUT_LIMIT = 24_000;
/** Hard cap on the stored summary, so a runaway response cannot bloat the row. */
export const SUMMARY_OUTPUT_LIMIT = 2000;

export interface SummaryCoverage {
  /** Highest turn ordinal that went into the summary. */
  throughOrdinal: number;
  /** How many turns went into it; lower than the session total when the tail bound applied. */
  turnCount: number;
}

export interface ExternalSessionSummaryRecord {
  sessionId: string;
  summary: string | null;
  provider: string | null;
  model: string | null;
  throughOrdinal: number | null;
  turnCount: number | null;
  generatedAt: string | null;
  status: "ready" | "failed";
  /** Bounded reason text; present only while the last attempt failed. */
  failure: string | null;
  attemptedAt: string;
}

/**
 * Derived state for a stored summary. `stale` means the session has advanced past what the summary covered —
 * the text is still accurate about what it read, so it is shown with the staleness rather than hidden.
 */
export interface SummaryState {
  stale: boolean;
  /** Turns ingested after the summary's coverage. */
  turnsSince: number;
}

export function summaryState(record: ExternalSessionSummaryRecord | null, latestOrdinal: number | null): SummaryState {
  if (!record || record.throughOrdinal === null || latestOrdinal === null) return { stale: false, turnsSince: 0 };
  const since = latestOrdinal - record.throughOrdinal;
  return since > 0 ? { stale: true, turnsSince: since } : { stale: false, turnsSince: 0 };
}

function excerpt(value: string, limit = SUMMARY_TURN_EXCERPT): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * Assemble the bounded model input from a session's turns, oldest first, plus the coverage it represents.
 * Returns null when there is nothing to summarize, so a caller never prompts a model with an empty transcript.
 */
export function summaryInput(turns: ExternalSessionTurn[]): { text: string; coverage: SummaryCoverage } | null {
  if (!turns.length) return null;
  const ordered = [...turns].sort((a, b) => a.ordinal - b.ordinal);
  const parts: string[] = [];
  for (const turn of ordered) {
    const prompt = turn.prompts.map(p => p.text).filter(Boolean).join("\n");
    const files = turn.fileChanges.map(change => change.path).slice(0, 20);
    const section = [
      `### Turn ${turn.ordinal + 1}`,
      prompt ? `Operator: ${excerpt(prompt)}` : "Operator: (no prompt recorded)",
      turn.response ? `Agent: ${excerpt(turn.response)}` : "Agent: (no response recorded)",
      files.length ? `Files touched: ${files.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    parts.push(section);
  }
  // Trim from the FRONT when over budget: the tail is the recent work a reader is orienting on.
  let text = parts.join("\n\n");
  let used = ordered;
  while (text.length > SUMMARY_INPUT_LIMIT && used.length > 1) {
    used = used.slice(1);
    parts.shift();
    text = parts.join("\n\n");
  }
  const last = used[used.length - 1]!;
  return { text: text.slice(0, SUMMARY_INPUT_LIMIT), coverage: { throughOrdinal: last.ordinal, turnCount: used.length } };
}

export function boundSummary(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > SUMMARY_OUTPUT_LIMIT ? trimmed.slice(0, SUMMARY_OUTPUT_LIMIT).trim() : trimmed;
}

/*
FNXC:ExternalSessionSummary 2026-09-24-07:05: The durable record. `recordFailure` deliberately writes only the
failure columns on an existing row, so an outage degrades the pane from "current summary" to "summary as of an
earlier point, plus why it has not advanced" rather than to nothing.
*/
export class ExternalSessionSummaryStore {
  constructor(private readonly layer: AsyncDataLayer, private readonly projectId: string) {
    if (layer.projectId !== projectId) throw new Error("External session summaries require matching project storage");
  }

  private scope(sessionId: string) {
    return and(eq(externalSessionSummaries.projectId, this.projectId), eq(externalSessionSummaries.sessionId, sessionId));
  }

  async read(sessionId: string): Promise<ExternalSessionSummaryRecord | null> {
    const [row] = await this.layer.db.select().from(externalSessionSummaries).where(this.scope(sessionId)).limit(1);
    if (!row) return null;
    return { sessionId: row.sessionId, summary: row.summary, provider: row.provider, model: row.model,
      throughOrdinal: row.throughOrdinal === null ? null : Number(row.throughOrdinal),
      turnCount: row.turnCount === null ? null : Number(row.turnCount),
      generatedAt: row.generatedAt, status: row.status, failure: row.failure, attemptedAt: row.attemptedAt };
  }

  /** Highest ordinal currently ingested for the session; null when it has no turns. */
  async latestOrdinal(sessionId: string): Promise<number | null> {
    const [row] = await this.layer.db.select({ ordinal: externalSessionTurns.ordinal }).from(externalSessionTurns)
      .where(and(eq(externalSessionTurns.projectId, this.projectId), eq(externalSessionTurns.sessionId, sessionId)))
      .orderBy(desc(externalSessionTurns.ordinal)).limit(1);
    return row ? Number(row.ordinal) : null;
  }

  /**
   * The most recent `limit` turns, oldest first. Read descending and reversed rather than paged forward: a
   * summary needs the tail, and paging a long session forward to reach it would be unbounded work.
   */
  async tail(sessionId: string, limit = SUMMARY_TURN_LIMIT): Promise<ExternalSessionTurn[]> {
    const rows = await this.layer.db.select({ turn: externalSessionTurns.turn }).from(externalSessionTurns)
      .where(and(eq(externalSessionTurns.projectId, this.projectId), eq(externalSessionTurns.sessionId, sessionId)))
      .orderBy(desc(externalSessionTurns.ordinal)).limit(Math.max(1, Math.min(limit, SUMMARY_TURN_LIMIT)));
    return rows.map(row => row.turn).reverse();
  }

  async recordSuccess(sessionId: string, input: { summary: string; provider: string | null; model: string | null;
    coverage: SummaryCoverage }, now = new Date().toISOString()): Promise<ExternalSessionSummaryRecord> {
    const values = { summary: boundSummary(input.summary), provider: input.provider, model: input.model,
      throughOrdinal: input.coverage.throughOrdinal, turnCount: input.coverage.turnCount,
      generatedAt: now, status: "ready" as const, failure: null, attemptedAt: now };
    await this.layer.db.insert(externalSessionSummaries).values({ projectId: this.projectId, sessionId, ...values })
      .onConflictDoUpdate({ target: [externalSessionSummaries.projectId, externalSessionSummaries.sessionId], set: values });
    return { sessionId, ...values };
  }

  /**
   * Record a failed attempt WITHOUT disturbing an existing summary. The insert path is the first-attempt case
   * only: it is the one moment where there is genuinely no previous summary to preserve.
   */
  async recordFailure(sessionId: string, reason: string, now = new Date().toISOString()): Promise<ExternalSessionSummaryRecord> {
    const failure = reason.trim().slice(0, 500) || "Summary generation failed";
    await this.layer.db.insert(externalSessionSummaries)
      .values({ projectId: this.projectId, sessionId, summary: null, provider: null, model: null,
        throughOrdinal: null, turnCount: null, generatedAt: null, status: "failed", failure, attemptedAt: now })
      .onConflictDoUpdate({ target: [externalSessionSummaries.projectId, externalSessionSummaries.sessionId],
        // Only the failure columns: summary, coverage, generatedAt and model stay as they were.
        set: { status: sql`'failed'`, failure, attemptedAt: now } });
    return (await this.read(sessionId))!;
  }
}
