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
});
