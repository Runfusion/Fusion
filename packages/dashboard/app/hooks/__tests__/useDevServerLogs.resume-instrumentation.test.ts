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
  fetchDevServerLogHistory: vi.fn(),
  getDevServerLogsStreamUrl: vi.fn((projectId?: string) => `/api/dev-server/logs/stream${projectId ? `?projectId=${projectId}` : ""}`),
}));

describe("useDevServerLogs resume instrumentation", () => {
  beforeEach(() => {
    recordResumeEvent.mockReset();
    subscribeSse.mockReset();
  });

  it("emits sse-open and sse-reconnect with replay event id", async () => {
    const { fetchDevServerLogHistory } = await import("../../api");
    vi.mocked(fetchDevServerLogHistory)
      .mockResolvedValueOnce({ lines: [{ id: 5, text: "a", stream: "stdout", timestamp: "" }], totalLines: 1 })
      .mockResolvedValueOnce({ lines: [], totalLines: 1 });

    let reconnect: (() => void) | undefined;
    subscribeSse.mockImplementation((_url, handlers) => {
      reconnect = handlers.onReconnect;
      return () => {};
    });

    const { useDevServerLogs } = await import("../useDevServerLogs");
    renderHook(({ projectId }) => useDevServerLogs(projectId, true), { initialProps: { projectId: "proj-1" } });

    await waitFor(() => {
      expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
        view: "useDevServerLogs",
        trigger: "sse-open",
        sseChannel: "/api/dev-server/logs/stream?projectId=proj-1",
      }));
    });

    act(() => reconnect?.());

    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useDevServerLogs",
      trigger: "sse-reconnect",
      replayFromEventId: 5,
      replayAttempted: true,
    }));
  });

  it("emits project-context-change when project id changes", async () => {
    const { fetchDevServerLogHistory } = await import("../../api");
    vi.mocked(fetchDevServerLogHistory).mockResolvedValue({ lines: [], totalLines: 0 });
    subscribeSse.mockImplementation(() => () => {});

    const { useDevServerLogs } = await import("../useDevServerLogs");
    const { rerender } = renderHook(({ projectId }) => useDevServerLogs(projectId, true), {
      initialProps: { projectId: "proj-1" },
    });

    rerender({ projectId: "proj-2" });

    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useDevServerLogs",
      trigger: "project-context-change",
      projectId: "proj-2",
      reason: "context-version-bumped",
    }));
  });
});
