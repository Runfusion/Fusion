import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordResumeEvent = vi.fn();
const subscribeSse = vi.fn();

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse,
}));

vi.mock("../../api", () => ({
  listResearchRuns: vi.fn().mockResolvedValue({ runs: [], availability: { available: true } }),
  getResearchRun: vi.fn(),
  createResearchRun: vi.fn(),
  cancelResearchRun: vi.fn(),
  retryResearchRun: vi.fn(),
  exportResearchRun: vi.fn(),
  createTaskFromResearchRun: vi.fn(),
  attachResearchRunToTask: vi.fn(),
}));

describe("useResearch resume instrumentation", () => {
  beforeEach(() => {
    recordResumeEvent.mockReset();
    subscribeSse.mockReset();
  });

  it("emits sse-open and reconnect instrumentation, then refreshes", async () => {
    const { listResearchRuns } = await import("../../api");
    const mockList = vi.mocked(listResearchRuns);

    let reconnect: (() => void) | undefined;
    subscribeSse.mockImplementation((_url, handlers) => {
      reconnect = handlers.onReconnect;
      return () => {};
    });

    const { useResearch } = await import("../useResearch");
    renderHook(() => useResearch({ projectId: "proj-1" }));

    await waitFor(() => {
      expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
        view: "useResearch",
        trigger: "sse-open",
        sseChannel: "/api/events?projectId=proj-1",
      }));
    });

    mockList.mockClear();
    act(() => reconnect?.());

    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useResearch",
      trigger: "sse-reconnect",
      sseChannel: "/api/events?projectId=proj-1",
    }));
  });
});
