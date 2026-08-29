/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearTraces, getTraces, pushTrace } from "../dashboardTraceBuffer";

describe("dashboardTraceBuffer", () => {
  beforeEach(() => {
    clearTraces();
  });

  it("appends trace entries", () => {
    pushTrace("versionCheck", "mismatch", { local: "a", remote: "b" });

    const traces = getTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      source: "versionCheck",
      event: "mismatch",
      detail: { local: "a", remote: "b" },
    });
    expect(typeof traces[0].ts).toBe("string");
  });

  it("caps entries at 200 and drops oldest", () => {
    for (let i = 0; i < 205; i += 1) {
      pushTrace("sse-bus", "event", { idx: i });
    }

    const traces = getTraces();
    expect(traces).toHaveLength(200);
    expect(traces[0]?.detail).toEqual({ idx: 5 });
    expect(traces[199]?.detail).toEqual({ idx: 204 });
  });

  it("exposes traces via window.__fusionDebug.dashboardTraces.get", () => {
    pushTrace("useTasks", "dropped-stale-event", { count: 1 });

    const debugApi = window.__fusionDebug?.dashboardTraces;
    expect(debugApi).toBeDefined();
    expect(debugApi?.get()).toHaveLength(1);
    expect(debugApi?.get()[0]).toMatchObject({
      source: "useTasks",
      event: "dropped-stale-event",
    });
  });
});
