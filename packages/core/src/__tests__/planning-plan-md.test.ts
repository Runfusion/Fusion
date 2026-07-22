import { describe, expect, it } from "vitest";
import { formatPlanningPlanMd, parsePlanningPlanMd } from "../planning-plan-md.js";

describe("Planning Mode plan.md", () => {
  it("round-trips the lean operator schema without priority", () => {
    const formatted = formatPlanningPlanMd({ title: "Ship plans", description: "Keep plans durable.", proposedChanges: ["Persist the plan state"], acceptanceCriteria: ["Refresh restores the active plan"], suggestedSize: "M", priority: "high", suggestedDependencies: ["FN-1"], keyDeliverables: ["Format plan", "Store request"] });
    expect(formatted).not.toContain("## Priority");
    expect(formatted).toContain("## What to change\n- Persist the plan state");
    expect(formatted).toContain("## Acceptance criteria\n- Refresh restores the active plan");
    expect(parsePlanningPlanMd(formatted)).toEqual({ title: "Ship plans", description: "Keep plans durable.", proposedChanges: ["Persist the plan state"], acceptanceCriteria: ["Refresh restores the active plan"], suggestedSize: "M", suggestedDependencies: ["FN-1"], keyDeliverables: ["Format plan", "Store request"] });
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

  it("keeps Markdown-flavored multiline list values as single round-trip items", () => {
    const formatted = formatPlanningPlanMd({
      title: "Stable lists",
      description: "Keep structured plan fields parseable.",
      proposedChanges: ["Render Markdown\n  - preserve the canonical section"],
      acceptanceCriteria: ["Review shows **formatted** content\nwithout splitting the criterion"],
      suggestedSize: "S",
      suggestedDependencies: [],
      keyDeliverables: ["A stable\nplan.md"],
    });

    expect(parsePlanningPlanMd(formatted)).toEqual(expect.objectContaining({
      proposedChanges: ["Render Markdown - preserve the canonical section"],
      acceptanceCriteria: ["Review shows **formatted** content without splitting the criterion"],
      keyDeliverables: ["A stable plan.md"],
    }));
  });
});
