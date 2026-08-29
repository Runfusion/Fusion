import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeshEngines } from "../useMeshEngines";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchMeshEngines: vi.fn(),
}));

const mockFetchMeshEngines = vi.mocked(api.fetchMeshEngines);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/*
 * FNXC:MeshSharedPg 2026-06-25-00:00:
 * useMeshEngines fetches active engine connections from shared PG via
 * GET /api/mesh/engines and exposes them for <MeshTopology engines=...>.
 */
describe("useMeshEngines", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchMeshEngines.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads active engine connections on mount", async () => {
    mockFetchMeshEngines.mockResolvedValueOnce({
      collectedAt: "2026-06-25T00:00:00.000Z",
      backend: "shared-postgres",
      engines: [
        {
          projectId: "proj_1",
          projectName: "Engine One",
          runtimeStatus: "active",
          inFlightTasks: 3,
          activeAgents: 2,
          lastActivityAt: "2026-06-25T00:00:00.000Z",
        },
      ],
    });

    const { result } = renderHook(() => useMeshEngines());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.engines).toHaveLength(1);
    expect(result.current.engines[0]?.projectId).toBe("proj_1");
  });

  it("retains stale engine data on refresh error", async () => {
    mockFetchMeshEngines
      .mockResolvedValueOnce({
        collectedAt: "2026-06-25T00:00:00.000Z",
        backend: "shared-postgres",
        engines: [
          {
            projectId: "proj_1",
            projectName: "Engine One",
            runtimeStatus: "active",
            inFlightTasks: 1,
            activeAgents: 1,
          },
        ],
      })
      .mockRejectedValueOnce(new Error("engines unavailable"));

    const { result } = renderHook(() => useMeshEngines());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("engines unavailable");
    expect(result.current.engines).toHaveLength(1);
  });

  it("returns an empty engine list without error when backend reports no engines", async () => {
    mockFetchMeshEngines.mockResolvedValueOnce({
      collectedAt: "2026-06-25T00:00:00.000Z",
      backend: "shared-postgres",
      engines: [],
    });

    const { result } = renderHook(() => useMeshEngines());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.engines).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("refreshes on manual invocation", async () => {
    mockFetchMeshEngines
      .mockResolvedValueOnce({
        collectedAt: "2026-06-25T00:00:00.000Z",
        backend: "shared-postgres",
        engines: [{ projectId: "proj_1", runtimeStatus: "active", inFlightTasks: 0, activeAgents: 0 }],
      })
      .mockResolvedValueOnce({
        collectedAt: "2026-06-25T00:01:00.000Z",
        backend: "shared-postgres",
        engines: [{ projectId: "proj_2", runtimeStatus: "active", inFlightTasks: 1, activeAgents: 1 }],
      });

    const { result } = renderHook(() => useMeshEngines());

    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.engines[0]?.projectId).toBe("proj_2");
    expect(mockFetchMeshEngines).toHaveBeenCalledTimes(2);
  });
});
