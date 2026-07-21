import { describe, expect, it } from "vitest";
import { formatPlanningPlanMd, parsePlanningPlanMd } from "../planning-plan-md.js";

describe("Planning Mode plan.md", () => {
  it("round-trips the lean operator schema without priority", () => {
    const formatted = formatPlanningPlanMd({ title: "Ship plans", description: "Keep plans durable.", suggestedSize: "M", priority: "high", suggestedDependencies: ["FN-1"], keyDeliverables: ["Format plan", "Store request"] });
    expect(formatted).not.toContain("## Priority");
    expect(parsePlanningPlanMd(formatted)).toEqual({ title: "Ship plans", description: "Keep plans durable.", suggestedSize: "M", suggestedDependencies: ["FN-1"], keyDeliverables: ["Format plan", "Store request"] });
  });

  it("round-trips empty dependencies", () => {
    const formatted = formatPlanningPlanMd({ title: "Empty deps", description: "A plan.", suggestedSize: "S", suggestedDependencies: [], keyDeliverables: [] });
    expect(formatted).toContain("## Suggested dependencies\n_None_");
    expect(parsePlanningPlanMd(formatted)?.suggestedDependencies).toEqual([]);
  });

  it("does not confuse heading-like description prose with canonical sections", () => {
    const description = "Explain the input:\n\n## Size\nS\n\nThis is prose, not the artifact boundary.";
    const formatted = formatPlanningPlanMd({
      title: "Heading-safe plan",
      description,
      suggestedSize: "L",
      suggestedDependencies: ["FN-12"],
      keyDeliverables: ["Keep the complete description"],
    });

    expect(parsePlanningPlanMd(formatted)).toEqual(expect.objectContaining({
      description,
      suggestedSize: "L",
      suggestedDependencies: ["FN-12"],
    }));
  });
});
