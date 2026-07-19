import { describe, expect, it } from "vitest";
import { buildHeuristicSuggestedCases, extractPromptBullets } from "../suggestions/heuristic-cases.js";

describe("heuristic suggested cases", () => {
  it("extracts markdown bullets", () => {
    const bullets = extractPromptBullets("# Title\n\n- First case\n- Second case\n");
    expect(bullets).toContain("First case");
    expect(bullets).toContain("Second case");
  });

  it("builds cases from title, files, and UI extensions", () => {
    const cases = buildHeuristicSuggestedCases({
      title: "Fix login button",
      prompt: "## Acceptance\n- Button works on mobile\n",
      filePaths: ["packages/dashboard/app/components/Login.tsx", "packages/dashboard/app/Login.css"],
    });
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => /login button/i.test(c.text))).toBe(true);
    expect(cases.some((c) => /mobile/i.test(c.text))).toBe(true);
  });

  it("always returns at least smoke cases", () => {
    const cases = buildHeuristicSuggestedCases({});
    expect(cases.length).toBeGreaterThanOrEqual(2);
  });
});
