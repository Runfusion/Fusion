import { describe, expect, it, vi } from "vitest";
import { promoteResearchFinding } from "../research/research-feature-promotion.js";

describe("promoteResearchFinding recall capture", () => {
  it("records the promoted finding without awaiting optional recall persistence", async () => {
    let releaseCapture!: () => void;
    const captureStarted = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const capture = vi.fn(() => { void captureStarted; });
    const researchStore = {
      getRun: vi.fn(async () => ({
        id: "RR-1",
        status: "completed",
        tags: ["architecture"],
        results: { findings: [{ id: "finding-1", heading: "Adopt a seam", content: "Use the durable seam.", sources: [] }] },
      })),
    };
    const missionStore = {
      addResearchFeature: vi.fn(async () => ({ feature: { id: "F-1" }, reused: false })),
    };

    const promoted = await promoteResearchFinding(
      researchStore as never,
      missionStore as never,
      { runId: "RR-1", findingId: "finding-1", sliceId: "SL-1" },
      { capture },
    );

    expect(promoted.feature.id).toBe("F-1");
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      origin: "research-finding",
      title: "Adopt a seam",
      summary: "Research finding finding-1 from completed run RR-1 was promoted to the roadmap.",
      researchRunId: "RR-1",
      findingId: "finding-1",
      tags: ["research", "promotion", "architecture"],
    }));
    releaseCapture();
  });
});
