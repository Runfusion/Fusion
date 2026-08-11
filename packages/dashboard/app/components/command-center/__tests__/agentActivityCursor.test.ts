import { describe, expect, it } from "vitest";
import type { AgentActivityEvent, AgentActivityPage } from "../../../api";
import { AGENT_ACTIVITY_PAGE_SIZE, MAX_CONSECUTIVE_NO_PROGRESS_PAGES, compareAgentActivityDesc, cursorToQuery, isStrictlyOlderCursor, isTruncationFrame, mergeAgentActivity, resolvePageOutcome } from "../agentActivityCursor";

const event = (seq: string, eventId = `event-${seq}`): AgentActivityEvent => ({ seq, eventId, projectId: "p", agentId: "a", agentAttribution: "agent", taskId: null, type: "task:started", fromAgentId: null, toAgentId: null, summary: eventId, occurredAt: "2026-01-01T00:00:00.000Z", metadata: null });
const page = (events: AgentActivityEvent[], nextCursor: string | null): AgentActivityPage => ({ events, nextCursor });

describe("agent activity cursor", () => {
  it("sorts decimal sequences without number precision loss", () => {
    expect([event("2"), event("9007199254740993"), event("10")].sort(compareAgentActivityDesc).map((row) => row.seq)).toEqual(["9007199254740993", "10", "2"]);
  });
  it("dedupes incoming rows without mutating inputs and preserves sorted out-of-order rows", () => {
    const held = [event("9", "same"), event("5")]; const incoming = [event("7"), { ...event("10", "same"), summary: "new" }];
    const merged = mergeAgentActivity(held, incoming);
    expect(merged.map((row) => row.seq)).toEqual(["10", "7", "5"]); expect(merged[0]?.summary).toBe("new"); expect(held.map((row) => row.seq)).toEqual(["9", "5"]); expect(incoming.map((row) => row.seq)).toEqual(["7", "10"]);
  });
  it("encodes cursor predicates and recognizes truncation frames", () => {
    expect(isStrictlyOlderCursor("5", null)).toBe(true); expect(isStrictlyOlderCursor("5", "5")).toBe(false); expect(isStrictlyOlderCursor("6", "5")).toBe(false); expect(isStrictlyOlderCursor("4", "5")).toBe(true);
    expect(cursorToQuery(null)).toEqual({}); expect(cursorToQuery("5")).toEqual({ before: "5" });
    expect(isTruncationFrame({ truncated: true, fromSeq: "1", toSeq: "2" })).toBe(true); expect(isTruncationFrame(event("1"))).toBe(false); expect(isTruncationFrame(null)).toBe(false); expect(isTruncationFrame("bad")).toBe(false);
  });
  it("ends on a null cursor while retaining fetched rows", () => {
    const outcome = resolvePageOutcome({ requestedCursor: "10", existing: [event("10")], page: page([event("9")], null), consecutiveNoProgress: 2 });
    expect(outcome).toMatchObject({ nextCursor: null, hasMore: false, reason: "end-of-history", consecutiveNoProgress: 0 }); expect(outcome.merged.map((row) => row.seq)).toEqual(["10", "9"]);
  });
  it("keeps a retryable no-progress outcome", () => {
    expect(resolvePageOutcome({ requestedCursor: "10", existing: [event("9")], page: page([event("9")], "8"), consecutiveNoProgress: 0 })).toMatchObject({ nextCursor: "8", hasMore: true, reason: "no-progress", consecutiveNoProgress: 1 });
  });
  it("keeps a retryable cursor rewind outcome", () => {
    expect(resolvePageOutcome({ requestedCursor: "10", existing: [], page: page([event("9")], "10"), consecutiveNoProgress: 0 })).toMatchObject({ nextCursor: "10", hasMore: true, reason: "cursor-rewind", consecutiveNoProgress: 1 });
  });
  it("caps repeated non-advancing responses", () => {
    const outcome = resolvePageOutcome({ requestedCursor: "10", existing: [event("9")], page: page([event("9")], "8"), consecutiveNoProgress: MAX_CONSECUTIVE_NO_PROGRESS_PAGES - 1 });
    expect(outcome).toMatchObject({ nextCursor: "10", hasMore: false, reason: "attempt-cap", consecutiveNoProgress: MAX_CONSECUTIVE_NO_PROGRESS_PAGES });
  });
  it("advances an exact page and resets progress", () => {
    expect(resolvePageOutcome({ requestedCursor: "10", existing: [], page: page([event("9")], "9"), consecutiveNoProgress: 2 })).toMatchObject({ nextCursor: "9", hasMore: true, reason: null, consecutiveNoProgress: 0 });
  });
  it("walks pages once each and caps a stalled server", () => {
    let held: AgentActivityEvent[] = []; let cursor: string | null = null; let progress = 0;
    for (const response of [page([event("3"), event("2")], "2"), page([event("1")], null)]) { const result = resolvePageOutcome({ requestedCursor: cursor, existing: held, page: response, consecutiveNoProgress: progress }); held = result.merged; cursor = result.nextCursor; progress = result.consecutiveNoProgress; }
    expect(held.map((row) => row.eventId)).toEqual(["event-3", "event-2", "event-1"]); expect(cursor).toBeNull();
    let stalled = resolvePageOutcome({ requestedCursor: "10", existing: [event("9")], page: page([event("9")], "8"), consecutiveNoProgress: 0 });
    while (stalled.hasMore) stalled = resolvePageOutcome({ requestedCursor: stalled.nextCursor, existing: stalled.merged, page: page([event("9")], "8"), consecutiveNoProgress: stalled.consecutiveNoProgress });
    expect(stalled.reason).toBe("attempt-cap"); expect(AGENT_ACTIVITY_PAGE_SIZE).toBeLessThanOrEqual(1000);
  });
});
