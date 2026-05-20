import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import { useAgentsMapCache } from "../useAgentsMapCache";

vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
}));

const { fetchAgents } = await import("../../api");
const mockFetchAgents = vi.mocked(fetchAgents);

describe("useAgentsMapCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchAgents.mockResolvedValue([
      { id: "agent-1", name: "Alpha", role: "executor", state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: {} },
    ]);
  });

  it("hydrates synchronously from cache", async () => {
    localStorage.setItem(
      `${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}proj-1`,
      JSON.stringify({
        savedAt: Date.now(),
        data: [{ id: "agent-cached", name: "Cached", role: "reviewer", state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: {} }],
      }),
    );

    const { result } = renderHook(() => useAgentsMapCache("proj-1"));

    expect(result.current.loading).toBe(false);
    expect(result.current.agentsMap.get("agent-cached")?.name).toBe("Cached");

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj-1");
    });
  });

  it("loads on cache miss and writes through", async () => {
    const { result } = renderHook(() => useAgentsMapCache("proj-1"));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.agents[0]?.id).toBe("agent-1");
    });

    const cached = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}proj-1`) ?? "null") as { data: Array<{ id: string }> };
    expect(cached.data[0]?.id).toBe("agent-1");
  });

  it("deduplicates concurrent mounts per project", async () => {
    let resolveFetch: ((agents: Awaited<ReturnType<typeof fetchAgents>>) => void) | undefined;
    mockFetchAgents.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const hookA = renderHook(() => useAgentsMapCache("proj-1"));
    const hookB = renderHook(() => useAgentsMapCache("proj-1"));

    expect(mockFetchAgents).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.([
        { id: "agent-1", name: "Alpha", role: "executor", state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: {} },
      ]);
    });

    await waitFor(() => {
      expect(hookA.result.current.loading).toBe(false);
      expect(hookB.result.current.agentsMap.get("agent-1")?.name).toBe("Alpha");
    });
  });

  it("clears cache on empty-cache failure", async () => {
    const swrCacheModule = await import("../../utils/swrCache");
    const clearCacheSpy = vi.spyOn(swrCacheModule, "clearCache");
    mockFetchAgents.mockRejectedValueOnce(new Error("nope"));

    const { result } = renderHook(() => useAgentsMapCache("proj-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(clearCacheSpy).toHaveBeenCalledWith(`${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}proj-1`);
  });

  it("hydrates per-project cache on switch and fetches the new project once", async () => {
    localStorage.setItem(
      `${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}p1`,
      JSON.stringify({ savedAt: Date.now(), data: [{ id: "agent-p1", name: "Project One", role: "executor", state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: {} }] }),
    );
    localStorage.setItem(
      `${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}p2`,
      JSON.stringify({ savedAt: Date.now(), data: [{ id: "agent-p2", name: "Project Two", role: "reviewer", state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata: {} }] }),
    );

    const { result, rerender } = renderHook(({ projectId }: { projectId: string }) => useAgentsMapCache(projectId), {
      initialProps: { projectId: "p1" },
    });

    expect(result.current.agentsMap.get("agent-p1")?.name).toBe("Project One");
    expect(result.current.loading).toBe(false);

    rerender({ projectId: "p2" });

    expect(result.current.agentsMap.get("agent-p2")?.name).toBe("Project Two");
    expect(result.current.loading).toBe(false);

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "p2");
    });
    expect(mockFetchAgents).toHaveBeenCalledTimes(2);
  });
});
