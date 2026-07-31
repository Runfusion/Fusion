/*
FNXC:MobileTabRetention 2026-07-26-11:52:
Invariant regression test for the mobile tab-discard fix. Mobile browsers (iOS Safari tabs, iOS installed
PWAs, Chrome Android) reclaim a backgrounded page that keeps doing work, which showed up as a full
white-splash reload whenever the operator returned to the dashboard after a few minutes away. The invariant
being locked here is deliberately asserted across a REPRESENTATIVE SAMPLE of polling surfaces, not a single
repro (AGENTS.md "Fix the Invariant, Not the Repro"):

  1. while `document.visibilityState === "hidden"`, an elapsed poll interval performs NO fetch, and
  2. on the hidden -> visible transition, EXACTLY ONE refresh happens and polling resumes.

Every dashboard poll routes through the one shared `useVisibilityAwarePoll` helper, so the helper itself is
covered directly and the hook-level cases prove the helper is actually wired into each surface.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const fetchDashboardHealth = vi.fn();
const refreshDashboardHealth = vi.fn();
const fetchActivityLog = vi.fn();
const fetchActivityFeed = vi.fn();
const fetchProjectHealth = vi.fn();
const apiFn = vi.fn();
const fetchProjectsAcrossNodes = vi.fn();
const fetchNodes = vi.fn();
const fetchMeshState = vi.fn();

vi.mock("../../api", () => ({
  fetchDashboardHealth: (...a: unknown[]) => fetchDashboardHealth(...a),
  refreshDashboardHealth: (...a: unknown[]) => refreshDashboardHealth(...a),
  fetchActivityLog: (...a: unknown[]) => fetchActivityLog(...a),
  fetchActivityFeed: (...a: unknown[]) => fetchActivityFeed(...a),
  fetchProjectHealth: (...a: unknown[]) => fetchProjectHealth(...a),
  api: (...a: unknown[]) => apiFn(...a),
  // Surfaces added when useProjects / useNodes / useMeshState were migrated onto the shared gate.
  fetchProjectsAcrossNodes: (...a: unknown[]) => fetchProjectsAcrossNodes(...a),
  hasNodeMappingsSupport: () => false,
  registerProject: vi.fn(),
  updateProject: vi.fn(),
  unregisterProject: vi.fn(),
  fetchNodes: (...a: unknown[]) => fetchNodes(...a),
  registerNode: vi.fn(),
  updateNode: vi.fn(),
  unregisterNode: vi.fn(),
  checkNodeHealth: vi.fn(),
  discoverRemoteNodeProjects: vi.fn(),
  fetchDockerNodeConfig: vi.fn(),
  fetchDockerConfigDiff: vi.fn(),
  updateDockerNodeConfig: vi.fn(),
  fetchMeshState: (...a: unknown[]) => fetchMeshState(...a),
}));

vi.mock("../../api-node", () => ({
  persistNodeProjectPathMappings: vi.fn(),
}));

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent: vi.fn(),
}));

// `t` must be referentially stable: `useNodes`/`useMeshState` list it in effect deps, so a fresh function
// per render would re-run their load effect and fabricate fetches this test would misattribute to polling.
const translate = (_key: string, fallback?: string) => fallback ?? _key;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

import {
  VISIBLE_EDGE_STAGGER_SLOTS,
  VISIBLE_EDGE_STAGGER_STEP_MS,
  VISIBLE_EDGE_STAGGER_WINDOW_MS,
  __resetVisibleEdgeStaggerRegistryForTests,
  useVisibilityAwarePoll,
  visibleEdgeStaggerDelayMs,
} from "../visibilitySuspension";
import { useActivityLog } from "../useActivityLog";
import { useDashboardHealth } from "../useDashboardHealth";
import { useMeshState } from "../useMeshState";
import { useNodes } from "../useNodes";
import { useProjectHealth } from "../useProjectHealth";
import { useProjects } from "../useProjects";
import { useStashOrphanCount } from "../useStashOrphanCount";

/** Drive the jsdom visibility state and dispatch the event the gate listens for. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("polling loops are suspended while the document is hidden", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetVisibleEdgeStaggerRegistryForTests();
    setVisibility("visible");
    for (const fn of [
      fetchDashboardHealth,
      fetchActivityLog,
      fetchActivityFeed,
      fetchProjectHealth,
      apiFn,
      fetchProjectsAcrossNodes,
      fetchNodes,
      fetchMeshState,
    ]) {
      fn.mockReset();
    }
    fetchDashboardHealth.mockResolvedValue({ status: "ok" });
    fetchActivityLog.mockResolvedValue([]);
    fetchActivityFeed.mockResolvedValue([]);
    fetchProjectHealth.mockResolvedValue({ ok: true });
    apiFn.mockResolvedValue({ count: 0 });
    fetchProjectsAcrossNodes.mockResolvedValue([]);
    fetchNodes.mockResolvedValue([]);
    fetchMeshState.mockResolvedValue({ nodes: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("useVisibilityAwarePoll: no ticks while hidden, exactly one refresh on becoming visible", async () => {
    const tick = vi.fn();
    renderHook(() => useVisibilityAwarePoll(tick, 5_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(tick).toHaveBeenCalledTimes(3);

    tick.mockClear();
    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(tick).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility("visible");
    });
    // Exactly one immediate refresh on the hidden -> visible edge, before the interval re-arms.
    expect(tick).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("useVisibilityAwarePoll: mounting while hidden arms nothing until the tab is shown", async () => {
    setVisibility("hidden");
    const tick = vi.fn();
    renderHook(() => useVisibilityAwarePoll(tick, 5_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(tick).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility("visible");
    });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  /*
  Each case below is a distinct surface that previously polled unconditionally: a 5s feed poll, a 10s
  multi-project health poll, a 15s backend-health poll, and a 30s badge poll. They share one assertion shape
  so a surface that drifts off the shared helper fails here.
  */
  // `useProjectHealth` keys its fetch callback off the identity of the id array, so the sample must pass a
  // stable reference exactly as real callers do.
  const PROJECT_IDS = ["p1"];

  const surfaces: Array<{
    name: string;
    intervalMs: number;
    render: () => { unmount: () => void };
    spy: () => ReturnType<typeof vi.fn>;
  }> = [
    {
      name: "useActivityLog (5s feed poll)",
      intervalMs: 5_000,
      render: () => renderHook(() => useActivityLog({ projectId: "p1" })),
      spy: () => fetchActivityLog,
    },
    {
      name: "useProjectHealth (10s health poll)",
      intervalMs: 10_000,
      render: () => renderHook(() => useProjectHealth(PROJECT_IDS)),
      spy: () => fetchProjectHealth,
    },
    {
      name: "useDashboardHealth (15s backend-health poll)",
      intervalMs: 15_000,
      render: () => renderHook(() => useDashboardHealth()),
      spy: () => fetchDashboardHealth,
    },
    {
      name: "useStashOrphanCount (30s badge poll)",
      intervalMs: 30_000,
      render: () => renderHook(() => useStashOrphanCount("p1")),
      spy: () => apiFn,
    },
    /*
    FNXC:MobileTabRetention 2026-07-26-16:05:
    These three were the gap between the change set's claim ("every polling loop is visibility-gated") and
    its behavior. Each owned a `visibilitychange` listener that only ADDED a refresh-on-visible and never
    cleared its interval, so all three kept fetching the whole time the tab was backgrounded. `useProjects`
    is the worst of them: App.tsx mounts it unconditionally, so its 5s loop alone kept the page non-idle for
    the entire session — the precise condition that makes a mobile browser discard the tab. Against the
    pre-fix code the hidden-window assertion below fails (6 poll periods of fetches, not zero).
    */
    {
      name: "useProjects (5s project-list poll, mounted for the whole session)",
      intervalMs: 5_000,
      render: () => renderHook(() => useProjects()),
      spy: () => fetchProjectsAcrossNodes,
    },
    {
      name: "useNodes (10s node-registry poll)",
      intervalMs: 10_000,
      render: () => renderHook(() => useNodes()),
      spy: () => fetchNodes,
    },
    {
      name: "useMeshState (10s mesh-state poll)",
      intervalMs: 10_000,
      render: () => renderHook(() => useMeshState()),
      spy: () => fetchMeshState,
    },
  ];

  for (const surface of surfaces) {
    it(`${surface.name} performs no fetch while hidden and refreshes once on return`, async () => {
      let view: { unmount: () => void } | null = null;
      await act(async () => {
        view = surface.render();
        await vi.advanceTimersByTimeAsync(0);
      });

      const spy = surface.spy();
      spy.mockClear();

      await act(async () => {
        setVisibility("hidden");
        // Well past several poll periods for every surface under test.
        await vi.advanceTimersByTimeAsync(surface.intervalMs * 6);
      });
      expect(spy).not.toHaveBeenCalled();

      await act(async () => {
        setVisibility("visible");
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(spy).toHaveBeenCalledTimes(1);

      // Polling resumes at the normal cadence once visible again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(surface.intervalMs);
      });
      expect(spy).toHaveBeenCalledTimes(2);

      await act(async () => {
        view?.unmount();
      });
    });
  }
});

/*
FNXC:MobileTabRetention 2026-07-26-14:20:
Companion invariant to the suspension tests above, locking the fix for a regression THOSE tests permitted.
Suspending every poller on `hidden` and refreshing every poller on `visible` traded a background drain for a
foreground stampede: one visibilitychange fired ~35 synchronous refreshes (≈25 in-viewport runtime-fallback
badges plus the singleton pollers) against a 6-connection-per-origin browser cap, on a waking mobile radio,
while the SSE bus was reopening its EventSource on the same edge.

Asserted here:
  1. N mounted background consumers do NOT all refresh in the same tick on the visible edge,
  2. a `priority: "critical"` consumer still refreshes synchronously on that edge (staleness is not the fix),
  3. every consumer does eventually refresh, exactly once, within the bounded stagger window, and
  4. the re-armed intervals inherit the stagger offset, so the herd does not simply re-form one interval later.

Stagger geometry is deterministic (subscription order, no randomness) so these are exact-count assertions.
*/
describe("the hidden -> visible edge is staggered, not a synchronized stampede", () => {
  const STEP_MS = 150;
  const WINDOW_MS = 3_000;
  const INTERVAL_MS = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetVisibleEdgeStaggerRegistryForTests();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  /** Mount `ticks.length` pollers inside one hook so registry order is the array order. */
  function renderPollers(
    ticks: Array<ReturnType<typeof vi.fn>>,
    priorityOf: (index: number) => "critical" | "background" = () => "background",
  ) {
    return renderHook(() => {
      // Hook order is stable because the array length is fixed for the lifetime of each test.
      ticks.forEach((tick, index) => {
        useVisibilityAwarePoll(tick, INTERVAL_MS, { priority: priorityOf(index) });
      });
    });
  }

  function calledCount(ticks: Array<ReturnType<typeof vi.fn>>): number {
    return ticks.filter((tick) => tick.mock.calls.length > 0).length;
  }

  /*
  FNXC:MobileTabRetention 2026-07-26-16:05:
  The stagger geometry is shared with the SSE bus's visible-edge channel reopen, so the pure slot function is
  asserted directly: both fan-outs must derive delays from it rather than hand-roll a second stagger whose
  union with this one would be unbounded.
  */
  it("exposes a deterministic, bounded slot delay for other visible-edge fan-outs to reuse", () => {
    expect(VISIBLE_EDGE_STAGGER_SLOTS).toBe(Math.round(VISIBLE_EDGE_STAGGER_WINDOW_MS / VISIBLE_EDGE_STAGGER_STEP_MS));
    expect(visibleEdgeStaggerDelayMs(0)).toBe(0);
    expect(visibleEdgeStaggerDelayMs(1)).toBe(VISIBLE_EDGE_STAGGER_STEP_MS);
    expect(visibleEdgeStaggerDelayMs(3)).toBe(3 * VISIBLE_EDGE_STAGGER_STEP_MS);
    // Wraps instead of growing without bound, so a large fan-out stays inside the window.
    expect(visibleEdgeStaggerDelayMs(VISIBLE_EDGE_STAGGER_SLOTS)).toBe(0);
    expect(visibleEdgeStaggerDelayMs(VISIBLE_EDGE_STAGGER_SLOTS * 4 + 2)).toBe(2 * VISIBLE_EDGE_STAGGER_STEP_MS);
    for (let index = 0; index < VISIBLE_EDGE_STAGGER_SLOTS * 3; index += 1) {
      expect(visibleEdgeStaggerDelayMs(index)).toBeLessThan(VISIBLE_EDGE_STAGGER_WINDOW_MS);
    }
  });

  it("N background consumers do not all fire in the same tick, and all refresh within the window", async () => {
    const N = 8;
    const ticks = Array.from({ length: N }, () => vi.fn());
    const view = renderPollers(ticks);

    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    });
    expect(calledCount(ticks)).toBe(0);

    // The visible edge itself: only the slot-0 consumer refreshes synchronously.
    await act(async () => {
      setVisibility("visible");
    });
    expect(calledCount(ticks)).toBe(1);
    expect(ticks[0]).toHaveBeenCalledTimes(1);

    // Each subsequent slot lands one step later, so no single tick carries the whole burst.
    for (let index = 1; index < N; index += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STEP_MS);
      });
      expect(calledCount(ticks)).toBe(index + 1);
      expect(ticks[index]).toHaveBeenCalledTimes(1);
    }

    // Nothing is dropped or duplicated: every consumer refreshed exactly once inside the bounded window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
    });
    for (const tick of ticks) {
      expect(tick).toHaveBeenCalledTimes(1);
    }

    await act(async () => {
      view.unmount();
    });
  });

  it("a critical consumer still refreshes immediately on the visible edge", async () => {
    const ticks = Array.from({ length: 4 }, () => vi.fn());
    // The critical one is mounted LAST, so a slot-order-only implementation would have delayed it.
    const criticalIndex = 3;
    const view = renderPollers(ticks, (index) => (index === criticalIndex ? "critical" : "background"));

    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    });
    expect(calledCount(ticks)).toBe(0);

    await act(async () => {
      setVisibility("visible");
    });
    // Synchronously on the edge: the critical consumer plus the slot-0 background consumer.
    expect(ticks[criticalIndex]).toHaveBeenCalledTimes(1);
    expect(ticks[0]).toHaveBeenCalledTimes(1);
    expect(ticks[1]).not.toHaveBeenCalled();
    expect(ticks[2]).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
    });
    for (const tick of ticks) {
      expect(tick).toHaveBeenCalledTimes(1);
    }

    await act(async () => {
      view.unmount();
    });
  });

  it("re-armed intervals inherit the stagger offset instead of re-synchronizing", async () => {
    const ticks = Array.from({ length: 2 }, () => vi.fn());
    const view = renderPollers(ticks);

    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    });

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    expect(ticks[0]).toHaveBeenCalledTimes(1);
    expect(ticks[1]).toHaveBeenCalledTimes(1);

    // Slot 0 armed at edge+0, slot 1 at edge+STEP: their next interval ticks must not coincide.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS - STEP_MS);
    });
    expect(ticks[0]).toHaveBeenCalledTimes(2);
    expect(ticks[1]).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
    expect(ticks[1]).toHaveBeenCalledTimes(2);

    await act(async () => {
      view.unmount();
    });
  });

  it("backgrounding again mid-stagger cancels the pending refresh — a hidden page does no work", async () => {
    const ticks = Array.from({ length: 3 }, () => vi.fn());
    const view = renderPollers(ticks);

    await act(async () => {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    });

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(STEP_MS / 2);
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(WINDOW_MS + INTERVAL_MS);
    });
    // Only the synchronous slot-0 refresh got through; the queued ones were cancelled by re-hiding.
    expect(ticks[0]).toHaveBeenCalledTimes(1);
    expect(ticks[1]).not.toHaveBeenCalled();
    expect(ticks[2]).not.toHaveBeenCalled();

    await act(async () => {
      view.unmount();
    });
  });
});
