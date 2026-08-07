import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTraces, getTraces } from "../../utils/dashboardTraceBuffer";

const recordResumeEvent = vi.fn();
const subscribeCalls: Array<{ onReconnect?: () => void }> = [];

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (_url: string, handlers: { onReconnect?: () => void }) => {
    subscribeCalls.push({ onReconnect: handlers.onReconnect });
    return () => {};
  },
}));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTasks: vi.fn().mockResolvedValue([]),
  });
});

describe("useTasks resume instrumentation", () => {
  beforeEach(() => {
    clearTraces();
    subscribeCalls.length = 0;
    recordResumeEvent.mockReset();
  });

  it("records visibility trigger and preserves visibility-context-version-changed trace", async () => {
    const { useTasks } = await import("../useTasks");
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useTasks({ projectId }),
      { initialProps: { projectId: "proj-1" } },
    );

    await waitFor(() => {
      expect(subscribeCalls.length).toBeGreaterThan(0);
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      rerender({ projectId: "proj-2" });
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useTasks",
      trigger: "visibility",
      projectId: "proj-2",
      reason: "context-version-changed",
    }));

    expect(getTraces().some((entry) => entry.source === "useTasks" && entry.event === "visibility-context-version-changed")).toBe(true);
  });

  it("records sse-reconnect trigger on reconnect callback", async () => {
    const { useTasks } = await import("../useTasks");
    renderHook(() => useTasks({ projectId: "proj-1" }));

    await waitFor(() => {
      expect(subscribeCalls[0]?.onReconnect).toBeTypeOf("function");
    });

    act(() => {
      subscribeCalls[0]?.onReconnect?.();
    });

    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useTasks",
      trigger: "sse-reconnect",
      projectId: "proj-1",
      replayAttempted: false,
    }));
  });

  it("coalesces visibility, focus, pageshow, and reconnect bursts into one current-context fetch", async () => {
    const api = await import("../../api");
    const fetchTasks = vi.mocked(api.fetchTasks);
    const { useTasks } = await import("../useTasks");
    renderHook(() => useTasks({ projectId: "proj-current" }));
    await waitFor(() => expect(subscribeCalls[0]?.onReconnect).toBeTypeOf("function"));
    await waitFor(() => expect(fetchTasks).toHaveBeenCalled());
    fetchTasks.mockClear();

    let resolveRefresh: (tasks: never[]) => void = () => {};
    fetchTasks.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      subscribeCalls[0]?.onReconnect?.();
    });

    expect(fetchTasks).toHaveBeenCalledTimes(1);
    await act(async () => resolveRefresh([]));
  });

  describe.each([
    ["focus", () => window.dispatchEvent(new Event("focus"))],
    ["pageshow", () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))],
  ])("%s resume instrumentation", (trigger, dispatch) => {
    it("uses the production hook revalidation seam", async () => {
      const { useTasks } = await import("../useTasks");
      renderHook(() => useTasks({ projectId: "proj-1", sseEnabled: false }));

      act(dispatch);

      expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
        view: "useTasks",
        trigger,
        projectId: "proj-1",
        replayAttempted: false,
      }));
    });
  });
});
