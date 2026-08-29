import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useManagedDockerNodes } from "../useManagedDockerNodes";
import * as api from "../../api";
import type { ManagedDockerNodeInfo } from "../../api";

vi.mock("../../api", () => ({
  fetchManagedDockerNodes: vi.fn(),
  fetchManagedDockerNodeContainerStatus: vi.fn(),
  fetchDockerNodeLogs: vi.fn(),
  createManagedDockerNode: vi.fn(),
}));

const mockFetchManagedDockerNodes = vi.mocked(api.fetchManagedDockerNodes);
const mockFetchManagedDockerNodeContainerStatus = vi.mocked(api.fetchManagedDockerNodeContainerStatus);
const mockFetchDockerNodeLogs = vi.mocked(api.fetchDockerNodeLogs);

function makeDockerNode(overrides: Partial<ManagedDockerNodeInfo> = {}): ManagedDockerNodeInfo {
  return {
    id: "dn-1",
    name: "Docker Node",
    status: "running",
    hostConfig: { type: "local" },
    envVars: {},
    imageName: "runfusion/fusion",
    imageTag: "latest",
    volumeMounts: [],
    persistentStorage: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useManagedDockerNodes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchManagedDockerNodes.mockReset();
    mockFetchManagedDockerNodeContainerStatus.mockReset();
    mockFetchDockerNodeLogs.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches docker nodes on mount", async () => {
    mockFetchManagedDockerNodes.mockResolvedValueOnce([makeDockerNode()]);

    const { result } = renderHook(() => useManagedDockerNodes());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.dockerNodes).toHaveLength(1);
  });

  it("polls every 15 seconds", async () => {
    mockFetchManagedDockerNodes
      .mockResolvedValueOnce([makeDockerNode({ name: "Before" })])
      .mockResolvedValueOnce([makeDockerNode({ name: "After" })]);

    const { result } = renderHook(() => useManagedDockerNodes());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      vi.advanceTimersByTime(15000);
      await flushPromises();
    });

    expect(result.current.dockerNodes[0]?.name).toBe("After");
  });

  it("gets container status", async () => {
    mockFetchManagedDockerNodes.mockResolvedValueOnce([makeDockerNode()]);
    mockFetchManagedDockerNodeContainerStatus.mockResolvedValueOnce({ running: true, status: "running" });

    const { result } = renderHook(() => useManagedDockerNodes());
    await act(async () => {
      await flushPromises();
    });

    await expect(result.current.getContainerStatus("dn-1")).resolves.toEqual({ running: true, status: "running" });
  });

  it("gets docker logs string", async () => {
    mockFetchManagedDockerNodes.mockResolvedValueOnce([makeDockerNode()]);
    mockFetchDockerNodeLogs.mockResolvedValueOnce({ logs: "hello" });

    const { result } = renderHook(() => useManagedDockerNodes());
    await act(async () => {
      await flushPromises();
    });

    await expect(result.current.getLogs("dn-1", { tail: 50 })).resolves.toBe("hello");
    expect(mockFetchDockerNodeLogs).toHaveBeenCalledWith("dn-1", { tail: 50 });
  });

  it("keeps stale data on polling failure and sets error", async () => {
    mockFetchManagedDockerNodes
      .mockResolvedValueOnce([makeDockerNode({ name: "Stale" })])
      .mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useManagedDockerNodes());
    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      vi.advanceTimersByTime(15000);
      await flushPromises();
    });

    expect(result.current.dockerNodes[0]?.name).toBe("Stale");
    expect(result.current.error).toBe("boom");
  });

  it("refreshes on visibility change", async () => {
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    mockFetchManagedDockerNodes
      .mockResolvedValueOnce([makeDockerNode({ name: "Initial" })])
      .mockResolvedValueOnce([makeDockerNode({ name: "Visible Again" })]);

    const { result } = renderHook(() => useManagedDockerNodes());
    await act(async () => {
      await flushPromises();
    });

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    await act(async () => {
      vi.advanceTimersByTime(1100);
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
    });

    expect(result.current.dockerNodes[0]?.name).toBe("Visible Again");

    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    }
  });
});
