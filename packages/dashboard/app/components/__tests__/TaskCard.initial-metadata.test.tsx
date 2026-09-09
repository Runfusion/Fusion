import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { deriveTaskCardStructuralProjection } from "../TaskCard";

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-321",
    title: "Stable metadata",
    description: "",
    column: "done",
    steps: [],
    dependencies: [],
    ...overrides,
  } as Task;
}

const complete = { isWip: false, isReview: false, isComplete: true };
const wip = { isWip: true, isReview: false, isComplete: false };

describe("TaskCard first-paint structural projection", () => {
  it.each([
    ["unknown complete count", task({ mergeDetails: undefined }), complete, undefined],
    ["recorded complete count", task({ mergeDetails: { filesChanged: 3 } as Task["mergeDetails"] }), complete, 3],
    ["deduplicated landed count", task({ mergeDetails: { landedFiles: ["a.ts", "a.ts", "b.ts"] } as Task["mergeDetails"] }), complete, 2],
    ["restricted attribution clamps disagreement", task({ mergeDetails: { filesChanged: 8, landedFiles: ["a.ts", "b.ts"], landedFilesAttributionRestricted: true } as Task["mergeDetails"] }), complete, 2],
    ["restricted attribution stays unknown without paths", task({ mergeDetails: { filesChanged: 8, landedFilesAttributionRestricted: true } as Task["mergeDetails"] }), complete, undefined],
    ["active snapshot deduplicates modified paths", task({ column: "in-progress", modifiedFiles: ["a.ts", "a.ts", "b.ts"] }), wip, 2],
    ["known zero creates no affordance", task({ mergeDetails: { filesChanged: 0 } as Task["mergeDetails"] }), complete, 0],
  ])("projects %s synchronously", (_name, input, roles, expectedCount) => {
    const projection = deriveTaskCardStructuralProjection(input, roles);
    expect(projection.filesChangedCount).toBe(expectedCount);
    expect(projection.hasFilesRegion).toBe(typeof expectedCount === "number" && expectedCount > 0);
  });

  it("projects honest mission, agent, and task oversight identities on first paint", () => {
    expect(deriveTaskCardStructuralProjection(task({
      missionId: "M-001",
      assignedAgentId: "agent-1",
      plannerOversightLevel: "observe",
    }), complete)).toMatchObject({
      hasMissionRegion: true,
      hasAgentRegion: true,
      hasOversightRegion: true,
    });
  });
});
