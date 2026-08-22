import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordResumeEvent = vi.fn();
const subscribeSse = vi.fn();
const requestSync = vi.fn();
const broadcastUpdate = vi.fn();
const broadcastCompleted = vi.fn();

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse,
}));

vi.mock("../useAiSessionSync", () => ({
  useAiSessionSync: () => ({
    sessions: new Map(),
    requestSync,
    broadcastUpdate,
    broadcastCompleted,
  }),
}));

vi.mock("../../api", () => ({
  fetchAiSessions: vi.fn().mockResolvedValue([]),
  deleteAiSession: vi.fn(),
  cancelPlanning: vi.fn(),
  cancelMissionInterview: vi.fn(),
}));

describe("useBackgroundSessions resume instrumentation", () => {
  beforeEach(() => {
    recordResumeEvent.mockReset();
    subscribeSse.mockReset();
    requestSync.mockReset();
  });

  it("emits sse-open and reconnect instrumentation, then refreshes", async () => {
    const { fetchAiSessions } = await import("../../api");
    const mockFetch = vi.mocked(fetchAiSessions);

    let reconnect: (() => void) | undefined;
    subscribeSse.mockImplementation((_url, handlers) => {
      reconnect = handlers.onReconnect;
      return () => {};
    });

    const { useBackgroundSessions } = await import("../useBackgroundSessions");
    renderHook(() => useBackgroundSessions("proj-1"));

    await waitFor(() => {
      expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
        view: "useBackgroundSessions",
        trigger: "sse-open",
        sseChannel: "/api/events?projectId=proj-1",
      }));
    });

    mockFetch.mockClear();
    act(() => reconnect?.());

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useBackgroundSessions",
      trigger: "sse-reconnect",
      sseChannel: "/api/events?projectId=proj-1",
    }));
  });
});
