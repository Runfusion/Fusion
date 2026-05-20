import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import { useDiscoveredSkillsCache } from "../useDiscoveredSkillsCache";

vi.mock("../../api", () => ({
  fetchDiscoveredSkills: vi.fn(),
}));

const { fetchDiscoveredSkills } = await import("../../api");
const mockFetchDiscoveredSkills = vi.mocked(fetchDiscoveredSkills);

describe("useDiscoveredSkillsCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchDiscoveredSkills.mockResolvedValue([
      { name: "agent-browser", enabled: true, source: "skills/browser" },
    ]);
  });

  it("hydrates synchronously from cache", async () => {
    localStorage.setItem(
      `${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}proj-1`,
      JSON.stringify({ savedAt: Date.now(), data: [{ name: "cached-skill", enabled: true, source: "cache/source" }] }),
    );

    const { result } = renderHook(() => useDiscoveredSkillsCache("proj-1"));

    expect(result.current.loading).toBe(false);
    expect(result.current.skills[0]?.name).toBe("cached-skill");

    await waitFor(() => {
      expect(mockFetchDiscoveredSkills).toHaveBeenCalledWith("proj-1");
    });
  });

  it("loads on cache miss and writes through", async () => {
    const { result } = renderHook(() => useDiscoveredSkillsCache("proj-1"));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.skills[0]?.name).toBe("agent-browser");
    });

    const cached = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}proj-1`) ?? "null") as { data: Array<{ name: string }> };
    expect(cached.data[0]?.name).toBe("agent-browser");
  });

  it("deduplicates concurrent mounts per project", async () => {
    let resolveFetch: ((skills: Awaited<ReturnType<typeof fetchDiscoveredSkills>>) => void) | undefined;
    mockFetchDiscoveredSkills.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const hookA = renderHook(() => useDiscoveredSkillsCache("proj-1"));
    const hookB = renderHook(() => useDiscoveredSkillsCache("proj-1"));

    expect(mockFetchDiscoveredSkills).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.([{ name: "agent-browser", enabled: true, source: "skills/browser" }]);
    });

    await waitFor(() => {
      expect(hookA.result.current.loading).toBe(false);
      expect(hookB.result.current.skills[0]?.name).toBe("agent-browser");
    });
  });

  it("clears cache on empty-cache failure", async () => {
    const swrCacheModule = await import("../../utils/swrCache");
    const clearCacheSpy = vi.spyOn(swrCacheModule, "clearCache");
    mockFetchDiscoveredSkills.mockRejectedValueOnce(new Error("nope"));

    const { result } = renderHook(() => useDiscoveredSkillsCache("proj-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(clearCacheSpy).toHaveBeenCalledWith(`${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}proj-1`);
  });

  it("refresh forces a new request", async () => {
    const { result } = renderHook(() => useDiscoveredSkillsCache("proj-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    mockFetchDiscoveredSkills.mockResolvedValueOnce([{ name: "filesystem", enabled: false, source: "skills/fs" }]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetchDiscoveredSkills).toHaveBeenCalledTimes(2);
    expect(result.current.skills[0]?.name).toBe("filesystem");
  });
});
