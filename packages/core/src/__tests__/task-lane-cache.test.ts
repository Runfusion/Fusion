import { describe, expect, it } from "vitest";
import { TaskLaneCache } from "../task-lane-cache.js";

const lanes = { hold: "queued", wip: "building", review: "reviewing" };

describe("TaskLaneCache", () => {
  it("returns hits, misses, explicit invalidations, and fake-clock expiry", () => {
    let now = 0;
    const cache = new TaskLaneCache({ ttlMs: 10, now: () => now });
    expect(cache.get("missing")).toBeUndefined();
    cache.set("task", lanes);
    expect(cache.get("task")).toEqual(lanes);
    cache.invalidate("task");
    expect(cache.get("task")).toBeUndefined();
    cache.set("task", lanes);
    now = 10;
    expect(cache.get("task")).toBeUndefined();
  });

  it("evicts least-recently-used entries at its configured bound", () => {
    const cache = new TaskLaneCache({ maxSize: 2 });
    cache.set("first", lanes);
    cache.set("second", lanes);
    expect(cache.get("first")).toEqual(lanes);
    cache.set("third", lanes);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toEqual(lanes);
    expect(cache.get("third")).toEqual(lanes);
  });
});
