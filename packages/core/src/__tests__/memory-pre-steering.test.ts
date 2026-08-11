import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildMemoryPreSteeringNudge,
  MAX_PRE_STEERING_FULL_BYTES,
  MAX_PRE_STEERING_INDEX_BYTES,
  MEMORY_PRE_STEERING_MARKER,
} from "../memory/memory-pre-steering.js";

describe("buildMemoryPreSteeringNudge", () => {
  it("suppresses steering when memory inclusion is off", () => {
    expect(buildMemoryPreSteeringNudge("off")).toBe("");
  });

  it("keeps index steering terse and byte-bounded", () => {
    const nudge = buildMemoryPreSteeringNudge("index");
    expect(nudge).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(nudge).toContain("fn_memory_search");
    expect(Buffer.byteLength(nudge, "utf8")).toBeLessThanOrEqual(MAX_PRE_STEERING_INDEX_BYTES);
  });

  it("provides byte-bounded full search-first guidance", () => {
    const nudge = buildMemoryPreSteeringNudge("full");
    expect(nudge).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(nudge).toContain("fn_memory_search");
    expect(Buffer.byteLength(nudge, "utf8")).toBeLessThanOrEqual(MAX_PRE_STEERING_FULL_BYTES);
  });
});
