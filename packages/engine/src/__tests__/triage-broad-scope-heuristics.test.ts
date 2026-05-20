import { describe, expect, it } from "vitest";

import {
  BROAD_SCOPE_FLAG_VERSION,
  decideBroadScopeFlag,
  extractBroadScopeSignals,
} from "../triage-broad-scope-heuristics.js";

describe("triage broad-scope heuristics", () => {
  describe("extractBroadScopeSignals", () => {
    it("uses the largest matching multi-digit failing-file mention", () => {
      const signals = extractBroadScopeSignals({
        size: "M",
        stepCount: 5,
        fileScopeCount: 4,
        descriptionText: "Touches 12 failing files, 30 broken tests, and 21 files overall. Ignore 7 failing files.",
      });

      expect(signals).toMatchObject({
        size: "M",
        stepCount: 5,
        fileScopeCount: 4,
        failingFileMentions: 30,
      });
    });

    it("caps pathological counts at 9999", () => {
      const signals = extractBroadScopeSignals({
        size: "L",
        stepCount: 14,
        fileScopeCount: 24,
        descriptionText: "Spec mentions 12345 failing files across 200 broken tests.",
      });

      expect(signals.failingFileMentions).toBe(9999);
    });

    it("returns zero when there are no qualifying mentions", () => {
      const signals = extractBroadScopeSignals({
        size: "S",
        stepCount: 2,
        fileScopeCount: 1,
        descriptionText: "Only 9 failing files are listed, plus one broken test.",
      });

      expect(signals.failingFileMentions).toBe(0);
    });
  });

  describe("decideBroadScopeFlag", () => {
    it("does not flag small low-scope tasks", () => {
      const decision = decideBroadScopeFlag({
        size: "S",
        stepCount: 4,
        fileScopeCount: 3,
        failingFileMentions: 0,
      });

      expect(decision.flagged).toBe(false);
      expect(decision.score).toBe(0);
      expect(decision.reasons).toEqual([]);
    });

    it("does not flag size L alone", () => {
      const decision = decideBroadScopeFlag({
        size: "L",
        stepCount: 4,
        fileScopeCount: 3,
        failingFileMentions: 0,
      });

      expect(decision.flagged).toBe(false);
      expect(decision.score).toBe(2);
      expect(decision.reasons).toEqual(["size-l"]);
    });

    it("flags size L tasks with many steps", () => {
      const decision = decideBroadScopeFlag({
        size: "L",
        stepCount: 12,
        fileScopeCount: 3,
        failingFileMentions: 0,
      });

      expect(decision.flagged).toBe(true);
      expect(decision.score).toBe(5);
      expect(decision.reasons).toEqual(["size-l", "steps-high", "size-l-with-many-steps"]);
    });

    it("does not flag high file scope alone", () => {
      const decision = decideBroadScopeFlag({
        size: "M",
        stepCount: 5,
        fileScopeCount: 21,
        failingFileMentions: 0,
      });

      expect(decision.flagged).toBe(false);
      expect(decision.score).toBe(2);
      expect(decision.reasons).toEqual(["file-scope-high"]);
    });

    it("flags when multiple strong signals combine", () => {
      const decision = decideBroadScopeFlag({
        size: "M",
        stepCount: 5,
        fileScopeCount: 21,
        failingFileMentions: 30,
      });

      expect(decision.flagged).toBe(true);
      expect(decision.score).toBe(4);
      expect(decision.reasons).toEqual(["file-scope-high", "failing-file-mentions-high"]);
    });
  });

  it("exports the initial heuristic version", () => {
    expect(BROAD_SCOPE_FLAG_VERSION).toBe(1);
  });
});
