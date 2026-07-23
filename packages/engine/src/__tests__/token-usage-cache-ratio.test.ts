import { describe, it, expect } from "vitest";
import { computeCacheHitRatio } from "../execution/session-token-usage.js";

describe("computeCacheHitRatio", () => {
  it("returns 0 when no tokens used", () => {
    expect(computeCacheHitRatio(0, 0)).toBe(0);
  });

  it("returns 0 when no cached tokens", () => {
    expect(computeCacheHitRatio(1000, 0)).toBe(0);
  });

  it("returns ratio of cached to total input", () => {
    expect(computeCacheHitRatio(500, 500)).toBeCloseTo(0.5);
  });

  it("returns close to 1 when mostly cached", () => {
    expect(computeCacheHitRatio(100, 9900)).toBeCloseTo(0.99);
  });
});
