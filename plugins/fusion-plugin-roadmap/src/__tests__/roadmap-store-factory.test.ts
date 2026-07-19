import { describe, expect, it, vi } from "vitest";
import { AsyncRoadmapStore } from "../store/async-roadmap-store.js";
import { createRoadmapStoreForTaskStore } from "../server/index.js";

describe("createRoadmapStoreForTaskStore", () => {
  it("prefers a native roadmap store bridge", () => {
    const roadmapStore = { listRoadmaps: vi.fn() };
    const taskStore = { getRoadmapStore: vi.fn(() => roadmapStore), getAsyncLayer: vi.fn() } as any;
    expect(createRoadmapStoreForTaskStore(taskStore)).toBe(roadmapStore);
    expect(taskStore.getAsyncLayer).not.toHaveBeenCalled();
  });

  it("constructs and caches an async store from the task store layer", () => {
    const taskStore = { getAsyncLayer: vi.fn(() => ({ projectId: "project-1" })) } as any;
    const first = createRoadmapStoreForTaskStore(taskStore);
    const second = createRoadmapStoreForTaskStore(taskStore);
    expect(first).toBeInstanceOf(AsyncRoadmapStore);
    expect(second).toBe(first);
    expect(taskStore.getAsyncLayer).toHaveBeenCalledOnce();
  });

  it("throws when neither a bridge nor async layer is available", () => {
    expect(() => createRoadmapStoreForTaskStore({ getAsyncLayer: () => null } as any)).toThrow("PostgreSQL AsyncDataLayer");
  });
});
