import { describe, expect, it } from "vitest";
import { requireAsyncLayer } from "../require-async-layer.js";

describe("requireAsyncLayer", () => {
  /** FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Runtime satellite composition fails clearly instead of constructing hidden SQLite state when project-layer wiring is missing. */
  it("returns the project layer and rejects missing wiring", () => {
    const layer = { projectId: "project-a" };
    expect(requireAsyncLayer({ getAsyncLayer: () => layer as never }, "Knowledge query")).toBe(layer);
    expect(() => requireAsyncLayer({ getAsyncLayer: () => null }, "Knowledge query"))
      .toThrow("Knowledge query requires the project PostgreSQL AsyncDataLayer");
  });
});
