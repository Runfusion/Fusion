import { describe, expect, it } from "vitest";
import { splitTaskPlanSummary } from "../taskPlanSummary";

const bothSections = `# Task: FN-195 - Summary first

## Original Description

<!-- fusion-original-description:start -->
Keep task intent readable.
<!-- fusion-original-description:end -->

## What This Delivers

Operators can confirm the expected outcome quickly.

## Before → After Transformation

- **Before:** intent is buried
- **After:** intent is visible

## Mission

Implement the technical details.

## Steps

### Step 1: Ship it
`;

function nonBlankLines(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.trim().length > 0);
}

describe("splitTaskPlanSummary", () => {
  it("extracts both summary sections in document order", () => {
    const result = splitTaskPlanSummary(bothSections);

    expect(result.hasSummary).toBe(true);
    expect(result.summaryMarkdown).toContain("Operators can confirm the expected outcome quickly.");
    expect(result.summaryMarkdown).toContain("- **Before:** intent is buried");
    expect(result.summaryMarkdown.indexOf("## What This Delivers")).toBeLessThan(
      result.summaryMarkdown.indexOf("## Before → After Transformation"),
    );
    expect(result.restMarkdown).toContain("## Original Description");
    expect(result.restMarkdown).toContain("## Mission");
  });

  it("extracts each supported section independently", () => {
    const beforeOnly = splitTaskPlanSummary("# Task: FN-195\n\n## Before → After Transformation\n\n- **After:** clear\n\n## Mission\n\nShip it.\n");
    const whatOnly = splitTaskPlanSummary("# Task: FN-195\n\n## What This Delivers\n\nOperators understand it.\n\n## Mission\n\nShip it.\n");

    expect(beforeOnly.summaryMarkdown).toContain("- **After:** clear");
    expect(beforeOnly.restMarkdown).toContain("## Mission");
    expect(whatOnly.summaryMarkdown).toContain("Operators understand it.");
    expect(whatOnly.restMarkdown).toContain("## Mission");
  });

  it("leaves plans without a summary unchanged after title stripping", () => {
    const prompt = "# Task: FN-195\n\n## Mission\n\nShip it.\n";
    const result = splitTaskPlanSummary(prompt);

    expect(result).toEqual({ summaryMarkdown: "", restMarkdown: "## Mission\n\nShip it.\n", hasSummary: false });
    expect(splitTaskPlanSummary("")).toEqual({ summaryMarkdown: "", restMarkdown: "", hasSummary: false });
    expect(splitTaskPlanSummary("DUPLICATE: FN-123")).toEqual({
      summaryMarkdown: "",
      restMarkdown: "DUPLICATE: FN-123",
      hasSummary: false,
    });
  });

  it("accepts the ASCII Before -> After heading", () => {
    const result = splitTaskPlanSummary("## Before -> After Transformation\n\n- **After:** clear\n\n## Mission\n\nShip it.\n");

    expect(result.summaryMarkdown).toContain("## Before -> After Transformation");
    expect(result.restMarkdown).toContain("## Mission");
  });

  it("does not treat fenced headings as summary boundaries", () => {
    const result = splitTaskPlanSummary("## What This Delivers\n\nUse this example:\n\n```markdown\n## Not a section\n```\n\nStill a summary.\n\n## Mission\n\nShip it.\n");

    expect(result.summaryMarkdown).toContain("## Not a section");
    expect(result.summaryMarkdown).toContain("Still a summary.");
    expect(result.restMarkdown).toContain("## Mission");
  });

  it("keeps duplicate later summary headings in the disclosure remainder", () => {
    const result = splitTaskPlanSummary("## Before → After Transformation\n\n- **After:** first\n\n## Mission\n\nShip it.\n\n## Before → After Transformation\n\n- **After:** duplicate\n");

    expect(result.summaryMarkdown).toContain("- **After:** first");
    expect(result.summaryMarkdown).not.toContain("- **After:** duplicate");
    expect(result.restMarkdown).toContain("## Before → After Transformation\n\n- **After:** duplicate");
  });

  it("returns an empty remainder when the summary is the final section", () => {
    const result = splitTaskPlanSummary("# Task: FN-195\n\n## What This Delivers\n\nOperators can confirm the outcome.\n");

    expect(result.hasSummary).toBe(true);
    expect(result.restMarkdown.trim()).toBe("");
  });

  it("preserves every non-blank line in exactly one output half", () => {
    const result = splitTaskPlanSummary(bothSections);
    const source = bothSections.replace(/^#\s+[^\n]*\n+/, "");
    const combined = `${result.summaryMarkdown}\n${result.restMarkdown}`;

    expect(nonBlankLines(combined)).toEqual(expect.arrayContaining(nonBlankLines(source)));
    for (const line of nonBlankLines(source)) {
      const inSummary = nonBlankLines(result.summaryMarkdown).filter((candidate) => candidate === line).length;
      const inRest = nonBlankLines(result.restMarkdown).filter((candidate) => candidate === line).length;
      const inSource = nonBlankLines(source).filter((candidate) => candidate === line).length;
      expect(inSummary + inRest).toBe(inSource);
    }
  });
});
