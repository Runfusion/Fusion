import type { AgentActivityEvent, AgentActivityPage } from "../../api";

/*
FNXC:CommandCenterAgentActivity 2026-08-10-01:13:
The agent-activity route orders unique per-project `seq` values descending and applies `before` exclusively,
returning `{ events, nextCursor }`. Echoing that cursor is therefore exact: offset and timestamp tiebreakers
would only weaken this total order. Sequences are decimal strings and may exceed Number's safe range, so all
ordering uses BigInt. The no-progress counter is only a bounded backstop for a regressed server contract.
*/

/** Bounded page size sent as `limit`; must stay <= the server hard max of 1000. */
export const AGENT_ACTIVITY_PAGE_SIZE = 50;
/** Bounded retry backstop for a server whose cursor does not advance. */
export const MAX_CONSECUTIVE_NO_PROGRESS_PAGES = 3;

export type PageExhaustionReason = "end-of-history" | "no-progress" | "cursor-rewind" | "attempt-cap";

export interface ResolvePageInput {
  requestedCursor: string | null;
  existing: readonly AgentActivityEvent[];
  page: AgentActivityPage;
  consecutiveNoProgress: number;
}

export interface ResolvePageOutcome {
  merged: AgentActivityEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  reason: PageExhaustionReason | null;
  consecutiveNoProgress: number;
}

/** Numeric-safe descending compare on decimal `seq` strings. */
export function compareAgentActivityDesc(a: AgentActivityEvent, b: AgentActivityEvent): number {
  const left = BigInt(a.seq);
  const right = BigInt(b.seq);
  return left === right ? 0 : left > right ? -1 : 1;
}

/** eventId-keyed dedupe where the newest incoming representation wins. */
export function mergeAgentActivity(existing: readonly AgentActivityEvent[], incoming: readonly AgentActivityEvent[]): AgentActivityEvent[] {
  const rows = new Map<string, AgentActivityEvent>();
  for (const event of existing) rows.set(event.eventId, event);
  for (const event of incoming) rows.set(event.eventId, event);
  return [...rows.values()].sort(compareAgentActivityDesc);
}

export function isStrictlyOlderCursor(candidate: string, requested: string | null): boolean {
  return requested === null || BigInt(candidate) < BigInt(requested);
}

/** The sole owner of the HTTP continuation parameter name. */
export function cursorToQuery(cursor: string | null): Record<string, string> {
  return cursor === null ? {} : { before: cursor };
}

export function isTruncationFrame(frame: unknown): frame is { truncated: true; fromSeq: string; toSeq: string } {
  return typeof frame === "object" && frame !== null && (frame as { truncated?: unknown }).truncated === true;
}

export function resolvePageOutcome(input: ResolvePageInput): ResolvePageOutcome {
  const { requestedCursor, existing, page, consecutiveNoProgress } = input;
  const merged = mergeAgentActivity(existing, page.events);
  const newRowCount = merged.length - existing.length;
  if (page.nextCursor === null) return { merged, nextCursor: null, hasMore: false, reason: "end-of-history", consecutiveNoProgress: 0 };

  const nextCount = consecutiveNoProgress + 1;
  const cursorAdvances = isStrictlyOlderCursor(page.nextCursor, requestedCursor);
  if ((newRowCount === 0 || !cursorAdvances) && nextCount >= MAX_CONSECUTIVE_NO_PROGRESS_PAGES) {
    return { merged, nextCursor: requestedCursor, hasMore: false, reason: "attempt-cap", consecutiveNoProgress: nextCount };
  }
  if (newRowCount === 0) return { merged, nextCursor: page.nextCursor, hasMore: true, reason: "no-progress", consecutiveNoProgress: nextCount };
  if (!cursorAdvances) return { merged, nextCursor: requestedCursor, hasMore: true, reason: "cursor-rewind", consecutiveNoProgress: nextCount };
  return { merged, nextCursor: page.nextCursor, hasMore: true, reason: null, consecutiveNoProgress: 0 };
}
