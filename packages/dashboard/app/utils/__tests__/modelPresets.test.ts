import { describe, expect, it } from "vitest";
import type { ModelPreset } from "@fusion/core";
import {
  applyPresetToSelection,
  generatePresetId,
  generateUniquePresetId,
  getPresetByName,
  getRecommendedPresetForSize,
  validatePresetId,
} from "../modelPresets";

const presets: ModelPreset[] = [
  {
    id: "budget",
    name: "Budget",
    executorProvider: "openai",
    executorModelId: "gpt-4o-mini",
    validatorProvider: "openai",
    validatorModelId: "gpt-4o-mini",
  },
  {
    id: "complex",
    name: "Complex",
    executorProvider: "anthropic",
    executorModelId: "claude-sonnet-4-5",
  },
];

describe("modelPresets utils", () => {
  it("finds presets by case-insensitive display name", () => {
    expect(getPresetByName(presets, "budget")).toEqual(presets[0]);
    expect(getPresetByName(presets, "  COMPLEX ")).toEqual(presets[1]);
    expect(getPresetByName(presets, "missing")).toBeUndefined();
  });

  it("applies a preset to dropdown selection values", () => {
    expect(applyPresetToSelection(presets[0])).toEqual({
      executorValue: "openai/gpt-4o-mini",
      validatorValue: "openai/gpt-4o-mini",
    });
    expect(applyPresetToSelection(undefined)).toEqual({
      executorValue: "",
      validatorValue: "",
    });
  });

  it("recommends the mapped preset for a task size", () => {
    expect(
      getRecommendedPresetForSize("S", { S: "budget", M: "complex" }, presets),
    ).toEqual(presets[0]);
    expect(
      getRecommendedPresetForSize("L", { S: "budget", M: "complex" }, presets),
    ).toBeUndefined();
    expect(getRecommendedPresetForSize(undefined, { S: "budget" }, presets)).toBeUndefined();
  });

  it("validates preset ids", () => {
    expect(validatePresetId("budget")).toBe(true);
    expect(validatePresetId("budget_v2")).toBe(true);
    expect(validatePresetId("budget-v2")).toBe(true);
    expect(validatePresetId("")).toBe(false);
    expect(validatePresetId("has spaces")).toBe(false);
    expect(validatePresetId("invalid!char")).toBe(false);
    expect(validatePresetId("a".repeat(33))).toBe(false);
  });

  it("generates slug-friendly preset ids", () => {
    expect(generatePresetId("Budget")).toBe("budget");
    expect(generatePresetId("  Normal Mode  ")).toBe("normal-mode");
    expect(generatePresetId("Complex / Reviewer")).toBe("complex-reviewer");
    expect(generatePresetId("!!!")).toBe("preset");
    expect(generatePresetId("a".repeat(40))).toBe("a".repeat(32));
  });

  describe("generateUniquePresetId", () => {
    it("returns the base slug when no collision", () => {
      // "standard" is not in the presets fixture
      expect(generateUniquePresetId("Standard", presets)).toBe("standard");
    });

    it("returns base slug when existing list is empty", () => {
      expect(generateUniquePresetId("Budget", [])).toBe("budget");
    });

    it("appends suffix when base slug is already taken", () => {
      // "budget" is already used in presets, so should get "budget-1"
      expect(generateUniquePresetId("Budget", presets)).toBe("budget-1");
      // "complex" is also taken, so should get "complex-1"
      expect(generateUniquePresetId("Complex", presets)).toBe("complex-1");
    });

    it("increments suffix until finding a free id", () => {
      const crowded: ModelPreset[] = [
        { id: "budget", name: "Budget" },
        { id: "budget-1", name: "Budget Copy" },
        { id: "budget-2", name: "Budget Copy 2" },
      ];
      expect(generateUniquePresetId("Budget", crowded)).toBe("budget-3");
    });

    it("truncates base slug to leave room for suffix", () => {
      const longName = "a".repeat(40);
      const existing: ModelPreset[] = [
        { id: generatePresetId(longName), name: longName },
      ];
      const result = generateUniquePresetId(longName, existing);
      // baseId is 32 a's, collision → truncate to 28 a's + "-1" = 30 chars
      expect(result).toBe(`${"a".repeat(28)}-1`);
      expect(result.length).toBeLessThanOrEqual(32);
      expect(validatePresetId(result)).toBe(true);
    });

    it("handles fallback 'preset' slug collisions", () => {
      const existing: ModelPreset[] = [
        { id: "preset", name: "!!!" },
      ];
      expect(generateUniquePresetId("!!!", existing)).toBe("preset-1");
    });
  });
});
