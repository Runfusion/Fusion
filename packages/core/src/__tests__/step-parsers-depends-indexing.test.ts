import { describe, expect, it } from "vitest";

import {
  StepDependencyValidationError,
  matchStepHeadings,
  parseJsonSteps,
  parseStepHeadings,
  validateStepDependencies,
} from "../tasks/step-parsers.js";

describe("step parser dependency indexing", () => {
  it("keeps visible heading labels independent from positional dependencies", () => {
    const content = [
      "### Step 0: First",
      "### Step 12: Second",
      "### Step 99: Third",
      "### Step 12 (depends: 1,2): Fourth",
    ].join("\n");
    expect(matchStepHeadings(content).map((match) => match.headingNumber)).toEqual([0, 12, 99, 12]);
    expect(parseStepHeadings(content)[3]).toMatchObject({ name: "Fourth", dependsOn: [0, 1] });
  });

  it.each([0, 1])("accepts legacy suffix dependencies for contiguous headings starting at %s", (offset) => {
    const steps = parseStepHeadings([
      `### Step ${offset}: Preflight`,
      `### Step ${offset + 1}: Implement (depends: ${offset})`,
      `### Step ${offset + 2}: Check (depends: ${offset},${offset + 1})`,
    ].join("\n"));
    expect(steps.map(step => ({ name: step.name, dependsOn: step.dependsOn }))).toEqual([
      { name: "Preflight", dependsOn: undefined }, { name: "Implement", dependsOn: [0] }, { name: "Check", dependsOn: [0, 1] },
    ]);
  });

  it("preserves an explicit independent root in a legacy suffix", () => {
    expect(parseStepHeadings("### Step 0: First\n### Step 1: Independent (depends:)")[1])
      .toEqual({ name: "Independent", status: "pending", dependsOn: [] });
  });

  it("keeps positional prefix and authored-label suffix coordinates independent in mixed plans", () => {
    const steps = parseStepHeadings("### Step 0: First\n### Step 1 (depends: 1): Second\n### Step 2: Third (depends: 1)");
    expect(steps.map(step => step.dependsOn)).toEqual([undefined, [0], [1]]);
  });

  it.each([
    "### Step 0: First\n### Step 2: Gap (depends: 0)",
    "### Step 0: First\n### Step 0: Duplicate (depends: 0)",
    "### Step 0: First\n### Step 1: Self (depends: 1)",
    "### Step 0: First (depends: 1)\n### Step 1: Cycle (depends: 0)",
    "### Step 0: First\n### Step 1: Missing (depends: 8)",
    "### Step 0: First\n### Step 1: Invalid (depends: -1)",
    "### Step 0: First\n### Step 1: Invalid (depends: 0,0)",
    "### Step 0: First\n### Step 1: Invalid (depends: nope)",
    "### Step 0: First\n### Step 1 (depends: 1): Duplicate declaration (depends: 0)",
  ])("rejects ambiguous or invalid legacy suffix dependencies: %s", (content) => {
    expect(() => parseStepHeadings(content)).toThrow(StepDependencyValidationError);
  });

  it("preserves omitted dependencies and explicit roots", () => {
    const steps = parseStepHeadings("### Step 12: First\n### Step 42 (depends:): Independent");
    expect(steps[0]).not.toHaveProperty("dependsOn");
    expect(steps[1]?.dependsOn).toEqual([]);
  });

  it.each([
    ["0", "zero"],
    ["-1", "negative"],
    ["no", "malformed"],
    ["1,1", "duplicate"],
    ["8", "out-of-range"],
    ["4", "self-or-forward"],
  ] as const)("rejects invalid Markdown token %s as %s", (token, reason) => {
    const content = `### Step 1: One\n### Step 2: Two\n### Step 3: Three\n### Step 12 (depends: ${token}): Four`;
    expect(() => parseStepHeadings(content)).toThrow(StepDependencyValidationError);
    try { parseStepHeadings(content); } catch (error) {
      expect(error).toMatchObject({ dependentPosition: 4, token: token === "1,1" ? "1" : token, reason, coordinate: "markdown-position" });
    }
  });

  it("returns the actionable positional out-of-range diagnostic", () => {
    const content = Array.from({ length: 7 }, (_, index) =>
      index === 3 ? "### Step 12 (depends: 8): Four" : `### Step ${index * 3}: Item ${index + 1}`,
    ).join("\n");
    expect(() => parseStepHeadings(content)).toThrow("step 4 depends on out-of-range step 8 (valid positions: 1-7)");
  });

  it("rejects invalid persisted plugin or JSON graph edges without reinterpreting them", () => {
    expect(() => validateStepDependencies([{ dependsOn: [] }, { dependsOn: [2] }])).toThrow("out-of-range step 3");
    expect(() => validateStepDependencies([{ dependsOn: [] }, { dependsOn: [2] }, { dependsOn: [] }])).toThrow(/self-or-forward/);
    expect(() => validateStepDependencies([{ dependsOn: [1] }, { dependsOn: [0] }])).toThrow(/self-or-forward/);
    expect(() => parseJsonSteps(JSON.stringify([{ name: "First" }, { name: "Second", depends: [1] }]))).toThrow(/self-or-forward/);
    expect(() => parseJsonSteps(JSON.stringify([{ name: "First" }, { name: "Second", depends: [0, 0] }]))).toThrow(/duplicate/);
  });

  it("keeps JSON dependencies as 0-based document indices", () => {
    expect(parseJsonSteps(JSON.stringify([{ name: "First" }, { name: "Second", depends: [0] }])).steps).toEqual([
      { name: "First" },
      { name: "Second", dependsOn: [0] },
    ]);
  });
});
