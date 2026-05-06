import { describe, expect, it } from "vitest";
import {
  computeCategoryFinalScore,
  computeOverallScore,
  normalizeCategoryScore,
  resolveScoreBand,
} from "../eval-scoring.js";

describe("eval-scoring", () => {
  it("resolves score bands at boundaries", () => {
    expect(resolveScoreBand(39)).toBe("failing");
    expect(resolveScoreBand(40)).toBe("weak");
    expect(resolveScoreBand(59)).toBe("weak");
    expect(resolveScoreBand(60)).toBe("acceptable");
    expect(resolveScoreBand(74)).toBe("acceptable");
    expect(resolveScoreBand(75)).toBe("strong");
    expect(resolveScoreBand(89)).toBe("strong");
    expect(resolveScoreBand(90)).toBe("excellent");
    expect(resolveScoreBand(100)).toBe("excellent");
  });

  it("computes deterministic/AI blend with canonical 70/30 rule", () => {
    expect(computeCategoryFinalScore(0, 100)).toBe(30);
    expect(computeCategoryFinalScore(100, 0)).toBe(70);
    expect(computeCategoryFinalScore(73, 89)).toBe(78);
  });

  it("computes overall weighted score with canonical category weights", () => {
    const categories = [
      normalizeCategoryScore({
        category: "agentPerformance",
        deterministicScore: 80,
        aiScore: 80,
        rationale: "solid execution",
        evidence: [],
      }),
      normalizeCategoryScore({
        category: "taskOutcomeQuality",
        deterministicScore: 90,
        aiScore: 90,
        rationale: "high quality",
        evidence: [],
      }),
      normalizeCategoryScore({
        category: "processCompliance",
        deterministicScore: 70,
        aiScore: 70,
        rationale: "mostly compliant",
        evidence: [],
      }),
    ];

    expect(computeOverallScore(categories)).toBe(82);
  });

  it("rejects invalid input scores", () => {
    expect(() => computeCategoryFinalScore(-1, 50)).toThrow(/deterministicScore/);
    expect(() => computeCategoryFinalScore(50, 101)).toThrow(/aiScore/);
    expect(() => resolveScoreBand(101)).toThrow(/integer between/);
  });
});
