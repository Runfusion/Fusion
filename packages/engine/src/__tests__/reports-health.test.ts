import { describe, expect, it } from "vitest";
import { classifyReportHealth, type ReportHealthInput } from "../reports-health.js";

const baseInput: ReportHealthInput = {
  state: "active",
  pauseReason: undefined,
  heartbeatAgeMs: 1_000,
  heartbeatTimeoutMs: 10_000,
  staleThresholdMs: 20_000,
  staleParkedAssignment: false,
};

describe("classifyReportHealth", () => {
  it.each(["paused", "active", "running", "idle"] as const)(
    "renders error-unrecoverable marker as operator-actionable for %s state",
    (state) => {
      const result = classifyReportHealth({ ...baseInput, state, pauseReason: "error-unrecoverable" });

      expect(result).toMatchObject({
        bucket: "operator-actionable",
        cellText: expect.stringContaining("needs operator repair"),
      });
      expect(result.cellText).not.toContain("healthy");
    },
  );

  it("tolerates a marker interleaved onto a resumed persisted row", () => {
    const persistedDesync = {
      state: "active",
      pauseReason: "error-unrecoverable",
    };

    expect(classifyReportHealth({ ...baseInput, ...persistedDesync }).bucket).toBe("operator-actionable");
  });

  it.each(["error-retry-exhausted", "heartbeat-model-unavailable"])(
    "renders %s marker as operator-actionable",
    (pauseReason) => {
      expect(classifyReportHealth({ ...baseInput, pauseReason }).bucket).toBe("operator-actionable");
    },
  );

  it.each(["user-requested", "awaiting-approval", "budget-exhausted"])(
    "renders non-operator marker %s as paused",
    (pauseReason) => {
      expect(classifyReportHealth({ ...baseInput, pauseReason })).toEqual({
        bucket: "paused",
        cellText: `paused (${pauseReason})`,
      });
    },
  );

  it("preserves existing state and freshness buckets when no marker exists", () => {
    expect(classifyReportHealth({ ...baseInput, state: "error" }).bucket).toBe("operator-actionable");
    expect(classifyReportHealth({ ...baseInput, staleParkedAssignment: true }).bucket).toBe("stale-assignment");
    expect(classifyReportHealth({ ...baseInput, state: "running", heartbeatAgeMs: 20_001 }).bucket).toBe("stuck");
    expect(classifyReportHealth({ ...baseInput, state: "active", heartbeatAgeMs: 20_001 }).bucket).toBe("stale");
    expect(classifyReportHealth({ ...baseInput, state: "idle", heartbeatAgeMs: 20_001 }).bucket).toBe("stale");
    expect(classifyReportHealth({ ...baseInput, state: "paused" })).toEqual({ bucket: "paused", cellText: "paused" });
    expect(classifyReportHealth({ ...baseInput, state: undefined })).toEqual({ bucket: "healthy", cellText: "healthy" });
  });

  it.each([undefined, "", "   "])("treats empty marker %j as unmarked", (pauseReason) => {
    expect(classifyReportHealth({ ...baseInput, pauseReason })).toEqual({ bucket: "healthy", cellText: "healthy" });
  });

  it("does not accept lastError as a classification input", () => {
    const withResidualError = { ...baseInput, lastError: "long residual diagnostic text" };
    const withoutResidualError = { ...baseInput };

    expect(classifyReportHealth(withResidualError)).toEqual(classifyReportHealth(withoutResidualError));
  });
});
