import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_OUTPUT_MAX_CHARS,
  buildToolOutputTruncationMarker,
  clampToolOutputBlocks,
  clampToolOutputText,
  resolveAgentToolOutputMaxChars,
  resolveToolOutputBudget,
} from "../tool-output-budget.js";

describe("tool output budget", () => {
  it("leaves empty, under-budget, and exactly-at-budget text unchanged", () => {
    expect(clampToolOutputText("", { maxChars: 5 })).toBe("");
    expect(clampToolOutputText("short", { maxChars: 5 })).toBe("short");
    expect(clampToolOutputText("exact", { maxChars: 5 })).toBe("exact");
  });

  it("reserves its marker within the string budget and is idempotent", () => {
    const maxChars = 100;
    const marker = buildToolOutputTruncationMarker();
    const output = clampToolOutputText("x".repeat(300), { maxChars });
    expect(output.length).toBeLessThanOrEqual(maxChars);
    expect(output.endsWith(marker)).toBe(true);
    expect(clampToolOutputText(output, { maxChars })).toBe(output);
  });

  it("supports custom, degenerate, and newline/multibyte input budgets", () => {
    const tiny = clampToolOutputText("non-empty", { maxChars: 3 });
    expect(tiny).toHaveLength(3);
    expect(clampToolOutputText("😀\n".repeat(100), { maxChars: 77 })).toHaveLength(77);
  });

  it("allocates a multi-block result in order under one total budget", () => {
    const maxChars = 300;
    const output = clampToolOutputBlocks(["a".repeat(30), "b".repeat(280), "c".repeat(30)], { maxChars });
    expect(output).toHaveLength(3);
    expect(output[0]).toBe("a".repeat(30));
    expect(output[1]).toContain("[Tool output truncated");
    expect(output[2]).toBe("");
    expect(output.join("").length).toBeLessThanOrEqual(maxChars);
  });

  it("reserves a marker when overflow lands on a block boundary and handles undefined", () => {
    const marker = buildToolOutputTruncationMarker();
    const maxChars = marker.length + 4;
    const output = clampToolOutputBlocks(["abcd", "overflow".repeat(20), undefined], { maxChars });
    expect(output).toEqual(["abcd", marker, ""]);
    expect(output.join("")).toHaveLength(maxChars);
  });

  it("resolves the setting's default, bounded, and explicit unlimited states", () => {
    for (const value of [undefined, null]) {
      expect(resolveAgentToolOutputMaxChars({ agentToolOutputMaxChars: value })).toBe(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
    }
    expect(resolveAgentToolOutputMaxChars({})).toBe(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
    expect(resolveAgentToolOutputMaxChars({ agentToolOutputMaxChars: 0 })).toBeNull();
    expect(resolveAgentToolOutputMaxChars({ agentToolOutputMaxChars: 500 })).toBe(500);
    for (const value of [-1, 1.5, Number.NaN, Infinity, "500"]) {
      expect(resolveAgentToolOutputMaxChars({ agentToolOutputMaxChars: value })).toBe(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
    }
  });

  it("resolves only finite positive integer overrides over a supplied base budget", () => {
    expect(resolveToolOutputBudget("missing", {}, 500)).toBe(500);
    expect(resolveToolOutputBudget("large", { large: 20_000 }, 500)).toBe(20_000);
    expect(resolveToolOutputBudget("small", { small: 10 }, 500)).toBe(10);
    for (const value of [Infinity, 0, -1, Number.NaN, null]) {
      expect(() => resolveToolOutputBudget("bad", { bad: value }, 500)).toThrow(/finite positive integers/);
    }
  });
});
