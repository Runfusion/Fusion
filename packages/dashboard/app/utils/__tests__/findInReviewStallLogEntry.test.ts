import type { TaskLogEntry } from "@fusion/core";
import { describe, expect, it } from "vitest";

import { findInReviewStallLogEntry } from "../findInReviewStallLogEntry";

function makeEntry(action: string, timestamp = "2026-05-13T00:00:00.000Z"): TaskLogEntry {
  return { action, timestamp };
}

describe("findInReviewStallLogEntry", () => {
  it("returns undefined for empty logs", () => {
    expect(findInReviewStallLogEntry({ log: [] }, "merge-blocker")).toBeUndefined();
  });

  it("returns undefined when no entries match", () => {
    expect(
      findInReviewStallLogEntry(
        { log: [makeEntry("Something else happened"), makeEntry("Merge retries started")] },
        "merge-blocker",
      ),
    ).toBeUndefined();
  });

  it("returns single match as newest entry with reversedIndex 0", () => {
    const entry = makeEntry("In-review stall surfaced [merge-blocker]: blocked");
    const result = findInReviewStallLogEntry({ log: [entry] }, "merge-blocker");

    expect(result?.entry).toBe(entry);
    expect(result?.reversedIndex).toBe(0);
    expect(result?.code).toBe("merge-blocker");
  });

  it("returns the most recent matching code", () => {
    const older = makeEntry("In-review stall surfaced [merge-blocker]: older");
    const otherCode = makeEntry("In-review stall surfaced [merge-retries-exhausted]: other");
    const newest = makeEntry("In-review stall surfaced [merge-blocker]: newest");

    const result = findInReviewStallLogEntry({ log: [older, otherCode, newest] }, "merge-blocker");

    expect(result?.entry.action).toContain("newest");
    expect(result?.reversedIndex).toBe(0);
  });

  it("returns undefined when code does not match", () => {
    expect(
      findInReviewStallLogEntry(
        { log: [makeEntry("In-review stall surfaced [merge-retries-exhausted]: exhausted")] },
        "merge-blocker",
      ),
    ).toBeUndefined();
  });

  it("is case-sensitive for the canonical prefix", () => {
    expect(
      findInReviewStallLogEntry(
        { log: [makeEntry("in-review stall surfaced [merge-blocker]: lower")] },
        "merge-blocker",
      ),
    ).toBeUndefined();
  });
});
