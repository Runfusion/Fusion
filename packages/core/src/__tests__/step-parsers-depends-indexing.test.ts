import { describe, expect, it } from "vitest";

import { matchStepHeadings, parseJsonSteps, parseStepHeadings } from "../tasks/step-parsers.js";

describe("step parser dependency indexing", () => {
  it("matches every canonical numbered heading, including annotations", () => {
    const content = "### Step 0: Plain\n### Step 1 (depends: 0): Dependent\n### Step 2 (depends:): Independent\n### Step 10 (depends: 1: Malformed";
    const matches = matchStepHeadings(content);
    expect(matches.map((match) => match.headingNumber)).toEqual([0, 1, 2, 10]);
    expect(matches.map((match) => match.headingNumber)).toEqual(parseStepHeadings(content).map((_, index) => [0, 1, 2, 10][index]));
    expect(matches[1]).toMatchObject({ index: content.indexOf("### Step 1") });
    expect(content.slice(matches[1].index, matches[1].headingLineEnd)).toBe("### Step 1 (depends: 0): Dependent");
    expect(matchStepHeadings("#### Step 1: no\n### Preflight")).toEqual([]);
  });

  it("maps canonical heading annotations to their literal heading numbers", () => {
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1: Implement\n### Step 2 (depends: 1): Test")[2].dependsOn).toEqual([1]);
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1 (depends: 0): Implement")[1].dependsOn).toEqual([0]);
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1: Implement\n### Step 2 (depends: 2,0,0): Test")[2].dependsOn).toEqual([0, 2]);
  });

  it("preserves explicit, absent, malformed, and legacy heading annotation contracts", () => {
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1 (depends:): Independent")[1].dependsOn).toEqual([]);
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1: Implement")[1]).not.toHaveProperty("dependsOn");
    expect(parseStepHeadings("### Step 1: First\n### Step 2: Second\n### Step 3 (depends: 1): Third")[2].dependsOn).toEqual([0]);
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1 (depends: no): Implement")[1]).not.toHaveProperty("dependsOn");
    expect(parseStepHeadings("### Step 0: Preflight\n### Step 1 (depends: 0: Implement")[1]).not.toHaveProperty("dependsOn");
    expect(parseStepHeadings("### Step 1: First\n### Step 2 (depends: 0): Second")[1]).not.toHaveProperty("dependsOn");
  });

  it("leaves single and plain-heading documents unaffected", () => {
    expect(parseStepHeadings("### Step 0: Preflight")).toEqual([{ name: "Preflight", status: "pending" }]);
    expect(parseStepHeadings("## Steps\n\n### Preflight\n### Implement")).toEqual([
      { name: "Preflight", status: "pending" },
      { name: "Implement", status: "pending" },
    ]);
  });

  it("treats JSON dependencies as 0-based document indices", () => {
    expect(parseJsonSteps(JSON.stringify([{ name: "First" }, { name: "Second", depends: [0] }])).steps).toEqual([
      { name: "First" },
      { name: "Second", dependsOn: [0] },
    ]);
    expect(parseJsonSteps(JSON.stringify([{ name: "First", depends: [] }, { name: "Second" }])).steps).toEqual([
      { name: "First", dependsOn: [] },
      { name: "Second" },
    ]);
    expect(() => parseJsonSteps(JSON.stringify([{ name: "First", depends: [-1] }]))).toThrow("0-based document indices");
    expect(() => parseJsonSteps(JSON.stringify([{ name: "First", depends: [1.5] }]))).toThrow("0-based document indices");
  });
});
