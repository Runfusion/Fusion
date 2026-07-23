import { describe, expect, it } from "vitest";
import {
  buildSnippet,
  extractGoalCitations,
  GOAL_CITATION_SNIPPET_MAX,
} from "../goals/goal-citation-extractor.js";

describe("goal-citation-extractor", () => {
  it("extracts simple fixture goal IDs", () => {
    const matches = extractGoalCitations("prioritizing per G-FAKE001 today");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.goalId).toBe("G-FAKE001");
  });

  it("extracts realistic generated goal IDs", () => {
    expect(extractGoalCitations("working against G-MABC-0001-XYZW now")[0]?.goalId).toBe(
      "G-MABC-0001-XYZW",
    );
  });

  it("rejects false positives", () => {
    expect(extractGoalCitations("FN-5663 g-lowercase GG-NOPE prefixG-X")).toEqual([]);
  });

  it("deduplicates duplicate IDs and keeps first index", () => {
    const text = "G-FAKE001 then later G-FAKE001 again";
    const matches = extractGoalCitations(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ goalId: "G-FAKE001", index: text.indexOf("G-FAKE001") });
  });

  it("returns empty for empty/undefined/non-string", () => {
    expect(extractGoalCitations("")).toEqual([]);
    expect(extractGoalCitations(undefined as unknown as string)).toEqual([]);
    expect(extractGoalCitations(42 as unknown as string)).toEqual([]);
  });

  it("buildSnippet caps length and collapses whitespace", () => {
    const text = `before\n\nG-FAKE001\n\nafter`;
    const snippet = buildSnippet(text, text.indexOf("G-FAKE001"));
    expect(snippet.length).toBeLessThanOrEqual(GOAL_CITATION_SNIPPET_MAX);
    expect(snippet).toContain("G-FAKE001");
    expect(snippet).toBe("before G-FAKE001 after");
  });

  it("buildSnippet handles left/right/short-text edges", () => {
    const leftText = "G-LEFT text";
    expect(buildSnippet(leftText, 0, 8)).toContain("G-LEFT");

    const rightText = "prefix text ending G-RIGHT";
    expect(buildSnippet(rightText, rightText.indexOf("G-RIGHT"), 12)).toContain("G-RIGHT");

    const shortText = "tiny G-SHORT";
    expect(buildSnippet(shortText, shortText.indexOf("G-SHORT"), 200)).toBe("tiny G-SHORT");
  });
});
