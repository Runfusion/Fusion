import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const subscribeCalls: Array<{
  handlers: {
    events?: Record<string, (event: MessageEvent) => void>;
    onReconnect?: () => void;
  };
}> = [];

vi.mock("../../sse-bus", () => ({
  subscribeSse: (_url: string, handlers: { events?: Record<string, (event: MessageEvent) => void>; onReconnect?: () => void }) => {
    subscribeCalls.push({ handlers });
    return () => {};
  },
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTasks: vi.fn().mockResolvedValue([]),
  });
});

describe("useTasks stale trace instrumentation", () => {
  beforeEach(() => {
    subscribeCalls.length = 0;
    vi.resetModules();
  });

  it("emits dropped-stale-event trace when stale subscription handler fires after project switch", async () => {
    const traceBuffer = await import("../../utils/dashboardTraceBuffer");
    traceBuffer.clearTraces();

    const { useTasks } = await import("../useTasks");

    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useTasks({ projectId }),
      { initialProps: { projectId: "project-a" } },
    );

    await waitFor(() => {
      expect(subscribeCalls.length).toBeGreaterThanOrEqual(1);
    });

    const staleCreated = subscribeCalls[0]?.handlers.events?.["task:created"];
    expect(staleCreated).toBeTypeOf("function");

    await act(async () => {
      rerender({ projectId: "project-b" });
    });

    act(() => {
      staleCreated?.({ data: JSON.stringify({ id: "FN-STALE", dependencies: [], steps: [], log: [] }) } as MessageEvent);
    });

    const staleTrace = traceBuffer
      .getTraces()
      .find((entry) => entry.source === "useTasks" && entry.event === "dropped-stale-event");

    expect(staleTrace).toBeDefined();
    expect(staleTrace?.detail).toMatchObject({
      count: 1,
      projectId: "project-a",
      contextVersionAtStart: 0,
      currentContextVersion: 1,
    });
  });
});
