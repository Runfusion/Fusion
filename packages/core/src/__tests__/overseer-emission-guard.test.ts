import { describe, expect, it } from "vitest";
import {
  normalizeOverseerAdviceNote,
  normalizeOverseerAdviceSeverity,
  overseerAdviceSeverityRank,
} from "../overseer-advice.js";
import { OverseerEmissionGuard } from "../overseer-emission-guard.js";

describe("normalizeOverseerAdviceNote", () => {
  it("folds case, punctuation, and whitespace into one key", () => {
    expect(normalizeOverseerAdviceNote("Stop.")).toBe("stop");
    expect(normalizeOverseerAdviceNote("*Stop*")).toBe("stop");
    expect(normalizeOverseerAdviceNote("  STOP  ")).toBe("stop");
    expect(normalizeOverseerAdviceNote("No issue; continue.")).toBe("no issue continue");
  });
});

describe("normalizeOverseerAdviceSeverity", () => {
  it("accepts known severities case-insensitively and rejects unknowns", () => {
    expect(normalizeOverseerAdviceSeverity("blocker")).toBe("blocker");
    expect(normalizeOverseerAdviceSeverity("CONCERN")).toBe("concern");
    expect(normalizeOverseerAdviceSeverity("nit")).toBe("nit");
    expect(normalizeOverseerAdviceSeverity("warn")).toBeUndefined();
    expect(normalizeOverseerAdviceSeverity(null)).toBeUndefined();
  });
});

describe("overseerAdviceSeverityRank", () => {
  it("ranks omitted severity as nit", () => {
    expect(overseerAdviceSeverityRank(undefined)).toBe(1);
    expect(overseerAdviceSeverityRank("nit")).toBe(1);
    expect(overseerAdviceSeverityRank("concern")).toBe(2);
    expect(overseerAdviceSeverityRank("blocker")).toBe(3);
  });
});

describe("OverseerEmissionGuard", () => {
  it("rejects empty and whitespace-only notes", () => {
    const guard = new OverseerEmissionGuard();
    expect(guard.accept("")).toBe(false);
    expect(guard.accept("   ")).toBe(false);
    expect(guard.accept({ note: "\n\t" })).toBe(false);
  });

  it("rejects content-free phrases after normalization", () => {
    const guard = new OverseerEmissionGuard();
    expect(guard.accept("Stop.")).toBe(false);
    expect(guard.accept("LGTM")).toBe(false);
    expect(guard.accept("no issue; continue.")).toBe(false);
    expect(guard.accept("nothing to add")).toBe(false);
  });

  it("accepts a concrete note once and rejects an equal-severity repeat", () => {
    const guard = new OverseerEmissionGuard();
    const note = "You are editing the wrong module; File Scope says packages/engine only.";
    expect(guard.accept({ note, severity: "concern" })).toBe(true);
    expect(guard.accept({ note, severity: "concern" })).toBe(false);
    expect(guard.accept({ note, severity: "nit" })).toBe(false);
  });

  it("allows the same note text when severity strictly escalates", () => {
    const guard = new OverseerEmissionGuard();
    const note = "Missing await on writeStream.end will drop buffered writes.";
    expect(guard.accept({ note, severity: "nit" })).toBe(true);
    // Per-update budget already consumed — need a new update cycle.
    guard.beginUpdate();
    expect(guard.accept({ note, severity: "concern" })).toBe(true);
    guard.beginUpdate();
    expect(guard.accept({ note, severity: "blocker" })).toBe(true);
    guard.beginUpdate();
    expect(guard.accept({ note, severity: "blocker" })).toBe(false);
  });

  it("allows only one accept per update cycle; noise does not burn the slot", () => {
    const guard = new OverseerEmissionGuard();
    expect(guard.accept("Stop.")).toBe(false);
    expect(
      guard.accept({
        note: "Parallelize the two independent test runs.",
        severity: "nit",
      }),
    ).toBe(true);
    expect(
      guard.accept({
        note: "Also extract the shared helper.",
        severity: "nit",
      }),
    ).toBe(false);
    guard.beginUpdate();
    expect(
      guard.accept({
        note: "Also extract the shared helper.",
        severity: "nit",
      }),
    ).toBe(true);
  });

  it("reset clears history so a prior note can re-fire", () => {
    const guard = new OverseerEmissionGuard();
    const note = "Re-check File Scope before editing dashboard.";
    expect(guard.accept({ note })).toBe(true);
    guard.reset();
    expect(guard.accept({ note })).toBe(true);
  });

  it("FIFO-evicts oldest keys when capacity is exceeded", () => {
    const guard = new OverseerEmissionGuard({ capacity: 2 });
    expect(guard.accept({ note: "alpha unique advice" })).toBe(true);
    guard.beginUpdate();
    expect(guard.accept({ note: "beta unique advice" })).toBe(true);
    guard.beginUpdate();
    expect(guard.accept({ note: "gamma unique advice" })).toBe(true);
    // alpha was evicted; may re-accept after a new update
    guard.beginUpdate();
    expect(guard.accept({ note: "alpha unique advice" })).toBe(true);
  });
});
