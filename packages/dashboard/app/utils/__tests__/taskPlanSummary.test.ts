import { describe, expect, it } from "vitest";
import { extractTaskBeforeAfterTransformation, extractTaskProductSummary, splitTaskPlanSummary } from "../taskPlanSummary";

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

/*
FNXC:TaskDetailDefinition 2026-09-14-20:25:
FN-391's product-outcome selector. Deliberately narrower than `splitTaskPlanSummary`: it returns ONE
section in product language, never the technical Mission, and reports which section supplied it so a
caller can tell a modern plan from a legacy fallback.
*/
describe("extractTaskProductSummary", () => {
  it("prefers What This Delivers and reports its source", () => {
    const summary = extractTaskProductSummary(bothSections);

    expect(summary?.source).toBe("what-this-delivers");
    expect(summary?.markdown).toContain("Operators can confirm the expected outcome quickly.");
    expect(summary?.markdown).not.toContain("**Before:**");
  });

  it("falls back to Before → After Transformation when What This Delivers is absent", () => {
    const summary = extractTaskProductSummary("# Task: FN-1 - Legacy\n\n## Before → After Transformation\n\n- **Before:** manual\n- **After:** automatic\n\n## Mission\n\nTechnical brief.\n");

    expect(summary?.source).toBe("before-after");
    expect(summary?.markdown).toContain("**After:** automatic");
  });

  it("accepts the ASCII arrow variant of the legacy heading", () => {
    const summary = extractTaskProductSummary("# Task: FN-1 - Legacy\n\n## Before -> After Transformation\n\nASCII arrow plan.\n");

    expect(summary?.source).toBe("before-after");
    expect(summary?.markdown).toContain("ASCII arrow plan.");
  });

  it.each([
    { label: "a Mission-only plan", prompt: "# Task: FN-1 - Mission\n\n## Mission\n\nTechnical brief.\n" },
    { label: "an empty prompt", prompt: "" },
    { label: "a heading-only prompt", prompt: "# Task: FN-1 - Heading only\n" },
    { label: "an empty summary section", prompt: "# Task: FN-1 - Empty\n\n## What This Delivers\n\n## Mission\n\nTechnical brief.\n" },
  ])("returns null for $label", ({ prompt }) => {
    expect(extractTaskProductSummary(prompt)).toBeNull();
  });

  it("skips a fenced heading and uses the first real occurrence only", () => {
    const summary = extractTaskProductSummary("# Task: FN-1 - Fenced\n\n```md\n## What This Delivers\n\nFenced example.\n```\n\n## What This Delivers\n\nReal outcome.\n\n## What This Delivers\n\nDuplicate.\n");

    expect(summary?.markdown).toContain("Real outcome.");
    expect(summary?.markdown).not.toContain("Fenced example.");
    expect(summary?.markdown).not.toContain("Duplicate.");
  });

  it("never returns the Mission section, even when it is the only prose in the plan", () => {
    expect(extractTaskProductSummary("# Task: FN-1 - Mission\n\n## Mission\n\nUnifier le contrat titre/description.\n")).toBeNull();
  });

  it("excludes the heading line itself from the returned markdown", () => {
    const summary = extractTaskProductSummary(bothSections);

    expect(summary?.markdown.startsWith("## ")).toBe(false);
    expect(summary?.markdown).not.toContain("## What This Delivers");
  });
});

describe("extractTaskBeforeAfterTransformation", () => {
  it("returns the before/after body when the plan carries both summary sections", () => {
    const transformation = extractTaskBeforeAfterTransformation(bothSections);

    expect(transformation).toContain("**Before:** intent is buried");
    expect(transformation).toContain("**After:** intent is visible");
    expect(transformation).not.toContain("## Before");
    expect(transformation).not.toContain("Operators can confirm");
  });

  it("accepts the ASCII arrow variant of the heading", () => {
    expect(extractTaskBeforeAfterTransformation("# Task: FN-1 - Legacy\n\n## Before -> After Transformation\n\nASCII arrow body.\n")).toBe("ASCII arrow body.");
  });

  it("skips a fenced heading and keeps only the first real occurrence", () => {
    const transformation = extractTaskBeforeAfterTransformation(
      "# Task: FN-1 - Fenced\n\n```md\n## Before → After Transformation\n\nFenced example.\n```\n\n## Before → After Transformation\n\nReal transformation.\n\n## Before → After Transformation\n\nDuplicate.\n",
    );

    expect(transformation).toBe("Real transformation.");
    expect(transformation).not.toContain("Fenced example.");
    expect(transformation).not.toContain("Duplicate.");
  });

  it.each([
    { label: "a plan without the section", prompt: "# Task: FN-1 - Outcome only\n\n## What This Delivers\n\nOutcome.\n" },
    { label: "an empty before/after section", prompt: "# Task: FN-1 - Empty\n\n## Before → After Transformation\n\n## Mission\n\nTechnical brief.\n" },
    { label: "an empty prompt", prompt: "" },
    { label: "a heading-only prompt", prompt: "# Task: FN-1 - Heading only\n" },
  ])("returns null for $label", ({ prompt }) => {
    expect(extractTaskBeforeAfterTransformation(prompt)).toBeNull();
  });

  it("does not change extractTaskProductSummary results for the same plans", () => {
    expect(extractTaskProductSummary(bothSections)?.source).toBe("what-this-delivers");
    expect(extractTaskProductSummary(bothSections)?.markdown).toContain("Operators can confirm the expected outcome quickly.");

    const legacyOnly = "# Task: FN-1 - Legacy\n\n## Before → After Transformation\n\n- **Before:** manual\n- **After:** automatic\n";
    expect(extractTaskProductSummary(legacyOnly)?.source).toBe("before-after");
    expect(extractTaskProductSummary(legacyOnly)?.markdown).toContain("**After:** automatic");
    expect(extractTaskBeforeAfterTransformation(legacyOnly)).toBe(extractTaskProductSummary(legacyOnly)?.markdown);
  });
});

/*
FNXC:PatchnodeLedger 2026-09-18-02:48:
FN-526 duplicates the History ledger's product-summary rule into `@fusion/core`
(`packages/core/src/board/patchnode-product-summary.ts`) because neither package can import the
other's runtime helper (the dashboard browser bundle aliases `@fusion/core` to `types.ts`). These
fixtures are copied LITERALLY from `packages/core/src/__tests__/patchnode-projection.test.ts` so
section selection cannot drift: editing one side requires editing the other.
*/
describe("core Patchnode mirror convergence", () => {
  const PLAN_WITH_BOTH_SECTIONS = [
    "# Task: FN-1 - Titre",
    "",
    "## What This Delivers",
    "",
    "- Les opérateurs relisent l'intention.",
    "- La description vient du plan.",
    "",
    "## Before → After Transformation",
    "",
    "- **Before:** ancien corps.",
    "",
    "## Mission",
    "",
    "Technique.",
    "",
  ].join("\n");

  const PLAN_BEFORE_AFTER_ONLY = [
    "# Task: FN-1 - Titre",
    "",
    "## Before -> After Transformation",
    "",
    "- **Before:** `body` venait du résumé.",
    "",
    "## Mission",
    "",
    "Technique.",
    "",
  ].join("\n");

  const PLAN_MISSION_ONLY = "# Task: FN-1 - Titre\n\n## Mission\n\nTechnique seulement.\n";

  it("selects the same plan section as the core extractor on the shared fixtures", () => {
    expect(extractTaskProductSummary(PLAN_WITH_BOTH_SECTIONS)?.source).toBe("what-this-delivers");
    expect(extractTaskProductSummary(PLAN_WITH_BOTH_SECTIONS)?.markdown).toContain("Les opérateurs relisent l'intention.");
    expect(extractTaskProductSummary(PLAN_WITH_BOTH_SECTIONS)?.markdown).not.toContain("ancien corps.");

    expect(extractTaskProductSummary(PLAN_BEFORE_AFTER_ONLY)?.source).toBe("before-after");
    expect(extractTaskProductSummary(PLAN_BEFORE_AFTER_ONLY)?.markdown).toContain("venait du résumé.");

    expect(extractTaskProductSummary(PLAN_MISSION_ONLY)).toBeNull();
  });
});
