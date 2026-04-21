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
import { subscribeSse, type SseSubscription } from "../../sse-bus";
import { __resetUseDevServerForTests, useDevServer } from "../useDevServer";

vi.mock("../../api", () => ({
  fetchDevServerCandidates: vi.fn(),
  fetchDevServerStatus: vi.fn(),
  getDevServerLogsStreamUrl: vi.fn(),
  startDevServer: vi.fn(),
  stopDevServer: vi.fn(),
  restartDevServer: vi.fn(),
  setDevServerPreviewUrl: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(),
}));

const mockFetchDevServerCandidates = vi.mocked(fetchDevServerCandidates);
const mockFetchDevServerStatus = vi.mocked(fetchDevServerStatus);
const mockGetDevServerLogsStreamUrl = vi.mocked(getDevServerLogsStreamUrl);
const mockStartDevServer = vi.mocked(startDevServer);
const mockStopDevServer = vi.mocked(stopDevServer);
const mockRestartDevServer = vi.mocked(restartDevServer);
const mockSetDevServerPreviewUrl = vi.mocked(setDevServerPreviewUrl);
const mockSubscribeSse = vi.mocked(subscribeSse);

let activeSubscription: SseSubscription | null = null;
let unsubscribeSpy = vi.fn();

function createCandidate(overrides: Partial<DevServerCandidate> = {}): DevServerCandidate {
  return {
    scriptName: "dev",
    command: "pnpm dev",
    packagePath: ".",
    confidence: 1,
    name: "dev",
    cwd: ".",
    source: "root",
    label: "project · dev (root)",
    ...overrides,
  };
}

function createState(overrides: Partial<DevServerState> = {}): DevServerState {
  return {
    id: "default",
    name: "default",
    status: "stopped",
    command: "pnpm dev",
    scriptName: "dev",
    cwd: ".",
    detectedUrl: "http://localhost:5173",
    manualUrl: undefined,
    logs: [],
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
    __resetUseDevServerForTests();

    activeSubscription = null;
    unsubscribeSpy = vi.fn();

    mockGetDevServerLogsStreamUrl.mockReturnValue("/api/dev-server/logs/stream?projectId=project-a");
    mockFetchDevServerCandidates.mockResolvedValue([createCandidate()]);
    mockFetchDevServerStatus.mockResolvedValue(createState());
    mockStartDevServer.mockResolvedValue(createState({ status: "running", pid: 1111 }));
    mockStopDevServer.mockResolvedValue(createState({ status: "stopped", pid: undefined }));
    mockRestartDevServer.mockResolvedValue(createState({ status: "running", pid: 2222 }));
    mockSetDevServerPreviewUrl.mockResolvedValue(createState({ manualUrl: "http://localhost:3000" }));

    mockSubscribeSse.mockImplementation((_url, sub) => {
      activeSubscription = sub;
      return unsubscribeSpy;
    });
  });

  it("initially exposes loading state", () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.candidates).toEqual([]);
    expect(result.current.serverState).toBeNull();
  });

  it("fetches candidates and status on mount", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetchDevServerCandidates).toHaveBeenCalledWith("project-a");
    expect(mockFetchDevServerStatus).toHaveBeenCalledWith("project-a");
    expect(result.current.candidates).toHaveLength(1);
    expect(result.current.serverState?.status).toBe("stopped");
  });

  it("opens SSE stream on mount", async () => {
    renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(mockSubscribeSse).toHaveBeenCalledWith(
        "/api/dev-server/logs/stream?projectId=project-a",
        expect.any(Object),
      );
    });
  });

  it("polls every 3s while running", async () => {
    vi.useFakeTimers();
    mockFetchDevServerStatus.mockResolvedValue(createState({ status: "running" }));

    renderHook(() => useDevServer("project-a"));

    await flushMicrotasks();
    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(2);
  });

  it("does not poll while stopped", async () => {
    vi.useFakeTimers();
    mockFetchDevServerStatus.mockResolvedValue(createState({ status: "stopped" }));

    renderHook(() => useDevServer("project-a"));

    await flushMicrotasks();
    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(9000);
      await Promise.resolve();
    });

    expect(mockFetchDevServerStatus).toHaveBeenCalledTimes(1);
  });

  it("appends logs from SSE events", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(mockSubscribeSse).toHaveBeenCalledTimes(1);
    });

    act(() => {
      activeSubscription?.events?.["dev-server:log"]?.({
        data: JSON.stringify({ line: "from namespaced log" }),
      } as MessageEvent<string>);
      activeSubscription?.events?.log?.({
        data: JSON.stringify({ line: "from log" }),
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(result.current.logs).toEqual(["from namespaced log", "from log"]);
    });
  });

  it("updates state from dev-server:status SSE events", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(mockSubscribeSse).toHaveBeenCalledTimes(1);
    });

    act(() => {
      activeSubscription?.events?.["dev-server:status"]?.({
        data: JSON.stringify(createState({ status: "running", pid: 9876 })),
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(result.current.serverState?.status).toBe("running");
      expect(result.current.serverState?.pid).toBe(9876);
    });
  });

  it("start() accepts candidate and custom payload inputs", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.start(createCandidate({ cwd: "apps/web", packagePath: "apps/web" }));
    });

    expect(mockStartDevServer).toHaveBeenCalledWith(
      {
        command: "pnpm dev",
        cwd: "apps/web",
        scriptName: "dev",
        packagePath: "apps/web",
      },
      "project-a",
    );

    await act(async () => {
      await result.current.start({ command: "pnpm start", scriptName: "start", cwd: "apps/api" });
    });

    expect(mockStartDevServer).toHaveBeenLastCalledWith(
      {
        command: "pnpm start",
        cwd: "apps/api",
        scriptName: "start",
        packagePath: "apps/api",
      },
      "project-a",
    );
  });

  it("stop(), restart(), and setPreviewUrl() call APIs", async () => {
    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.stop();
      await result.current.restart();
      await result.current.setPreviewUrl("http://localhost:3000");
    });

    expect(mockStopDevServer).toHaveBeenCalledWith("project-a");
    expect(mockRestartDevServer).toHaveBeenCalledWith("project-a");
    expect(mockSetDevServerPreviewUrl).toHaveBeenCalledWith({ url: "http://localhost:3000" }, "project-a");
  });

  it("sets error when API operations fail", async () => {
    mockStartDevServer.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.start({ command: "pnpm dev", scriptName: "dev" })).rejects.toThrow("boom");
    });

    expect(result.current.error).toBe("boom");
  });

  it("detect() refreshes candidate list", async () => {
    mockFetchDevServerCandidates
      .mockResolvedValueOnce([createCandidate()])
      .mockResolvedValueOnce([createCandidate({ scriptName: "start", command: "pnpm start" })]);

    const { result } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.detect();
    });

    expect(mockFetchDevServerCandidates).toHaveBeenCalledTimes(2);
    expect(result.current.candidates).toEqual([
      expect.objectContaining({ scriptName: "start", command: "pnpm start" }),
    ]);
  });

  it("cleans up SSE on unmount", async () => {
    const { unmount } = renderHook(() => useDevServer("project-a"));

    await waitFor(() => {
      expect(mockSubscribeSse).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });
});
