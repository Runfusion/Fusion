import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:CapacityModel 2026-07-29-00:50 (drop the cross-project cap — settings half):
The hook is READ-ONLY now, so `updateGlobalConcurrency` and every case that drove a
write are gone: the debounced PUT, the save-state machine and the
keeps-counts-after-a-successful-PUT case. The cap they persisted no longer exists
(capacity is two numbers PER PROJECT) and the PUT route is deleted.

What is still covered is what the hook still does: populate live running counts,
return zero for an absent project, and refuse to surface stale truthy counts while
loading or in error — the last being a real past defect, where a failed load left
consumers reading the previous fetch's numbers as if current.
*/
const legacyMocks = vi.hoisted(() => ({
  fetchGlobalConcurrency: vi.fn(),
}));

vi.mock("../../api/legacy", () => legacyMocks);

type UseGlobalConcurrencyModule = typeof import("../useGlobalConcurrency");
type GlobalConcurrencyApiState = {
  currentlyActive: number;
  projectsActive: Record<string, number>;
};

async function loadHook(): Promise<UseGlobalConcurrencyModule["useGlobalConcurrency"]> {
  vi.resetModules();
  const module = await import("../useGlobalConcurrency");
  return module.useGlobalConcurrency;
}

function concurrencyState(overrides: Partial<GlobalConcurrencyApiState> = {}): GlobalConcurrencyApiState {
  return {
    currentlyActive: 3,
    projectsActive: { proj_123: 2 },
    ...overrides,
  };
}

describe("useGlobalConcurrency", () => {
  beforeEach(() => {
    vi.useRealTimers();
    legacyMocks.fetchGlobalConcurrency.mockResolvedValue(concurrencyState());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("populates running counts after fetch and returns zero for absent projects", async () => {
    const useGlobalConcurrency = await loadHook();

    const { result } = renderHook(() => useGlobalConcurrency());

    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.currentlyActive).toBe(3);
    expect(result.current.projectActiveCount("proj_123")).toBe(2);
    expect(result.current.projectActiveCount("missing-project")).toBe(0);
    expect(result.current.projectActiveCount()).toBe(0);
  });


  it("does not surface stale truthy counts while loading or in error", async () => {
    const useGlobalConcurrency = await loadHook();
    const { result, rerender } = renderHook(({ activeWhen }) => useGlobalConcurrency({ activeWhen }), {
      initialProps: { activeWhen: true },
    });
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.currentlyActive).toBe(3);

    legacyMocks.fetchGlobalConcurrency.mockRejectedValueOnce(new Error("offline"));
    rerender({ activeWhen: false });
    rerender({ activeWhen: true });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.currentlyActive).toBe(0);
    expect(result.current.projectActiveCount("proj_123")).toBe(0);
  });
});
