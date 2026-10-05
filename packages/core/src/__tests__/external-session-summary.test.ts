import { describe, expect, it } from "vitest";
import { boundSummary, summaryInput, summaryState, SUMMARY_INPUT_LIMIT, SUMMARY_OUTPUT_LIMIT } from "../external-sessions/summary.js";
import type { ExternalSessionTurn } from "../external-sessions/turn-contract.js";

/*
FNXC:ExternalSessionSummary 2026-09-24-07:05 (F3 = A): the bounded-input and derived-staleness rules, which are
what keep a summary honest. A summary that does not say what it covered, or that claims currency after the
session moved on, is worse than none.
*/
function turn(ordinal: number, prompt: string, response: string | null = "did the thing"): ExternalSessionTurn {
  return {
    schemaVersion: 1, nativeTurnId: `t${ordinal}`, revision: 1, ordinal,
    startedAt: "2026-09-24T00:00:00.000Z", endedAt: "2026-09-24T00:01:00.000Z",
    prompts: [{ at: "2026-09-24T00:00:00.000Z", text: prompt }], response,
    fileChanges: [], usageComplete: true,
  } as unknown as ExternalSessionTurn;
}

describe("external session summary input", () => {
  it("returns nothing to summarize rather than prompting a model with an empty transcript", () => {
    expect(summaryInput([])).toBeNull();
  });

  it("reports the coverage it actually read, oldest turn first", () => {
    const built = summaryInput([turn(2, "third"), turn(0, "first"), turn(1, "second")]);
    expect(built?.coverage).toEqual({ throughOrdinal: 2, turnCount: 3 });
    expect(built!.text.indexOf("first")).toBeLessThan(built!.text.indexOf("third"));
    expect(built!.text).toContain("Turn 1");
  });

  it("bounds the prompt by dropping the OLDEST turns and says so through coverage", () => {
    const wide = Array.from({ length: 30 }, (_, i) => turn(i, "x".repeat(2000), "y".repeat(2000)));
    const built = summaryInput(wide)!;
    expect(built.text.length).toBeLessThanOrEqual(SUMMARY_INPUT_LIMIT);
    // The tail is kept: the newest turn is still the one the summary covers through.
    expect(built.coverage.throughOrdinal).toBe(29);
    expect(built.coverage.turnCount).toBeLessThan(30);
    expect(built.text).toContain(`Turn ${30}`);
  });

  it("marks a missing prompt or response explicitly instead of dropping the turn", () => {
    const built = summaryInput([turn(0, "", null)])!;
    expect(built.text).toContain("(no prompt recorded)");
    expect(built.text).toContain("(no response recorded)");
  });

  it("bounds the stored summary", () => {
    expect(boundSummary(` ${"a".repeat(SUMMARY_OUTPUT_LIMIT + 500)} `)).toHaveLength(SUMMARY_OUTPUT_LIMIT);
    expect(boundSummary("  short  ")).toBe("short");
  });
});

describe("external session summary staleness", () => {
  const record = (throughOrdinal: number | null) => ({
    sessionId: "s", summary: "text", provider: null, model: null, throughOrdinal, turnCount: 1,
    generatedAt: "2026-09-24T00:00:00.000Z", status: "ready" as const, failure: null, attemptedAt: "2026-09-24T00:00:00.000Z",
  });

  it("is stale exactly when the session advanced past what the summary covered", () => {
    expect(summaryState(record(2), 5)).toEqual({ stale: true, turnsSince: 3 });
    expect(summaryState(record(5), 5)).toEqual({ stale: false, turnsSince: 0 });
  });

  it("never claims staleness it cannot prove", () => {
    expect(summaryState(null, 5).stale).toBe(false);
    expect(summaryState(record(null), 5).stale).toBe(false);
    expect(summaryState(record(2), null).stale).toBe(false);
  });
});
