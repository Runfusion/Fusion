import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDevServerCandidates,
  fetchDevServerStatus,
  getDevServerLogsStreamUrl,
  restartDevServer,
  setDevServerPreviewUrl,
  startDevServer,
  stopDevServer,
  type DevServerCandidate,
  type DevServerState,
} from "../../api";
import { MockEventSource } from "../../../vitest.setup";
import { useDevServer } from "../useDevServer";

vi.mock("../../api", () => ({
  fetchDevServerCandidates: vi.fn(),
  fetchDevServerStatus: vi.fn(),
  startDevServer: vi.fn(),
  stopDevServer: vi.fn(),
  restartDevServer: vi.fn(),
  setDevServerPreviewUrl: vi.fn(),
  getDevServerLogsStreamUrl: vi.fn(),
}));

const mockFetchDevServerCandidates = vi.mocked(fetchDevServerCandidates);
const mockFetchDevServerStatus = vi.mocked(fetchDevServerStatus);
const mockStartDevServer = vi.mocked(startDevServer);
const mockStopDevServer = vi.mocked(stopDevServer);
const mockRestartDevServer = vi.mocked(restartDevServer);
const mockSetDevServerPreviewUrl = vi.mocked(setDevServerPreviewUrl);
const mockGetDevServerLogsStreamUrl = vi.mocked(getDevServerLogsStreamUrl);

function createState(overrides: Partial<DevServerState> = {}): DevServerState {
  return {
    id: "default",
    name: "default",
    status: "stopped",
    command: "pnpm dev",
    scriptName: "dev",
    cwd: ".",
    logs: [],
    ...overrides,
  };
}

function createCandidate(overrides: Partial<DevServerCandidate> = {}): DevServerCandidate {
  return {
    name: "dev",
    command: "pnpm dev",
    scriptName: "dev",
    cwd: ".",
    label: "project · dev (root)",
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useDevServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mockFetchDevServerCandidates.mockResolvedValue([createCandidate()]);
    mockFetchDevServerStatus.mockResolvedValue(createState());
    mockStartDevServer.mockResolvedValue(createState({ status: "running", pid: 1234 }));
    mockStopDevServer.mockResolvedValue(createState({ status: "stopped", pid: undefined }));
    mockRestartDevServer.mockResolvedValue(createState({ status: "running", pid: 4567 }));
    mockSetDevServerPreviewUrl.mockResolvedValue(createState({ manualPreviewUrl: "https://localhost:5173" }));
    mockGetDevServerLogsStreamUrl.mockReturnValue("/api/dev-server/logs/stream?projectId=project-a");
  });

  it("starts with loading state and triggers initial fetches", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    expect(result.current.loading).toBe(true);
    expect(result.current.candidates).toEqual([]);
    expect(result.current.serverState).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchDevServerCandidates).toHaveBeenCalledWith("project-a");
    expect(mockFetchDevServerStatus).toHaveBeenCalledWith("project-a");
  });

  it("populates candidates and server state from initial fetch", async () => {
    mockFetchDevServerCandidates.mockResolvedValueOnce([
      createCandidate({ name: "start", scriptName: "start", command: "npm run start" }),
    ]);
    mockFetchDevServerStatus.mockResolvedValueOnce(
      createState({ status: "running", pid: 4321, logs: ["ready"] }),
    );

    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.candidates).toHaveLength(1);
    expect(result.current.serverState?.status).toBe("running");
    expect(result.current.logs).toEqual(["ready"]);
  });

  it("creates EventSource and appends SSE log events", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockGetDevServerLogsStreamUrl).toHaveBeenCalledWith("project-a");
    expect(MockEventSource.instances).toHaveLength(1);

    const source = MockEventSource.instances[0];

    act(() => {
      source._emit("history", { lines: ["history line"] });
    });

    await waitFor(() => {
      expect(result.current.logs).toEqual(["history line"]);
    });

    act(() => {
      source._emit("log", { line: "new line" });
    });

    await waitFor(() => {
      expect(result.current.logs).toEqual(["history line", "new line"]);
    });
  });

  it("calls start API for candidate and direct command arguments", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const candidate = createCandidate({ command: "pnpm run dev", cwd: "apps/web" });

    await act(async () => {
      await result.current.start(candidate);
    });

    expect(mockStartDevServer).toHaveBeenCalledWith(
      { command: "pnpm run dev", scriptName: "dev", cwd: "apps/web" },
      "project-a",
    );

    await act(async () => {
      await result.current.start({ command: "npm run start", scriptName: "start", cwd: "." });
    });

    expect(mockStartDevServer).toHaveBeenCalledWith(
      { command: "npm run start", scriptName: "start", cwd: "." },
      "project-a",
    );
  });

  it("calls stop, restart, and setPreviewUrl APIs", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.stop();
    });
    expect(mockStopDevServer).toHaveBeenCalledWith("project-a");

    await act(async () => {
      await result.current.restart();
    });
    expect(mockRestartDevServer).toHaveBeenCalledWith("project-a");

    await act(async () => {
      await result.current.setPreviewUrl("https://localhost:3000");
    });
    expect(mockSetDevServerPreviewUrl).toHaveBeenCalledWith({ url: "https://localhost:3000" }, "project-a");
  });

  it("sets error when API operations fail", async () => {
    mockStartDevServer.mockRejectedValueOnce(new Error("start failed"));

    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      try {
        await result.current.start({ command: "pnpm dev", scriptName: "dev" });
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBe("start failed");
  });

  it("polls status while running and stops polling when status becomes stopped", async () => {
    vi.useFakeTimers();

    mockFetchDevServerStatus
      .mockResolvedValueOnce(createState({ status: "running" }))
      .mockResolvedValueOnce(createState({ status: "running" }))
      .mockResolvedValueOnce(createState({ status: "stopped" }))
      .mockResolvedValue(createState({ status: "stopped" }));

    renderHook(() => useDevServer("project-a"));

    await flushMicrotasks();

    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await flushMicrotasks();
    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await flushMicrotasks();
    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    await flushMicrotasks();

    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(3);
  });

  it("cleans up EventSource and polling on unmount", async () => {
    vi.useFakeTimers();

    mockFetchDevServerStatus.mockResolvedValue(createState({ status: "running" }));

    const { unmount } = renderHook(() => useDevServer("project-a"));

    await flushMicrotasks();

    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0];
    const closeSpy = vi.spyOn(source, "close");

    unmount();

    expect(closeSpy).toHaveBeenCalled();

    const callsBefore = mockFetchDevServerStatus.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    await flushMicrotasks();

    expect(mockFetchDevServerStatus.mock.calls.length).toBe(callsBefore);
  });
});
