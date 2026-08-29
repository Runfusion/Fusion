import { afterEach, describe, expect, it } from "vitest";
import { clearActivityTraceForTests, recordActivity, snapshotActivityTrace } from "../activity-trace.js";

afterEach(clearActivityTraceForTests);

describe("activity trace", () => {
  it("keeps the newest twenty entries", () => {
    for (let index = 0; index < 25; index++) recordActivity({ ts: String(index), kind: "view", label: `view ${index}` });
    const trace = snapshotActivityTrace();
    expect(trace).toHaveLength(20);
    expect(trace[0]?.ts).toBe("5");
  });

  it("evicts old entries when the text budget is exceeded", () => {
    for (let index = 0; index < 10; index++) recordActivity({ kind: "action", label: String(index).repeat(900) });
    const trace = snapshotActivityTrace();
    expect(trace.reduce((total, entry) => total + entry.ts.length + entry.kind.length + entry.label.length, 0)).toBeLessThanOrEqual(4000);
  });

  /*
   * FNXC:ReportPipeline 2026-07-19-20:45:
   * The client trace is a bounded chronological ring buffer, not a sanitizer.
   * Report-route egress tests own privacy scrubbing of arbitrary local labels.
   */
  it("truncates fields while preserving raw labels and oldest-to-newest order", () => {
    const rawLabel = "/Users/alice/private-project ghp_abcdefghijk1234567890";
    recordActivity({ ts: "t".repeat(100), kind: "k".repeat(100), label: rawLabel.repeat(30) });
    for (let index = 0; index < 20; index++) recordActivity({ ts: String(index), kind: "view", label: `later ${index}` });

    const trace = snapshotActivityTrace();
    expect(trace).toHaveLength(20);
    expect(trace[0]).toMatchObject({ ts: "0", label: "later 0" });
    expect(trace.at(-1)).toMatchObject({ ts: "19", label: "later 19" });

    clearActivityTraceForTests();
    recordActivity({ ts: "t".repeat(100), kind: "k".repeat(100), label: rawLabel.repeat(30) });
    const [entry] = snapshotActivityTrace();
    expect(entry?.ts).toHaveLength(64);
    expect(entry?.kind).toHaveLength(80);
    expect(entry?.label).toHaveLength(1000);
    expect(entry?.label).toContain("/Users/alice/private-project");
  });

  it("returns an empty snapshot safely and never exposes mutable stored entries", () => {
    expect(snapshotActivityTrace()).toEqual([]);
    recordActivity({ kind: "navigation", label: "Projects" });
    const snapshot = snapshotActivityTrace();
    snapshot[0]!.label = "mutated outside the buffer";
    expect(snapshotActivityTrace()[0]?.label).toBe("Projects");
  });
});
