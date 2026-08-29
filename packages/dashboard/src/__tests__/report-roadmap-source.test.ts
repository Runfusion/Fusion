import { describe, expect, it, vi } from "vitest";
import { createRoadmapDedupSourceForTaskStore } from "../report-roadmap-source.js";

const taskStore = { getAsyncLayer: () => ({}) } as any;

describe("roadmap report dedup source", () => {
  it("flattens features across roadmap hierarchies", async () => {
    const source = createRoadmapDedupSourceForTaskStore(taskStore, {
      createRoadmapStore: () => ({
        listRoadmaps: vi.fn().mockResolvedValue([{ id: "RM-1" }, { id: "RM-2" }]),
        getRoadmapWithHierarchy: vi.fn().mockImplementation(async (id: string) => id === "RM-1"
          ? { milestones: [{ features: [{ id: "RF-1", title: "Offline reports", description: "Keep reports while offline" }] }] }
          : { milestones: [{ features: [{ id: "RF-2", title: "Report search" }] }] }),
      }),
    });
    await expect(source([])).resolves.toEqual([
      { featureId: "RF-1", title: "Offline reports", body: "Keep reports while offline" },
      { featureId: "RF-2", title: "Report search", body: null },
    ]);
  });

  it("returns no candidates for an empty or unavailable roadmap store", async () => {
    const empty = createRoadmapDedupSourceForTaskStore(taskStore, {
      createRoadmapStore: () => ({ listRoadmaps: vi.fn().mockResolvedValue([]), getRoadmapWithHierarchy: vi.fn() }),
    });
    const unavailable = createRoadmapDedupSourceForTaskStore(taskStore, {
      createRoadmapStore: () => { throw new Error("missing layer"); },
    });
    await expect(empty([])).resolves.toEqual([]);
    await expect(unavailable([])).resolves.toEqual([]);
  });
});
